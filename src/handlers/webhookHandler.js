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
import { transferirParaHumano, encerrarLead } from '../lib/escalation.js';
import { buscarAlunoAtivoPorTelefone } from '../crm/evoService.js';

// ─── URLS DE MÍDIA ────────────────────────────────────────────────────────────

const FLUXOGRAMA_URL      = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/fluxo_alunos_2026_tv_2%20(2).png';
const TABELA_PLANOS_URL   = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/tabela%20cia%20do%20fitness.png';
const TABELA_COMPLETA_URL = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/compare%20os%20planos.png';
const QUADRO_AULAS_URL    = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/Quadro%20de%20Horario%20NOVO.png';

// ─── TEXTOS FIXOS ─────────────────────────────────────────────────────────────

const TEXTO_TABELA_PLANOS   = 'A Assinatura Mensal é R$ 149/mês, sem fidelidade, com acesso livre a musculação e aulas coletivas, avaliação física inclusa e adesão de R$ 69. A Assinatura Anual é R$ 119/mês, horário livre, aulas coletivas, avaliação física e consulta nutricional inclusas, sem taxa de adesão. Qual delas faz mais sentido pra você?';
const TEXTO_TABELA_COMPLETA = 'Aqui tá a comparação completa entre todos os planos. Qual deles faz mais sentido pro seu perfil?';
const TEXTO_QUADRO_AULAS    = 'Aqui tá a grade fixa das aulas coletivas Fast Training. São aulas de 30 minutos, alta intensidade. Você pode fazer mais de uma por dia.';
const TEXTO_FLUXO           = 'Essa tabela representa uma média de frequência dos alunos. Claro que há dias mais cheios e mais vazios. No geral, entre 10h e 15h e depois das 20h você encontra menos movimento.';
const TEXTO_REENVIO_QUADRO  = 'Já te enviei o quadro de aulas antes. Quer que eu mande novamente?';
const TEXTO_REENVIO_TABELA  = 'Já te enviei a tabela de planos antes. Quer que eu mande novamente?';
const TEXTO_REENVIO_FLUXO   = 'Já te enviei o fluxograma antes. Quer que eu mande novamente?';

// ─── PADRÕES DE OFERTA DE MATERIAL (última msg Mila) ─────────────────────────
// Usados pelo guard de confirmação de material (passo 12b)

const REGEX_OFERTA_QUADRO = /(quer que eu (te )?envie|quer que eu mande|posso (te )?mandar|mando o quadro|envio o quadro|quadro de (horário|aula)|grade (de aula|fixa))/i;
const REGEX_OFERTA_TABELA = /(quer que eu (te )?envie|quer que eu mande|posso (te )?mandar|mando a tabela|envio a tabela|tabela de planos|comparar os planos|tabela completa)/i;
const REGEX_OFERTA_FLUXO  = /(quer que eu (te )?envie|quer que eu mande|posso (te )?mandar|fluxograma|tabela de movimento|horário.{0,20}vazio|menos movimento)/i;

// ─── DEBOUNCE ─────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 2500;
const filaDebounce = new Map();

// ─── REGEX MÍNIMOS ────────────────────────────────────────────────────────────

const REGEX = {
  crise:    /(suicid|me matar|quero morrer|n[ãa]o quero mais viver|tirar minha vida|automutila|me machucar|n[ãa]o aguento mais|acabar com tudo|desaparecer para sempre)/i,
  personal: /\bpersonal\b/i,
  pagamentosInfo: /(pix.{0,30}(anual|inteiro|vista)|dinheiro.{0,30}(anual|inteiro|vista)|pagar.{0,30}(anual|inteiro).{0,30}vista|quanto.{0,20}(pix|dinheiro|vista)|desconto.{0,20}(pix|dinheiro|vista)|gympass|totalpass|tp2|gym.{0,5}pass)/i,
  confirmacaoReenvio: /^(sim|s|pode|manda|manda sim|quero|quero sim|claro|vai|ok|isso|por favor|pfv|pf|manda de novo|envia|envia sim)$/i,
  confirmacaoMaterial: /^(sim|s|pode|manda|manda sim|quero|quero sim|claro|vai|ok|isso|por favor|pfv|pf|manda de novo|envia|envia sim|pode mandar|manda aí|vai lá|manda pra mim)$/i,
};

// ─── FUNÇÕES AUXILIARES ───────────────────────────────────────────────────────

function primeiroNome(nomeCompleto) {
  if (!nomeCompleto) return null;
  return nomeCompleto.trim().split(' ')[0];
}

function ultimaSaidaMila(historico) {
  return historico
    .filter((m) => m.direcao === 'saida' && m.origem === 'mila')
    .slice(-1)[0] || null;
}

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

