import OpenAI from 'openai';
import { config } from '../config.js';

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

// ─── GERAR RESPOSTA ───────────────────────────────────────────────────────────

export async function gerarResposta({ systemPrompt, historico, mensagemNova }) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...historico,
    { role: 'user', content: mensagemNova },
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: config.openai.model,
      messages,
      max_tokens: config.openai.maxTokens,
      temperature: config.openai.temperature,
    });

    const resposta = completion.choices[0]?.message?.content?.trim();
    if (!resposta) throw new Error('Resposta vazia da OpenAI');

    const tokens = completion.usage;
    console.log(`💬 OpenAI: ${tokens.prompt_tokens} in + ${tokens.completion_tokens} out = ${tokens.total_tokens} tokens`);

    return resposta;
  } catch (error) {
    console.error('❌ Erro ao gerar resposta na OpenAI:', error.message);
    throw error;
  }
}

// ─── CLASSIFICAR MENSAGEM DE FOLLOW-UP ───────────────────────────────────────

// ─── CLASSIFICADOR GENÉRICO DE INTENÇÃO ──────────────────────────────────────
// Substitui regex em qualquer situação onde o contexto importa mais que a palavra.
// Cobre emojis (👍), gírias, frases ambíguas, confirmações indiretas, etc.
// Custo mínimo: max_tokens=5, temperature=0.
//
// Uso: classificarIntencao(texto, pergunta, opcoes)
// Ex: await classificarIntencao("👍", "O lead confirmou?", ["SIM", "NAO", "INCERTO"])
// Ex: await classificarIntencao("vou pensar", "O lead quer fechar?", ["SIM", "NAO", "TALVEZ"])

export async function classificarIntencao(texto, pergunta, opcoes = ['SIM', 'NAO', 'INCERTO'], contexto = '') {
  const opcoesStr = opcoes.join(' | ');
  const prompt = `Analise a mensagem abaixo e responda à pergunta.

${contexto ? 'Contexto: ' + contexto + '\n' : ''}Mensagem: "${texto}"

Pergunta: ${pergunta}

Responda APENAS com uma das opções: ${opcoesStr}
Sem explicação, sem pontuação, sem aspas.`;

  try {
    const completion = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 10,
      temperature: 0,
    });

    const resultado = completion.choices[0]?.message?.content?.trim().toUpperCase();
    const opcoesUpper = opcoes.map(o => o.toUpperCase());

    if (!opcoesUpper.includes(resultado)) {
      console.warn(`⚠️ classificarIntencao retornou "${resultado}" fora das opções. Usando "${opcoes[opcoes.length - 1]}".`);
      return opcoes[opcoes.length - 1]; // última opção = fallback seguro
    }

    return resultado;
  } catch (error) {
    console.error('❌ Erro ao classificar intenção:', error.message);
    return opcoes[opcoes.length - 1]; // fallback seguro em caso de erro
  }
}

// ─── CLASSIFICAR RESPOSTA DE FOLLOW-UP ───────────────────────────────────────

export async function classificarResposta(mensagemDoLead) {
  const prompt = `Você é um classificador de mensagens. Analise a mensagem abaixo de um lead de uma academia e classifique em UMA dessas 3 categorias:

1. "evasiva" - Lead tá empurrando a decisão, sem interesse claro nem rejeição. Exemplos: "depois falo", "vou pensar", "tô ocupado", "daqui a pouco respondo", "vou ver"

2. "engajamento" - Lead voltou a conversar com interesse real, fez pergunta concreta, demonstrou curiosidade. Exemplos: "quanto fica parcelado?", "tem aula de pilates?", "pode ser amanhã às 15h?"

3. "encerramento" - Lead claramente NÃO quer mais. Exemplos: "não tenho interesse", "para de me chamar", "já fechei em outro lugar", "tira meu número", "não vai dar"

Mensagem do lead:
"""
${mensagemDoLead}
"""

Responda APENAS com a palavra da categoria (sem aspas, sem explicação):`;

  try {
    const completion = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 10,
      temperature: 0,
    });

    const categoria = completion.choices[0]?.message?.content?.trim().toLowerCase();

    if (!['evasiva', 'engajamento', 'encerramento'].includes(categoria)) {
      console.warn(`⚠️ Categoria inválida retornada: "${categoria}". Tratando como engajamento.`);
      return 'engajamento';
    }

    return categoria;
  } catch (error) {
    console.error('❌ Erro ao classificar resposta:', error.message);
    return 'engajamento';
  }
}

