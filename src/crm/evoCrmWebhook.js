import { enviarTexto, enviarImagem } from '../services/zapi.js';
import { gravarLog } from '../services/supabase.js';

// Imagens por gatilho — null = só texto
// Atualize com as URLs das imagens quando estiverem prontas no Supabase
const IMAGENS = {
  'no_attendance_9':              null,
  'no_attendance_18':             null,
  'member_birthday':              null,
  'enrollment_1':                 null,
  'enrollment_30':                null,
  'contract_due_date_before':     null,
  'contract_due_date_after':      null,
  'prospect_registration_7':      null,
  'recurring_debit_charge_declined': null,
};

// Mensagens de cada gatilho
const MENSAGENS = {

  'no_attendance_9': `Ei {nome}! Aqui é {instrutor}, da Cia do Fitness 💛

Faz 9 dias que não te vejo por aqui... Tudo bem com você?

Sei que a rotina aperta, mas quero te lembrar que seu treino tá te esperando! Cada vez que você aparece, você tá investindo na melhor versão de você mesmo.

Quando a gente te vê por aqui? 💪`,

  'no_attendance_18': `{nome}, sentimos sua falta! 🥺

Aqui é {instrutor}, da Cia do Fitness. Faz 18 dias que você não aparece por aqui e isso me preocupa um pouquinho.

Às vezes a gente precisa de um empurrãozinho — e eu tô aqui pra isso. Me conta o que tá acontecendo? Posso te ajudar a retomar no seu ritmo! 💛

A academia tá te esperando.`,

  'member_birthday': `Feliz aniversário, {nome}! 🎉🎂

Toda a equipe da Cia do Fitness deseja um dia incrível pra você!

Que esse novo ano seja cheio de saúde, conquistas e muito treino! 💛💪

Com carinho, equipe Cia do Fitness.`,

  'enrollment_1': `Oi {nome}! 😊

Aqui é {instrutor}, da Cia do Fitness. Vi que você fez sua matrícula ontem — seja muito bem-vindo(a)!

Queria só te avisar que estarei por aqui pra te ajudar no que precisar. Qualquer dúvida sobre os treinos, horários ou aulas coletivas, é só me chamar!

Nos vemos em breve 💛`,

  'enrollment_30': `{nome}, já faz 1 mês que você está na Cia! 🎉

Aqui é {instrutor}. Queria saber como tá sendo sua experiência por aqui — o que você tá achando dos treinos?

Seu feedback é muito importante pra gente. E se tiver alguma coisa que posso melhorar no seu atendimento, pode falar à vontade! 💛💪`,

  'contract_due_date_before': `Oi {nome}! Tudo bem? 😊

Aqui é a equipe da Cia do Fitness. Passando pra te avisar que seu contrato vence em breve.

J� pensou em renovar? Na renovação antecipada você garante sua vaga e evita qualquer interrupção no seu treino 💛

Qualquer dúvida é só chamar a gente!`,

  'contract_due_date_after': `{nome}, seu contrato venceu há alguns dias 😊

Aqui é a equipe da Cia do Fitness. Queremos continuar te vendo por aqui!

Passa na recepção ou me chama aqui pra renovarmos juntos. Tem condições especiais pra quem renova agora 💛`,

  'prospect_registration_7': `Oi {nome}! Como você tá? 😊

Aqui é a equipe da Cia do Fitness. Faz uma semana desde que você demonstrou interesse em conhecer nossa academia.

Ainda tá pensando? Posso te ajudar com qualquer dúvida — planos, horários, modalidades. A gente tem a opção certa pra você! 💛

Quando quer vir dar uma olhada?`,

  'recurring_debit_charge_declined': `Oi {nome}! Tudo bem? 😊

Aqui é a equipe da Cia do Fitness. Identificamos que houve uma tentativa de cobrança no seu cartão, mas infelizmente não foi possível processar o pagamento.

Para não ter nenhuma interrupção no seu acesso à academia, pedimos que verifique com sua operadora ou entre em contato com a gente para regularizar 💛

Qualquer dúvida é só responder aqui!`,
};

// Identifica a chave da mensagem baseado no eventType e daysOffset
function identificarGatilho(eventType, eventContext) {
  const moment = eventContext?.moment; // 'before' ou 'after'
  const days = eventContext?.daysOffset || 0;

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
      return 'contract_due_date_after';

    case 'crm.automation.prospect_registration':
      return 'prospect_registration_7';

    case 'crm.automation.recurring_debit_charge_declined':
      return 'recurring_debit_charge_declined';

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

function extrairInstrutor(body) {
  return body?.instructor?.firstName
    || body?.responsible?.firstName
    || 'a equipe';
}

function montarTexto(chave, nome, instrutor) {
  const template = MENSAGENS[chave];
  if (!template) return null;
  return template
    .replace(/{nome}/g, nome)
    .replace(/{instrutor}/g, instrutor);
}

export async function processarEvoCRM(body, token) {
  // Valida token de segurança
  if (token !== process.env.ZAPI_TOKEN) {
    console.log('⚠️ EVO CRM: token inválido');
    return;
  }

  const eventType = body?.eventType;
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

  const nome = extrairNome(body);
  const instrutor = extrairInstrutor(body);
  const texto = montarTexto(chave, nome, instrutor);
  const imagemUrl = IMAGENS[chave];

  if (!texto) return;

  console.log(`📨 EVO CRM [${chave}] → ${nome} (${telefone})`);

  try {
    if (imagemUrl) {
      await enviarImagem(telefone, imagemUrl, texto);
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
