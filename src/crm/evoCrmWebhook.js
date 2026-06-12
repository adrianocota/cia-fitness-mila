import { montarMensagem } from './mensagens.js';
import { enviarTexto, enviarImagem } from '../services/zapi.js';
import { gravarLog, buscarOuCriarLead } from '../services/supabase.js';
import supabase from '../services/supabase.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── FILA DE DISPAROS ─────────────────────────────────────────────────────────
// Processa um disparo por vez com intervalo de 45s entre cada um.
// Evita banimento por disparo em massa simultâneo.

const INTERVALO_ENTRE_DISPAROS_MS = 45000; // 45 segundos
let filaProcessando = false;
const fila = [];

async function processarFila() {
  if (filaProcessando) return;
  filaProcessando = true;
  console.log(`📬 Fila CRM iniciada — ${fila.length} item(s) pendente(s)`);
  while (fila.length > 0) {
    const item = fila.shift();
    try {
      await executarDisparo(item);
    } catch (e) {
      console.error(`❌ Erro ao processar fila CRM:`, e.message);
    }
    if (fila.length > 0) {
      console.log(`⏳ Aguardando ${INTERVALO_ENTRE_DISPAROS_MS / 1000}s antes do próximo disparo CRM... (${fila.length} restante(s))`);
      await sleep(INTERVALO_ENTRE_DISPAROS_MS);
    }
  }
  filaProcessando = false;
  console.log(`✅ Fila CRM finalizada`);
}

// ─── MAPEAMENTO DE LABELS ─────────────────────────────────────────────────────

const LABEL_PARA_GATILHO = {
  // Aniversário
  'mila - aniversário cliente ativo': 'aniversario',
  'mila - aniversario cliente ativo': 'aniversario',

  // Presença
  'mila - 9 dias sem presença': '9_dias_sem_presenca',
  'mila - 9 dias sem presenca': '9_dias_sem_presenca',
  'mila - 18 dias sem presença': '18_dias_sem_presenca',
  'mila - 18 dias sem presenca': '18_dias_sem_presenca',

  // Matrícula
  'mila - 1 dia após matrícula': '1_dia_apos_matricula',
  'mila - 1 dia apos matricula': '1_dia_apos_matricula',
  'mila - 30 dias após matrícula': '30_dias_apos_matricula',
  'mila - 30 dias apos matricula': '30_dias_apos_matricula',

  // Vencimento
  'mila - 16 dias antes do vencimento': '16_dias_antes_vencimento',
  'mila - 16 dias antes vencimento': '16_dias_antes_vencimento',
  'mila - 5 dias após vencimento': '5_dias_apos_vencimento',
  'mila - 5 dias apos vencimento': '5_dias_apos_vencimento',
  'mila - 30 dias após vencimento': '30_dias_apos_vencimento',
  'mila - 30 dias apos vencimento': '30_dias_apos_vencimento',

  // Reativação
  'mila - reativação ex-aluno 30 dias': '30_dias_apos_vencimento',
  'mila - reativacao ex-aluno 30 dias': '30_dias_apos_vencimento',

  // Cobrança recusada
  'mila - cobrança recusada': 'cobranca_recusada',
  'mila - cobranca recusada': 'cobranca_recusada',
  'mila - cobrança recusada - 3 dias': 'cobranca_recusada_3d',
  'mila - cobranca recusada - 3 dias': 'cobranca_recusada_3d',
  'mila - cobrança recusada - 7 dias': 'cobranca_recusada_7d',
  'mila - cobranca recusada - 7 dias': 'cobranca_recusada_7d',

  // Prospect
  'mila - pós-visita oportunidade - 1 dia': 'pos_visita',
  'mila - pos-visita oportunidade - 1 dia': 'pos_visita',
  'mila - 7 dias após cadastro de oportunidade': '7_dias_apos_oportunidade',
  'mila - 7 dias apos cadastro de oportunidade': '7_dias_apos_oportunidade',
};

function resolverGatilho(body) {
  const label = (body.eventLabel ?? '').toLowerCase().trim();

  if (LABEL_PARA_GATILHO[label]) {
    return LABEL_PARA_GATILHO[label];
  }

  const { eventType, eventContext } = body;
  const days = eventContext?.daysOffset ?? 0;
  const moment = eventContext?.moment ?? '';

  switch (eventType) {
    case 'crm.automation.no_attendance':
      return days <= 12 ? '9_dias_sem_presenca' : '18_dias_sem_presenca';
    case 'crm.automation.member_birthday':
      return 'aniversario';
    case 'crm.automation.enrollment':
      return days <= 3 ? '1_dia_apos_matricula' : '30_dias_apos_matricula';
    case 'crm.automation.contract_due_date':
      if (moment === 'before') return '16_dias_antes_vencimento';
      if (days <= 7)           return '5_dias_apos_vencimento';
      return '30_dias_apos_vencimento';
    case 'crm.automation.recurring_debit_charge_declined':
      if (days >= 6)  return 'cobranca_recusada_7d';
      if (days >= 2)  return 'cobranca_recusada_3d';
      return 'cobranca_recusada';
    case 'crm.automation.prospect_registration':
      return days <= 2 ? 'pos_visita' : '7_dias_apos_oportunidade';
    case 'crm.automation.contract_cancellation':
      return '30_dias_apos_vencimento';
    default:
      return null;
  }
}

