import { classificarResposta } from '../services/openai.js';

/**
 * Padrões simples (sem IA) pra captura rápida de intenções óbvias.
 * Usar isso antes de chamar a IA economiza dinheiro.
 */
const PADROES_ENCERRAMENTO = [
  /n[ãa]o tenho interesse/i,
  /n[ãa]o quero (mais|nada)/i,
  /para de me chamar/i,
  /tira meu n[úu]mero/i,
  /j[áa] fechei (em outro|com outra)/i,
  /desisti/i,
  /n[ãa]o vai dar/i,
  /sair desse zap/i,
];

const PADROES_EVASIVO = [
  /depois (eu )?falo/i,
  /vou (ver|pensar|conversar)/i,
  /t[ôo] ocupad[ao]/i,
  /agora n[ãa]o/i,
  /^obrigad[ao]$/i,
  /^valeu$/i,
];

const PADROES_FECHAMENTO = [
  /quero (fechar|me matricular|matricular|começar)/i,
  /como (eu )?fa[çc]o pra (começar|fechar|matricular)/i,
  /quero falar com (algu[ée]m|atendente|pessoa)/i,
  /me passa pra (algu[ée]m|atendente|recepcionista)/i,
];

/**
 * Classifica rapidamente sem IA (heurísticas).
 * Retorna null se não tiver certeza.
 *
 * @param {string} texto
 * @returns {'evasiva'|'engajamento'|'encerramento'|'fechamento'|null}
 */
export function classificarRapido(texto) {
  if (!texto || typeof texto !== 'string') return null;
  const t = texto.trim();

  if (PADROES_FECHAMENTO.some((r) => r.test(t))) return 'fechamento';
  if (PADROES_ENCERRAMENTO.some((r) => r.test(t))) return 'encerramento';
  if (PADROES_EVASIVO.some((r) => r.test(t))) return 'evasiva';

  return null; // Não classificou, requer análise por IA
}

/**
 * Classificação completa: tenta heurística primeiro, IA depois.
 *
 * @param {string} texto
 * @returns {Promise<'evasiva'|'engajamento'|'encerramento'|'fechamento'>}
 */
export async function classificarMensagem(texto) {
  // Tenta padrão rápido primeiro (gratuito)
  const rapido = classificarRapido(texto);
  if (rapido) {
    console.log(`🎯 Classificação rápida: ${rapido}`);
    return rapido;
  }

  // Fallback pra IA
  const categoria = await classificarResposta(texto);
  console.log(`🤖 Classificação IA: ${categoria}`);
  return categoria;
}

/**
 * Verifica se uma mensagem indica que o lead quer fechar matrícula.
 * Atalho útil pra escalação automática.
 */
export function querFecharMatricula(texto) {
  return classificarRapido(texto) === 'fechamento';
}
