import { classificarResposta } from '../services/openai.js';

const PADROES_OBJECAO_COM_SOLUCAO = [
  /n[ãa]o tenho (o )?limite/i,
  /n[ãa]o tenho limit/i,
  /limit[e]?.{0,20}cart[ãa]o/i,
  /cart[ãa]o.{0,20}limit/i,
  /n[ãa]o tenho.{0,20}R\$/i,
  /n[ãa]o (tenho|consigo).{0,20}plano anual/i,
  /n[ãa]o tenho.{0,20}1[.,]4/i,
];

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
  /quero (fechar|me matricular|matricular)/i,
  /como (eu )?fa[çc]o pra (fechar|matricular)/i,
  /quero falar com (algu[ée]m|atendente|pessoa)/i,
  /me passa pra (algu[ée]m|atendente|recepcionista)/i,
  /quero (pagar|assinar|contratar)/i,
];

export function classificarRapido(texto) {
  if (!texto || typeof texto !== 'string') return null;
  const t = texto.trim();

  // Objeções com solução disponível — NUNCA classificar como encerramento
  if (PADROES_OBJECAO_COM_SOLUCAO.some((r) => r.test(t))) return null;

  if (PADROES_FECHAMENTO.some((r) => r.test(t))) return 'fechamento';
  if (PADROES_ENCERRAMENTO.some((r) => r.test(t))) return 'encerramento';
  if (PADROES_EVASIVO.some((r) => r.test(t))) return 'evasiva';
  return null;
}

export async function classificarMensagem(texto) {
  const rapido = classificarRapido(texto);
  if (rapido) {
    console.log(`🎯 Classificação rápida: ${rapido}`);
    return rapido;
  }
  const categoria = await classificarResposta(texto);
  console.log(`🤖 Classificação IA: ${categoria}`);
  return categoria;
}

export function querFecharMatricula(texto) {
  return classificarRapido(texto) === 'fechamento';
}
