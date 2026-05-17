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
  verificarDuplicata,
  reativarLead,
  gravarLog,
} from '../services/supabase.js';
import { gerarResposta, detectarEscalacao } from '../services/openai.js';
import { montarSystemPrompt, formatarHistorico } from '../lib/promptBuilder.js';
import { classificarMensagem, querFecharMatricula } from '../lib/messageClassifier.js';
import { transferirParaHumano, encerrarLead } from '../lib/escalation.js';

/**
 * Extrai apenas o primeiro nome de um nome completo.
 */
function primeiroNome(nomeCompleto) {
  if (!nomeCompleto) return null;
  return nomeCompleto.trim().split(' ')[0];
}

/**
 * Detecta se a mensagem contém indicadores de crise emocional grave.
 */
const PALAVRAS_CRISE = [
  /suicid/i,
  /me matar/i,
  /quero morrer/i,
  /n[ãa]o quero mais viver/i,
  /tirar minha vida/i,
  /automutila/i,
  /me machucar/i,
  /n[ãa]o aguento mais/i,
  /acabar com tudo/i,
  /desaparecer para sempre/i,
];

function detectarCrise(texto) {
  if (!texto) return false;
  return PALAVRAS_CRISE.some((r) => r.test(texto));
}

/**
 * Verifica se o lead transferido ainda está dentro da janela de silêncio (4 horas).
 */
function dentroJanelaSilencio(lead) {
  if (lead.status !== 'transferido') return false;
  if (!lead.ultima_interacao_em) return false;

  const JANELA_HORAS = 4;
  const ultimaInteracao = new Date(lead.ultima_interacao_em).getTime();
  const agora = Date.now();
  const diferencaHoras = (agora - ultimaInteracao) / (1000 * 60 * 60);

  return diferencaHoras < JANELA_HORAS;
}

