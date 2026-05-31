import { config, isTestMode } from '../config.js';
import {
  parsearWebhook,
  ehMensagemDeHumano,
  enviarTexto,
  enviarImagem,
} from '../services/zapi.js';
import {
  buscarOuCriarLead,
  buscarHistorico,
  salvarMensagem,
  ultimaMensagemFoiHumana,
  verificarDuplicata,
  verificarDuplicataConteudo,
  reativarLead,
  gravarLog,
} from '../services/supabase.js';
import { gerarResposta, classificarIntencao } from '../services/openai.js';
import { buscarPerfil, criarPerfilVazio, formatarPerfilParaPrompt, extrairEAtualizarPerfil, gerarResumoHandoff } from '../services/leadProfile.js';
import { montarSystemPrompt, formatarHistorico } from '../lib/promptBuilder.js';
// messageClassifier substituído por classificarIntencao
import { transferirParaHumano, encerrarLead } from '../lib/escalation.js';

// ─── URLS DE MÍDIA ────────────────────────────────────────────────────────────

const FLUXOGRAMA_URL    = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/fluxo_alunos_2026_tv_2%20(2).png';
const TABELA_PLANOS_URL = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/tabela%20cia%20do%20fitness.png';
const TABELA_COMPLETA_URL = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/compare%20os%20planos.png';
const QUADRO_AULAS_URL  = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/Quadro%20de%20Horario%20NOVO.png';

// ─── TEXTOS FIXOS ─────────────────────────────────────────────────────────────

const TEXTO_TABELA_PLANOS   = 'A Assinatura Mensal é R$ 149/mês, sem fidelidade, com acesso livre a musculação e aulas coletivas, avaliação física inclusa e adesão de R$ 69. A Assinatura Anual é R$ 119/mês, horário livre, aulas coletivas, avaliação física e consulta nutricional inclusas, sem taxa de adesão. Qual delas faz mais sentido pra você?';
const TEXTO_TABELA_COMPLETA = 'Aqui tá a comparação completa entre todos os planos. Qual deles faz mais sentido pro seu perfil?';
const TEXTO_QUADRO_AULAS    = 'Aqui tá a grade fixa das aulas coletivas Fast Training. São aulas de 30 minutos, alta intensidade. Você pode fazer mais de uma por dia.';
const TEXTO_FLUXO           = 'Essa tabela representa uma média de frequência dos alunos. Claro que há dias mais cheios e mais vazios. No geral, entre 10h e 15h e depois das 20h você encontra menos movimento.';
const TEXTO_REENVIO_QUADRO  = 'Já te enviei o quadro de aulas antes. Quer que eu mande novamente?';
const TEXTO_REENVIO_TABELA  = 'Já te enviei a tabela de planos antes. Quer que eu mande novamente?';
const TEXTO_REENVIO_FLUXO   = 'Já te enviei o fluxograma antes. Quer que eu mande novamente?';

// ─── DEBOUNCE ─────────────────────────────────────────────────────────────────
// Acumula mensagens em sequência rápida do mesmo número e processa tudo junto
// após DEBOUNCE_MS de silêncio.

const DEBOUNCE_MS = 2500;
const filaDebounce = new Map();

// ─── DETECÇÃO DE INTENÇÃO — REGEX ─────────────────────────────────────────────

const MODALIDADES_CONFIRMADAS = ['jump', 'combat', 'zumba', 'funcional', 'cardiomix', 'cardio mix'];

const TODAS_MODALIDADES = [
  'jump', 'combat', 'zumba', 'funcional', 'cardiomix', 'cardio mix',
  'ritbox', 'ritboxe', 'pilates', 'yoga', 'youga', 'ioga',
  'spinning', 'crossfit', 'muay thai', 'boxe', 'step',
  'hiit', 'tabata', 'localizada', 'alongamento', 'stretching',
  'barre', 'pole', 'aqua', 'natação', 'ciclismo', 'rpm',
  'body pump', 'body combat', 'body attack', 'kung fu', 'kungfu',
  'capoeira', 'jiu jitsu', 'jiujitsu', 'karate', 'judô', 'judo',
];

