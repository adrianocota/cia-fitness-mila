// ================================================
// HANDLER DO WEBHOOK CRM DO EVO
// Recebe eventos dos Disparos Automáticos do EVO
// e envia mensagens via Z-API
// ================================================

import { enviarTexto, enviarImagem } from '../services/zapi.js';
import { gravarLog } from '../services/supabase.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Mapeamento de eventType → chave de mensagem
// O EVO envia o eventType no corpo do webhook
// Configuramos um webhook por gatilho no EVO
const MAPA_EVENTOS = {
  '9_dias_sem_presenca':      '9_dias_sem_presenca',
  '18_dias_sem_presenca':     '18_dias_sem_presenca',
  'aniversario':              'aniversario',
  '1_dia_apos_matricula':     '1_dia_apos_matricula',
  '30_dias_apos_matricula':   '30_dias_apos_matricula',
  '16_dias_antes_vencimento': '16_dias_antes_vencimento',
  '5_dias_apos_vencimento':   '5_dias_apos_vencimento',
  '7_dias_apos_oportunidade': '7_dias_apos_oportunidade',
  'cobranca_recusada':        'cobranca_recusada',
};

// Mensagens de cada gatilho
// {nome} e {instrutor} são substituídos pelos dados do aluno
const MENSAGENS = {

  '9_dias_sem_presenca': `Ei {nome}! Aqui é {instrutor}, da Cia do Fitness 💛

Faz 9 dias que não te vejo por aqui... Tudo bem com você?

Sei que a rotina aperta, mas quero te lembrar que seu treino tá te esperando! Cada vez que você aparece, você tá investindo na melhor versão de você mesmo.

Quando a gente te vê por aqui? 💪`,

  '18_dias_sem_presenca': `{nome}, sentimos sua falta! 🥺

Aqui é {instrutor}, da Cia do Fitness. Faz 18 dias que você não aparece por aqui e isso me preocupa um pouquinho.

Às vezes a gente precisa de um empurrãozinho — e eu tô aqui pra isso. Me conta o que tá acontecendo? Posso te ajudar a retomar no seu ritmo! 💛

A academia tá te esperando.`,

  'aniversario': `Feliz aniversário, {nome}! 🎉🎂

Toda a equipe da Cia do Fitness deseja um dia incrível pra você!

Que esse novo ano seja cheio de saúde, conquistas e muito treino! 💛💪

Com carinho, equipe Cia do Fitness.`,

  '1_dia_apos_matricula': `Oi {nome}! 😊

Aqui é {instrutor}, da Cia do Fitness. Vi que você fez sua matrícula ontem — seja muito bem-vindo(a)!

Queria só te avisar que estarei por aqui pra te ajudar no que precisar. Qualquer dúvida sobre os treinos, horários ou aulas coletivas, é só me chamar!

Nos vemos em breve 💛`,

  '30_dias_apos_matricula': `{nome}, já faz 1 mês que você está na Cia! 🎉

Aqui é {instrutor}. Queria saber como tá sendo sua experiência por aqui — o que você tá achando dos treinos?

Seu feedback é muito importante pra gente. E se tiver alguma coisa que posso melhorar no seu atendimento, pode falar à vontade! 💛💪`,

  '16_dias_antes_vencimento': `Oi {nome}! Tudo bem? 😊

Aqui é a equipe da Cia do Fitness. Passando pra te avisar que seu contrato vence em 16 dias.

J� pensou em renovar? Na renovação antecipada você garante sua vaga e evita qualquer interrupção no seu treino 💛

Qualquer dúvida é só chamar a gente!`,

  '5_dias_apos_vencimento': `{nome}, seu contrato venceu há 5 dias 😊

Aqui é a equipe da Cia do Fitness. Queremos continuar te vendo por aqui!

Passa na recepção ou me chama aqui pra renovarmos juntos. Tem condições especiais pra quem renova agora 💛`,

  '7_dias_apos_oportunidade': `Oi {nome}! Como você tá? 😊

Aqui é a equipe da Cia do Fitness. Faz uma semana desde que você demonstrou interesse em conhecer nossa academia.

Ainda tá pensando? Posso te ajudar com qualquer dúvida — planos, horários, modalidades. A gente tem a opção certa pra você! 💛

Quando quer vir dar uma olhada?`,

  'cobranca_recusada': `Oi {nome}! Tudo bem? 😊

Aqui é a equipe da Cia do Fitness. Identificamos que houve uma tentativa de cobrança no seu cartão hoje, mas infelizmente não foi possível processar o pagamento.

Para não ter nenhuma interrupção no seu acesso à academia, pedimos que verifique com sua operadora ou entre em contato com a gente para regularizar 💛

Qualquer dúvida é só responder aqui!`,
};

