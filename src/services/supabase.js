import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import crypto from 'crypto';
import { config } from '../config.js';

const supabase = createClient(config.supabase.url, config.supabase.serviceKey, {
  auth: { persistSession: false },
  realtime: { transport: ws },
  global: { headers: { 'X-Client-Info': 'cia-fitness-mila' } },
});

export async function gravarLog({ nivel = 'erro', contexto, mensagem, telefone = null, leadId = null, payload = null }) {
  try {
    await supabase.from('error_logs').insert({ nivel, contexto, mensagem, telefone, lead_id: leadId, payload });
  } catch (err) {
    console.error('⚠️ Falha ao gravar log:', err.message);
  }
}

export async function verificarDuplicata(messageId) {
  if (!messageId) return false;
  try {
    const { error } = await supabase.from('webhook_ids').insert({ message_id: messageId });
    if (error) {
      if (error.code === '23505') {
        console.log(`⚠️ Webhook duplicado por messageId ignorado: ${messageId}`);
        return true;
      }
      console.error('Erro ao verificar duplicata por messageId:', error.message);
      return false;
    }
    return false;
  } catch (err) {
    console.error('Erro inesperado no deduplicador por messageId:', err.message);
    return false;
  }
}

const JANELA_DEDUP_SEGUNDOS = 10;

export async function verificarDuplicataConteudo(telefone, conteudo) {
  if (!telefone || !conteudo) return false;
  try {
    const hash = crypto.createHash('sha256').update(`${telefone}|${conteudo.trim().toLowerCase()}`).digest('hex');
    const limiteData = new Date(Date.now() - JANELA_DEDUP_SEGUNDOS * 1000).toISOString();
    const { data: existente, error: erroBusca } = await supabase
      .from('mensagens_recentes').select('id').eq('telefone', telefone).eq('hash_conteudo', hash)
      .gte('created_at', limiteData).limit(1).maybeSingle();
    if (erroBusca) { console.error('Erro ao buscar duplicata por conteúdo:', erroBusca.message); return false; }
    if (existente) {
      console.log(`⚠️ Mensagem duplicada por conteúdo ignorada (${telefone}): "${conteudo.substring(0, 40)}..."`);
      return true;
    }
    const { error: erroInsert } = await supabase.from('mensagens_recentes').insert({ telefone, hash_conteudo: hash });
    if (erroInsert) console.error('Erro ao registrar mensagem recente:', erroInsert.message);
    return false;
  } catch (err) {
    console.error('Erro inesperado no deduplicador por conteúdo:', err.message);
    return false;
  }
}

// ─── VERIFICAÇÃO COLABORADORES EVO ───────────────────────────────────────────

const EVO_EMPLOYEES_URL = 'https://evo-integracao-api.w12app.com.br/api/v1/employees';
const EVO_AUTH = 'Basic Y2lhZml0bmVzczo1OUVBNUZDRi01NjIyLTQ4M0EtQjcyMC0yQzE4MEE1Nzg4N0E=';

let _cacheColaboradores = null;
let _cacheTimestamp = 0;
const CACHE_TTL_MS = 30 * 60 * 1000;
let _cacheLiberados = null;
let _cacheLiberadosTimestamp = 0;

async function buscarTelefonesColaboradores() {
  if (_cacheColaboradores && Date.now() - _cacheTimestamp < CACHE_TTL_MS) return _cacheColaboradores;
  try {
    const res = await fetch(`${EVO_EMPLOYEES_URL}?status=Ativo&take=100`, { headers: { Authorization: EVO_AUTH } });
    if (!res.ok) throw new Error(`EVO employees status ${res.status}`);
    const lista = await res.json();
    _cacheColaboradores = lista.map(e => (e.telephone || '').replace(/\D/g, '')).filter(t => t.length >= 8);
    _cacheTimestamp = Date.now();
    console.log(`📋 Cache colaboradores EVO atualizado: ${_cacheColaboradores.length} registros`);
    return _cacheColaboradores;
  } catch (err) {
    console.warn('⚠️ Falha ao buscar colaboradores EVO (usando cache):', err.message);
    return _cacheColaboradores || [];
  }
}

async function buscarTelefonesLiberados() {
  if (_cacheLiberados && Date.now() - _cacheLiberadosTimestamp < CACHE_TTL_MS) return _cacheLiberados;
  try {
    const { data, error } = await supabase.from('recepcionistas').select('telefone').eq('pode_testar_mila', true);
    if (error) throw new Error(error.message);
    _cacheLiberados = (data || []).map(r => (r.telefone || '').replace(/\D/g, '')).filter(t => t.length >= 8);
    _cacheLiberadosTimestamp = Date.now();
    console.log(`✅ Cache liberados Mila atualizado: ${_cacheLiberados.length} registros`);
    return _cacheLiberados;
  } catch (err) {
    console.warn('⚠️ Falha ao buscar liberados Mila (usando cache):', err.message);
    return _cacheLiberados || [];
  }
}

export async function eColaboradorEvo(telefone) {
  const numLimpo = telefone.replace(/\D/g, '');
  const liberados = await buscarTelefonesLiberados();
  const estaLiberado = liberados.some(t => numLimpo.endsWith(t) || t.endsWith(numLimpo));
  if (estaLiberado) { console.log(`🟢 Telefone ${telefone} é colaborador liberado para testar Mila`); return false; }
  const colaboradores = await buscarTelefonesColaboradores();
  return colaboradores.some(t => numLimpo.endsWith(t) || t.endsWith(numLimpo));
}

