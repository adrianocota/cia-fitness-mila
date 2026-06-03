import { montarMensagem } from './mensagens.js';
import { enviarTexto, enviarImagem } from '../services/zapi.js';
import { gravarLog } from '../services/supabase.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── MAPEAMENTO DE eventType → gatilho ───────────────────────────────────────

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

// ─── EXTRATOR DE LEAD DO PAYLOAD ─────────────────────────────────────────────

function extrairLead(body) {
  const p = body.person ?? {};

  // telefone: usa o campo phone direto, remove não-dígitos exceto o +
  let telefone = (p.phone ?? '').replace(/\D/g, '');
  if (!telefone) return null;

  // garante DDI 55
  if (!telefone.startsWith('55')) telefone = '55' + telefone;

  return {
    telefone,
    nome:  p.nickName || p.firstName || 'você',
    valor: body.membership?.[0]?.nameMembership ?? null,
  };
}

// ─── PROCESSADOR PRINCIPAL ────────────────────────────────────────────────────

export async function processarEvoCRM(body, token) {
  console.log('📋 EVO CRM payload completo:', JSON.stringify(body));

  const gatilho = resolverGatilho(body);

  if (!gatilho) {
    console.log(`⚠️ eventType não mapeado: ${body.eventType} — ignorado`);
    return;
  }

  const lead = extrairLead(body);

  if (!lead) {
    console.log(`⚠️ Telefone não encontrado no payload — gatilho ${gatilho} ignorado`);
    await gravarLog({
      contexto: 'evo-crm',
      mensagem: `Telefone ausente no payload`,
      payload: { gatilho, eventType: body.eventType },
    });
    return;
  }

  const msg = montarMensagem(gatilho, lead);

  if (!msg) {
    console.log(`⚠️ montarMensagem retornou null para gatilho ${gatilho}`);
    return;
  }

  try {
    if (msg.imagem) {
      await enviarImagem(lead.telefone, msg.imagem, '');
      await sleep(1500);
    }
    await enviarTexto(lead.telefone, msg.texto);
    console.log(`✅ [${gatilho}] ${lead.nome} (${lead.telefone})`);
  } catch (e) {
    console.error(`❌ Erro ao enviar [${gatilho}] ${lead.telefone}:`, e.message);
    await gravarLog({
      contexto: 'evo-crm',
      mensagem: `Erro ao enviar gatilho ${gatilho}`,
      telefone: lead.telefone,
      payload: { erro: e.message, gatilho },
    });
  }
}
