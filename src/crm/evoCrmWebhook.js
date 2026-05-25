import { enviarTexto, enviarImagem } from '../services/zapi.js';
import { gravarLog } from '../services/supabase.js';

const BASE = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens';

const IMAGENS = {
  'no_attendance_9':                    `${BASE}/9%20dias%20sem%20presenca.png`,
  'no_attendance_18':                   `${BASE}/18%20dias%20sem%20presenca.png`,
  'member_birthday':                    `${BASE}/feliz%20aniversario.png`,
  'enrollment_1':                       `${BASE}/seja%20muito%20bem%20vindo.png`,
  'enrollment_30':                      `${BASE}/1%20mes%20com%20a%20gente.png`,
  'contract_due_date_before':           `${BASE}/renove%20suas%20metas.png`,
  'contract_due_date_after_5':          `${BASE}/5%20dias%20pos%20vencimento.png`,
  'contract_due_date_after_30':         `${BASE}/30%20dias%20apos%20venc%20contr.png`,
  'prospect_registration_7':            `${BASE}/vamos%20comecar.png`,
  'prospect_visit':                     `${BASE}/pos%20visita%20oportunidade%201%20dia.png`,
  'recurring_debit_charge_declined':    `${BASE}/atualize%20seu%20pagamento.png`,
  'recurring_debit_charge_declined_7d': `${BASE}/atualize%20seu%20pagamento.png`,
  'contract_cancelled_reactivation':    `${BASE}/que%20tal%20voltar.png`,
};

const MENSAGENS = {

  'no_attendance_9':
`Ei {nome}! Tudo bem? 😊 Aqui é a Mila, da Cia do Fitness. Sentimos sua falta por aqui nos últimos dias.. 😕 Espero que não seja o desânimo, hein? Lembre-se de que o seu objetivo continua te esperando. 💪 Bora retornar aos treinos? Estamos te esperando de braços abertos! 💛`,

  'no_attendance_18':
`Oi {nome}! 💛 Notamos que você tem estado ausente já faz um tempinho e queríamos saber como podemos te ajudar a retomar o ritmo. 😕 Não esqueça o motivo pelo qual você começou: cada treino é um passo mais perto da versão de você que deseja se tornar. Estamos aqui para te apoiar. Vamos combinar de retornar? 💪`,

  'member_birthday':
`Ei {nome}! Hoje é um dia muito especial e toda a equipe da Cia do Fitness quer te desejar um Feliz Aniversário! 🎉 Que seja um ano repleto de saúde, conquistas e muita disposição. Aproveite o seu dia, você merece! Um forte abraço de toda a nossa equipe. 💛🥳`,

  'enrollment_1':
`Ei {nome}, seja muito bem-vindo(a) à Cia do Fitness! 🎉 Estamos muito felizes por você ter nos escolhido. A nossa equipe se preocupa de verdade com o alcance dos seus objetivos e faremos de tudo para que você continue conosco por muito tempo. Qualquer dúvida, é só chamar. Bora treinar! 💪💛`,

  'enrollment_30':
`Ei {nome}! 💛 Já faz um mês que você começou essa jornada com a gente, e queremos saber: como você está se sentindo? 😊 Esse primeiro mês é o mais importante para criar o hábito. Se precisar de qualquer ajuste no treino ou tiver alguma dúvida, conte com a nossa equipe. Continue firme, os resultados vêm! 💪`,

  'contract_due_date_before':
`Oi {nome}! Aqui é da Cia do Fitness 💛 Passando para lembrar, com carinho, que o seu plano está chegando ao fim em breve. Para você não perder nenhum dia de treino e manter o ritmo dos seus resultados, já deixamos a renovação prontinha. Quer que a gente te passe as condições? 😊`,

  'contract_due_date_after_5':
`Ei {nome}, tudo bem? 💛 Notamos que o seu plano na Cia do Fitness venceu há alguns dias e sentimos a sua falta por aqui. Não deixe a rotina te afastar dos seus objetivos! Que tal renovar e voltar a treinar com a gente? É rapidinho. Posso te ajudar com isso? 💪`,

  'contract_due_date_after_30':
`Oi {nome}! 💛 Já faz um mês que o seu plano venceu e a gente continua com a porta aberta esperando o seu retorno. Que tal não deixar os seus objetivos para depois? Preparamos uma condição especial para você voltar a treinar com a gente. Quer saber mais? Posso te explicar tudinho por aqui! 😊`,

  'prospect_registration_7':
`Ei {nome}! Tudo bem? 😊 Aqui é a Mila, da Cia do Fitness. Você demonstrou interesse em começar a treinar com a gente e eu não queria deixar essa vontade esfriar! 💪 Ainda dá tempo de dar o primeiro passo rumo aos seus objetivos. Quer que eu te passe as nossas condições especiais? 💛`,

  'prospect_visit':
`Ei {nome}! Aqui é a Mila, da Cia do Fitness 💛 Passando para agradecer pela sua visita ao nosso espaço! 🤩 Espero que tenha gostado da estrutura e das condições que apresentamos. Ficou com alguma dúvida? Estou por aqui para te ajudar a dar o primeiro passo. Esperamos te ver treinando com a gente em breve! 💪`,

  'recurring_debit_charge_declined':
`Oi {nome}! Aqui é da Cia do Fitness 💛 Notamos que a cobrança da sua mensalidade não foi processada. Para regularizar e continuar treinando sem interrupção, é só acessar o link abaixo 👇 https://evo-totem.w12app.com.br/CIAFITNESS/1/site/checkout`,

  'recurring_debit_charge_declined_7d':
`Oi {nome}. Aqui é da Cia do Fitness 💛 Infelizmente não conseguimos processar o pagamento da sua mensalidade e já se passaram 7 dias desde a primeira tentativa. Para evitar que o seu cadastro seja encaminhado ao setor jurídico para cobrança formal, pedimos que regularize sua situação ainda hoje pelo link abaixo 👇 https://evo-totem.w12app.com.br/CIAFITNESS/1/site/checkout Qualquer dúvida, estamos à disposição para te ajudar a resolver isso da melhor forma.`,

  'contract_cancelled_reactivation':
`Ei {nome}! Tudo bem? 💛 Aqui é a Mila, da Cia do Fitness. Faz um tempo que você não treina com a gente e queremos muito te ver de volta! 🏋️ Sabemos que a rotina aperta, mas cuidar de você é o melhor investimento. Que tal recomeçar? Tenho uma condição especial de retorno pra te apresentar. Bora? 💪`,

};

