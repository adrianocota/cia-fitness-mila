import OpenAI from 'openai';
import { config } from '../config.js';

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

/**
 * Gera resposta da Mila para uma conversa.
 *
 * @param {Object} params
 * @param {string} params.systemPrompt - O prompt do sistema (persona + regras + base de conhecimento)
 * @param {Array} params.historico - Array de mensagens da conversa [{role, content}]
 * @param {string} params.mensagemNova - A mensagem que o lead acabou de mandar
 * @returns {Promise<string>} A resposta da Mila
 */
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

    if (!resposta) {
      throw new Error('Resposta vazia da OpenAI');
    }

    // Log de uso pra você acompanhar custo
    const tokens = completion.usage;
    console.log(`💬 OpenAI: ${tokens.prompt_tokens} in + ${tokens.completion_tokens} out = ${tokens.total_tokens} tokens`);

    return resposta;
  } catch (error) {
    console.error('❌ Erro ao gerar resposta na OpenAI:', error.message);
    throw error;
  }
}

/**
 * Classifica a intenção da resposta do lead em uma de 3 categorias:
 * - 'evasiva': "depois falo", "vou pensar" → continua sequência de follow-up
 * - 'engajamento': pergunta real, interesse → pausa sequência
 * - 'encerramento': "não quero", "para de chamar" → para definitivamente
 *
 * @param {string} mensagemDoLead
 * @returns {Promise<'evasiva'|'engajamento'|'encerramento'>}
 */
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
    return 'engajamento'; // Fallback seguro
  }
}

/**
 * Detecta se a conversa atingiu um gatilho de escalação pro humano.
 *
 * @param {string} systemPrompt - Mesmo prompt da Mila (pra ela ter contexto)
 * @param {Array} historico - Histórico da conversa
 * @param {string} mensagemNova - Última mensagem do lead
 * @returns {Promise<{escalar: boolean, motivo: string|null}>}
 */
export async function detectarEscalacao({ historico, mensagemNova }) {
  const prompt = `Você analisa conversas entre lead e atendente virtual de uma academia. Decida se essa conversa deve ser transferida pra atendente humano agora.

GATILHOS DE TRANSFERÊNCIA (responda "SIM" se algum acontecer):
- Lead disse explicitamente que quer fechar matrícula ("quero fechar", "quero me matricular", "como começo")
- Lead pediu pra falar com pessoa ("quero falar com alguém", "passa pra um atendente")
- Lead pediu desconto e insistiu mesmo após resposta padrão
- Lead perguntou valor de multa de cancelamento e insistiu
- Lead fez reclamação grave
- Lead pediu pra agendar visita com hora marcada específica
- Lead tem condição médica complexa (não simples) que requer avaliação humana

NÃO É GATILHO (responda "NAO"):
- Lead só perguntou sobre planos
- Lead disse "vou pensar" ou outras respostas evasivas
- Lead fez perguntas gerais sobre a academia
- Lead mencionou objetivo (emagrecer, ganhar massa) sem agendamento concreto

Últimas mensagens da conversa:
${historico.slice(-6).map((m) => `${m.role === 'user' ? 'Lead' : 'Mila'}: ${m.content}`).join('\n')}

Última mensagem do lead: "${mensagemNova}"

Responda APENAS no formato:
RESPOSTA: SIM ou NAO
MOTIVO: [se SIM, qual gatilho. Se NAO, deixe em branco]`;

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
