import { enviarImagem, enviarTexto } from './zapiService.js';
import { gravarLog } from './supabaseService.js';

const BASE_IMG = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/';

// ─────────────────────────────────────────────
// MAPEAMENTO: eventType do EVO → chave interna
// ─────────────────────────────────────────────
const GATILHOS = {
  // Ausência
  'crm.automation.absence_9_days':          'ausencia_9d',
  'crm.automation.absence_18_days':         'ausencia_18d',

  // Cobrança recusada
  'crm.automation.charge_refused':          'cobranca_recusada',
  'crm.automation.charge_refused_3_days':   'cobranca_recusada_3d',
  'crm.automation.charge_refused_7_days':   'cobranca_recusada_7d',

  // Vencimento
  'crm.automation.contract_due_date_16':    'vencimento_16d_antes',
  'crm.automation.contract_due_date_5':     'vencimento_5d_depois',
  'crm.automation.contract_due_date_30':    'vencimento_30d_depois',

  // Matrícula
  'crm.automation.enrollment_1_day':        'matricula_1d',
  'crm.automation.enrollment_30_days':      'matricula_30d',

  // Aniversário
  'crm.automation.birthday':                'aniversario',

  // Oportunidade
  'crm.automation.opportunity_visit_1_day': 'pos_visita',
  'crm.automation.opportunity_7_days':      'oportunidade_7d',

  // Reativação
  'crm.automation.reactivation':            'reativacao',
};

// ─────────────────────────────────────────────
// MENSAGENS
// ─────────────────────────────────────────────
const MENSAGENS = {
  ausencia_9d:
    'Oi {nome}! Sentimos sua falta por aqui. Tá tudo bem? O treino te espera quando você quiser voltar 💪',

  ausencia_18d:
    '{nome}, faz quase 3 semanas que você não aparece na Cia. A gente sente de verdade. Tem algo que esteja te impedindo? Pode contar com a gente.',

  cobranca_recusada:
    'Oi {nome}! Notamos que a cobrança da sua mensalidade não foi processada. Pode ser algo simples como limite ou dados desatualizados. Clica aqui para regularizar 👉 https://evo-totem.w12app.com.br/CIAFITNESS/1/site/checkout/',

  cobranca_recusada_3d:
    '{nome}, sua mensalidade ainda está em aberto. Para não perder seu acesso, regularize pelo link abaixo. Qualquer dúvida é só chamar! 👉 https://evo-totem.w12app.com.br/CIAFITNESS/1/site/checkout/',

  cobranca_recusada_7d:
    '{nome}, é o último aviso antes do seu acesso ser suspenso. Se precisar de ajuda para regularizar ou quiser conversar sobre outra forma de pagamento, estamos aqui. 👉 https://evo-totem.w12app.com.br/CIAFITNESS/1/site/checkout/',

  vencimento_16d_antes:
    'Oi {nome}! Seu plano vence em breve. Aproveite para renovar com antecedência e não ter nenhuma interrupção nos seus treinos. 👉 https://evo-totem.w12app.com.br/CIAFITNESS/1/site/checkout/',

  vencimento_5d_depois:
    '{nome}, seu plano venceu há 5 dias. Para continuar treinando sem interrupção, renove agora. 👉 https://evo-totem.w12app.com.br/CIAFITNESS/1/site/checkout/',

  vencimento_30d_depois:
    'Oi {nome}! Quanto tempo. A gente sentiu sua falta na Cia do Fitness. Sem pressão, só queria saber como você tá. Se em algum momento quiser voltar a treinar, pode contar com a gente — temos condições especiais pra quem está retornando. Um abraço!',

  matricula_1d:
    'Oi {nome}, seja muito bem-vindo à Cia do Fitness! 🎉 Estamos felizes em ter você aqui. Qualquer dúvida sobre horários, aulas ou estrutura, é só chamar!',

  matricula_30d:
    '{nome}, já faz um mês que você está treinando com a gente! Como está sendo a experiência? Conta pra gente 💪',

  aniversario:
    'Feliz aniversário, {nome}! 🎂 Toda a equipe da Cia do Fitness deseja um dia incrível pra você. Hoje é dia de comemorar!',

  pos_visita:
    'Oi {nome}! Foi um prazer te receber aqui na Cia do Fitness. O que achou? Ficou alguma dúvida? Posso te ajudar 😊',

  oportunidade_7d:
    '{nome}, vi que você se cadastrou na Cia do Fitness há uma semana. Ainda não fechou sua matrícula? Posso te ajudar a tirar qualquer dúvida ou agendar uma visita!',

  reativacao:
    'Oi {nome}! Faz um tempo que você não treina com a gente. Sentimos sua falta. Se quiser voltar, temos uma condição especial esperando por você. 🏋️ É só chamar!',
};