// Imagens por gatilho — null = só texto
// Você pode atualizar depois com as URLs das imagens que criar
const IMAGENS = {
  '9_dias_sem_presenca':      null,
  '18_dias_sem_presenca':     null,
  'aniversario':              null,
  '1_dia_apos_matricula':     null,
  '30_dias_apos_matricula':   null,
  '16_dias_antes_vencimento': null,
  '5_dias_apos_vencimento':   null,
  '7_dias_apos_oportunidade': null,
  'cobranca_recusada':        null,
};

// Extrai telefone do payload do EVO
function extrairTelefone(body) {
  // O EVO envia phone como "+5531999999999"
  const phone = body?.person?.phone || body?.phone || null;
  if (!phone) return null;
  // Remove tudo que não for número
  const num = phone.replace(/\D/g, '');
  if (num.length < 10) return null;
  // Garante DDI 55
  return num.startsWith('55') ? num : `55${num}`;
}

function extrairNome(body) {
  return body?.person?.nickName
    || body?.person?.firstName
    || body?.nome
    || 'você';
}

function extrairInstrutor(body) {
  return body?.instructor?.firstName
    || body?.instrutor
    || 'a equipe';
}

function montarTexto(gatilho, nome, instrutor) {
  const template = MENSAGENS[gatilho];
  if (!template) return null;
  return template
    .replace(/{nome}/g, nome)
    .replace(/{instrutor}/g, instrutor);
}

// ================================================
// PROCESSADOR PRINCIPAL
// ================================================

export async function processarEvoCRM(body) {
  // O gatilho vem no campo que configuramos no EVO
  // Usamos o campo customizado "gatilho" que vamos configurar no webhook do EVO
  const gatilho = body?.gatilho || body?.eventType || null;

  if (!gatilho) {
    console.log('⚠️ EVO CRM: gatilho não identificado', body);
    return;
  }

  const chaveGatilho = MAPA_EVENTOS[gatilho];
  if (!chaveGatilho) {
    console.log(`⚠️ EVO CRM: gatilho desconhecido: ${gatilho}`);
    return;
  }

  const telefone = extrairTelefone(body);
  if (!telefone) {
    console.log(`⚠️ EVO CRM: telefone não encontrado para gatilho ${gatilho}`);
    return;
  }

  const nome = extrairNome(body);
  const instrutor = extrairInstrutor(body);
  const texto = montarTexto(chaveGatilho, nome, instrutor);
  const imagemUrl = IMAGENS[chaveGatilho];

  if (!texto) {
    console.log(`⚠️ EVO CRM: mensagem não encontrada para ${chaveGatilho}`);
    return;
  }

  console.log(`📨 EVO CRM [${chaveGatilho}] → ${nome} (${telefone})`);

  try {
    if (imagemUrl) {
      await enviarImagem(telefone, imagemUrl, texto);
    } else {
      await enviarTexto(telefone, texto);
    }
    console.log(`✅ EVO CRM enviado: ${nome} (${telefone})`);
  } catch (error) {
    console.error(`❌ EVO CRM erro ${telefone}:`, error.message);
    await gravarLog({
      contexto: 'evo_crm',
      mensagem: `Erro ao enviar ${chaveGatilho}`,
      telefone,
      payload: { erro: error.message, gatilho: chaveGatilho },
    });
  }
}
