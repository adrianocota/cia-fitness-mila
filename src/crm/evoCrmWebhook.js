import { montarMensagem } from './mensagens.js';
import { enviarTexto, enviarImagem } from '../services/zapi.js';
import { gravarLog, buscarOuCriarLead } from '../services/supabase.js';
import supabase from '../services/supabase.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function resolverGatilho(body) {
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
  const ctx = body.eventContext ?? {};
  let telefone = (p.phone ?? '').replace(/\D/g, '');
  if (!telefone) return null;
  if (!telefone.startsWith('55')) telefone = '55' + telefone;
  return {
    telefone,
    nome:       p.nickName || p.firstName || 'você',
    instrutor:  null,
    valor:      null,
    vencimento: ctx.moment === 'before'
      ? new Date(Date.now() + 16 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      : null,
  };
}

export async function processarEvoCRM(body, token) {
  console.log('📋 EVO CRM payload completo:', JSON.stringify(body));

  const gatilho = resolverGatilho(body);
  if (!gatilho) {
    console.log(`⚠️ eventType não mapeado: ${body.eventType} — ignorado`);
    return;
  }

  const leadDados = extrairLead(body);
  if (!leadDados) {
    console.log(`⚠️ Telefone ausente — gatilho ${gatilho} ignorado`);
    await gravarLog({
      contexto: 'evo-crm',
      mensagem: 'Telefone ausente no payload',
      payload: { gatilho, eventType: body.eventType },
    });
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
  } catch (e) {
    console.error(`❌ Erro ao enviar [${gatilho}] ${leadDados.telefone}:`, e.message);
    await gravarLog({
      contexto: 'evo-crm',
      mensagem: `Erro ao enviar gatilho ${gatilho}`,
      telefone: leadDados.telefone,
      payload: { erro: e.message, gatilho },
    });
    return;
  }

  // Registra o lead no Supabase com status 'crm' para silenciar respostas
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
