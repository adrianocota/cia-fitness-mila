import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

// __dirname não existe em ES modules, então fazemos manualmente
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Caminho da pasta data (relativo a este arquivo)
const DATA_DIR = path.join(__dirname, '..', 'data');

/**
 * Cache simples pra não ler os arquivos de markdown a cada mensagem.
 * Recarrega automaticamente se o arquivo mudar (em produção, requer redeploy).
 */
let cacheBaseConhecimento = null;
let cacheOfertaVigente = null;

function lerArquivo(nomeArquivo) {
  const caminho = path.join(DATA_DIR, nomeArquivo);
  try {
    return fs.readFileSync(caminho, 'utf8');
  } catch (error) {
    console.error(`❌ Erro ao ler ${nomeArquivo}:`, error.message);
    throw new Error(`Arquivo ${nomeArquivo} não encontrado em ${DATA_DIR}`);
  }
}

function getBaseConhecimento() {
  if (!cacheBaseConhecimento) {
    cacheBaseConhecimento = lerArquivo('base_conhecimento.md');
  }
  return cacheBaseConhecimento;
}

function getOfertaVigente() {
  if (!cacheOfertaVigente) {
    cacheOfertaVigente = lerArquivo('oferta_vigente.md');
  }
  return cacheOfertaVigente;
}

/**
 * Monta o prompt do sistema que vai pra OpenAI.
 * Junta a base de conhecimento + oferta vigente + instruções operacionais.
 *
 * @returns {string} O prompt completo pro modelo
 */
export function montarSystemPrompt() {
  const baseConhecimento = getBaseConhecimento();
  const ofertaVigente = getOfertaVigente();

  return `Você é Mila, atendente virtual da Cia do Fitness. Siga RIGOROSAMENTE as instruções abaixo.

═══════════════════════════════════════════════════════
BASE DE CONHECIMENTO (informações da Cia, como você se comporta, exemplos de resposta):
═══════════════════════════════════════════════════════

${baseConhecimento}

═══════════════════════════════════════════════════════
CAMPANHA ATUALMENTE VIGENTE (o que o lead acabou de ver no anúncio):
═══════════════════════════════════════════════════════

${ofertaVigente}

═══════════════════════════════════════════════════════
INSTRUÇÕES OPERACIONAIS FINAIS:
═══════════════════════════════════════════════════════

- Responda SEMPRE em português brasileiro natural, como em WhatsApp.
- Mantenha respostas CURTAS (1-3 frases na maioria das vezes). WhatsApp não é e-mail.
- Use o nome do lead quando relevante, mas não em toda mensagem.
- NUNCA invente informações que não estejam nesta base.
- NUNCA use travessões (—) nem traços longos (–). Use vírgula, ponto, dois pontos.
- Se o lead pedir algo que requer humano (fechar matrícula, agendar com hora, etc.), conduza pra transferência de forma natural.
- Sua única função é atender este lead. Foque nele.
`.trim();
}

/**
 * Converte o histórico de mensagens do banco em formato OpenAI.
 *
 * Mensagens com direcao='entrada' viram role='user' (lead falou).
 * Mensagens com direcao='saida' viram role='assistant' (Mila respondeu).
 *
 * @param {Array} mensagens - Mensagens vindas do Supabase
 * @returns {Array} Array no formato esperado pela OpenAI
 */
export function formatarHistorico(mensagens) {
  return mensagens.map((m) => ({
    role: m.direcao === 'entrada' ? 'user' : 'assistant',
    content: m.conteudo,
  }));
}

/**
 * Limpa cache (útil em desenvolvimento e quando arquivos forem atualizados via webhook do GitHub)
 */
export function limparCache() {
  cacheBaseConhecimento = null;
  cacheOfertaVigente = null;
  console.log('✅ Cache de prompt limpo');
}