// ─── GUARD DE CONFIRMAÇÃO DE REENVIO ─────────────────────────────────────────
// Só dispara quando:
//   1. A mensagem do lead é uma confirmação curta (sim, manda, quero, etc.)
//   2. A última mensagem da Mila foi especificamente uma oferta de reenvio

async function tentarReenvio(phone, lead, conteudo, historicoBruto) {
  if (!REGEX.confirmacaoReenvio.test(conteudo.trim())) return false;

  const ultima = ultimaSaidaMila(historicoBruto);
  if (!ultima?.conteudo) return false;

  const msg = ultima.conteudo;

  if (msg === TEXTO_REENVIO_TABELA) {
    const url = tabelaCompletaJaFoiEnviada(historicoBruto) ? TABELA_COMPLETA_URL : TABELA_PLANOS_URL;
    const marker = tabelaCompletaJaFoiEnviada(historicoBruto) ? '[tabela completa enviada]' : '[tabela planos enviada]';
    const texto = tabelaCompletaJaFoiEnviada(historicoBruto) ? TEXTO_TABELA_COMPLETA : TEXTO_TABELA_PLANOS;
    await enviarImagem(phone, url, ' ');
    await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: marker });
    await enviarTexto(phone, texto);
    await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: texto });
    console.log(`🔁 Reenvio tabela para lead ${lead.id}`);
    return true;
  }

  if (msg === TEXTO_REENVIO_QUADRO) {
    await enviarImagem(phone, QUADRO_AULAS_URL, ' ');
    await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: '[quadro aulas reenviado]' });
    await enviarTexto(phone, TEXTO_QUADRO_AULAS);
    await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: TEXTO_QUADRO_AULAS });
    console.log(`🔁 Reenvio quadro aulas para lead ${lead.id}`);
    return true;
  }

  if (msg === TEXTO_REENVIO_FLUXO) {
    await enviarImagem(phone, FLUXOGRAMA_URL, ' ');
    await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: '[fluxograma enviado]' });
    await enviarTexto(phone, TEXTO_FLUXO);
    await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: TEXTO_FLUXO });
    console.log(`🔁 Reenvio fluxograma para lead ${lead.id}`);
    return true;
  }

  return false;
}

// ─── GUARD DE CONFIRMAÇÃO DE MATERIAL (novo) ─────────────────────────────────
// Dispara quando:
//   1. A mensagem do lead é uma confirmação curta ("pode mandar", "manda", "sim", etc.)
//   2. A última mensagem da Mila continha oferta de envio de material (quadro/tabela/fluxo)
//      MAS não era uma oferta de reenvio explícita (esse caso é tratado por tentarReenvio)
// Objetivo: evitar que o classificador interprete "pode mandar" como FECHAR

async function tentarEnvioMaterial(phone, lead, conteudo, historicoBruto) {
  if (!REGEX.confirmacaoMaterial.test(conteudo.trim())) return false;

  const ultima = ultimaSaidaMila(historicoBruto);
  if (!ultima?.conteudo) return false;

  const msg = ultima.conteudo;

  // Não interceptar se já foi tratado pelo guard de reenvio (ofertas explícitas)
  if (
    msg === TEXTO_REENVIO_TABELA ||
    msg === TEXTO_REENVIO_QUADRO ||
    msg === TEXTO_REENVIO_FLUXO
  ) return false;

  // Mila ofereceu o quadro de aulas e ainda não foi enviado
  if (REGEX_OFERTA_QUADRO.test(msg) && !quadroAulasJaFoiEnviado(historicoBruto)) {
    await enviarImagem(phone, QUADRO_AULAS_URL, ' ');
    await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: '[quadro aulas enviado]' });
    await enviarTexto(phone, TEXTO_QUADRO_AULAS);
    await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: TEXTO_QUADRO_AULAS });
    console.log(`📋 Guard material: quadro de aulas enviado para lead ${lead.id}`);
    return true;
  }

  // Mila ofereceu a tabela completa e ainda não foi enviada
  if (REGEX_OFERTA_TABELA.test(msg) && !tabelaCompletaJaFoiEnviada(historicoBruto)) {
    const url = tabelaJaFoiEnviada(historicoBruto) ? TABELA_COMPLETA_URL : TABELA_PLANOS_URL;
    const marker = tabelaJaFoiEnviada(historicoBruto) ? '[tabela completa enviada]' : '[tabela planos enviada]';
    const texto = tabelaJaFoiEnviada(historicoBruto) ? TEXTO_TABELA_COMPLETA : TEXTO_TABELA_PLANOS;
    await enviarImagem(phone, url, ' ');
    await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: marker });
    await enviarTexto(phone, texto);
    await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: texto });
    console.log(`📋 Guard material: tabela enviada para lead ${lead.id}`);
    return true;
  }

  // Mila ofereceu o fluxograma e ainda não foi enviado
  if (REGEX_OFERTA_FLUXO.test(msg) && !fluxogramaJaFoiEnviado(historicoBruto)) {
    await enviarImagem(phone, FLUXOGRAMA_URL, ' ');
    await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: '[fluxograma enviado]' });
    await enviarTexto(phone, TEXTO_FLUXO);
    await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: TEXTO_FLUXO });
    console.log(`📋 Guard material: fluxograma enviado para lead ${lead.id}`);
    return true;
  }

  return false;
}

