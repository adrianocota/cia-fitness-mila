import { montarMensagem } from './mensagens.js';
import { enviarTexto, enviarImagem } from '../services/zapi.js';
import { gravarLog, buscarOuCriarLead } from '../services/supabase.js';
import supabase from '../services/supabase.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Mapeamento por eventLabel (enviado pelo EVO — eventType é genérico "regra_N")
const LABEL_PARA_GATILHO = {
  // Aniversário
  'mila - aniversário cliente ativo': 'aniversario',
  'mila - aniversario cliente ativo': 'aniversario',

  // Cobrança recusada
  'mila - cobrança recusada': 'cobranca_recusada',
  'mila - cobranca recusada': 'cobranca_recusada',

  // Ausência
  'mila - 9 dias sem presença': '9_dias_sem_presenca',
  'mila - 9 dias sem presenca': '9_dias_sem_presenca',
  'mila - 18 dias sem presença': '18_dias_sem_presenca',
  'mila - 18 dias sem presenca': '18_dias_sem_presenca',

  // Matrícula
  'mila - boas-vindas': '1_dia_apos_matricula',
  'mila - 1 mês de academia': '30_dias_apos_matricula',
  'mila - 1 mes de academia': '30_dias_apos_matricula',

  // Vencimento
  'mila - aviso de vencimento': '16_dias_antes_vencimento',
  'mila - plano vencido': '5_dias_apos_vencimento',
  'mila - reconexão': '30_dias_apos_vencimento',
  'mila - reconexao': '30_dias_apos_vencimento',

  // Cobrança recusada com dias
  'mila - cobrança recusada 3 dias': 'cobranca_recusada_3d',
  'mila - cobranca recusada 3 dias': 'cobranca_recusada_3d',
  'mila - cobrança recusada 7 dias': 'cobranca_recusada_7d',
  'mila - cobranca recusada 7 dias': 'cobranca_recusada_7d',

  // Prospect
  'mila - pós-visita': 'pos_visita',
  'mila - pos-visita': 'pos_visita',
  'mila - 7 dias após oportunidade': '7_dias_apos_oportunidade',
  'mila - 7 dias apos oportunidade': '7_dias_apos_oportunidade',
};

function resolverGatilho(body) {
  const label = (body.eventLabel ?? '').toLowerCase().trim();

  // Tenta por label primeiro (confiável)
  if (LABEL_PARA_GATILHO[label]) {
    return LABEL_PARA_GATILHO[label];
  }

  // Fallback: tenta por eventType semântico (caso alguma automação use o padrão correto)
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
    default:
      return null;
  }
}

function extrairLead(body) {
  const p = body.person ?? {};
  let telefone = (p.phone ?? '').replace(/\D/g, '');
  if (!telefone) return null;
  if (!telefone.startsWith('55')) telefone = '55' + telefone;

  // Usa contractSigning como link de pagamento personalizado se disponível
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
      data: hoje,
      telefone,
      gatilho,
      nome,
      status,
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

export async function processarEvoCRM(body, token) {
  console.log('📋 EVO CRM payload completo:', JSON.stringify(body));

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

  // Deduplicação: não disparar duas vezes no mesmo dia para o mesmo gatilho
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

  // Marca lead como crm no Supabase para silenciar respostas da Mila
  try {
    const lead = await buscarOuCriarLead({ telefone: leadDados.telefone, nome: leadDados.nome });
    await supabase.from('leads').update({
      status: 'crm',
      ultima_interacao_em: new Date().toISOString(),
    }).eq('id', lead.id);
    console.log(`📌 Lead ${lead.id} marcado como crm`);
  } catch (e) {
    console.error(`❌ Erro ao marcar lead como crm:`, e.message);
  }
}
