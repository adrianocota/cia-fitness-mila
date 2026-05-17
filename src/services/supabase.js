import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { config } from '../config.js';

// Cria cliente do Supabase com WebSocket explícito (Node 20 compatibility)
const supabase = createClient(config.supabase.url, config.supabase.serviceKey, {
  auth: {
    persistSession: false,
  },
  realtime: {
    transport: ws,
  },
  global: {
    headers: {
      'X-Client-Info': 'cia-fitness-mila',
    },
  },
});

/**
 * Grava um log de erro ou evento no Supabase.
 * Nunca lança exceção — log não pode derrubar o fluxo principal.
 */
export async function gravarLog({ nivel = 'erro', contexto, mensagem, telefone = null, leadId = null, payload = null }) {
  try {
    await supabase.from('error_logs').insert({
      nivel,
      contexto,
      mensagem,
      telefone,
      lead_id: leadId,
      payload,
    });
  } catch (err) {
    // Falha silenciosa — log não pode derrubar o sistema
    console.error('⚠️ Falha ao gravar log:', err.message);
  }
}

/**
 * Verifica se um messageId já foi processado.
 * Retorna true se for duplicado (já existe), false se for novo.
 */
export async function verificarDuplicata(messageId) {
  if (!messageId) return false;

  try {
    const { error } = await supabase
      .from('webhook_ids')
      .insert({ message_id: messageId });

    if (error) {
      if (error.code === '23505') {
        console.log(`⚠️ Webhook duplicado ignorado: ${messageId}`);
        return true;
      }
      console.error('Erro ao verificar duplicata:', error.message);
      return false;
    }

    return false;
  } catch (err) {
    console.error('Erro inesperado no deduplicador:', err.message);
    return false;
  }
}

/**
 * Busca um lead pelo número de telefone.
 */
export async function buscarLeadPorTelefone(telefone) {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('telefone', telefone)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Erro ao buscar lead:', error);
    throw error;
  }

  return data;
}

/**
 * Cria um lead novo.
 */
export async function criarLead({ telefone, nome, campanhaOrigem }) {
  const { data, error } = await supabase
    .from('leads')
    .insert({
      telefone,
      nome: nome || null,
      campanha_origem: campanhaOrigem || null,
      status: 'ativo',
    })
    .select()
    .single();

  if (error) {
    console.error('Erro ao criar lead:', error);
    throw error;
  }

  console.log(`✅ Lead criado: ${nome || 'sem nome'} (${telefone})`);
  return data;
}

/**
 * Busca ou cria um lead.
 */
export async function buscarOuCriarLead({ telefone, nome, campanhaOrigem }) {
  let lead = await buscarLeadPorTelefone(telefone);

  if (!lead) {
    lead = await criarLead({ telefone, nome, campanhaOrigem });
  }

  return lead;
}

/**
 * Reativa um lead encerrado que voltou a falar.
 */
export async function reativarLead(lead) {
  const DIAS_LIMITE = 30;

  const ultimaInteracao = lead.ultima_interacao_em
    ? new Date(lead.ultima_interacao_em)
    : null;

  const diasPassados = ultimaInteracao
    ? (Date.now() - ultimaInteracao.getTime()) / (1000 * 60 * 60 * 24)
    : 999;

  const retomandoContexto = diasPassados < DIAS_LIMITE;

  const { data, error } = await supabase
    .from('leads')
    .update({
      status: 'ativo',
      observacoes: `Reativado após ${Math.floor(diasPassados)} dias. ${retomandoContexto ? 'Contexto retomado.' : 'Conversa reiniciada.'}`,
      ultima_interacao_em: new Date().toISOString(),
    })
    .eq('id', lead.id)
    .select()
    .single();

  if (error) {
    console.error('Erro ao reativar lead:', error);
    throw error;
  }

  console.log(`🔄 Lead ${lead.id} reativado. Dias passados: ${Math.floor(diasPassados)}. Retomando contexto: ${retomandoContexto}`);
  return { lead: data, retomandoContexto, diasPassados: Math.floor(diasPassados) };
}

/**
 * Salva uma mensagem.
 */
export async function salvarMensagem({ leadId, direcao, origem, conteudo, tipo = 'texto' }) {
  const { data, error } = await supabase
    .from('mensagens')
    .insert({
      lead_id: leadId,
      direcao,
      origem,
      conteudo,
      tipo,
    })
    .select()
    .single();

  if (error) {
    console.error('Erro ao salvar mensagem:', error);
    throw error;
  }

  await supabase
    .from('leads')
    .update({ ultima_interacao_em: new Date().toISOString() })
    .eq('id', leadId);

  return data;
}

/**
 * Busca histórico de mensagens.
 */
export async function buscarHistorico(leadId, limite = 20) {
  const { data, error } = await supabase
    .from('mensagens')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: true })
    .limit(limite);

  if (error) {
    console.error('Erro ao buscar histórico:', error);
    throw error;
  }

  return data || [];
}

/**
 * Atualiza status do lead.
 */
export async function atualizarStatusLead(leadId, novoStatus, observacoes = null) {
  const update = { status: novoStatus };
  if (observacoes) update.observacoes = observacoes;

  const { data, error } = await supabase
    .from('leads')
    .update(update)
    .eq('id', leadId)
    .select()
    .single();

  if (error) {
    console.error('Erro ao atualizar status:', error);
    throw error;
  }

  console.log(`✅ Lead ${leadId} atualizado para status: ${novoStatus}`);
  return data;
}

/**
 * Busca leads pra follow-up.
 */
export async function buscarLeadsParaFollowup(dia) {
  const horasAtras = { 1: 24, 3: 72, 7: 168, 14: 336 }[dia];
  if (!horasAtras) throw new Error(`Dia inválido: ${dia}`);

  const limiteData = new Date(Date.now() - horasAtras * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('leads')
    .select(`*, followups (dia)`)
    .eq('status', 'ativo')
    .lt('ultima_interacao_em', limiteData);

  if (error) {
    console.error('Erro ao buscar leads para follow-up:', error);
    throw error;
  }

  const leadsParaProcessar = (data || []).filter((lead) => {
    const followupsRecebidos = (lead.followups || []).map((f) => f.dia);
    return !followupsRecebidos.includes(dia);
  });

  return leadsParaProcessar;
}

/**
 * Registra follow-up disparado.
 */
export async function registrarFollowup(leadId, dia, status = 'enviado') {
  const { data, error } = await supabase
    .from('followups')
    .insert({
      lead_id: leadId,
      dia,
      status,
    })
    .select()
    .single();

  if (error) {
    console.error('Erro ao registrar follow-up:', error);
    throw error;
  }

  console.log(`✅ Follow-up dia ${dia} registrado pro lead ${leadId}`);
  return data;
}

/**
 * Verifica se última mensagem foi de humano.
 */
export async function ultimaMensagemFoiHumana(leadId) {
  const { data } = await supabase
    .from('mensagens')
    .select('origem, direcao')
    .eq('lead_id', leadId)
    .eq('direcao', 'saida')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  return data?.origem === 'humano';
}

export default supabase;
