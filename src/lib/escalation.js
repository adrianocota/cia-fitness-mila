import { config } from '../config.js';
import { enviarMensagemGrupo, enviarTexto } from '../services/zapi.js';
import { atualizarStatusLead, buscarHistorico } from '../services/supabase.js';

/**
 * Mensagem que a Mila envia pro lead avisando que vai transferir pro humano.
 */
const MENSAGEM_DESPEDIDA = (nome) =>
  `Perfeito${nome ? ', ' + nome : ''}! Vou te conectar agora com nossa equipe presencial. Eles vão te dar todos os detalhes e finalizar isso pra você. Em alguns minutos uma de nossas atendentes te chama por aqui mesmo, tá bom?`;

/**
 * Gera o resumo da conversa pra mandar no grupo interno.
 * Pega as últimas N mensagens e formata pra leitura rápida.
 */
function formatarResumoConversa(mensagens) {
  const ultimas = mensagens.slice(-6); // Últimas 6 trocas
  return ultimas
    .map((m) => {
      const quem = m.direcao === 'entrada' ? 'Lead' : 'Mila';
      const conteudo = m.conteudo.length > 200 ? m.conteudo.slice(0, 200) + '...' : m.conteudo;
      return `${quem}: ${conteudo}`;
    })
    .join('\n');
}

/**
 * Executa a transferência completa de um lead pro humano.
 *
 * 1. Manda mensagem de despedida pro lead
 * 2. Atualiza status do lead pra 'transferido' no banco
 * 3. Envia notificação detalhada no grupo "Leads Cia Fitness"
 *
 * @param {Object} params
 * @param {Object} params.lead - Lead completo do banco
 * @param {string} params.motivo - Por que tá escalando (vem do detectarEscalacao)
 */
export async function transferirParaHumano({ lead, motivo }) {
  console.log(`🔥 Transferindo lead ${lead.id} (${lead.telefone}) pro humano. Motivo: ${motivo}`);

  // 1. Despede do lead
  try {
    await enviarTexto(lead.telefone, MENSAGEM_DESPEDIDA(lead.nome));
  } catch (error) {
    console.error('❌ Erro ao enviar mensagem de despedida:', error.message);
    // Continua o fluxo mesmo se falhar, o importante é avisar o time
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
    const historico = await buscarHistorico(lead.id, 10);
    const resumo = formatarResumoConversa(historico);

    const mensagemGrupo = `🔥 LEAD QUENTE

Nome: ${lead.nome || 'não informado'}
Telefone: ${lead.telefone}
Campanha: ${lead.campanha_origem || 'não informada'}
Motivo da transferência: ${motivo}

Últimas mensagens:
${resumo}

Status: aguardando contato humano
👉 Continue a conversa no contato dele.`;

    await enviarMensagemGrupo(config.group.leadsId, mensagemGrupo);
    console.log(`✅ Notificação enviada no grupo`);
  } catch (error) {
    console.error('❌ Erro ao notificar grupo:', error.message);
  }
}

/**
 * Marca lead como encerrado (lead disse que não quer mais).
 * Não notifica grupo nem manda despedida elaborada.
 */
export async function encerrarLead(lead, motivo = 'lead pediu pra encerrar') {
  console.log(`🛑 Encerrando lead ${lead.id} (${lead.telefone}). Motivo: ${motivo}`);

  try {
    await enviarTexto(
      lead.telefone,
      `Tranquilo${lead.nome ? ', ' + lead.nome : ''}! Qualquer coisa no futuro, sabe onde me encontrar. Abraço!`
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