// ─── REFORMULAÇÃO ANTI-REPETIÇÃO ─────────────────────────────────────────────

async function reformularSeNecessario(textoOriginal, historico) {
  const ultima = ultimaSaidaMila(historico);
  if (!ultima?.conteudo) return textoOriginal;

  const identico = ultima.conteudo.trim() === textoOriginal.trim();
  const normalize = (s) => s.toLowerCase().replace(/[^a-záàâãéêíóôõúüç\s]/g, '').trim();
  const wordsA = new Set(normalize(ultima.conteudo).split(/\s+/));
  const wordsB = normalize(textoOriginal).split(/\s+/);
  const matches = wordsB.filter(w => wordsA.has(w)).length;
  const similaridade = matches / Math.max(wordsA.size, wordsB.length);
  const muitoSimilar = similaridade > 0.7;

  if (!identico && !muitoSimilar) return textoOriginal;

  console.log(`🔄 Reformulando (${identico ? 'idêntico' : 'similar ' + similaridade.toFixed(2)})`);
  try {
    const reformulada = await gerarResposta({
      systemPrompt: `Você é Mila, atendente da Cia do Fitness. Reformule a mensagem abaixo com outras palavras, mantendo exatamente o mesmo conteúdo. Seja natural, breve e no estilo WhatsApp brasileiro. Responda APENAS com a mensagem reformulada, sem explicações, sem aspas.

Mensagem anterior: "${ultima.conteudo}"
Mensagem a reformular: "${textoOriginal}"`,
      historico: [],
      mensagemNova: 'Reformule agora.',
    });
    return reformulada || textoOriginal;
  } catch (e) {
    return textoOriginal;
  }
}

async function enviarTextoComVariacao(phone, lead, texto, historico) {
  const textoFinal = await reformularSeNecessario(texto, historico);
  await enviarTexto(phone, textoFinal);
  await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: textoFinal });
}

async function enviarMidiaComTexto(phone, lead, url, marker, texto, historico = []) {
  const textoFinal = historico.length > 0 ? await reformularSeNecessario(texto, historico) : texto;
  await enviarImagem(phone, url, ' ');
  await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: marker });
  await enviarTexto(phone, textoFinal);
  await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: textoFinal });
}

// ─── CLASSIFICADOR UNIFICADO COM CONTEXTO ────────────────────────────────────