// ─── DETECTAR ESCALAÇÃO ───────────────────────────────────────────────────────
// REGRA GERAL: só escala quando o gatilho for CLARO e EXPLÍCITO.
// Em caso de dúvida, a resposta correta é NAO.

export async function detectarEscalacao({ historico, mensagemNova }) {
  const prompt = `Você analisa conversas entre lead e atendente virtual de uma academia. Decida se essa conversa deve ser transferida pra atendente humano AGORA.

REGRA GERAL: só responda SIM quando o gatilho for CLARO e EXPLÍCITO. Em caso de dúvida, responda NAO. A atendente virtual sabe responder a grande maioria das perguntas.

═══════════════════════════════════════
GATILHOS REAIS — responda SIM apenas se um desses ocorrer de forma clara:
═══════════════════════════════════════

1. Lead pediu EXPLICITAMENTE pra falar com humano: "quero falar com alguém", "passa pra atendente", "me liga", "quero falar com a recepção", "fala com humano"
2. Lead quer agendar visita com hora marcada E confirmou que já decidiu matricular: "posso ir amanhã às 15h pra me matricular"
3. Lead manifestou intenção clara de fechar AGORA e perguntou como pagar: "como faço o pagamento?", "quero assinar agora", "pode me passar o link pra matricular?", "posso pagar hoje?"
4. Lead pediu desconto e INSISTIU pela segunda vez ou mais (após já ter recebido resposta padrão)
5. Lead perguntou valor de multa de cancelamento e INSISTIU pela segunda vez ou mais
6. Reclamação grave sobre a academia (não sobre o atendimento virtual)
7. Lead cadeirante ou com necessidade especial de acessibilidade
8. Lead pediu aula experimental E informou disponibilidade de horário concreto
9. Lead disse que quer treinar SÓ um mês
10. Lead confirmou que NÃO tem nem R$ 119 disponível no cartão
11. Lead insistiu pela segunda vez que quer pagar o plano mensal no dinheiro (após já ter recebido explicação)

═══════════════════════════════════════
NÃO SÃO GATILHOS — nunca transfira por esses motivos:
═══════════════════════════════════════

SAUDAÇÕES E ABERTURAS (a atendente responde com abertura padrão):
- "oi", "olá", "ola", "bom dia", "boa tarde", "boa noite"
- "ola mila", "oi mila", "vamos conversar", "tô aqui", "oi tudo bem?"
- Qualquer mensagem de saudação genérica na abertura da conversa

INTENÇÕES GENÉRICAS DE ENTRADA (qualificação normal):
- "quero fazer academia", "quero treinar", "quero começar", "quero me matricular"
- "quero saber mais", "me passa informações", "pode me ajudar?"
- Lead nas primeiras 1-3 mensagens da conversa

PERGUNTAS QUE A ATENDENTE SABE RESPONDER:
- Planos, preços, valores, mensalidades, diferenças entre planos
- Horários de funcionamento, horários de aulas, quadro de modalidades
- Estrutura, equipamentos, vestiário, armários, estacionamento, bicicletário
- Formas de pagamento (cartão, Pix, dinheiro, boleto, cheque) — primeira vez
- Gympass, Totalpass, convênios — qualquer pergunta
- Trancamento de plano, como funciona, quantos dias
- Cancelamento, carência, multa — primeira vez
- Avaliação física, consulta nutricional, dayuse, personal trainer
- Condições de saúde (hérnia, lesão, diabetes, hipertensão, gravidez, etc.)
- Idade, vergonha, medo de começar
- Luto, perda de familiar — a atendente acolhe
- Período de teste, semana experimental — a atendente oferece dayuse e aula experimental
- Cartão de outra pessoa — a atendente informa que pode com CPF do titular
- Objeção de preço (achar caro) — a atendente apresenta alternativas
- Preocupação com compromisso de 12 meses — a atendente explica trancamento
- Lead está avaliando opções ou comparando academias
- Qualquer pergunta que a atendente possa responder com base nas informações da academia

═══════════════════════════════════════

Últimas mensagens da conversa:
${historico.slice(-10).map((m) => (m.role === 'user' ? 'Lead' : 'Mila') + ': ' + m.content).join('\n')}

Última mensagem do lead: "${mensagemNova}"

Responda APENAS no formato:
RESPOSTA: SIM ou NAO
MOTIVO: [se SIM, qual gatilho específico ocorreu. Se NAO, deixe em branco]`;

  try {
    const completion = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 100,
      temperature: 0,
    });

    const texto = completion.choices[0]?.message?.content?.trim() || '';
    const escalar = /RESPOSTA:\s*SIM/i.test(texto);
    const motivoMatch = texto.match(/MOTIVO:\s*(.+)/i);
    const motivo = motivoMatch ? motivoMatch[1].trim() : null;

    if (escalar) {
      console.log(`🚨 Escalação detectada: ${motivo}`);
    }

    return { escalar, motivo };
  } catch (error) {
    console.error('❌ Erro ao detectar escalação:', error.message);
    return { escalar: false, motivo: null };
  }
}