const REGEX = {
  contextoPlan:      /(econômic|economic|mensal|anual|plano|assinatura|clube\+|clube plus)/i,
  avaliando:         /(avaliando|comparando|pesquisando|ainda.{0,15}decid|ainda.{0,15}pens)/i,
  danca:             /(dança|danca|aula.{0,15}dan[çc]|forró|forro|sertanejo|ballet)/i,
  crianca:           /(\bfilho\b|\bfilha\b|\bcriança\b|\bcrianças\b|\bbebê\b|\bbebe\b|\bbaby\b)/i,
  bebe:              /(\bbebê\b|\bbebe\b|\bbaby\b)/i,
  personal:          /\bpersonal\b/i,
  gradeAulas:        /(quadro.{0,20}hor|grade.{0,20}hor|hor[aá]rio.{0,20}aula|hor[aá]rio.{0,20}coletiv|quadro.{0,20}aula|ver.{0,20}quadro|manda.{0,20}quadro|envia.{0,20}quadro)/i,
  termosAulas:       /(aula|aulas|coletiv|fast training|fast.training|modalidade|modalidades|jump|zumba|combat|funcional|cardiomix|cardio mix|quadro.{0,20}hor|grade.{0,20}hor|ver.{0,15}quadro|manda.{0,15}quadro|quero.{0,15}quadro|cad[eê].{0,15}quadro)/i,
  indicadoresGrade:  /(horário|hora|grade|quadro|quando|que dia|qual dia|dias|tabela|cronograma|tem.{0,10}aula|tem.{0,10}coletiv|que aulas|quais aulas|quais.{0,15}modalidade)/i,
  termosPlanos:      /(plano|planos|mensalidade|mensalidades|preç|valor|valores|diferen|quanto.{0,15}custa|quanto.{0,15}fica|quanto.{0,15}é|quanto.{0,15}sai|quanto.{0,15}paga)/i,
  indicadoresPedido: /(quer|queria|gostaria|preciso|me fala|me diz|me passa|me informa|me manda|me envia|me conta|conta sobre|fala sobre|saber|conhecer|informaç|opç|quais|que tipo|tem|tô interessad|sobre|me explica|como funciona|diferen[çc]|compara|comparar|qual|quanto|o que muda|o que inclui)/i,
  comparacaoTodos:   /(todos.{0,20}planos|comparaç|comparar|tabela.{0,20}planos|todos.{0,20}opç|ver todos|mostra todos|quais.{0,20}todos|entre todos|comparativo)/i,
  fluxo:             /(fluxo|movimento|lotad|chei|vazi|tranquil|fila|quantos alunos|horário.{0,20}vaz|horário.{0,20}tranquil|horário.{0,20}menos gente|menos movimentad|mais calmo|quando.{0,20}vaz|quando.{0,20}menos|horário.{0,20}cheio|horário.{0,20}lotad)/i,
  pagamentosInfo:    /(pix.{0,30}(anual|inteiro|vista)|dinheiro.{0,30}(anual|inteiro|vista)|pagar.{0,30}(anual|inteiro).{0,30}vista|quanto.{0,20}(pix|dinheiro|vista)|desconto.{0,20}(pix|dinheiro|vista)|pagar.{0,25}mensal.{0,25}(dinheiro|pix)|(dinheiro|pix).{0,25}mensal|mensalidade.{0,25}(dinheiro|pix)|mensal.{0,25}dinheiro|mensal.{0,25}pix|gympass|totalpass|tp2|gym.{0,5}pass)/i,
  confirmacaoReenvio: /^(sim|s|yes|pode|pode ser|manda|manda sim|por favor|por fav|claro|quero|quero sim|tá|ta|ok|isso|manda novamente|manda de novo|envia|envia sim|sim por favor|sim, por favor|pode mandar|vai|bora|isso aí|claro que sim|sim pode|vai lá|sim please|já pedi|pode sim|manda aí|manda sim|quero ver|ver sim|sim quero|quero sim|bora ver|pode mandar sim|sim já pedi|já havia pedido|já pedi sim|mandei sim|vai lá|sim manda|sim, manda|sim pode mandar|com certeza|certeza|lógico|lógico que sim|pode mandar|sim por gentileza|sim, por gentileza)$/i,
  crise:             /(suicid|me matar|quero morrer|n[ãa]o quero mais viver|tirar minha vida|automutila|me machucar|n[ãa]o aguento mais|acabar com tudo|desaparecer para sempre)/i,
};

// ─── FUNÇÕES AUXILIARES ───────────────────────────────────────────────────────

function primeiroNome(nomeCompleto) {
  if (!nomeCompleto) return null;
  return nomeCompleto.trim().split(' ')[0];
}

function detectarModalidadeMencionada(texto) {
  if (!texto) return null;
  const lower = texto.toLowerCase();
  for (const modalidade of TODAS_MODALIDADES) {
    if (lower.includes(modalidade)) return modalidade;
  }
  return null;
}

function modalidadeEConfirmada(modalidade) {
  if (!modalidade) return true;
  return MODALIDADES_CONFIRMADAS.some((m) => modalidade.includes(m) || m.includes(modalidade));
}

// Detecta perguntas curtas de horário quando o contexto imediato foi sobre aulas coletivas.
// Ex: Mila falou de Zumba -> lead perguntou "quais horários?" -> envia quadro, não fala de pico.
const REGEX_HORARIO_CURTO = /^(quais hor[aá]rios?|que hor[aá]rios?|qual hor[aá]rio|que horas?|quando tem|que dias?|quais dias?|qual dia|como [eé] o hor[aá]rio|tem hor[aá]rio|os hor[aá]rios?)\s*[?!.]?\s*$/i;
const REGEX_CONTEXTO_COLETIVA = /(jump|combat|zumba|funcional|cardiomix|cardio mix|fast training|aula coletiva|aulas coletivas|modalidade|modalidades|30 minutos)/i;

function ultimaMilaFalouDeColetiva(historico) {
  const ultima = ultimaSaidaMila(historico);
  if (!ultima?.conteudo) return false;
  return REGEX_CONTEXTO_COLETIVA.test(ultima.conteudo);
}

function isPerguntaCurtaDeHorarioAposColetiva(texto, historico) {
  if (!texto) return false;
  return REGEX_HORARIO_CURTO.test(texto.trim()) && ultimaMilaFalouDeColetiva(historico);
}

// Negações sobre aulas não devem disparar o quadro.
const REGEX_NEGACAO_AULA = /n[aã]o\s+tem|n[aã]o\s+t[eê]m|n[aã]o\s+[eé]|sem\s+aula|n[aã]o\s+oferece|n[aã]o\s+h[aá]|n[aã]o\s+possui/i;

