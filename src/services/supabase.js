import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

// Cria cliente do Supabase usando a Service Key (acesso admin)
const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

/**
 * Busca um lead pelo número de telefone.
 * Retorna o lead ou null se não existir.
 */
export async function buscarLeadPorTelefone(telefone) {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('telefone', telefone)
    .single();

  if (error && error.code !== 'PGRST116') {
    // PGRST116 = "nenhuma linha encontrada", não é erro real
    console.error('Erro ao buscar lead:', error);
    throw error;
  }

  return data;
}

/**
 * Cria um lead novo no banco.
 * Retorna o lead criado.
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
 * Se não existir, cria. Se existir, retorna o existente.
 */
export async function buscarOuCriarLead({ telefone, nome, campanhaOrigem }) {
  let lead = await buscarLeadPorTelefone(telefone);

  if (!lead) {
    lead = await criarLead({ telefone, nome, campanhaOrigem });
  }

  return lead;
}

/**
 * Salva uma mensagem no histórico.
 */
export async function salvarMensagem({ leadId, direcao, origem, conteudo, tipo = 'texto' }) {
  const { data, error } = await supabase
    .from('mensagens')
    .insert({
      lead_id: leadId,
      direcao, // 'entrada' ou 'saida'
      origem, // 'mila', 'humano', 'lead'
      conteudo,
      tipo,
    })
    .select()
    .single();

  if (error) {
    console.error('Erro ao salvar mensagem:', error);
    throw error;
  }

  // Atualiza ultima_interacao_em do lead
  await supabase
    .from('leads')
    .update({ ultima_interacao_em: new Date().toISOString() })
    .eq('id', leadId);

  return data;
}

/**
 * Busca o histórico de mensagens de um lead (últimas N).
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
 * Atualiza o status de um lead (ativo, transferido, encerrado, matriculado).
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
 * Busca leads que precisam de follow-up no dia específico.
 * Retorna lista de leads + qual mensagem disparar.
 */
export async function buscarLeadsParaFollowup(dia) {
  const horasAtras = { 1: 24, 3: 72, 7: 168, 14: 336 }[dia];
  if (!horasAtras) throw new Error(`Dia inválido: ${dia}`);

  const limiteData = new Date(Date.now() - horasAtras * 60 * 60 * 1000).toISOString();

  // Busca leads:
  // - Status 'ativo' (não transferido nem encerrado)
  // - Última interação há exatamente N horas
  // - Que ainda não receberam follow-up do dia X
  const { data, error } = await supabase
    .from('leads')
    .select(`
      *,
      followups (dia)
    `)
    .eq('status', 'ativo')
    .lt('ultima_interacao_em', limiteData);

  if (error) {
    console.error('Erro ao buscar leads para follow-up:', error);
    throw error;
  }

  // Filtra leads que ainda não receberam o follow-up do dia X
  const leadsParaProcessar = (data || []).filter((lead) => {
    const followupsRecebidos = (lead.followups || []).map((f) => f.dia);
    return !followupsRecebidos.includes(dia);
  });

  return leadsParaProcessar;
}

/**
 * Registra que um follow-up foi disparado.
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
 * Verifica se a última mensagem foi enviada manualmente (humano operando).
 * Se sim, a Mila fica em silêncio.
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
