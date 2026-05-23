// ================================================
// MENSAGENS DOS 9 GATILHOS
// Variáveis disponíveis: {nome}, {instrutor}, {dias}, {vencimento}, {valor}
// ================================================

export const MENSAGENS = {

  '9_dias_sem_presenca': {
    texto: `Ei {nome}! Aqui é {instrutor}, da Cia do Fitness 💛

Faz 9 dias que não te vejo por aqui... Tudo bem com você?

Sei que a rotina aperta, mas quero te lembrar que seu treino tá te esperando! Cada vez que você aparece, você tá investindo na melhor versão de você mesmo.

Quando a gente te vê por aqui? 💪`,
    imagem: null,
  },

  '18_dias_sem_presenca': {
    texto: `{nome}, sentimos sua falta! 🥺

Aqui é {instrutor}, da Cia do Fitness. Faz 18 dias que você não aparece por aqui e isso me preocupa um pouquinho.

Às vezes a gente precisa de um empurrãozinho — e eu tô aqui pra isso. Me conta o que tá acontecendo? Posso te ajudar a retomar no seu ritmo! 💛

A academia tá te esperando.`,
    imagem: null,
  },

  'aniversario': {
    texto: `Feliz aniversário, {nome}! 🎉🎂

Toda a equipe da Cia do Fitness deseja um dia incrível pra você!

Que esse novo ano seja cheio de saúde, conquistas e muito treino! 💛💪

Com carinho, equipe Cia do Fitness.`,
    imagem: null,
  },

  '1_dia_apos_matricula': {
    texto: `Oi {nome}! 😊

Aqui é {instrutor}, da Cia do Fitness. Vi que você fez sua matrícula ontem — seja muito bem-vindo(a)!

Queria só te avisar que estarei por aqui pra te ajudar no que precisar. Qualquer dúvida sobre os treinos, horários ou aulas coletivas, é só me chamar!

Nos vemos em breve 💛`,
    imagem: null,
  },

  '30_dias_apos_matricula': {
    texto: `{nome}, já faz 1 mês que você está na Cia! 🎉

Aqui é {instrutor}. Queria saber como tá sendo sua experiência por aqui — o que você tá achando dos treinos?

Seu feedback é muito importante pra gente. E se tiver alguma coisa que posso melhorar no seu atendimento, pode falar à vontade! 💛💪`,
    imagem: null,
  },

  '16_dias_antes_vencimento': {
    texto: `Oi {nome}! Tudo bem? 😊

Aqui é a equipe da Cia do Fitness. Passando pra te avisar que seu contrato vence em 16 dias (dia {vencimento}).

Já pensou em renovar? Na renovação antecipada você garante sua vaga e evita qualquer interrupção no seu treino 💛

Qualquer dúvida é só chamar a gente!`,
    imagem: null,
  },

  '5_dias_apos_vencimento': {
    texto: `{nome}, seu contrato venceu há 5 dias 😊

Aqui é a equipe da Cia do Fitness. Queremos continuar te vendo por aqui!

Passa na recepção ou me chama aqui pra renovarmos juntos. Tem condições especiais pra quem renova agora 💛`,
    imagem: null,
  },

  '7_dias_apos_oportunidade': {
    texto: `Oi {nome}! Como você tá? 😊

Aqui é a equipe da Cia do Fitness. Faz uma semana desde que você demonstrou interesse em conhecer nossa academia.

Ainda tá pensando? Posso te ajudar com qualquer dúvida — planos, horários, modalidades. A gente tem a opção certa pra você! 💛

Quando quer vir dar uma olhada?`,
    imagem: null,
  },

  'cobranca_recusada': {
    texto: `Oi {nome}! Tudo bem? 😊

Aqui é a equipe da Cia do Fitness. Identificamos que houve uma tentativa de cobrança de R$ {valor} no seu cartão hoje, mas infelizmente não foi possível processar o pagamento.

Para não ter nenhuma interrupção no seu acesso à academia, pedimos que verifique com sua operadora ou entre em contato com a gente para regularizar 💛

Qualquer dúvida é só responder aqui!`,
    imagem: null,
  },

};

// Substitui variáveis na mensagem
export function montarMensagem(gatilho, dados) {
  const template = MENSAGENS[gatilho];
  if (!template) return null;

  let texto = template.texto;
  texto = texto.replace(/{nome}/g, dados.nome || 'você');
  texto = texto.replace(/{instrutor}/g, dados.instrutor || 'a equipe');
  texto = texto.replace(/{dias}/g, dados.diasSemPresenca || '');
  texto = texto.replace(/{valor}/g, dados.valor
    ? Number(dados.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 })
    : '');
  texto = texto.replace(/{vencimento}/g, dados.vencimento
    ? new Date(dados.vencimento).toLocaleDateString('pt-BR')
    : '');

  return { texto, imagem: template.imagem };
}