// ─────────────────────────────────────────────────────────────────────────────

export async function buscarLeadPorTelefone(telefone) {
  const { data, error } = await supabase.from('leads').select('*').eq('telefone', telefone).single();
  if (error && error.code !== 'PGRST116') { console.error('Erro ao buscar lead:', error); throw error; }
  return data;
}

export async function criarLead({ telefone, nome, campanhaOrigem }) {
  const { data, error } = await supabase.from('leads').insert({
    telefone, nome: nome || null, campanha_origem: campanhaOrigem || null, status: 'ativo',
  }).select().single();
  if (error) { console.error('Erro ao criar lead:', error); throw error; }
  console.log(`✅ Lead criado: ${nome || 'sem nome'} (${telefone})`);
  return data;
}

export async function buscarOuCriarLead({ telefone, nome, campanhaOrigem }) {
  const isColaborador = await eColaboradorEvo(telefone);
  if (isColaborador) { console.log(`🔕 Telefone ${telefone} identificado como colaborador EVO — ignorado`); return null; }
  let lead = await buscarLeadPorTelefone(telefone);
  if (!lead) lead = await criarLead({ telefone, nome, campanhaOrigem });
  return lead;
}

export async function reativarLead(lead) {
  const DIAS_LIMITE = 30;
  const ultimaInteracao = lead.ultima_interacao_em ? new Date(lead.ultima_interacao_em) : null;
  const diasPassados = ultimaInteracao ? (Date.now() - ultimaInteracao.getTime()) / (1000 * 60 * 60 * 24) : 999;
  const retomandoContexto = diasPassados < DIAS_LIMITE;
  const { data, error } = await supabase.from('leads').update({
    status: 'ativo',
    observacoes: `Reativado após ${Math.floor(diasPassados)} dias. ${retomandoContexto ? 'Contexto retomado.' : 'Conversa reiniciada.'}`,
    ultima_interacao_em: new Date().toISOString(),
  }).eq('id', lead.id).select().single();
  if (error) { console.error('Erro ao reativar lead:', error); throw error; }
  console.log(`🔄 Lead ${lead.id} reativado. Dias passados: ${Math.floor(diasPassados)}. Retomando contexto: ${retomandoContexto}`);
  return { lead: data, retomandoContexto, diasPassados: Math.floor(diasPassados) };
}

export async function salvarMensagem({ leadId, direcao, origem, conteudo, tipo = 'texto' }) {
  const { data, error } = await supabase.from('mensagens').insert({
    lead_id: leadId, direcao, origem, conteudo, tipo,
  }).select().single();
  if (error) { console.error('Erro ao salvar mensagem:', error); throw error; }
  await supabase.from('leads').update({ ultima_interacao_em: new Date().toISOString() }).eq('id', leadId);
  return data;
}

export async function buscarHistorico(leadId, limite = 20) {
  const { data, error } = await supabase.from('mensagens').select('*').eq('lead_id', leadId)
    .order('created_at', { ascending: true }).limit(limite);
  if (error) { console.error('Erro ao buscar histórico:', error); throw error; }
  return data || [];
}

export async function atualizarStatusLead(leadId, novoStatus, observacoes = null) {
  const update = { status: novoStatus };
  if (observacoes) update.observacoes = observacoes;
  const { data, error } = await supabase.from('leads').update(update).eq('id', leadId).select().single();
  if (error) { console.error('Erro ao atualizar status:', error); throw error; }
  console.log(`✅ Lead ${leadId} atualizado para status: ${novoStatus}`);
  return data;
}

/**
 * Busca leads pra follow-up.
 * Filtra followups cancelados para que leads reativados possam receber follow-up novamente.
 */
export async function buscarLeadsParaFollowup(dia) {
  const horasAtras = { 1: 24, 3: 72, 7: 168, 14: 336 }[dia];
  if (!horasAtras) throw new Error(`Dia inválido: ${dia}`);

  const limiteData = new Date(Date.now() - horasAtras * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('leads')
    .select(`*, followups (dia, cancelado)`)
    .eq('status', 'ativo')
    .lt('ultima_interacao_em', limiteData);

  if (error) { console.error('Erro ao buscar leads para follow-up:', error); throw error; }

  const leadsParaProcessar = (data || []).filter((lead) => {
    const followupsRecebidos = (lead.followups || [])
      .filter(f => !f.cancelado)
      .map(f => f.dia);
    return !followupsRecebidos.includes(dia);
  });

  return leadsParaProcessar;
}

export async function registrarFollowup(leadId, dia, status = 'enviado') {
  const { data, error } = await supabase.from('followups').insert({ lead_id: leadId, dia, status }).select().single();
  if (error) { console.error('Erro ao registrar follow-up:', error); throw error; }
  console.log(`✅ Follow-up dia ${dia} registrado pro lead ${leadId}`);
  return data;
}

export async function ultimaMensagemFoiHumana(leadId) {
  const { data } = await supabase.from('mensagens').select('origem, direcao')
    .eq('lead_id', leadId).eq('direcao', 'saida').order('created_at', { ascending: false }).limit(1).single();
  return data?.origem === 'humano';
}

export default supabase;