// Extrai a modalidade de uma pergunta "tem aula de X?" / "vocês têm X?"
const REGEX_EXTRAIR_MODALIDADE = /(?:tem\s+aula\s+de|aula\s+de|aulas?\s+de|modalidade\s+de)\s+([a-záàâãéêíóôõúüçñ][a-záàâãéêíóôõúüçñ\s\-]{1,30}?)\s*[?!.]?\s*$/i;

// Modalidades confirmadas como texto para checagem
const MODALIDADES_CONFIRMADAS_TEXTO = ['jump', 'combat', 'zumba', 'funcional', 'cardiomix', 'cardio mix'];

function perguntaSobreModalidadeNaoConfirmada(texto) {
  // Negações saem direto — o bloco 18 trata
  if (REGEX_NEGACAO_AULA.test(texto)) return false;
  const match = REGEX_EXTRAIR_MODALIDADE.exec(texto.toLowerCase().trim());
  if (!match) return false;
  const modalidadePerguntada = match[1].trim();
  // Se é modalidade confirmada, deixa o quadro de aulas responder normalmente
  const eConfirmada = MODALIDADES_CONFIRMADAS_TEXTO.some((m) =>
    modalidadePerguntada.includes(m) || m.includes(modalidadePerguntada)
  );
  // Se é coletiva genericamente, deixa o quadro responder
  if (/coletiv/.test(modalidadePerguntada)) return false;
  return !eConfirmada;
}

function detectarPerguntaAulas(texto) {
  if (!texto) return false;
  if (REGEX.contextoPlan.test(texto)) return false;
  // Negações não disparam quadro
  if (REGEX_NEGACAO_AULA.test(texto)) return false;
  // "tem aula de X?" onde X não é modalidade confirmada → GPT responde, não quadro
  if (perguntaSobreModalidadeNaoConfirmada(texto)) return false;
  return REGEX.termosAulas.test(texto) && REGEX.indicadoresGrade.test(texto);
}

function detectarPerguntaPlanos(texto) {
  if (!texto) return false;
  if (REGEX.avaliando.test(texto)) return false;
  if (REGEX.gradeAulas.test(texto)) return false;
  return REGEX.termosPlanos.test(texto) && REGEX.indicadoresPedido.test(texto);
}

// ─── VERIFICAÇÕES DE HISTÓRICO ────────────────────────────────────────────────
// IMPORTANTE: usar APENAS os markers internos para verificar o que foi enviado.
// Nunca usar conteúdo de texto livre como critério — evita falsos positivos.

function tabelaJaFoiEnviada(historico) {
  return historico.some((m) =>
    m.conteudo === '[tabela planos enviada]' ||
    m.conteudo === '[tabela completa enviada]'
  );
}

function tabelaCompletaJaFoiEnviada(historico) {
  return historico.some((m) => m.conteudo === '[tabela completa enviada]');
}

function quadroAulasJaFoiEnviado(historico) {
  return historico.some((m) =>
    m.conteudo === '[quadro aulas enviado]' ||
    m.conteudo === '[quadro aulas reenviado]'
  );
}

function fluxogramaJaFoiEnviado(historico) {
  return historico.some((m) => m.conteudo === '[fluxograma enviado]');
}

function todosOsPlanosCitados(historico) {
  const texto = historico.map((m) => m.conteudo || '').join(' ').toLowerCase();
  return (
    /assinatura mensal|r\$\s*149/.test(texto) &&
    /assinatura anual|r\$\s*119/.test(texto) &&
    /econômic|econômica anual|r\$\s*95/.test(texto) &&
    /clube\+|clube plus|12x|r\$\s*109/.test(texto)
  );
}

function ultimaSaidaMila(historico) {
  return historico
    .filter((m) => m.direcao === 'saida' && m.origem === 'mila')
    .slice(-1)[0] || null;
}

function ultimaMensagemMilaFoiOfertaDeQuadro(historico) {
  const ultima = ultimaSaidaMila(historico);
  if (!ultima?.conteudo) return false;
  const c = ultima.conteudo;
  // Cobre tanto textos fixos quanto variações geradas pelo GPT
  // Ex: "Quer que eu envie o quadro de horários pra você?", "posso te mandar o quadro?", etc.
  // Regex principal: cobre variações do GPT com verbos + quadro
  const REGEX_OFERTA_QUADRO = /(?:quer(?:o|e)?|posso|mando|envio|te mando|te envio|mandar|enviar|ver|veja|confira).{0,40}quadro.{0,30}(?:hor[aá]rios?|aulas?|coletivas?)/i;
  // Regex secundária: cobre quando "quadro" aparece no final como convite
  const REGEX_OFERTA_QUADRO2 = /quadro.{0,30}(?:hor[aá]rios?|aulas?|coletivas?).{0,20}(?:\?|!)/i;
  // Padrões fixos do sistema
  const PADROES_FIXOS = [TEXTO_REENVIO_QUADRO, 'quadro de horários!', 'quadro de aulas!'];
  return REGEX_OFERTA_QUADRO.test(c) || REGEX_OFERTA_QUADRO2.test(c) || PADROES_FIXOS.some((p) => c.includes(p));
}