// ─── DETECTAR AMBIGUIDADE ─────────────────────────────────────────────────────

export async function detectarAmbiguidade({ historico, mensagemNova }) {
  // Heurística: mensagens muito curtas ou respostas simples não precisam de checagem
  const limpo = mensagemNova.trim().toLowerCase();
  if (limpo.length < 8) return null;

  const respostasSimples = /^(sim|não|nao|ok|tá|ta|claro|pode|quero|anual|mensal|manhã|manha|noite|tarde|s|n)$/i;
  if (respostasSimples.test(limpo)) return null;

  const prompt = `Você analisa mensagens de WhatsApp enviadas para uma academia de ginástica chamada Cia do Fitness.

Avalie se a mensagem abaixo tem intenção CLARA ou AMBÍGUA para uma atendente virtual responder.

AMBÍGUA = a mensagem mistura dois assuntos diferentes OU pode ser interpretada de duas formas completamente distintas, tornando impossível saber exatamente o que o lead quer saber.

CLARA = tem uma intenção óbvia, mesmo que mal escrita ou com erro de português. Uma pergunta sobre um único assunto é CLARA, mesmo que informal.

Exemplos CLAROS (não perguntar):
- "quanto custa?" → clara, é sobre preço
- "tem estacionamento?" → clara, é sobre estacionamento
- "posso pagar no pix?" → clara, é sobre pagamento
- "tem professor?" → clara, é sobre equipe
- "quero me matricular" → clara, é intenção de matrícula
- "ola bom dia" → clara, é saudação
- "tem personal?" → clara, quer saber sobre personal trainer
- "tem aulas?" → clara, quer saber sobre aulas coletivas
- "vamos conversar" → clara, é abertura de conversa

Exemplos AMBÍGUOS (perguntar):
- "tem aulas com personal?" → ambíguo: quer saber sobre aulas coletivas ou sobre personal trainer?
- "como funciona o treino e o pagamento?" → ambíguo: dois assuntos distintos ao mesmo tempo
- "quero saber sobre horários e planos" → ambíguo: dois assuntos ao mesmo tempo

Histórico recente (para contexto):
${historico.slice(-4).map((m) => (m.role === 'user' ? 'Lead' : 'Mila') + ': ' + m.content).join('\n')}

Mensagem do lead: "${mensagemNova}"

Se AMBÍGUA, escreva uma pergunta de esclarecimento natural e curta no formato:
"Sou uma atendente virtual e quero te ajudar direitinho! Você quer saber sobre [interpretação A] ou sobre [interpretação B]?"

Responda APENAS no formato:
CLARA: SIM ou NAO
PERGUNTA: [se NAO, a pergunta de esclarecimento. Se SIM, deixe em branco]`;

  try {
    const completion = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 120,
      temperature: 0,
    });

    const texto = completion.choices[0]?.message?.content?.trim() || '';
    const eClara = /CLARA:\s*SIM/i.test(texto);
    if (eClara) return null;

    const perguntaMatch = texto.match(/PERGUNTA:\s*(.+)/i);
    const pergunta = perguntaMatch ? perguntaMatch[1].trim() : null;

    if (pergunta && pergunta.length > 10) {
      console.log(`🤔 Ambiguidade detectada: "${pergunta}"`);
      return pergunta;
    }
    return null;
  } catch (error) {
    console.error('❌ Erro ao detectar ambiguidade:', error.message);
    return null;
  }
}

export default openai;