function identificarGatilho(eventType, eventContext) {
  const moment   = eventContext?.moment;
  const days     = parseInt(eventContext?.daysOffset || 0);

  switch (eventType) {

    case 'crm.automation.no_attendance':
      if (days <= 12) return 'no_attendance_9';
      return 'no_attendance_18';

    case 'crm.automation.member_birthday':
      return 'member_birthday';

    case 'crm.automation.enrollment':
      if (days <= 5) return 'enrollment_1';
      return 'enrollment_30';

    case 'crm.automation.contract_due_date':
      if (moment === 'before') return 'contract_due_date_before';
      if (days <= 10)          return 'contract_due_date_after_5';
      return 'contract_due_date_after_30';

    case 'crm.automation.prospect_registration':
      return 'prospect_registration_7';

    case 'crm.automation.prospect_visit':
      return 'prospect_visit';

    case 'crm.automation.recurring_debit_charge_declined':
      // Modelo C: a cada recusa → mensagem padrão
      // No 7º dia (automação #11 com delay=7) → mensagem jurídica
      if (days >= 7) return 'recurring_debit_charge_declined_7d';
      return 'recurring_debit_charge_declined';

    case 'crm.automation.contract_cancelled':
      return 'contract_cancelled_reactivation';

    default:
      return null;
  }
}

function extrairTelefone(body) {
  const phone = body?.person?.phone || null;
  if (!phone) return null;
  const num = phone.replace(/\D/g, '');
  if (num.length < 10) return null;
  return num.startsWith('55') ? num : `55${num}`;
}

function extrairNome(body) {
  return body?.person?.nickName
    || body?.person?.firstName
    || 'você';
}

function montarTexto(chave, nome) {
  const template = MENSAGENS[chave];
  if (!template) return null;
  return template.replace(/{nome}/g, nome);
}

export async function processarEvoCRM(body, token) {
  // LOG TEMPORÁRIO — remover após validar payload do EVO
  console.log('🔍 EVO CRM payload recebido:', JSON.stringify(body, null, 2));
  console.log('🔍 EVO CRM token recebido:', token);

  // Valida token de segurança
  if (token !== process.env.EVO_SECRET_TOKEN) {
    console.log('⚠️ EVO CRM: token inválido');
    return;
  }

  const eventType    = body?.eventType;
  const eventContext = body?.eventContext;

  if (!eventType) {
    console.log('⚠️ EVO CRM: eventType não encontrado');
    return;
  }

  const chave = identificarGatilho(eventType, eventContext);
  if (!chave) {
    console.log(`ℹ️ EVO CRM: evento ignorado — ${eventType}`);
    return;
  }

  const telefone = extrairTelefone(body);
  if (!telefone) {
    console.log(`⚠️ EVO CRM: telefone não encontrado — ${eventType}`);
    return;
  }

  const nome      = extrairNome(body);
  const texto     = montarTexto(chave, nome);
  const imagemUrl = IMAGENS[chave];

  if (!texto) return;

  console.log(`📨 EVO CRM [${chave}] → ${nome} (${telefone})`);

  try {
    if (imagemUrl) {
      await enviarImagem(telefone, imagemUrl, ' ');
      await new Promise(r => setTimeout(r, 1500));
      await enviarTexto(telefone, texto);
    } else {
      await enviarTexto(telefone, texto);
    }
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