function ultimaMensagemMilaFoiOfertaDeFluxo(historico) {
  const ultima = ultimaSaidaMila(historico);
  if (!ultima?.conteudo) return false;
  const c = ultima.conteudo;
  const REGEX_OFERTA_FLUXO = /(?:quer(?:o|e)?|posso|mando|envio|te mando|te envio|mandar|enviar|ver|veja).{0,40}(?:fluxograma|fluxo|movimento|lotaç|horários? mais vazi)/i;
  const PADROES_FLUXO = [TEXTO_REENVIO_FLUXO, 'fluxograma antes', 'mande novamente', 'manda novamente'];
  return REGEX_OFERTA_FLUXO.test(c) || c === TEXTO_REENVIO_FLUXO || PADROES_FLUXO.some(p => c.includes(p));
}

function ultimaMensagemMilaFoiOfertaDeTabela(historico) {
  const ultima = ultimaSaidaMila(historico);
  if (!ultima?.conteudo) return false;
  const c = ultima.conteudo;
  // Regex: cobre variações do GPT com verbos + tabela/planos
  const REGEX_OFERTA_TABELA = /(?:quer(?:o|e)?|posso|mando|envio|te mando|te envio|mandar|enviar|ver|veja|confira).{0,40}(?:tabela|comparaç|planos?|opç)/i;
  const PADROES_FIXOS = [
    TEXTO_REENVIO_TABELA,
    'tabela comparativa', 'tabela de planos', 'tabela dos planos',
    'comparação completa', 'Qual delas faz mais sentido', 'Qual deles faz mais sentido'
  ];
  return REGEX_OFERTA_TABELA.test(c) || PADROES_FIXOS.some((p) => c.includes(p));
}

function dentroJanelaSilencio(lead) {
  if (lead.status !== 'transferido' || !lead.ultima_interacao_em) return false;
  const JANELA_HORAS = 2;
  const diff = (Date.now() - new Date(lead.ultima_interacao_em).getTime()) / (1000 * 60 * 60);
  return diff < JANELA_HORAS;
}

function diasDeSilencio(lead) {
  if (!lead.ultima_interacao_em) return 0;
  return (Date.now() - new Date(lead.ultima_interacao_em).getTime()) / (1000 * 60 * 60 * 24);
}

// ─── ENVIO DE MÍDIA COM TEXTO ─────────────────────────────────────────────────

// ─── REFORMULAÇÃO ANTI-REPETIÇÃO ─────────────────────────────────────────────
// Verifica se a última mensagem da Mila é similar ao texto que seria enviado.
// Se sim, pede ao GPT para reformular com outras palavras, mantendo o conteúdo.
// Isso garante que a Mila nunca soe robótica — mesmo em casos não previstos.

async function reformularSeNecessario(textoOriginal, historico) {
  const ultima = ultimaSaidaMila(historico);
  if (!ultima?.conteudo) return textoOriginal;

  try {
    // Usa GPT para detectar similaridade semântica
    const resultado = await classificarIntencao(
      textoOriginal,
      'Esta mensagem transmite o mesmo conteúdo e significado que a mensagem anterior?',
      ['SIM', 'NAO'],
      `Mensagem anterior: "${ultima.conteudo.slice(0, 150)}"`
    );

    if (resultado !== 'SIM') return textoOriginal;
    console.log('🔄 Reformulando resposta semanticamente similar...');

    const reformulada = await gerarResposta({
      systemPrompt: `Você é Mila, atendente da Cia do Fitness. Reformule a mensagem abaixo com outras palavras, mantendo exatamente o mesmo conteúdo e informações. Seja natural, breve e no estilo WhatsApp. NUNCA use as mesmas frases da mensagem anterior. Responda APENAS com a mensagem reformulada, sem explicações.

Mensagem anterior que você já enviou:
"${ultima.conteudo}"

Mensagem a reformular:
"${textoOriginal}"`,
      historico: [],
      mensagemNova: 'Reformule agora.',
    });
    return reformulada || textoOriginal;
  } catch (error) {
    console.error('❌ Erro ao reformular:', error.message);
    return textoOriginal;
  }
}

async function enviarTextoComVariacao(phone, lead, texto, historico) {
  const textoFinal = await reformularSeNecessario(texto, historico);
  await enviarTexto(phone, textoFinal);
  await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: textoFinal });
}

async function enviarMidiaComTexto(phone, lead, url, marker, texto, historico = []) {
  const textoFinal = historico.length > 0
    ? await reformularSeNecessario(texto, historico)
    : texto;
  await enviarImagem(phone, url, ' ');
  await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: marker });
  await enviarTexto(phone, textoFinal);
  await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: textoFinal });
}

// ─── WEBHOOK PRINCIPAL ────────────────────────────────────────────────────────