// ─────────────────────────────────────────────
// IMAGENS (Supabase Storage)
// ─────────────────────────────────────────────
const IMAGENS = {
  ausencia_9d:           BASE_IMG + '9%20dias%20sem%20presenca.png',
  ausencia_18d:          BASE_IMG + '18%20dias%20sem%20presenca.png',
  cobranca_recusada:     BASE_IMG + 'atualize%20seu%20pagamento.png',
  cobranca_recusada_3d:  BASE_IMG + 'atualize%20seu%20pagamento%203%20dias.png',
  cobranca_recusada_7d:  BASE_IMG + 'atualize%20seu%20pagamento.png',
  vencimento_16d_antes:  BASE_IMG + 'renove%20suas%20metas.png',
  vencimento_5d_depois:  BASE_IMG + '5%20dias%20pos%20vencimento.png',
  vencimento_30d_depois: BASE_IMG + '30%20dias%20apos%20venc%20contr.png',
  matricula_1d:          BASE_IMG + 'seja%20muito%20bem%20vindo.png',
  matricula_30d:         BASE_IMG + '1%20mes%20com%20a%20gente.png',
  aniversario:           BASE_IMG + 'feliz%20aniversario.png',
  pos_visita:            BASE_IMG + 'pos%20visita%20oportunidade%201%20dia.png',
  oportunidade_7d:       BASE_IMG + 'vamos%20comecar.png',
  reativacao:            BASE_IMG + 'que%20tal%20voltar.png',
};

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function identificarGatilho(eventType) {
  return GATILHOS[eventType] || null;
}

function extrairTelefone(body) {
  const raw =
    body?.person?.cellphone ||
    body?.person?.phone ||
    body?.cellphone ||
    body?.phone ||
    '';
  if (!raw) return null;
  const num = raw.replace(/\D/g, '');
  return num.startsWith('55') ? num : `55${num}`;
}

function extrairNome(body) {
  return (
    body?.person?.nickName ||
    body?.person?.firstName ||
    'você'
  );
}

function montarTexto(chave, nome) {
  const template = MENSAGENS[chave];
  if (!template) return null;
  return template.replace(/{nome}/g, nome);
}

// ─────────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────────
export async function processarEvoCRM(body, token) {
  if (token !== process.env.ZAPI_TOKEN) {
    console.log('⚠️ EVO CRM: token inválido');
    return;
  }

  const eventType = body?.eventType;
  if (!eventType) {
    console.log('⚠️ EVO CRM: eventType ausente');
    return;
  }

  const chave = identificarGatilho(eventType);
  if (!chave) {
    console.log(`ℹ️ EVO CRM: evento ignorado — ${eventType}`);
    return;
  }

  const telefone = extrairTelefone(body);
  if (!telefone) {
    console.log(`⚠️ EVO CRM: telefone não encontrado — ${eventType}`);
    return;
  }

  const nome    = extrairNome(body);
  const texto   = montarTexto(chave, nome);
  const imgUrl  = IMAGENS[chave];

  if (!texto) return;

  console.log(`📨 EVO CRM [${chave}] → ${nome} (${telefone})`);

  try {
    if (imgUrl) {
      await enviarImagem(telefone, imgUrl, '');
      await new Promise(r => setTimeout(r, 1500));
    }
    await enviarTexto(telefone, texto);
    console.log(`✅ EVO CRM enviado: ${nome} (${telefone})`);
  } catch (error) {
    console.error(`❌ EVO CRM erro:`, error.message);
    await gravarLog({
      contexto: 'evo_crm',
      mensagem: `Erro ao enviar ${chave}`,
      telefone,
      payload: { erro: error.message, eventType },
    });
  }
}