export async function processarWebhook(webhookBody) {
  console.log('📥 Webhook recebido');

  // Deduplicação: ignora webhooks já processados
  const messageId = webhookBody.messageId || webhookBody.id || null;
  if (messageId) {
    const duplicata = await verificarDuplicata(messageId);
    if (duplicata) return;
  }

  // Filtro: ignora mensagens de grupo
  const phoneOrigem = webhookBody.phone || '';
  if (phoneOrigem.includes('-group') || phoneOrigem.includes('@g.us') || webhookBody.isGroup) {
    console.log(`🔕 Mensagem de grupo ignorada (${phoneOrigem})`);
    return;
  }

  // Caso 1: Mensagem da própria Mila/humano operando manualmente
  if (ehMensagemDeHumano(webhookBody)) {
    console.log('👤 Mensagem manual de humano detectada. Mila não vai responder nessa conversa.');
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
        await gravarLog({
          contexto: 'webhook',
          mensagem: 'Erro ao salvar mensagem do humano',
          telefone: webhookBody.phone,
          payload: { erro: error.message },
        });
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
      nome: primeiroNome(nome),
      campanhaOrigem: null,
    });
  } catch (error) {
    console.error('❌ Erro ao buscar/criar lead:', error.message);
    await gravarLog({
      contexto: 'supabase',
      mensagem: 'Erro ao buscar ou criar lead',
      telefone: phone,
      payload: { erro: error.message },
    });
    return;
  }

  // Tratamento de crise emocional — prioridade máxima
  if (detectarCrise(conteudo)) {
    console.log(`🆘 Crise emocional detectada para lead ${lead.id}. Acionando protocolo de cuidado.`);
    try {
      await enviarTexto(
        phone,
        `Fico feliz que você compartilhou isso comigo. Pensamentos assim são pesados de carregar, e faz sentido querer mudar algo na vida.\n\nSe precisar conversar com alguém especializado, o CVV atende 24h pelo 188 ou pelo chat em cvv.org.br, de graça e com sigilo total.\n\nAqui na Cia, o treino pode ser um caminho pra se cuidar também. Mas o mais importante agora é você estar bem.`
      );
      await salvarMensagem({
        leadId: lead.id,
        direcao: 'entrada',
        origem: 'lead',
        conteudo,
        tipo,
      });
      await transferirParaHumano({
        lead,
        motivo: 'situação de cuidado emocional — lead mencionou pensamentos graves',
      });
      await gravarLog({
        nivel: 'aviso',
        contexto: 'webhook',
        mensagem: 'Protocolo de crise emocional acionado',
        telefone: phone,
        leadId: lead.id,
      });
    } catch (error) {
      console.error('❌ Erro ao tratar crise emocional:', error.message);
      await gravarLog({
        contexto: 'webhook',
        mensagem: 'Erro ao tratar crise emocional',
        telefone: phone,
        leadId: lead.id,
        payload: { erro: error.message },
      });
    }
    return;
  }

  // Tratamento de áudio e imagem
  if (tipo === 'audio' || tipo === 'imagem') {
    console.log(`🎵 Mensagem do tipo ${tipo} recebida. Enviando resposta padrão.`);
    await enviarTexto(phone, 'Oi! Não consigo ouvir áudios ou ver imagens por aqui, mas pode me mandar em texto que te respondo na hora! 😊');
    await salvarMensagem({
      leadId: lead.id,
      direcao: 'entrada',
      origem: 'lead',
      conteudo: `[${tipo}]`,
      tipo,
    });
    return;
  }

  // Reabertura de lead encerrado que voltou a falar
  if (lead.status === 'encerrado') {
    console.log(`🔄 Lead ${lead.id} encerrado voltou a falar. Avaliando reabertura.`);
    try {
      const { lead: leadReativado, retomandoContexto, diasPassados } = await reativarLead(lead);
      lead = leadReativado;

      await salvarMensagem({
        leadId: lead.id,
        direcao: 'entrada',
        origem: 'lead',
        conteudo,
        tipo,
      });

      const systemPrompt = montarSystemPrompt();
      let historicoFormatado = [];

      if (retomandoContexto) {
        console.log(`📋 Retomando contexto (${diasPassados} dias atrás).`);
        const historicoBruto = await buscarHistorico(lead.id, 10);
        const historicoSemUltima = historicoBruto.slice(0, -1);
        historicoFormatado = formatarHistorico(historicoSemUltima);
      } else {
        console.log(`🆕 Mais de 30 dias (${diasPassados} dias). Iniciando conversa do zero.`);
        historicoFormatado = [];
      }

      const resposta = await gerarResposta({
        systemPrompt,
        historico: historicoFormatado,
        mensagemNova: retomandoContexto
          ? `[CONTEXTO INTERNO — NÃO MENCIONE ISSO NA RESPOSTA: Este lead já conversou com você há ${diasPassados} dias e a conversa foi encerrada. Ele voltou agora. Retome de forma natural, sem ser dramático, reconheça que já conversaram se fizer sentido.]\n\nMensagem do lead: ${conteudo}`
          : conteudo,
      });

      await enviarTexto(phone, resposta);
      await salvarMensagem({
        leadId: lead.id,
        direcao: 'saida',
        origem: 'mila',
        conteudo: resposta,
      });
      console.log(`✅ Lead reaberto e respondido.`);
    } catch (error) {
      console.error('❌ Erro ao reabrir lead:', error.message);
      await gravarLog({
        contexto: 'webhook',
        mensagem: 'Erro ao reabrir lead encerrado',
        telefone: phone,
        leadId: lead.id,
        payload: { erro: error.message },
      });
    }
    return;
  }

  // Janela de silêncio pós-escalação (4 horas)
  if (dentroJanelaSilencio(lead)) {
    console.log(`🤝 Lead ${lead.id} transferido e dentro da janela de silêncio. Mila em silêncio.`);
    await salvarMensagem({
      leadId: lead.id,
      direcao: 'entrada',
      origem: 'lead',
      conteudo,
      tipo,
    });
    return;
  }

  // Se transferido mas fora da janela de silêncio (4h+), verifica se humano ainda está ativo
  if (lead.status === 'transferido') {
    const humanoAtivo = await ultimaMensagemFoiHumana(lead.id);
    if (humanoAtivo) {
      console.log(`🤝 Lead ${lead.id} sendo atendido por humano. Mila em silêncio.`);
      await salvarMensagem({
        leadId: lead.id,
        direcao: 'entrada',
        origem: 'lead',
        conteudo,
        tipo,
      });
      return;
    }
    console.log(`🔄 Lead ${lead.id} transferido há mais de 4h sem resposta humana. Mila retomando.`);
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

  // 1. Fechamento rápido por heurística
  if (querFecharMatricula(conteudo)) {
    console.log('🎯 Lead quer fechar matrícula. Transferindo direto pro humano.');
    await transferirParaHumano({ lead, motivo: 'lead quer fechar matrícula' });
    return;
  }

  // 2. Classifica intenção
  const classificacao = await classificarMensagem(conteudo);

  if (classificacao === 'encerramento') {
    console.log('🛑 Lead pediu pra encerrar. Despedindo.');
    await encerrarLead(lead, 'lead expressou desinteresse');
    return;
  }

  // 3. Busca histórico (últimas 10 mensagens)
  const historicoBruto = await buscarHistorico(lead.id, 10);
  const historicoSemUltima = historicoBruto.slice(0, -1);
  const historicoFormatado = formatarHistorico(historicoSemUltima);

  // 4. Detecta escalação via IA
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
    await gravarLog({
      contexto: 'openai',
      mensagem: 'Erro ao gerar resposta',
      telefone: phone,
      leadId: lead.id,
      payload: { erro: error.message },
    });
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
    await gravarLog({
      contexto: 'zapi',
      mensagem: 'Erro ao enviar resposta pro lead',
      telefone: phone,
      leadId: lead.id,
      payload: { erro: error.message, resposta },
    });
  }
}