async function classificarIntencaoComContexto(conteudo, historico, statusLead) {
  const ultimas = historico.slice(-6).map(m => {
    const quem = m.origem === 'mila' ? 'Mila' : 'Lead';
    return `${quem}: ${m.conteudo}`;
  }).join('\n');

  const intencoes = statusLead === 'matriculado'
    ? ['ALUNO_DUVIDA', 'ENCERRAR', 'ESCALAR', 'CONTINUAR']
    : [
        'FECHAR', 'ENCERRAR', 'ESCALAR', 'TABELA_COMPLETA', 'TABELA_BASICA',
        'QUADRO_AULAS', 'FLUXO', 'DAYUSE', 'CRIANCA', 'BEBE', 'MEDICAMENTO',
        'DANCA', 'MODALIDADE_NAO_TEMOS', 'CONTINUAR',
      ];

  const regrasAluno = statusLead === 'matriculado' ? `
ATENÇÃO: Este lead já é um ALUNO MATRICULADO. Use apenas as intenções abaixo:

ALUNO_DUVIDA = aluno tem dúvida operacional (horário, aula, plano, cancelamento, etc).
ENCERRAR = aluno pediu para parar de receber mensagens.
ESCALAR = aluno pediu para falar com humano ou tem reclamação grave.
CONTINUAR = qualquer outra coisa, inclusive saudações.
` : `
REGRAS DE CLASSIFICAÇÃO:

FECHAR = lead confirma intenção de pagar/assinar AGORA de forma inequívoca. Ex: "quero assinar", "como pago", "vou fechar", "manda o link pra pagar", "quero fazer a matrícula agora".
NÃO É FECHAR — use CONTINUAR para: "posso me matricular hoje?", "dá pra começar hoje?", "como funciona a matrícula?", "posso iniciar e depois fazer avaliação?", "posso começar antes da avaliação?", "quando posso começar?", "preciso de atestado?", "o que preciso pra me matricular?", "como funciona o primeiro dia?", "pode mandar", "manda", "sim", "pode", "claro", "vai", "ok" quando em resposta a uma oferta de envio de material — essas são confirmações de recebimento, não intenção de pagamento.

ENCERRAR = lead desistiu clara e definitivamente. Ex: "não quero mais", "para de me chamar", "fechei em outro lugar".
ESCALAR = lead pediu explicitamente falar com humano, quer agendar visita com hora marcada e confirmou, ou insistiu em desconto pela segunda vez.
TABELA_COMPLETA = lead quer comparar TODOS os planos ou pede a tabela/quadro comparativo. Ex: "qual a vantagem de cada?", "me mostra todos os planos", "qual é melhor?", "me manda o quadro dos planos", "quero ver os planos comparativos", "aqueles dois planos comparativos", "manda a tabela completa", "qual a diferença entre os planos?".
TABELA_BASICA = lead pergunta sobre preço/planos de forma direta e genérica, SEM pedir comparação e SEM ser day use. Ex: "quanto custa?", "qual o preço?", "tem mensalidade?".
QUADRO_AULAS = lead quer ver o quadro/grade/horários das aulas coletivas. Ex: "manda o quadro de horários", "quais os horários das aulas", "quando tem aula?".
FLUXO = lead quer saber sobre lotação ou horários mais vazios.
DAYUSE = lead quer visitar ou experimentar por um dia. Ex: "quero conhecer antes", "tem day use?", "qual a diária?".
CRIANCA = lead pergunta sobre trazer filho, criança (não bebê).
BEBE = lead pergunta sobre trazer bebê, nenê, recém-nascido.
MEDICAMENTO = lead menciona remédio ou medicamento de qualquer tipo.
DANCA = lead pergunta sobre aula de dança.
MODALIDADE_NAO_TEMOS = lead pergunta sobre modalidade que não oferecemos (pilates, yoga, natação, etc).
CONTINUAR = tudo que não se encaixa acima. EM CASO DE DÚVIDA: use CONTINUAR.`;

  const resultado = await classificarIntencao(
    conteudo,
    'Qual é a intenção desta mensagem considerando o contexto da conversa?',
    intencoes,
    `Você é um classificador de intenções para uma academia de ginástica. Analise a mensagem do lead considerando TODO o contexto da conversa abaixo.

STATUS DO LEAD: ${statusLead}

CONTEXTO DA CONVERSA (mais recente embaixo):
${ultimas || '(início da conversa)'}

MENSAGEM ATUAL DO LEAD: "${conteudo}"

${regrasAluno}`
  );

  console.log(`🧠 Intenção classificada: ${resultado} para "${conteudo.slice(0, 60)}" (status: ${statusLead})`);
  return resultado;
}

// ─── WEBHOOK PRINCIPAL ────────────────────────────────────────────────────────

