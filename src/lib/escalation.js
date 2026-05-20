import { config } from '../config.js';
import { enviarMensagemGrupo, enviarTexto } from '../services/zapi.js';
import { atualizarStatusLead, buscarHistorico } from '../services/supabase.js';
import { gerarResposta } from '../services/openai.js';
import supabase from '../services/supabase.js';

function primeiroNome(nomeCompleto) {
  if (!nomeCompleto) return '';
  return nomeCompleto.trim().split(' ')[0];
}

function horaBrasilia() {
  const agora = new Date();
  const brasilia = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
  return {
    hora: brasilia.getUTCHours(),
    diaSemana: brasilia.getUTCDay(),
  };
}

async function buscarRecepcionistasDeAgora() {
  const { hora, diaSemana } = horaBrasilia();

  const { data, error } = await supabase
    .from('recepcionistas')
    .select('*')
    .eq('ativa', true)
    .lte('hora_inicio', hora)
    .gt('hora_fim', hora)
    .contains('dia_semana', [diaSemana]);

  if (error) {
    console.error('Erro ao buscar recepcionistas:', error.message);
    return [];
  }

  return data || [];
}

async function buscarProximaRecepcionista() {
  const { hora, diaSemana } = horaBrasilia();

  const { data: hoje, error: erroHoje } = await supabase
    .from('recepcionistas')
    .select('*')
    .eq('ativa', true)
    .gt('hora_inicio', hora)
    .contains('dia_semana', [diaSemana])
    .order('hora_inicio', { ascending: true })
    .limit(1);

  if (!erroHoje && hoje && hoje.length > 0) return hoje[0];

  const amanha = (diaSemana + 1) % 7;

  const { data: prox, error: erroProx } = await supabase
    .from('recepcionistas')
    .select('*')
    .eq('ativa', true)
    .contains('dia_semana', [amanha])
    .order('hora_inicio', { ascending: true })
    .limit(1);

  if (!erroProx && prox && prox.length > 0) return prox[0];

  return null;
}

async function selecionarRecepcionista(recepcionistas) {
  if (!recepcionistas || recepcionistas.length === 0) return null;
  if (recepcionistas.length === 1) return recepcionistas[0];

  const ordenadas = [...recepcionistas].sort((a, b) => {
    if (!a.ultima_escalacao_em) return -1;
    if (!b.ultima_escalacao_em) return 1;
    return new Date(a.ultima_escalacao_em) - new Date(b.ultima_escalacao_em);
  });

  return ordenadas[0];
}

async function registrarEscalacao(recepcionistaId) {
  const { error } = await supabase
    .from('recepcionistas')
    .update({ ultima_escalacao_em: new Date().toISOString() })
    .eq('id', recepcionistaId);

  if (error) {
    console.error('Erro ao registrar escalação:', error.message);
  }
}

const MENSAGEM_DESPEDIDA = (nome) =>
  `Perfeito${nome ? ', ' + primeiroNome(nome) : ''}! Vou te conectar agora com nossa equipe presencial. Eles vão te ajudar com tudo. Em alguns minutos uma de nossas atendentes te chama por aqui mesmo, tá bom?`;

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
    console.error('❌ Erro ao gerar resumo:', error.message);
    const mensagensLead = historico
      .filter((m) => m.direcao === 'entrada')
      .slice(-2)
      .map((m) => m.conteudo)
      .join(' | ');
    return mensagensLead || 'Resumo não disponível.';
  }
}

export async function transferirParaHumano({ lead, motivo }) {
  console.log(`🔥 Transferindo lead ${lead.id} (${lead.telefone}). Motivo: ${motivo}`);

  try {
    await enviarTexto(lead.telefone, MENSAGEM_DESPEDIDA(lead.nome));
  } catch (error) {
    console.error('❌ Erro ao enviar despedida:', error.message);
  }

  try {
    await atualizarStatusLead(lead.id, 'transferido', `Transferido: ${motivo}`);
  } catch (error) {
    console.error('❌ Erro ao atualizar status:', error.message);
  }

  if (!config.group.leadsId) {
    console.warn('⚠️ GROUP_LEADS_ID não configurado.');
    return;
  }

  try {
    const historico = await buscarHistorico(lead.id, 20);
    const resumo = await gerarResumoConversa(historico, motivo);

    const recepcionistasAgora = await buscarRecepcionistasDeAgora();
    const selecionada = await selecionarRecepcionista(recepcionistasAgora);

    let cabecalhoRecepcionista = '';
    let linhaPlantao = '';

    if (selecionada) {
      await registrarEscalacao(selecionada.id);
      cabecalhoRecepcionista = `👩 ${selecionada.nome.toUpperCase()} — você é a plantão agora!\n\n`;
      linhaPlantao = `Plantão: ${selecionada.nome}`;
      console.log(`✅ Lead roteado para ${selecionada.nome}`);
    } else {
      const proxima = await buscarProximaRecepcionista();
      if (proxima) {
        const diaNome = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
        const { diaSemana } = horaBrasilia();
        const amanha = (diaSemana + 1) % 7;
        const diaTexto = proxima.dia_semana.includes(diaSemana) ? 'hoje' : diaNome[amanha];
        cabecalhoRecepcionista = `⏰ Fora do horário de atendimento\n\n`;
        linhaPlantao = `Próxima: ${proxima.nome} às ${proxima.hora_inicio}h (${diaTexto})`;
        console.log(`⏰ Fora do horário. Próxima: ${proxima.nome} às ${proxima.hora_inicio}h`);
      } else {
        cabecalhoRecepcionista = `⚠️ Nenhuma recepcionista encontrada\n\n`;
        linhaPlantao = 'Verificar escala manualmente';
        console.warn('⚠️ Nenhuma recepcionista encontrada.');
      }
    }

    const mensagemGrupo = `${cabecalhoRecepcionista}🔥 LEAD QUENTE
Nome: ${primeiroNome(lead.nome) || 'não informado'}
Telefone: ${lead.telefone}
Campanha: ${lead.campanha_origem || 'não informada'}
📋 Resumo: ${resumo}
Motivo: ${motivo}
${linhaPlantao}
👉 Continue a conversa no contato dele.`;

    await enviarMensagemGrupo(config.group.leadsId, mensagemGrupo);
    console.log(`✅ Notificação enviada no grupo`);
  } catch (error) {
    console.error('❌ Erro ao notificar grupo:', error.message);
  }
}

export async function encerrarLead(lead, motivo = 'lead pediu pra encerrar') {
  console.log(`🛑 Encerrando lead ${lead.id}. Motivo: ${motivo}`);

  try {
    await enviarTexto(
      lead.telefone,
      `Tranquilo${lead.nome ? ', ' + primeiroNome(lead.nome) : ''}! Qualquer coisa no futuro, sabe onde me encontrar. Abraço!`
    );
  } catch (error) {
    console.error('❌ Erro ao enviar despedida:', error.message);
  }

  try {
    await atualizarStatusLead(lead.id, 'encerrado', motivo);
  } catch (error) {
    console.error('❌ Erro ao atualizar status:', error.message);
  }
}