export async function processarWebhook(webhookBody) {
  console.log('📥 Webhook recebido');

  // Deduplicação por messageId
  const messageId = webhookBody.messageId || webhookBody.id || null;
  if (messageId) {
    const duplicata = await verificarDuplicata(messageId);
    if (duplicata) return;
  }

  // Ignorar grupos
  const phoneOrigem = webhookBody.phone || '';
  if (phoneOrigem.includes('-group') || phoneOrigem.includes('@g.us') || webhookBody.isGroup) {
    console.log(`🔕 Mensagem de grupo ignorada (${phoneOrigem})`);
    return;
  }

  // Mensagem enviada por humano (atendente) — só salva no histórico
  if (ehMensagemDeHumano(webhookBody)) {
    console.log('👤 Mensagem manual de humano detectada.');
    const phone = webhookBody.phone;
    if (phone) {
      try {
        const lead = await buscarOuCriarLead({ telefone: phone });
        const conteudo = webhookBody.text?.message || '[mensagem do humano]';
        await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'humano', conteudo });
      } catch (error) {
        console.error('Erro ao salvar mensagem do humano:', error.message);
        await gravarLog({ contexto: 'webhook', mensagem: 'Erro ao salvar mensagem do humano', telefone: webhookBody.phone, payload: { erro: error.message } });
      }
    }
    return;
  }

  const mensagem = parsearWebhook(webhookBody);
  if (!mensagem) {
    console.log('⚠️ Webhook ignorado (formato não reconhecido)');
    return;
  }

  const { phone, nome, conteudo, tipo } = mensagem;

  // Mídia (áudio/imagem) não passa pelo debounce
  if (tipo !== 'texto') {
    await processarMensagem(phone, nome, conteudo, tipo, webhookBody);
    return;
  }

  // Deduplicação por conteúdo
  const duplicataConteudo = await verificarDuplicataConteudo(phone, conteudo);
  if (duplicataConteudo) return;

  // Modo teste
  if (isTestMode() && phone !== config.testPhoneNumber) {
    console.log(`🧪 Modo teste ativo. Ignorando ${phone}.`);
    return;
  }

  // Debounce: acumula mensagens rápidas do mesmo número
  console.log(`⏳ Debounce iniciado para ${phone}: "${conteudo}"`);

  if (filaDebounce.has(phone)) {
    const fila = filaDebounce.get(phone);
    clearTimeout(fila.timer);
    fila.conteudos.push(conteudo);
    fila.timer = setTimeout(async () => {
      const conteudoFinal = fila.conteudos.join(' ');
      filaDebounce.delete(phone);
      console.log(`🔄 Debounce disparado para ${phone}: "${conteudoFinal}"`);
      await processarMensagem(phone, nome, conteudoFinal, tipo, webhookBody);
    }, DEBOUNCE_MS);
  } else {
    const fila = { conteudos: [conteudo], timer: null };
    fila.timer = setTimeout(async () => {
      const conteudoFinal = fila.conteudos.join(' ');
      filaDebounce.delete(phone);
      console.log(`🔄 Debounce disparado para ${phone}: "${conteudoFinal}"`);
      await processarMensagem(phone, nome, conteudoFinal, tipo, webhookBody);
    }, DEBOUNCE_MS);
    filaDebounce.set(phone, fila);
  }
}

// ─── PROCESSAMENTO DA MENSAGEM ────────────────────────────────────────────────

