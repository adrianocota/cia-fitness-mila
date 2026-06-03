// ================================================
// MENSAGENS DOS GATILHOS CRM
// Variáveis disponíveis: {nome}, {instrutor}, {vencimento}, {valor}
// ================================================

const BASE_IMG = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/';

export const MENSAGENS = {

  '9_dias_sem_presenca': {
    texto: `Oi {nome}! Sentimos sua falta por aqui. Tá tudo bem? O treino te espera quando você quiser voltar 💪`,
    imagem: BASE_IMG + '9%20dias%20sem%20presenca.png',
  },

  '18_dias_sem_presenca': {
    texto: `{nome}, faz quase 3 semanas que você não aparece na Cia. A gente sente de verdade. Tem algo que esteja te impedindo? Pode contar com a gente.`,
    imagem: BASE_IMG + '18%20dias%20sem%20presenca.png',
  },

  'aniversario': {
    texto: `Feliz aniversário, {nome}! 🎂 Toda a equipe da Cia do Fitness deseja um dia incrível pra você. Hoje é dia de comemorar!`,
    imagem: BASE_IMG + 'feliz%20aniversario.png',
  },

  '1_dia_apos_matricula': {
    texto: `Oi {nome}, seja muito bem-vindo à Cia do Fitness! 🎉 Estamos felizes em ter você aqui. Qualquer dúvida sobre horários, aulas ou estrutura, é só chamar!`,
    imagem: BASE_IMG + 'seja%20muito%20bem%20vindo.png',
  },

  '30_dias_apos_matricula': {
    texto: `{nome}, já faz um mês que você está treinando com a gente! Como está sendo a experiência? Conta pra gente 💪`,
    imagem: BASE_IMG + '1%20mes%20com%20a%20gente.png',
  },

  '16_dias_antes_vencimento': {
    texto: `Oi {nome}! Seu plano vence em breve. Aproveite para renovar com antecedência e não ter nenhuma interrupção nos seus treinos. 👉 https://evo-totem.w12app.com.br/CIAFITNESS/1/site/checkout/`,
    imagem: BASE_IMG + 'renove%20suas%20metas.png',
  },

  '5_dias_apos_vencimento': {
    texto: `{nome}, seu plano venceu há 5 dias. Para continuar treinando sem interrupção, renove agora. 👉 https://evo-totem.w12app.com.br/CIAFITNESS/1/site/checkout/`,
    imagem: BASE_IMG + '5%20dias%20pos%20vencimento.png',
  },

  '30_dias_apos_vencimento': {
    texto: `Oi {nome}! Quanto tempo. A gente sentiu sua falta na Cia do Fitness. Sem pressão, só queria saber como você tá. Se em algum momento quiser voltar a treinar, pode contar com a gente — temos condições especiais pra quem está retornando. Um abraço!`,
    imagem: BASE_IMG + '30%20dias%20apos%20venc%20contr.png',
  },

  'cobranca_recusada': {
    texto: `Oi {nome}! Notamos que a cobrança da sua mensalidade não foi processada. Pode ser algo simples como limite ou dados desatualizados. Clica aqui para regularizar 👉 https://evo-totem.w12app.com.br/CIAFITNESS/1/site/checkout/`,
    imagem: BASE_IMG + 'atualize%20seu%20pagamento.png',
  },

  'cobranca_recusada_3d': {
    texto: `{nome}, sua mensalidade ainda está em aberto. Para não perder seu acesso, regularize pelo link abaixo. Qualquer dúvida é só chamar! 👉 https://evo-totem.w12app.com.br/CIAFITNESS/1/site/checkout/`,
    imagem: BASE_IMG + 'atualize%20seu%20pagamento%203%20dias.png',
  },

  'cobranca_recusada_7d': {
    texto: `{nome}, é o último aviso antes do seu acesso ser suspenso. Se precisar de ajuda para regularizar ou quiser conversar sobre outra forma de pagamento, estamos aqui. 👉 https://evo-totem.w12app.com.br/CIAFITNESS/1/site/checkout/`,
    imagem: BASE_IMG + 'atualize%20seu%20pagamento.png',
  },

  'pos_visita': {
    texto: `Oi {nome}! Foi um prazer te receber aqui na Cia do Fitness. O que achou? Ficou alguma dúvida? Posso te ajudar 😊`,
    imagem: BASE_IMG + 'pos%20visita%20oportunidade%201%20dia.png',
  },

  '7_dias_apos_oportunidade': {
    texto: `{nome}, vi que você se cadastrou na Cia do Fitness há uma semana. Ainda não fechou sua matrícula? Posso te ajudar a tirar qualquer dúvida ou agendar uma visita!`,
    imagem: BASE_IMG + 'vamos%20comecar.png',
  },

  'reativacao': {
    texto: `Oi {nome}! Faz um tempo que você não treina com a gente. Sentimos sua falta. Se quiser voltar, temos uma condição especial esperando por você. 🏋️ É só chamar!`,
    imagem: BASE_IMG + 'que%20tal%20voltar.png',
  },

};

// ================================================
// MONTAR MENSAGEM — substitui variáveis no template
// ================================================
export function montarMensagem(gatilho, dados) {
  const template = MENSAGENS[gatilho];
  if (!template) return null;

  let texto = template.texto;
  texto = texto.replace(/{nome}/g,       dados.nome      || 'você');
  texto = texto.replace(/{instrutor}/g,  dados.instrutor || 'a equipe');
  texto = texto.replace(/{valor}/g,      dados.valor
    ? Number(dados.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 })
    : '');
  texto = texto.replace(/{vencimento}/g, dados.vencimento
    ? new Date(dados.vencimento + 'T12:00:00').toLocaleDateString('pt-BR')
    : '');

  return { texto, imagem: template.imagem };
}