function extrairLead(body) {
  const p = body.person ?? {};
  let telefone = (p.phone ?? '').replace(/\D/g, '');
  if (!telefone) return null;
  if (!telefone.startsWith('55')) telefone = '55' + telefone;

  const linkPagamento = body.links?.contractSigning || body.links?.checkout || null;

  return {
    telefone,
    nome: p.nickName || p.firstName || 'você',
    linkPagamento,
    vencimento: body.eventContext?.moment === 'before'
      ? new Date(Date.now() + 16 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      : null,
  };
}

async function registrarDisparoCRM(telefone, nome, gatilho, status = 'enviado') {
  try {
    const hoje = new Date().toISOString().split('T')[0];
    await supabase.from('crm_disparos').insert({
      data: hoje, telefone, gatilho, nome, status,
    });
  } catch (e) {
    console.warn('⚠️ Erro ao registrar disparo CRM:', e.message);
  }
}

async function jaDisparado(telefone, gatilho) {
  try {
    const hoje = new Date().toISOString().split('T')[0];
    const { data } = await supabase
      .from('crm_disparos')
      .select('id')
      .eq('data', hoje)
      .eq('telefone', telefone)
      .eq('gatilho', gatilho)
      .limit(1);
    return data && data.length > 0;
  } catch (e) {
    console.warn('⚠️ Erro ao verificar deduplicação CRM:', e.message);
    return false;
  }
}

// ─── EXECUÇÃO DO DISPARO ──────────────────────────────────────────────────────

async function executarDisparo({ gatilho, leadDados }) {
  const duplicado = await jaDisparado(leadDados.telefone, gatilho);
  if (duplicado) {
    console.log(`⏭️ [${gatilho}] ${leadDados.telefone} já disparado hoje — ignorado`);
    return;
  }

  const msg = montarMensagem(gatilho, leadDados);
  if (!msg) {
    console.log(`⚠️ montarMensagem retornou null para gatilho ${gatilho}`);
    return;
  }

  try {
    if (msg.imagem) {
      await enviarImagem(leadDados.telefone, msg.imagem, '');
      await sleep(1500);
    }
    await enviarTexto(leadDados.telefone, msg.texto);
    console.log(`✅ [${gatilho}] ${leadDados.nome} (${leadDados.telefone})`);
    await registrarDisparoCRM(leadDados.telefone, leadDados.nome, gatilho, 'enviado');
  } catch (e) {
    console.error(`❌ Erro ao enviar [${gatilho}] ${leadDados.telefone}:`, e.message);
    await registrarDisparoCRM(leadDados.telefone, leadDados.nome, gatilho, 'erro');
    await gravarLog({
      contexto: 'evo-crm',
      mensagem: `Erro ao enviar gatilho ${gatilho}`,
      telefone: leadDados.telefone,
      payload: { erro: e.message, gatilho },
    });
    return;
  }

  try {
    const lead = await buscarOuCriarLead({ telefone: leadDados.telefone, nome: leadDados.nome });
    if (lead) {
      await supabase.from('leads').update({
        status: 'crm',
        ultima_interacao_em: new Date().toISOString(),
      }).eq('id', lead.id);
      console.log(`📌 Lead ${lead.id} marcado como crm`);
    }
  } catch (e) {
    console.error(`❌ Erro ao marcar lead como crm:`, e.message);
  }
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

export async function processarEvoCRM(body, token) {
  console.log('📋 EVO CRM recebido:', JSON.stringify(body).slice(0, 300));

  const gatilho = resolverGatilho(body);
  if (!gatilho) {
    console.log(`⚠️ eventType não mapeado: ${body.eventType} / label: "${body.eventLabel}" — ignorado`);
    return;
  }

  const leadDados = extrairLead(body);
  if (!leadDados) {
    console.log(`⚠️ Telefone ausente — gatilho ${gatilho} ignorado`);
    await gravarLog({
      contexto: 'evo-crm',
      mensagem: 'Telefone ausente no payload',
      payload: { gatilho, eventType: body.eventType, eventLabel: body.eventLabel },
    });
    return;
  }

  // Adiciona na fila em vez de processar imediatamente
  fila.push({ gatilho, leadDados });
  console.log(`📥 [${gatilho}] ${leadDados.nome} adicionado à fila (posição ${fila.length})`);

  // Inicia processamento da fila se não estiver rodando
  processarFila();
}
