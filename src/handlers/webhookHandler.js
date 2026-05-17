import { config, isTestMode } from '../config.js';
import {
  parsearWebhook,
  ehMensagemDeHumano,
  enviarTexto,
} from '../services/zapi.js';
import {
  buscarOuCriarLead,
  buscarHistorico,
  salvarMensagem,
  ultimaMensagemFoiHumana,
} from '../services/supabase.js';
import { gerarResposta, detectarEscalacao } from '../services/openai.js';
import { montarSystemPrompt, formatarHistorico } from '../lib/promptBuilder.js';
import { classificarMensagem, querFecharMatricula } from '../lib/messageClassifier.js';
import { transferirParaHumano, encerrarLead } from '../lib/escalation.js';

/**
 * Handler principal de webhooks da Z-API.
 * Recebe a notificação de nova mensagem e decide o que fazer.
 *
 * @param {Object} webhookBody - Body do webhook (já como objeto JS)
 */
export async function processarWebhook(webhookBody) {
  console.log('📥 Webhook recebido');

  // Filtro: ignora qualquer mensagem vinda de grupo (evita lead-lixo no banco).
  // A Mila opera só em conversas 1-a-1 com leads. Grupos (inclusive o de notificação
  // interna) não devem virar lead nem disparar fluxo de atendimento.
  const phoneOrigem = webhookBody.phone || '';
  if (phoneOrigem.includes('-group') || phoneOrigem.includes('@g.us') || webhookBody.isGroup) {
    console.log(`🔕 Mensagem de grupo ignorada (${phoneOrigem})`);
    return;
  }

  // Caso 1: Mensagem é da própria Mila/humano operando manualmente
  // (responder pelo painel da Z-API ou WhatsApp Business direto)
  if (ehMensagemDeHumano(webhookBody)) {
    console.log('👤 Mensagem manual de humano detectada. Mila não vai responder nessa conversa.');

    // Salva no histórico pra Mila saber que humano respondeu
    const phone = webhookBody.phone;
    if (phone) {
      try {
        const lead = await buscarOuCriarLead({ telefone: phone });
        const conteudo = webhookBody.text?.message || '[mensagem do humano]';
        await salvarMensagem({
          leadId: lead.id,
          direcao: 'saida',
          origem: 'humano',
          conteudo,
        });
      } catch (error) {
        console.error('Erro ao salvar mensagem do humano:', error.message);
      }
    }
    return;
  }

  // Caso 2: Mensagem de entrada (lead falou)
  const mensagem = parsearWebhook(webhookBody);
  if (!mensagem) {
    console.log('⚠️ Webhook ignorado (formato não reconhecido)');
    return;
  }

  const { phone, nome, conteudo, tipo } = mensagem;

  // Validação modo teste
  if (isTestMode() && phone !== config.testPhoneNumber) {
    console.log(`🧪 Modo teste ativo. Ignorando mensagem de ${phone} (autorizado: ${config.testPhoneNumber}).`);
    return;
  }

  // Identifica ou cria lead
  let lead;
  try {
    lead = await buscarOuCriarLead({
      telefone: phone,
      nome,
      campanhaOrigem: null, // futuramente: extrair do Meta Ads
    });
  } catch (error) {
    console.error('❌ Erro ao buscar/criar lead:', error.message);
    return;
  }

  // Se o lead já está com status 'encerrado', não responde
  if (lead.status === 'encerrado') {
    console.log(`🛑 Lead ${lead.id} está encerrado. Mila não vai responder.`);
    // Mas registra a mensagem mesmo assim, pra histórico
    await salvarMensagem({
      leadId: lead.id,
      direcao: 'entrada',
      origem: 'lead',
      conteudo,
      tipo,
    });
    return;
  }

  // Se o lead foi transferido recentemente E humano respondeu por último,
  // Mila fica em silêncio
  if (lead.status === 'transferido') {
    const humanoAtivo = await ultimaMensagemFoiHumana(lead.id);
    if (humanoAtivo) {
      console.log(`🤝 Lead ${lead.id} está sendo atendido por humano. Mila em silêncio.`);
      await salvarMensagem({
        leadId: lead.id,
        direcao: 'entrada',
        origem: 'lead',
        conteudo,
        tipo,
      });
      return;
    }
  }

  // Salva a mensagem do lead no histórico
  await salvarMensagem({
    leadId: lead.id,
    direcao: 'entrada',
    origem: 'lead',
    conteudo,
    tipo,
  });

  // === DECISÕES SOBRE COMO RESPONDER ===

  // 1. Mensagem pode ser "fechamento rápido" (heurística)
  if (querFecharMatricula(conteudo)) {
    console.log('🎯 Lead quer fechar matrícula. Transferindo direto pro humano.');
    await transferirParaHumano({ lead, motivo: 'lead quer fechar matrícula' });
    return;
  }

  // 2. Classifica intenção (evasiva, engajamento, encerramento)
  const classificacao = await classificarMensagem(conteudo);

  // Se for encerramento explícito, despede e marca como encerrado
  if (classificacao === 'encerramento') {
    console.log('🛑 Lead pediu pra encerrar. Despedindo.');
    await encerrarLead(lead, 'lead expressou desinteresse');
    return;
  }

  // 3. Busca histórico pra dar contexto pra IA
  const historicoBruto = await buscarHistorico(lead.id, 20);
  // Remove a mensagem que acabou de entrar (já vamos passar como 'mensagemNova')
  const historicoSemUltima = historicoBruto.slice(0, -1);
  const historicoFormatado = formatarHistorico(historicoSemUltima);

  // 4. Detecta se a conversa exige escalação (lead pediu visita, valor de multa, etc.)
  const { escalar, motivo } = await detectarEscalacao({
    historico: historicoFormatado,
    mensagemNova: conteudo,
  });

  if (escalar) {
    console.log(`🔥 Escalação detectada pela IA: ${motivo}`);
    await transferirParaHumano({ lead, motivo: motivo || 'gatilho detectado' });
    return;
  }

  // 5. Gera resposta normal da Mila
  let resposta;
  try {
    const systemPrompt = montarSystemPrompt();
    resposta = await gerarResposta({
      systemPrompt,
      historico: historicoFormatado,
      mensagemNova: conteudo,
    });
  } catch (error) {
    console.error('❌ Erro ao gerar resposta da Mila:', error.message);
    // Fallback: resposta genérica
    resposta = `Oi${lead.nome ? ', ' + lead.nome : ''}! Tive uma instabilidade aqui. Pode me chamar de novo em alguns minutos? 🙏`;
  }

  // 6. Envia resposta
  try {
    await enviarTexto(phone, resposta);
    await salvarMensagem({
      leadId: lead.id,
      direcao: 'saida',
      origem: 'mila',
      conteudo: resposta,
    });
    console.log(`✅ Mila respondeu pro lead ${lead.id}`);
  } catch (error) {
    console.error('❌ Erro ao enviar resposta:', error.message);
  }
}