export async function processarWebhook(webhookBody) {
  console.log('📥 Webhook recebido');

  if (webhookBody.fromMe === true) {
    console.log('🔕 fromMe=true — disparo próprio ignorado');
    return;
  }

  const messageId = webhookBody.messageId || webhookBody.id || null;
  if (messageId) {
    const duplicata = await verificarDuplicata(messageId);
    if (duplicata) return;
  }

  const phoneOrigem = webhookBody.phone || '';
  if (phoneOrigem.includes('-group') || phoneOrigem.includes('@g.us') || webhookBody.isGroup) {
    console.log(`🔕 Grupo ignorado (${phoneOrigem})`);
    return;
  }

  if (ehMensagemDeHumano(webhookBody)) {
    const phone = webhookBody.phone;
    if (phone) {
      try {
        const lead = await buscarOuCriarLead({ telefone: phone });
        if (!lead) return;
        const conteudo = webhookBody.text?.message || '[mensagem do humano]';
        await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'humano', conteudo });
      } catch (error) {
        await gravarLog({ contexto: 'webhook', mensagem: 'Erro ao salvar mensagem do humano', telefone: webhookBody.phone, payload: { erro: error.message } });
      }
    }
    return;
  }

  const mensagem = parsearWebhook(webhookBody);
  if (!mensagem) return;

  const { phone, nome, conteudo, tipo } = mensagem;

  if (tipo !== 'texto') {
    await processarMensagem(phone, nome, conteudo, tipo, webhookBody);
    return;
  }

  const duplicataConteudo = await verificarDuplicataConteudo(phone, conteudo);
  if (duplicataConteudo) return;

  if (isTestMode() && phone !== config.testPhoneNumber) return;

  if (filaDebounce.has(phone)) {
    const fila = filaDebounce.get(phone);
    clearTimeout(fila.timer);
    fila.conteudos.push(conteudo);
    fila.timer = setTimeout(async () => {
      const conteudoFinal = fila.conteudos.join(' ');
      filaDebounce.delete(phone);
      await processarMensagem(phone, nome, conteudoFinal, tipo, webhookBody);
    }, DEBOUNCE_MS);
  } else {
    const fila = { conteudos: [conteudo], timer: null };
    fila.timer = setTimeout(async () => {
      const conteudoFinal = fila.conteudos.join(' ');
      filaDebounce.delete(phone);
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

  if (!lead) return;

  const statusNormalizado = lead.status === 'ativo' ? 'mila' : (lead.status === 'transferido' ? 'humano' : lead.status);

  // 2. Lead CRM — silêncio total
  if (lead.status === 'crm') {
    await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });
    console.log(`🔕 Lead ${lead.id} em modo CRM — mensagem salva, sem resposta`);
    return;
  }

  // 3. Protocolo de crise
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

  // 4. Áudio ou imagem
  if (tipo === 'audio' || tipo === 'imagem') {
    const variacoesAudio = [
      'Oi! Não consigo ouvir áudios por aqui, mas pode me mandar em texto que te respondo na hora! 😊',
      'Áudios não consigo processar, mas texto funciona perfeitamente! Me manda em texto. 😊',
      'Por aqui só consigo ler texto — manda sua mensagem escrita que respondo na hora!',
    ];
    try {
      const historicoBrutoAudio = await buscarHistorico(lead.id, 20);
      const respostasAudio = historicoBrutoAudio.filter(m => m.conteudo?.startsWith('[audio') || m.conteudo?.startsWith('[imagem')).length;
      const respostaAudio = variacoesAudio[Math.min(respostasAudio, variacoesAudio.length - 1)];
      await enviarTexto(phone, respostaAudio);
      await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo: `[${tipo}]`, tipo });
    } catch (e) { console.error('❌ Erro áudio:', e.message); }
    return;
  }

  // 5. Lead encerrado — reativar
  if (statusNormalizado === 'encerrado') {
    try {
      const { lead: leadReativado, retomandoContexto, diasPassados } = await reativarLead(lead);
      lead = leadReativado;
      await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });
      let historicoFormatado = [];
      if (retomandoContexto) {
        const historicoBruto = await buscarHistorico(lead.id, 20);
        historicoFormatado = formatarHistorico(historicoBruto.slice(0, -1));
      }
      const mensagemFinal = retomandoContexto
        ? `[CONTEXTO INTERNO: Este lead já conversou há ${diasPassados} dias e voltou. Cumprimente naturalmente e retome onde parou.]\n\nMensagem: ${conteudo}`
        : conteudo;
      const resposta = await gerarResposta({ systemPrompt: montarSystemPrompt(), historico: historicoFormatado, mensagemNova: mensagemFinal });
      await enviarTexto(phone, resposta);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: resposta });
    } catch (error) {
      console.error('❌ Erro ao reabrir lead:', error.message);
    }
    return;
  }

  // 6. Lead perdido — reativar como encerrado (mesmo tratamento)
  if (statusNormalizado === 'perdido') {
    try {
      const { lead: leadReativado, retomandoContexto, diasPassados } = await reativarLead(lead);
      lead = leadReativado;
      await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });
      const historicoBruto = await buscarHistorico(lead.id, 20);
      const historicoFormatado = formatarHistorico(historicoBruto.slice(0, -1));
      const mensagemFinal = `[CONTEXTO INTERNO: Este lead ficou sem resposta e voltou após ${diasPassados} dias. Cumprimente com leveza e retome o contato de forma natural.]\n\nMensagem: ${conteudo}`;
      const resposta = await gerarResposta({ systemPrompt: montarSystemPrompt(), historico: historicoFormatado, mensagemNova: mensagemFinal });
      await enviarTexto(phone, resposta);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: resposta });
      console.log(`🔄 Lead ${lead.id} perdido reativado após ${diasPassados} dias`);
    } catch (error) {
      console.error('❌ Erro ao reativar lead perdido:', error.message);
    }
    return;
  }

  // 7. Lead agendado — só salva, não responde (humano já está cuidando)
  if (statusNormalizado === 'agendado') {
    await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });
    console.log(`📅 Lead ${lead.id} com visita agendada — mensagem salva, sem resposta automática`);
    return;
  }

  // 8. Lead transferido — janela de silêncio ou humano ainda ativo
  if (dentroJanelaSilencio(lead)) {
    await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });
    return;
  }

  if (statusNormalizado === 'humano') {
    const humanoAtivo = await ultimaMensagemFoiHumana(lead.id);
    if (humanoAtivo) {
      await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });
      return;
    }
    console.log(`🔄 Lead ${lead.id} retomando com Mila.`);
  }

  // 9. Lead MATRICULADO — modo aluno
  if (statusNormalizado === 'matriculado') {
    await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });

    const historicoBruto = await buscarHistorico(lead.id, 20);
    const historicoSemUltima = historicoBruto.slice(0, -1);
    const historicoFormatado = formatarHistorico(historicoSemUltima);

    const intencao = await classificarIntencaoComContexto(conteudo, historicoBruto, 'matriculado');

    if (intencao === 'ENCERRAR') {
      await encerrarLead(lead, 'aluno pediu para não receber mais mensagens');
      return;
    }

    if (intencao === 'ESCALAR') {
      await transferirParaHumano({ lead, motivo: 'aluno matriculado pediu atendimento humano' });
      return;
    }

    try {
      const systemPromptAluno = montarSystemPrompt(null, 'aluno');
      const resposta = await gerarResposta({
        systemPrompt: systemPromptAluno,
        historico: historicoFormatado,
        mensagemNova: conteudo,
      });
      const delay = resposta.length < 80 ? 1000 : resposta.length < 200 ? 2000 : 3000;
      await new Promise(resolve => setTimeout(resolve, delay));
      await enviarTexto(phone, resposta);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: resposta });
    } catch (error) {
      console.error('❌ Erro ao responder aluno:', error.message);
    }
    return;
  }

  // 10. Salvar mensagem (status: mila/ativo)
  await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });

  // 11. Buscar histórico e perfil
  const historicoBruto = await buscarHistorico(lead.id, 20);

  // 11a. GUARD DE ALUNO ATIVO — lead novo sem histórico prévio
  // Se o número não existia na tabela leads e acabou de ser criado (só 1 mensagem),
  // consulta o EVO para verificar se é aluno ativo respondendo a um disparo CRM.
  // Se for aluno, seta status 'crm' e encerra silenciosamente.
  if (historicoBruto.length === 1) {
    try {
      const alunoEvo = await buscarAlunoAtivoPorTelefone(phone);
      if (alunoEvo) {
        await supabase.from('leads').update({ status: 'crm' }).eq('id', lead.id);
        console.log(`🔕 Lead ${lead.id} identificado como aluno ativo EVO — status setado para crm, sem resposta`);
        return;
      }
    } catch (err) {
      console.warn(`⚠️ Guard aluno EVO falhou para ${phone}: ${err.message} — seguindo como lead normal`);
    }
  }
  const historicoSemUltima = historicoBruto.slice(0, -1);
  const historicoFormatado = formatarHistorico(historicoSemUltima);

  let perfilLead = await buscarPerfil(lead.id);
  if (!perfilLead) perfilLead = await criarPerfilVazio(lead.id);

  // 12a. GUARD DE REENVIO — roda ANTES do classificador
  // Só age quando: (a) mensagem é confirmação curta E (b) última msg da Mila foi oferta de reenvio explícita
  const reenvioFeito = await tentarReenvio(phone, lead, conteudo, historicoBruto);
  if (reenvioFeito) return;

  // 12b. GUARD DE CONFIRMAÇÃO DE MATERIAL — roda ANTES do classificador
  // Intercepta "pode mandar", "manda", "sim" etc. quando a Mila ofereceu envio de material
  // Evita que o classificador interprete essas confirmações como FECHAR
  const materialEnviado = await tentarEnvioMaterial(phone, lead, conteudo, historicoBruto);
  if (materialEnviado) return;

  // 13. CLASSIFICAÇÃO UNIFICADA COM CONTEXTO
  const intencao = await classificarIntencaoComContexto(conteudo, historicoBruto, statusNormalizado);

  // ─── ROTEAMENTO POR INTENÇÃO ──────────────────────────────────────────────

  if (intencao === 'FECHAR') {
    const resumo = await gerarResumoHandoff(lead, perfilLead, historicoFormatado).catch(() => null);
    let respostaAntes = null;
    try {
      respostaAntes = await gerarResposta({
        systemPrompt: `Você é Mila, atendente da Cia do Fitness. O lead quer fechar a matrícula. Responda a última mensagem dele em 1 frase curta e positiva, confirmando que é possível. Não transfira ainda, não explique o processo. Só confirme brevemente. Tom casual de WhatsApp.`,
        historico: historicoFormatado,
        mensagemNova: conteudo,
      });
    } catch (e) {
      respostaAntes = null;
    }
    await transferirParaHumano({ lead, motivo: 'lead quer fechar matrícula', resumo, respostaAntes });
    return;
  }

  if (intencao === 'ENCERRAR') {
    await encerrarLead(lead, 'lead expressou desinteresse');
    return;
  }

  if (intencao === 'ESCALAR') {
    const resumo = await gerarResumoHandoff(lead, perfilLead, historicoFormatado).catch(() => null);
    await transferirParaHumano({ lead, motivo: 'gatilho detectado pelo classificador', resumo });
    return;
  }

  if (intencao === 'TABELA_COMPLETA') {
    try {
      if (!tabelaCompletaJaFoiEnviada(historicoBruto)) {
        await enviarMidiaComTexto(phone, lead, TABELA_COMPLETA_URL, '[tabela completa enviada]', TEXTO_TABELA_COMPLETA, historicoBruto);
        return;
      } else {
        console.log(`📋 Tabela completa já enviada — respondendo pergunta específica via GPT (lead ${lead.id})`);
      }
    } catch (e) { console.error('❌ Tabela completa:', e.message); return; }
  }

  if (intencao === 'TABELA_BASICA') {
    try {
      if (!tabelaJaFoiEnviada(historicoBruto)) {
        await enviarMidiaComTexto(phone, lead, TABELA_PLANOS_URL, '[tabela planos enviada]', TEXTO_TABELA_PLANOS, historicoBruto);
        return;
      } else {
        console.log(`📋 Tabela básica já enviada — respondendo pergunta específica via GPT (lead ${lead.id})`);
      }
    } catch (e) { console.error('❌ Tabela básica:', e.message); return; }
  }

  if (intencao === 'QUADRO_AULAS') {
    try {
      if (!quadroAulasJaFoiEnviado(historicoBruto)) {
        await enviarMidiaComTexto(phone, lead, QUADRO_AULAS_URL, '[quadro aulas enviado]', TEXTO_QUADRO_AULAS, historicoBruto);
        return;
      } else {
        console.log(`📋 Quadro de aulas já enviado — respondendo pergunta específica via GPT (lead ${lead.id})`);
      }
    } catch (e) { console.error('❌ Quadro aulas:', e.message); return; }
  }

  if (intencao === 'FLUXO') {
    try {
      if (!fluxogramaJaFoiEnviado(historicoBruto)) {
        await enviarMidiaComTexto(phone, lead, FLUXOGRAMA_URL, '[fluxograma enviado]', TEXTO_FLUXO, historicoBruto);
        return;
      } else {
        console.log(`📋 Fluxograma já enviado — respondendo pergunta específica via GPT (lead ${lead.id})`);
      }
    } catch (e) { console.error('❌ Fluxograma:', e.message); return; }
  }

  if (intencao === 'DAYUSE') {
    const respostasDayUse = historicoBruto
      .filter(m => m.direcao === 'saida' && m.origem === 'mila' && m.conteudo &&
        (m.conteudo.toLowerCase().includes('diária') || m.conteudo.toLowerCase().includes('day use') || m.conteudo.toLowerCase().includes('r$ 30')))
      .slice(-2).map(m => `- "${m.conteudo}"`).join('\n') || 'nenhuma ainda';
    try {
      const respostaDayUse = await gerarResposta({
        systemPrompt: `Você é Mila, atendente da Cia do Fitness.
O lead quer saber sobre diária (day use).
INFORMAÇÕES: Valor R$ 30,00. Inclui musculação e aulas coletivas. Não precisa agendar.
VOCÊ JÁ DISSE (NÃO REPITA): ${respostasDayUse}
Máximo 2-3 frases. Tom casual de WhatsApp.`,
        historico: historicoFormatado,
        mensagemNova: conteudo,
      });
      await enviarTexto(phone, respostaDayUse);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: respostaDayUse });
    } catch (e) { console.error('❌ Day use:', e.message); }
    return;
  }

  if (intencao === 'CRIANCA') {
    try {
      await enviarTextoComVariacao(phone, lead, 'Por motivo de segurança, criança não pode entrar na área de treino, mas pode aguardar no banco de espera na recepção, pertinho de você.', historicoBruto);
    } catch (e) { console.error('❌ Criança:', e.message); }
    return;
  }

  if (intencao === 'BEBE') {
    try {
      await enviarTextoComVariacao(phone, lead, 'Geralmente não é permitido levar bebê para a área de treino. Mas cada caso é um caso — recomendo passar pessoalmente e conversar com nossa equipe de direção pra ver se há alguma possibilidade. Eles vão te receber bem!', historicoBruto);
    } catch (e) { console.error('❌ Bebê:', e.message); }
    return;
  }

  if (intencao === 'MEDICAMENTO') {
    const respostasAnteriresMed = historicoBruto
      .filter(m => m.direcao === 'saida' && m.origem === 'mila' && m.conteudo &&
        (m.conteudo.toLowerCase().includes('médico') || m.conteudo.toLowerCase().includes('medicamento') ||
         m.conteudo.toLowerCase().includes('remédio') || m.conteudo.toLowerCase().includes('opinar')))
      .map(m => `- "${m.conteudo}"`).join('\n') || 'nenhuma ainda';
    try {
      const respostaMed = await gerarResposta({
        systemPrompt: `Você é Mila, atendente virtual da Cia do Fitness.
O lead mencionou um medicamento. REGRA ABSOLUTA: nunca opina sobre medicamentos.
VOCÊ JÁ DISSE (NÃO REPITA): ${respostasAnteriresMed}
Responda com 1-2 frases dizendo que isso é com o médico. Tom casual de WhatsApp.`,
        historico: historicoFormatado,
        mensagemNova: conteudo,
      });
      await enviarTexto(phone, respostaMed);
      await salvarMensagem({ leadId: lead.id, direcao: 'mila', origem: 'mila', conteudo: respostaMed });
    } catch (e) { console.error('❌ Medicamento:', e.message); }
    return;
  }

  if (intencao === 'DANCA') {
    const respostasDanca = historicoBruto
      .filter(m => m.direcao === 'saida' && m.origem === 'mila' && m.conteudo &&
        m.conteudo.toLowerCase().includes('zumba'))
      .slice(-2).map(m => `- "${m.conteudo}"`).join('\n') || 'nenhuma ainda';
    try {
      const respostaDanca = await gerarResposta({
        systemPrompt: `Você é Mila, atendente da Cia do Fitness. O lead perguntou sobre dança.
Não temos dança específica, mas temos Zumba no Fast Training.
VOCÊ JÁ DISSE (NÃO REPITA): ${respostasDanca}
1-2 frases. Tom casual de WhatsApp.`,
        historico: historicoFormatado,
        mensagemNova: conteudo,
      });
      await enviarTexto(phone, respostaDanca);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: respostaDanca });
    } catch (e) { console.error('❌ Dança:', e.message); }
    return;
  }

  if (intencao === 'MODALIDADE_NAO_TEMOS') {
    const respostasModais = historicoBruto
      .filter(m => m.direcao === 'saida' && m.origem === 'mila' && m.conteudo &&
        (m.conteudo.toLowerCase().includes('não temos') || m.conteudo.toLowerCase().includes('não tem')))
      .slice(-3).map(m => `- "${m.conteudo}"`).join('\n') || 'nenhuma ainda';
    try {
      const respostaModal = await gerarResposta({
        systemPrompt: `Você é Mila, atendente da Cia do Fitness. O lead perguntou sobre modalidade que não oferecemos.
Nossas aulas: Jump, Combat, Zumba, Funcional e CardioMix (Fast Training, 30 min).
VOCÊ JÁ DISSE (NÃO REPITA): ${respostasModais}
Máximo 2 frases. Tom casual de WhatsApp.`,
        historico: historicoFormatado,
        mensagemNova: conteudo,
      });
      await enviarTexto(phone, respostaModal);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: respostaModal });
    } catch (e) { console.error('❌ Modalidade:', e.message); }
    return;
  }

  // CONTINUAR — GPT livre
  const silencio = diasDeSilencio(lead);
  let mensagemComContexto = conteudo;
  if (silencio >= 2) {
    mensagemComContexto = `[CONTEXTO INTERNO: Lead ficou ${Math.floor(silencio)} dias sem responder. Cumprimente calorosa e naturalmente e retome onde parou.]\n\nMensagem: ${conteudo}`;
  }

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
    const tamanho = resposta.length;
    const delay = tamanho < 80 ? 1000 : tamanho < 200 ? 2000 : 3000;
    await new Promise(resolve => setTimeout(resolve, delay));
    await enviarTexto(phone, resposta);
    await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: resposta });
    console.log(`✅ Mila respondeu pro lead ${lead.id} (delay: ${delay}ms)`);

    const totalMensagens = historicoBruto.length;
    if (totalMensagens % 3 === 0 || totalMensagens <= 3) {
      const historicoCompleto = [...historicoFormatado, { role: 'user', content: mensagemComContexto }, { role: 'assistant', content: resposta }];
      extrairEAtualizarPerfil(lead.id, historicoCompleto).catch((e) => console.error('❌ Extração de perfil:', e.message));
    }
  } catch (error) {
    console.error('❌ Erro ao enviar resposta:', error.message);
    await gravarLog({ contexto: 'zapi', mensagem: 'Erro ao enviar resposta', telefone: phone, leadId: lead.id, payload: { erro: error.message } });
  }
}