async function processarMensagem(phone, nome, conteudo, tipo, webhookBody) {

  // 1. Buscar ou criar lead
  let lead;
  try {
    lead = await buscarOuCriarLead({ telefone: phone, nome: primeiroNome(nome), campanhaOrigem: null });
  } catch (error) {
    console.error('❌ Erro ao buscar/criar lead:', error.message);
    await gravarLog({ contexto: 'supabase', mensagem: 'Erro ao buscar ou criar lead', telefone: phone, payload: { erro: error.message } });
    return;
  }

  // 2. Protocolo de crise
  if (REGEX.crise.test(conteudo)) {
    try {
      await enviarTexto(phone, `Fico feliz que você compartilhou isso comigo. Pensamentos assim são pesados de carregar, e faz sentido querer mudar algo na vida.\n\nSe precisar conversar com alguém especializado, o CVV atende 24h pelo 188 ou pelo chat em cvv.org.br, de graça e com sigilo total.\n\nAqui na Cia, o treino pode ser um caminho pra se cuidar também. Mas o mais importante agora é você estar bem.`);
      await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });
      await transferirParaHumano({ lead, motivo: 'situação de cuidado emocional' });
      await gravarLog({ nivel: 'aviso', contexto: 'webhook', mensagem: 'Protocolo de crise acionado', telefone: phone, leadId: lead.id });
    } catch (error) {
      console.error('❌ Erro ao tratar crise:', error.message);
    }
    return;
  }

  // 3. Áudio ou imagem — resposta fixa
  if (tipo === 'audio' || tipo === 'imagem') {
    await enviarTexto(phone, 'Oi! Não consigo ouvir áudios por aqui, mas pode me mandar em texto que te respondo na hora! 😊');
    await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo: `[${tipo}]`, tipo });
    return;
  }

  // 4. Lead encerrado — reativar
  if (lead.status === 'encerrado') {
    try {
      const { lead: leadReativado, retomandoContexto, diasPassados } = await reativarLead(lead);
      lead = leadReativado;
      await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });
      const systemPrompt = montarSystemPrompt();
      let historicoFormatado = [];
      if (retomandoContexto) {
        const historicoBruto = await buscarHistorico(lead.id, 20);
        historicoFormatado = formatarHistorico(historicoBruto.slice(0, -1));
      }
      const mensagemFinal = retomandoContexto
        ? `[CONTEXTO INTERNO: Este lead já conversou há ${diasPassados} dias e voltou. Cumprimente naturalmente e retome onde parou.]\n\nMensagem: ${conteudo}`
        : conteudo;
      const resposta = await gerarResposta({ systemPrompt, historico: historicoFormatado, mensagemNova: mensagemFinal });
      await enviarTexto(phone, resposta);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: resposta });
    } catch (error) {
      console.error('❌ Erro ao reabrir lead:', error.message);
      await gravarLog({ contexto: 'webhook', mensagem: 'Erro ao reabrir lead', telefone: phone, leadId: lead.id, payload: { erro: error.message } });
    }
    return;
  }

  // 5. Lead transferido — janela de silêncio ou humano ativo
  if (dentroJanelaSilencio(lead)) {
    await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });
    return;
  }

  if (lead.status === 'transferido') {
    const humanoAtivo = await ultimaMensagemFoiHumana(lead.id);
    if (humanoAtivo) {
      await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });
      return;
    }
    console.log(`🔄 Lead ${lead.id} retomando com Mila.`);
  }

  // 6. Salvar mensagem do lead
  await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });

  // Buscar perfil estruturado do lead (ou criar se não existe)
  let perfilLead = await buscarPerfil(lead.id);
  if (!perfilLead) {
    perfilLead = await criarPerfilVazio(lead.id);
  }

  // 7. CLASSIFICAÇÃO UNIFICADA — uma única chamada GPT substitui três decisões anteriores:
  //    classificarIntencao(fechar/encerrar) + detectarEscalacao + querFecharMatricula
  //    Economiza uma chamada GPT por mensagem e elimina decisões contraditórias.
  const decisao = await classificarIntencao(
    conteudo,
    'Qual é a ação correta para esta mensagem?',
    ['FECHAR', 'ENCERRAR', 'ESCALAR', 'CONTINUAR'],
    `FECHAR = lead quer assinar/matricular/pagar agora. Ex: "quero assinar", "como pago", "vou fechar".
ENCERRAR = lead desistiu clara e definitivamente. Ex: "não quero mais", "para de me chamar", "fechei em outro lugar".
ESCALAR = lead pediu explicitamente falar com humano, ou quer agendar visita com hora marcada E confirmou decisão, ou insistiu em desconto pela segunda vez.
CONTINUAR = qualquer outra coisa: perguntas, dúvidas, objeções, saudações, reclamações. Em caso de dúvida use CONTINUAR.`
  );
  console.log(`🎯 Decisão: ${decisao} para "${conteudo.slice(0, 50)}"`);

  // Buscar histórico — necessário para todos os caminhos seguintes
  const historicoBruto = await buscarHistorico(lead.id, 20);
  const historicoSemUltima = historicoBruto.slice(0, -1);
  const historicoFormatado = formatarHistorico(historicoSemUltima);

  if (decisao === 'FECHAR') {
    const resumo = await gerarResumoHandoff(lead, perfilLead, historicoFormatado).catch(() => null);
    await transferirParaHumano({ lead, motivo: 'lead quer fechar matrícula', resumo });
    return;
  }

  if (decisao === 'ENCERRAR') {
    await encerrarLead(lead, 'lead expressou desinteresse');
    return;
  }

  if (decisao === 'ESCALAR') {
    const resumo = await gerarResumoHandoff(lead, perfilLead, historicoFormatado).catch(() => null);
    await transferirParaHumano({ lead, motivo: 'gatilho detectado pelo classificador', resumo });
    return;
  }

  // CONTINUAR — processar normalmente
  const silencio = diasDeSilencio(lead);
  let mensagemComContexto = conteudo;
  if (silencio >= 2) {
    mensagemComContexto = `[CONTEXTO INTERNO: Lead ficou ${Math.floor(silencio)} dias sem responder. Cumprimente calorosa e naturalmente e retome onde parou.]\n\nMensagem: ${conteudo}`;
  }

  const ePerguntaPersonal    = REGEX.personal.test(conteudo);
  const ePerguntaInformativa = REGEX.pagamentosInfo.test(conteudo);

  // ─── RESPOSTAS FIXAS (por ordem de prioridade) ───────────────────────────

  // 13. Confirmação de reenvio — tabela de planos
  // ─── CONFIRMAÇÕES DE REENVIO VIA GPT ────────────────────────────────────────
  // Usa classificarIntencao em vez de regex para cobrir emojis, gírias e qualquer texto.
  // Ex: "👍", "vai lá", "manda logo", "obvio", "aff sim" — todos detectados corretamente.

  const ultimaMilaSaida = ultimaSaidaMila(historicoBruto);
  const ultimaMilaTexto = ultimaMilaSaida?.conteudo || '';

  const eOfertaTabela = ultimaMensagemMilaFoiOfertaDeTabela(historicoBruto);
  const eOfertaQuadro = ultimaMensagemMilaFoiOfertaDeQuadro(historicoBruto);
  const eOfertaFluxo = ultimaMensagemMilaFoiOfertaDeFluxo(historicoBruto);

  // Só chama o GPT se houver uma oferta ativa para confirmar
  let confirmouReenvio = 'INCERTO';
  if (eOfertaTabela || eOfertaQuadro || eOfertaFluxo) {
    confirmouReenvio = await classificarIntencao(
      conteudo,
      'O lead está confirmando que quer receber o conteúdo que foi oferecido?',
      ['SIM', 'NAO', 'INCERTO'],
      `A Mila ofereceu: "${ultimaMilaTexto.slice(0, 100)}"`
    );
    console.log(`🤔 Confirmação de reenvio: ${confirmouReenvio} para "${conteudo}"`);
  }

  if (eOfertaTabela && confirmouReenvio === 'SIM') {
    console.log('📋 Reenvio de tabela confirmado.');
    const usarCompleta = tabelaCompletaJaFoiEnviada(historicoBruto);
    try {
      await enviarMidiaComTexto(
        phone, lead,
        usarCompleta ? TABELA_COMPLETA_URL : TABELA_PLANOS_URL,
        usarCompleta ? '[tabela completa enviada]' : '[tabela planos enviada]',
        usarCompleta ? TEXTO_TABELA_COMPLETA : TEXTO_TABELA_PLANOS
      );
    } catch (error) { console.error('❌ Erro ao reenviar tabela:', error.message); }
    return;
  }

  // 14. Confirmação de reenvio — quadro de aulas
  if (eOfertaQuadro && confirmouReenvio === 'SIM') {
    console.log('🗓️ Reenvio de quadro confirmado.');
    try {
      await enviarMidiaComTexto(phone, lead, QUADRO_AULAS_URL, '[quadro aulas enviado]', TEXTO_QUADRO_AULAS, historicoBruto);
    } catch (error) { console.error('❌ Erro ao reenviar quadro:', error.message); }
    return;
  }

  // 15. Confirmação de reenvio — fluxograma
  if (eOfertaFluxo && confirmouReenvio === 'SIM') {
    console.log('📊 Reenvio de fluxograma confirmado.');
    try {
      await enviarMidiaComTexto(phone, lead, FLUXOGRAMA_URL, '[fluxograma enviado]', TEXTO_FLUXO, historicoBruto);
    } catch (error) { console.error('❌ Erro ao reenviar fluxograma:', error.message); }
    return;
  }

  // 16. Criança / bebê — regex + GPT como fallback
  const regexDetectouCrianca = REGEX.crianca.test(conteudo);
  let gptDetectouCrianca = false;
  let gptDetectouBebe = false;
  if (!regexDetectouCrianca) {
    const querCrianca = await classificarIntencao(
      conteudo,
      'O lead está perguntando sobre levar criança ou bebê para a academia?',
      ['CRIANCA', 'BEBE', 'NAO'],
      'CRIANCA = menciona filho, filha, criança, menor, garoto, garota, kid. BEBE = menciona bebê, bebe, baby, recém-nascido, nenê. NAO = outra coisa.'
    );
    gptDetectouCrianca = querCrianca === 'CRIANCA' || querCrianca === 'BEBE';
    gptDetectouBebe = querCrianca === 'BEBE';
  }
  if (regexDetectouCrianca || gptDetectouCrianca) {
    const eBebe = gptDetectouBebe || REGEX.bebe.test(conteudo);
    const resposta = eBebe
      ? 'Geralmente não é permitido levar bebê para a área de treino. Mas cada caso é um caso — recomendo passar pessoalmente e conversar com nossa equipe de direção pra ver se há alguma possibilidade. Eles vão te receber bem!'
      : 'Por motivo de segurança, criança não pode entrar na área de treino, mas pode aguardar no banco de espera na recepção, pertinho de você.';
    try {
      await enviarTextoComVariacao(phone, lead, resposta, historicoBruto);
    } catch (error) { console.error('❌ Erro ao enviar resposta criança:', error.message); }
    return;
  }

  // 17. Dança → Zumba — regex + GPT como fallback
  const regexDetectouDanca = REGEX.danca.test(conteudo);
  let gptDetectouDanca = false;
  if (!regexDetectouDanca) {
    const querDanca = await classificarIntencao(
      conteudo,
      'O lead está perguntando sobre aulas de dança?',
      ['SIM', 'NAO'],
      'SIM = menciona dança, ritmo, coreografia, baile, funk, samba, forró, pagode, axé, reggaeton ou qualquer estilo de dança. NAO = outra coisa.'
    );
    gptDetectouDanca = querDanca === 'SIM';
  }
  if (regexDetectouDanca || gptDetectouDanca) {
    console.log('💃 Dança detectada — redirecionando para Zumba.');
    const resposta = 'Aula de dança específica não temos, mas temos Zumba, que mistura dança e exercício num formato bem animado. São 30 minutos de Fast Training. Quer que eu envie o quadro de horários?';
    try {
      await enviarTextoComVariacao(phone, lead, resposta, historicoBruto);
    } catch (error) { console.error('❌ Erro ao enviar resposta dança:', error.message); }
    return;
  }

  // 18. Modalidade não confirmada (lista conhecida) ou modalidade desconhecida
  const modalidadeMencionada = detectarModalidadeMencionada(conteudo);
  if (modalidadeMencionada && !modalidadeEConfirmada(modalidadeMencionada)) {
    // Modalidade está na lista mas não é confirmada (spinning, pilates, yoga, etc.)
    console.log(`🚫 Modalidade não confirmada: ${modalidadeMencionada}`);
    const nomeModal = modalidadeMencionada.charAt(0).toUpperCase() + modalidadeMencionada.slice(1);
    const resposta = `${nomeModal} não temos. Nossas aulas coletivas são Jump, Combat, Zumba, Funcional e CardioMix, todas em formato Fast Training de 30 minutos. Quer que eu envie o quadro de horários?`;
    try {
      await enviarTextoComVariacao(phone, lead, resposta, historicoBruto);
    } catch (error) { console.error('❌ Erro ao enviar resposta modalidade:', error.message); }
    return;
  }

  // 18b. Modalidade completamente desconhecida — "tem aula de X?" onde X não está em nenhuma lista
  // Nesses casos deixamos o GPT responder usando a base de conhecimento.
  // O detectarPerguntaAulas já foi bloqueado para esse padrão, então o fluxo chega até o GPT.
  // Não precisa de bloco extra aqui — o GPT ao final do fluxo trata corretamente.

  // 19. Fluxo de alunos — regex + GPT como fallback
  const regexDetectouFluxo = REGEX.fluxo.test(conteudo);
  let gptDetectouFluxo = false;
  if (!regexDetectouFluxo) {
    const querFluxo = await classificarIntencao(
      conteudo,
      'O lead está perguntando sobre lotação, movimento ou horários mais vazios da academia?',
      ['SIM', 'NAO'],
      'SIM = quer saber quando a academia está vazia, cheia, tranquila, com menos gente. NAO = outra pergunta.'
    );
    gptDetectouFluxo = querFluxo === 'SIM';
  }
  if (regexDetectouFluxo || gptDetectouFluxo) {
    try {
      if (!fluxogramaJaFoiEnviado(historicoBruto)) {
        await enviarMidiaComTexto(phone, lead, FLUXOGRAMA_URL, '[fluxograma enviado]', TEXTO_FLUXO, historicoBruto);
      } else {
        await enviarTextoComVariacao(phone, lead, TEXTO_REENVIO_FLUXO, historicoBruto);
      }
    } catch (error) { console.error('❌ Erro ao enviar fluxograma:', error.message); }
    return;
  }

  // 20. Quadro de aulas
  if (!ePerguntaPersonal && (detectarPerguntaAulas(conteudo) || isPerguntaCurtaDeHorarioAposColetiva(conteudo, historicoBruto))) {
    try {
      if (!quadroAulasJaFoiEnviado(historicoBruto)) {
        await enviarMidiaComTexto(phone, lead, QUADRO_AULAS_URL, '[quadro aulas enviado]', TEXTO_QUADRO_AULAS, historicoBruto);
      } else {
        await enviarTextoComVariacao(phone, lead, TEXTO_REENVIO_QUADRO, historicoBruto);
      }
    } catch (error) { console.error('❌ Erro ao enviar quadro:', error.message); }
    return;
  }

  // 21. Tabela completa
  if (!ePerguntaPersonal && (REGEX.comparacaoTodos.test(conteudo) || todosOsPlanosCitados(historicoBruto)) && !tabelaCompletaJaFoiEnviada(historicoBruto)) {
    console.log('📊 Enviando tabela completa.');
    try {
      await enviarMidiaComTexto(phone, lead, TABELA_COMPLETA_URL, '[tabela completa enviada]', TEXTO_TABELA_COMPLETA, historicoBruto);
    } catch (error) { console.error('❌ Erro ao enviar tabela completa:', error.message); }
    return;
  }

  // 22. Tabela básica de planos — regex + GPT como fallback
  const regexDetectouPlanos = !ePerguntaPersonal && detectarPerguntaPlanos(conteudo) && !tabelaJaFoiEnviada(historicoBruto);
  let gptDetectouPlanos = false;
  if (!regexDetectouPlanos && !tabelaJaFoiEnviada(historicoBruto) && !ePerguntaPersonal) {
    const querPlanos = await classificarIntencao(
      conteudo,
      'O lead está pedindo informações sobre preços ou planos da academia?',
      ['SIM', 'NAO'],
      'SIM = quer saber valores, planos, mensalidade, quanto custa. NAO = qualquer outra pergunta.'
    );
    gptDetectouPlanos = querPlanos === 'SIM';
  }
  if (regexDetectouPlanos || gptDetectouPlanos) {
    console.log('📋 Enviando tabela básica.');
    try {
      await enviarMidiaComTexto(phone, lead, TABELA_PLANOS_URL, '[tabela planos enviada]', TEXTO_TABELA_PLANOS, historicoBruto);
    } catch (error) { console.error('❌ Erro ao enviar tabela básica:', error.message); }
    return;
  }

  // ─── RESPOSTA GPT ────────────────────────────────────────────────────────

  let resposta;
  try {
    const perfilContexto = formatarPerfilParaPrompt(perfilLead);
    const systemPrompt = montarSystemPrompt(perfilContexto);
    resposta = await gerarResposta({ systemPrompt, historico: historicoFormatado, mensagemNova: mensagemComContexto });
  } catch (error) {
    console.error('❌ Erro ao gerar resposta:', error.message);
    await gravarLog({ contexto: 'openai', mensagem: 'Erro ao gerar resposta', telefone: phone, leadId: lead.id, payload: { erro: error.message } });
    resposta = `Oi${lead.nome ? ', ' + lead.nome : ''}! Tive uma instabilidade aqui. Pode me chamar de novo em alguns minutos? 🙏`;
  }

  try {
    // Timing variável — simula raciocínio humano
    // Respostas curtas: 1s | médias: 2s | longas: 3s
    const tamanho = resposta.length;
    const delay = tamanho < 80 ? 1000 : tamanho < 200 ? 2000 : 3000;
    await new Promise(resolve => setTimeout(resolve, delay));

    await enviarTexto(phone, resposta);
    await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: resposta });
    console.log(`✅ Mila respondeu pro lead ${lead.id} (delay: ${delay}ms)`);

    // Extrair perfil em background a cada 3 mensagens — economiza tokens sem perder informação
    const totalMensagens = historicoBruto.length;
    if (totalMensagens % 3 === 0 || totalMensagens <= 3) {
      const historicoCompleto = [...historicoFormatado, { role: 'user', content: mensagemComContexto }, { role: 'assistant', content: resposta }];
      extrairEAtualizarPerfil(lead.id, historicoCompleto).catch((e) => console.error('❌ Extração de perfil:', e.message));
    }

  } catch (error) {
    console.error('❌ Erro ao enviar resposta:', error.message);
    await gravarLog({ contexto: 'zapi', mensagem: 'Erro ao enviar resposta', telefone: phone, leadId: lead.id, payload: { erro: error.message, resposta } });
  }
}
