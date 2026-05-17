import OpenAI from 'openai';
import { config } from '../config.js';

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

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

export async function detectarEscalacao({ historico, mensagemNova }) {
  const prompt = `Você analisa conversas entre lead e atendente virtual de uma academia. Decida se essa conversa deve ser transferida pra atendente humano AGORA.

CONTEXTO IMPORTANTE:
Leads de academia frequentemente chegam dizendo "quero fazer academia", "quero treinar", "quero me matricular", "quero começar" logo na primeira mensagem. Isso é comportamento NORMAL de entrada e NÃO é gatilho de transferência. A atendente virtual deve qualificar o lead primeiro antes de transferir.

GATILHOS REAIS DE TRANSFERÊNCIA (responda "SIM" apenas se um desses acontecer de forma clara e explícita):
- Lead pediu explicitamente pra falar com pessoa humana ("quero falar com alguém", "passa pra atendente", "me liga", "quero falar com a recepção")
- Lead quer agendar visita com hora marcada específica E confirmou que já decidiu ("posso ir amanhã às 15h pra me matricular")
- Lead manifestou intenção clara de fechar agora e perguntou como pagar ("como faço o pagamento?", "qual o link pra matricular?", "posso pagar hoje?", "quero assinar agora")
- Lead pediu desconto e insistiu mesmo após resposta padrão (segunda vez ou mais)
- Lead perguntou valor de multa de cancelamento e insistiu (segunda vez ou mais)
- Lead fez reclamação grave sobre a academia
- Lead perguntou algo que a atendente virtual claramente não sabe responder

NÃO É GATILHO — NUNCA transfira por esses motivos:
- Lead disse "quero fazer academia", "quero treinar", "quero começar", "quero me matricular" (entrada normal)
- Lead perguntou qual é o plano mais barato, mais em conta ou mais acessível (é qualificação, não fechamento)
- Lead perguntou sobre planos, preços, horários, modalidades, estrutura, equipamentos
- Lead fez objeção simples de preço ou horário
- Lead disse "vou pensar", "depois falo" ou respostas evasivas
- Lead mencionou objetivo (emagrecer, ganhar massa) sem pedir agendamento concreto
- Lead perguntou sobre professores, formação, estagiários, equipamentos, vestiário, estacionamento
- Lead está no início da conversa (primeiras 1-3 mensagens)
- Lead mencionou condição de saúde (hérnia, lesão, diabetes, hipertensão) — a atendente sabe responder
- Lead é idoso e mencionou a idade — a atendente sabe acolher
- Lead tem vergonha, medo de começar, ou baixa autoestima — a atendente deve acolher
- Lead mencionou evento de vida difícil (luto, perda de familiar, perda de pet, separação) — a atendente deve acolher
- Lead perguntou sobre período de teste, semana experimental, dias de graça — a atendente oferece dayuse e aula experimental
- Lead perguntou sobre agendamento de avaliação sem confirmar decisão de matrícula

Últimas mensagens da conversa:
${historico.slice(-6).map((m) => `${m.role === 'user' ? 'Lead' : 'Mila'}: ${m.content}`).join('\n')}

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

    return { escalar, motivo };
  } catch (error) {
    console.error('❌ Erro ao detectar escalação:', error.message);
    return { escalar: false, motivo: null };
  }
}

export default openai;
