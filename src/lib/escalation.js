import { config } from '../config.js';
import { enviarMensagemGrupo, enviarTexto } from '../services/zapi.js';
import { atualizarStatusLead, buscarHistorico } from '../services/supabase.js';
import { gerarResposta } from '../services/openai.js';

/**
 * Extrai apenas o primeiro nome de um nome completo.
 * "Adriano Cota" → "Adriano"
 */
function primeiroNome(nomeCompleto) {
  if (!nomeCompleto) return '';
  return nomeCompleto.trim().split(' ')[0];
}

/**
 * Mensagem que a Mila envia pro lead avisando que vai transferir pro humano.
 */
const MENSAGEM_DESPEDIDA = (nome) =>
  `Perfeito${nome ? ', ' + primeiroNome(nome) : ''}! Vou te conectar agora com nossa equipe presencial. Eles vão te ajudar com tudo. Em alguns minutos uma de nossas atendentes te chama por aqui mesmo, tá bom?`;

/**
 * Gera resumo inteligente da conversa usando a OpenAI.
 * Extrai: plano de interesse, restrição de horário, intenção principal do lead.
 * Retorna até 3 frases curtas e diretas.
 */
async function gerarResumoConversa(historico, motivo) {
  try {
    const conversaFormatada = historico
      .map((m) => {
        const quem = m.direcao === 'entrada' ? 'Lead' : 'Mila';
        return `${quem}: ${m.conteudo}`;
      })
      .join('\n');

    const prompt = `Você é um assistente que resume conversas de vendas de academia de forma extremamente concisa.

Analise a conversa abaixo e gere um resumo em até 3 frases curtas e diretas, cobrindo:
- Qual plano o lead se interessou (se mencionado)
- Restrição de horário do lead (se mencionada)
- O que o lead quer ou precisa (intenção principal)

REGRAS:
- Máximo 3 frases curtas
- Sem introdução, sem conclusão, sem "o lead disse que"
- Direto ao ponto, como notas para uma atendente
- Em português brasileiro

Conversa:
${conversaFormatada}

Motivo da escalação: ${motivo}

Responda APENAS com o resumo, sem nenhuma outra informação.`;

    const resumo = await gerarResposta({
      systemPrompt: 'Você resume conversas de vendas em frases curtas e diretas.',
      historico: [],
      mensagemNova: prompt,
    });

    return resumo?.trim() || 'Resumo não disponível.';
  } catch (error) {
    console.error('❌ Erro ao gerar resumo da conversa:', error.message);
    // Fallback: últimas 2 mensagens do lead
    const mensagensLead = historico
      .filter((m) => m.direcao === 'entrada')
      .slice(-2)
      .map((m) => m.conteudo)
      .join(' | ');
    return mensagensLead || 'Resumo não disponível.';
  }
}

/**
 * Executa a transferência completa de um lead pro humano.
 */
export async function transferirParaHumano({ lead, motivo }) {
  console.log(`🔥 Transferindo lead ${lead.id} (${lead.telefone}) pro humano. Motivo: ${motivo}`);

  // 1. Despede do lead
  try {
    await enviarTexto(lead.telefone, MENSAGEM_DESPEDIDA(lead.nome));
  } catch (error) {
    console.error('❌ Erro ao enviar mensagem de despedida:', error.message);
  }

  // 2. Atualiza status no banco
  try {
    await atualizarStatusLead(lead.id, 'transferido', `Transferido: ${motivo}`);
  } catch (error) {
    console.error('❌ Erro ao atualizar status do lead:', error.message);
  }

  // 3. Notifica o grupo interno
  if (!config.group.leadsId) {
    console.warn('⚠️ GROUP_LEADS_ID não configurado. Pulando notificação no grupo.');
    return;
  }

  try {
    const historico = await buscarHistorico(lead.id, 20);
    const resumo = await gerarResumoConversa(historico, motivo);

    const mensagemGrupo = `🔥 LEAD QUENTE
Nome: ${primeiroNome(lead.nome) || 'não informado'}
Telefone: ${lead.telefone}
Campanha: ${lead.campanha_origem || 'não informada'}
📋 Resumo: ${resumo}
Motivo: ${motivo}
Status: aguardando contato humano
👉 Continue a conversa no contato dele.`;

    await enviarMensagemGrupo(config.group.leadsId, mensagemGrupo);
    console.log(`✅ Notificação enviada no grupo`);
  } catch (error) {
    console.error('❌ Erro ao notificar grupo:', error.message);
  }
}

/**
 * Marca lead como encerrado.
 */
export async function encerrarLead(lead, motivo = 'lead pediu pra encerrar') {
  console.log(`🛑 Encerrando lead ${lead.id} (${lead.telefone}). Motivo: ${motivo}`);

  try {
    await enviarTexto(
      lead.telefone,
      `Tranquilo${lead.nome ? ', ' + primeiroNome(lead.nome) : ''}! Qualquer coisa no futuro, sabe onde me encontrar. Abraço!`
    );
  } catch (error) {
    console.error('❌ Erro ao enviar despedida de encerramento:', error.message);
  }

  try {
    await atualizarStatusLead(lead.id, 'encerrado', motivo);
  } catch (error) {
    console.error('❌ Erro ao atualizar status:', error.message);
  }
}
