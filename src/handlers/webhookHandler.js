import { config, isTestMode, isAdminPhone } from '../config.js';
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

const FLUXOGRAMA_URL      = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/fluxo_alunos_2026_tv_2%20(2).png';
const TABELA_PLANOS_URL   = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/tabela%20cia%20do%20fitness.png';
const TABELA_COMPLETA_URL = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/compare%20os%20planos.png';
const QUADRO_AULAS_URL    = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/Quadro%20de%20Horario%20NOVO.png';

const TEXTO_TABELA_PLANOS   = 'A Assinatura Mensal e R$ 149/mes, sem fidelidade, com acesso livre a musculacao e aulas coletivas, avaliacao fisica inclusa e adesao de R$ 69. A Assinatura Anual e R$ 119/mes, horario livre, aulas coletivas, avaliacao fisica e consulta nutricional inclusas, sem taxa de adesao. Qual delas faz mais sentido pra voce?';
const TEXTO_TABELA_COMPLETA = 'Aqui ta a comparacao completa entre todos os planos. Qual deles faz mais sentido pro seu perfil?';
const TEXTO_QUADRO_AULAS    = 'Aqui ta a grade fixa das aulas coletivas Fast Training. Sao aulas de 30 minutos, alta intensidade. Voce pode fazer mais de uma por dia.';
const TEXTO_FLUXO           = 'Essa tabela representa uma media de frequencia dos alunos. Claro que ha dias mais cheios e mais vazios. No geral, entre 10h e 15h e depois das 20h voce encontra menos movimento.';
const TEXTO_REENVIO_QUADRO  = 'Ja te enviei o quadro de aulas antes. Quer que eu mande novamente?';
const TEXTO_REENVIO_TABELA  = 'Ja te enviei a tabela de planos antes. Quer que eu mande novamente?';
const TEXTO_REENVIO_FLUXO   = 'Ja te enviei o fluxograma antes. Quer que eu mande novamente?';

const DEBOUNCE_MS = 2500;
const filaDebounce = new Map();

const REGEX = {
  crise:    /(suicid|me matar|quero morrer|nao quero mais viver|tirar minha vida|automutila|me machucar|nao aguento mais|acabar com tudo|desaparecer para sempre)/i,
  personal: /\bpersonal\b/i,
  pagamentosInfo: /(pix.{0,30}(anual|inteiro|vista)|dinheiro.{0,30}(anual|inteiro|vista)|pagar.{0,30}(anual|inteiro).{0,30}vista|quanto.{0,20}(pix|dinheiro|vista)|desconto.{0,20}(pix|dinheiro|vista)|gympass|totalpass|tp2|gym.{0,5}pass)/i,
  confirmacaoReenvio: /^(sim|s|pode|manda|manda sim|quero|quero sim|claro|vai|ok|isso|por favor|pfv|pf|manda de novo|envia|envia sim)$/i,
};

function primeiroNome(nomeCompleto) {
  if (!nomeCompleto) return null;
  return nomeCompleto.trim().split(' ')[0];
}

function ultimaSaidaMila(historico) {
  return historico.filter((m) => m.direcao === 'saida' && m.origem === 'mila').slice(-1)[0] || null;
}

function tabelaJaFoiEnviada(historico) {
  return historico.some((m) => m.conteudo === '[tabela planos enviada]' || m.conteudo === '[tabela completa enviada]');
}

function tabelaCompletaJaFoiEnviada(historico) {
  return historico.some((m) => m.conteudo === '[tabela completa enviada]');
}

function quadroAulasJaFoiEnviado(historico) {
  return historico.some((m) => m.conteudo === '[quadro aulas enviado]' || m.conteudo === '[quadro aulas reenviado]');
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
    return true;
  }
  if (msg === TEXTO_REENVIO_QUADRO) {
    await enviarImagem(phone, QUADRO_AULAS_URL, ' ');
    await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: '[quadro aulas reenviado]' });
    await enviarTexto(phone, TEXTO_QUADRO_AULAS);
    await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: TEXTO_QUADRO_AULAS });
    return true;
  }
  if (msg === TEXTO_REENVIO_FLUXO) {
    await enviarImagem(phone, FLUXOGRAMA_URL, ' ');
    await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: '[fluxograma enviado]' });
    await enviarTexto(phone, TEXTO_FLUXO);
    await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: TEXTO_FLUXO });
    return true;
  }
  return false;
}

async function reformularSeNecessario(textoOriginal, historico) {
  const ultima = ultimaSaidaMila(historico);
  if (!ultima?.conteudo) return textoOriginal;
  const identico = ultima.conteudo.trim() === textoOriginal.trim();
  const normalize = (s) => s.toLowerCase().replace(/[^a-z\s]/g, '').trim();
  const wordsA = new Set(normalize(ultima.conteudo).split(/\s+/));
  const wordsB = normalize(textoOriginal).split(/\s+/);
  const matches = wordsB.filter(w => wordsA.has(w)).length;
  const similaridade = matches / Math.max(wordsA.size, wordsB.length);
  const muitoSimilar = similaridade > 0.7;
  if (!identico && !muitoSimilar) return textoOriginal;
  try {
    const reformulada = await gerarResposta({
      systemPrompt: `Voce e Mila, atendente da Cia do Fitness. Reformule a mensagem abaixo com outras palavras, mantendo exatamente o mesmo conteudo. Seja natural, breve e no estilo WhatsApp brasileiro. Responda APENAS com a mensagem reformulada, sem explicacoes, sem aspas.\n\nMensagem anterior: "${ultima.conteudo}"\nMensagem a reformular: "${textoOriginal}"`,
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

async function classificarIntencaoComContexto(conteudo, historico, statusLead) {
  const ultimas = historico.slice(-6).map(m => {
    const quem = m.origem === 'mila' ? 'Mila' : 'Lead';
    return `${quem}: ${m.conteudo}`;
  }).join('\n');

  const intencoes = statusLead === 'matriculado'
    ? ['ALUNO_DUVIDA', 'ENCERRAR', 'ESCALAR', 'CONTINUAR']
    : ['FECHAR', 'ENCERRAR', 'ESCALAR', 'TABELA_COMPLETA', 'TABELA_BASICA', 'QUADRO_AULAS', 'FLUXO', 'DAYUSE', 'CRIANCA', 'BEBE', 'MEDICAMENTO', 'DANCA', 'MODALIDADE_NAO_TEMOS', 'CONTINUAR'];

  const regrasAluno = statusLead === 'matriculado'
    ? `ATENCAO: Este lead ja e um ALUNO MATRICULADO.\nALUNO_DUVIDA = aluno tem duvida operacional.\nENCERRAR = aluno pediu para parar de receber mensagens.\nESCALAR = aluno pediu atendimento humano ou tem reclamacao grave.\nCONTINUAR = qualquer outra coisa.`
    : `FECHAR = lead confirma intencao de pagar/assinar AGORA.\nENCERRAR = lead desistiu clara e definitivamente.\nESCALAR = lead pediu falar com humano ou insistiu em desconto pela segunda vez.\nTABELA_COMPLETA = lead quer comparar TODOS os planos.\nTABELA_BASICA = lead pergunta sobre preco/planos.\nQUADRO_AULAS = lead quer ver grade/horarios de aulas.\nFLUXO = lead quer saber sobre lotacao ou horarios vazios.\nDAYUSE = lead quer visitar por um dia.\nCRIANCA = lead pergunta sobre crianca.\nBEBE = lead pergunta sobre bebe.\nMEDICAMENTO = lead menciona remedio.\nDANCA = lead pergunta sobre danca.\nMODALIDADE_NAO_TEMOS = lead pergunta sobre pilates, yoga, natacao etc.\nCONTINUAR = tudo que nao se encaixa. EM CASO DE DUVIDA: use CONTINUAR.`;

  const resultado = await classificarIntencao(
    conteudo,
    'Qual e a intencao desta mensagem considerando o contexto da conversa?',
    intencoes,
    `Voce e um classificador de intencoes para uma academia de ginastica.\n\nSTATUS DO LEAD: ${statusLead}\n\nCONTEXTO DA CONVERSA:\n${ultimas || '(inicio da conversa)'}\n\nMENSAGEM ATUAL DO LEAD: "${conteudo}"\n\n${regrasAluno}`
  );

  console.log(`Intencao classificada: ${resultado} para "${conteudo.slice(0, 60)}" (status: ${statusLead})`);
  return resultado;
}

// WEBHOOK PRINCIPAL

export async function processarWebhook(webhookBody) {
  console.log('Webhook recebido');

  if (webhookBody.fromMe === true) {
    console.log('fromMe=true - disparo proprio ignorado');
    return;
  }

  const messageId = webhookBody.messageId || webhookBody.id || null;
  if (messageId) {
    const duplicata = await verificarDuplicata(messageId);
    if (duplicata) return;
  }

  const phoneOrigem = webhookBody.phone || '';
  if (phoneOrigem.includes('-group') || phoneOrigem.includes('@g.us') || webhookBody.isGroup) {
    console.log(`Grupo ignorado (${phoneOrigem})`);
    return;
  }

  // ADMIN: passa direto para processarMensagem
  if (isAdminPhone(phoneOrigem)) {
    const mensagem = parsearWebhook(webhookBody);
    if (!mensagem) return;
    const { phone, nome, conteudo, tipo } = mensagem;
    console.log(`Admin (${phone}) - encaminhando para processarMensagem`);
    await processarMensagem(phone, nome, conteudo, tipo, webhookBody);
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

// PROCESSAMENTO DA MENSAGEM

async function processarMensagem(phone, nome, conteudo, tipo, webhookBody) {

  let lead;
  try {
    lead = await buscarOuCriarLead({ telefone: phone, nome: primeiroNome(nome), campanhaOrigem: null });
  } catch (error) {
    console.error('Erro ao buscar/criar lead:', error.message);
    await gravarLog({ contexto: 'supabase', mensagem: 'Erro ao buscar ou criar lead', telefone: phone, payload: { erro: error.message } });
    return;
  }

  if (!lead) return;

  const statusNormalizado = lead.status === 'ativo' ? 'mila' : (lead.status === 'transferido' ? 'humano' : lead.status);

  if (lead.status === 'crm') {
    await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });
    console.log(`Lead ${lead.id} em modo CRM - mensagem salva, sem resposta`);
    return;
  }

  if (REGEX.crise.test(conteudo)) {
    try {
      await enviarTexto(phone, 'Fico feliz que voce compartilhou isso comigo. Pensamentos assim sao pesados de carregar, e faz sentido querer mudar algo na vida.\n\nSe precisar conversar com alguem especializado, o CVV atende 24h pelo 188 ou pelo chat em cvv.org.br, de graca e com sigilo total.\n\nAqui na Cia, o treino pode ser um caminho pra se cuidar tambem. Mas o mais importante agora e voce estar bem.');
      await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });
      await transferirParaHumano({ lead, motivo: 'situacao de cuidado emocional' });
      await gravarLog({ nivel: 'aviso', contexto: 'webhook', mensagem: 'Protocolo de crise acionado', telefone: phone, leadId: lead.id });
    } catch (error) {
      console.error('Erro ao tratar crise:', error.message);
    }
    return;
  }

  if (tipo === 'audio' || tipo === 'imagem') {
    const variacoesAudio = [
      'Oi! Nao consigo ouvir audios por aqui, mas pode me mandar em texto que te respondo na hora!',
      'Audios nao consigo processar, mas texto funciona perfeitamente! Me manda em texto.',
      'Por aqui so consigo ler texto - manda sua mensagem escrita que respondo na hora!',
    ];
    try {
      const historicoBrutoAudio = await buscarHistorico(lead.id, 20);
      const respostasAudio = historicoBrutoAudio.filter(m => m.conteudo?.startsWith('[audio') || m.conteudo?.startsWith('[imagem')).length;
      const respostaAudio = variacoesAudio[Math.min(respostasAudio, variacoesAudio.length - 1)];
      await enviarTexto(phone, respostaAudio);
      await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo: `[${tipo}]`, tipo });
    } catch (e) { console.error('Erro audio:', e.message); }
    return;
  }

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
        ? `[CONTEXTO INTERNO: Este lead ja conversou ha ${diasPassados} dias e voltou. Cumprimente naturalmente e retome onde parou.]\n\nMensagem: ${conteudo}`
        : conteudo;
      const resposta = await gerarResposta({ systemPrompt: montarSystemPrompt(), historico: historicoFormatado, mensagemNova: mensagemFinal });
      await enviarTexto(phone, resposta);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: resposta });
    } catch (error) {
      console.error('Erro ao reabrir lead:', error.message);
    }
    return;
  }

  if (statusNormalizado === 'perdido') {
    try {
      const { lead: leadReativado, retomandoContexto, diasPassados } = await reativarLead(lead);
      lead = leadReativado;
      await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });
      const historicoBruto = await buscarHistorico(lead.id, 20);
      const historicoFormatado = formatarHistorico(historicoBruto.slice(0, -1));
      const mensagemFinal = `[CONTEXTO INTERNO: Este lead ficou sem resposta e voltou apos ${diasPassados} dias. Cumprimente com leveza e retome o contato de forma natural.]\n\nMensagem: ${conteudo}`;
      const resposta = await gerarResposta({ systemPrompt: montarSystemPrompt(), historico: historicoFormatado, mensagemNova: mensagemFinal });
      await enviarTexto(phone, resposta);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: resposta });
    } catch (error) {
      console.error('Erro ao reativar lead perdido:', error.message);
    }
    return;
  }

  if (statusNormalizado === 'agendado') {
    await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });
    return;
  }

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
  }

  if (statusNormalizado === 'matriculado') {
    await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });
    const historicoBruto = await buscarHistorico(lead.id, 20);
    const historicoFormatado = formatarHistorico(historicoBruto.slice(0, -1));
    const intencao = await classificarIntencaoComContexto(conteudo, historicoBruto, 'matriculado');
    if (intencao === 'ENCERRAR') { await encerrarLead(lead, 'aluno pediu para nao receber mais mensagens'); return; }
    if (intencao === 'ESCALAR') { await transferirParaHumano({ lead, motivo: 'aluno matriculado pediu atendimento humano' }); return; }
    try {
      const resposta = await gerarResposta({ systemPrompt: montarSystemPrompt(null, 'aluno'), historico: historicoFormatado, mensagemNova: conteudo });
      const delay = resposta.length < 80 ? 1000 : resposta.length < 200 ? 2000 : 3000;
      await new Promise(resolve => setTimeout(resolve, delay));
      await enviarTexto(phone, resposta);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: resposta });
    } catch (error) { console.error('Erro ao responder aluno:', error.message); }
    return;
  }

  await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });

  const historicoBruto = await buscarHistorico(lead.id, 20);
  const historicoSemUltima = historicoBruto.slice(0, -1);
  const historicoFormatado = formatarHistorico(historicoSemUltima);

  let perfilLead = await buscarPerfil(lead.id);
  if (!perfilLead) perfilLead = await criarPerfilVazio(lead.id);

  const reenvioFeito = await tentarReenvio(phone, lead, conteudo, historicoBruto);
  if (reenvioFeito) return;

  const intencao = await classificarIntencaoComContexto(conteudo, historicoBruto, statusNormalizado);

  if (intencao === 'FECHAR') {
    const resumo = await gerarResumoHandoff(lead, perfilLead, historicoFormatado).catch(() => null);
    let respostaAntes = null;
    try {
      respostaAntes = await gerarResposta({ systemPrompt: 'Voce e Mila. O lead quer fechar a matricula. Responda em 1 frase curta e positiva confirmando que e possivel. Tom casual de WhatsApp.', historico: historicoFormatado, mensagemNova: conteudo });
    } catch (e) { respostaAntes = null; }
    await transferirParaHumano({ lead, motivo: 'lead quer fechar matricula', resumo, respostaAntes });
    return;
  }

  if (intencao === 'ENCERRAR') { await encerrarLead(lead, 'lead expressou desinteresse'); return; }

  if (intencao === 'ESCALAR') {
    const resumo = await gerarResumoHandoff(lead, perfilLead, historicoFormatado).catch(() => null);
    await transferirParaHumano({ lead, motivo: 'gatilho detectado pelo classificador', resumo });
    return;
  }

  if (intencao === 'TABELA_COMPLETA' && !tabelaCompletaJaFoiEnviada(historicoBruto)) {
    await enviarMidiaComTexto(phone, lead, TABELA_COMPLETA_URL, '[tabela completa enviada]', TEXTO_TABELA_COMPLETA, historicoBruto);
    return;
  }

  if (intencao === 'TABELA_BASICA' && !tabelaJaFoiEnviada(historicoBruto)) {
    await enviarMidiaComTexto(phone, lead, TABELA_PLANOS_URL, '[tabela planos enviada]', TEXTO_TABELA_PLANOS, historicoBruto);
    return;
  }

  if (intencao === 'QUADRO_AULAS' && !quadroAulasJaFoiEnviado(historicoBruto)) {
    await enviarMidiaComTexto(phone, lead, QUADRO_AULAS_URL, '[quadro aulas enviado]', TEXTO_QUADRO_AULAS, historicoBruto);
    return;
  }

  if (intencao === 'FLUXO' && !fluxogramaJaFoiEnviado(historicoBruto)) {
    await enviarMidiaComTexto(phone, lead, FLUXOGRAMA_URL, '[fluxograma enviado]', TEXTO_FLUXO, historicoBruto);
    return;
  }

  if (intencao === 'DAYUSE') {
    try {
      const respostaDayUse = await gerarResposta({ systemPrompt: 'Voce e Mila, atendente da Cia do Fitness. O lead quer saber sobre diaria (day use). INFORMACOES: Valor R$ 30,00. Inclui musculacao e aulas coletivas. Nao precisa agendar. Maximo 2-3 frases. Tom casual de WhatsApp.', historico: historicoFormatado, mensagemNova: conteudo });
      await enviarTexto(phone, respostaDayUse);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: respostaDayUse });
    } catch (e) { console.error('Erro day use:', e.message); }
    return;
  }

  if (intencao === 'CRIANCA') {
    await enviarTextoComVariacao(phone, lead, 'Por motivo de seguranca, crianca nao pode entrar na area de treino, mas pode aguardar no banco de espera na recepcao, pertinho de voce.', historicoBruto);
    return;
  }

  if (intencao === 'BEBE') {
    await enviarTextoComVariacao(phone, lead, 'Geralmente nao e permitido levar bebe para a area de treino. Mas cada caso e um caso - recomendo passar pessoalmente e conversar com nossa equipe de direcao pra ver se ha alguma possibilidade.', historicoBruto);
    return;
  }

  if (intencao === 'MEDICAMENTO') {
    try {
      const respostaMed = await gerarResposta({ systemPrompt: 'Voce e Mila, atendente virtual da Cia do Fitness. O lead mencionou um medicamento. REGRA ABSOLUTA: nunca opina sobre medicamentos. Responda com 1-2 frases dizendo que isso e com o medico. Tom casual de WhatsApp.', historico: historicoFormatado, mensagemNova: conteudo });
      await enviarTexto(phone, respostaMed);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: respostaMed });
    } catch (e) { console.error('Erro medicamento:', e.message); }
    return;
  }

  if (intencao === 'DANCA') {
    try {
      const respostaDanca = await gerarResposta({ systemPrompt: 'Voce e Mila, atendente da Cia do Fitness. O lead perguntou sobre danca. Nao temos danca especifica, mas temos Zumba no Fast Training. 1-2 frases. Tom casual de WhatsApp.', historico: historicoFormatado, mensagemNova: conteudo });
      await enviarTexto(phone, respostaDanca);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: respostaDanca });
    } catch (e) { console.error('Erro danca:', e.message); }
    return;
  }

  if (intencao === 'MODALIDADE_NAO_TEMOS') {
    try {
      const respostaModal = await gerarResposta({ systemPrompt: 'Voce e Mila, atendente da Cia do Fitness. O lead perguntou sobre modalidade que nao oferecemos. Nossas aulas: Jump, Combat, Zumba, Funcional e CardioMix (Fast Training, 30 min). Maximo 2 frases. Tom casual de WhatsApp.', historico: historicoFormatado, mensagemNova: conteudo });
      await enviarTexto(phone, respostaModal);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: respostaModal });
    } catch (e) { console.error('Erro modalidade:', e.message); }
    return;
  }

  // CONTINUAR - GPT livre
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
    console.error('Erro ao gerar resposta:', error.message);
    await gravarLog({ contexto: 'openai', mensagem: 'Erro ao gerar resposta', telefone: phone, leadId: lead.id, payload: { erro: error.message } });
    resposta = `Oi${lead.nome ? ', ' + lead.nome : ''}! Tive uma instabilidade aqui. Pode me chamar de novo em alguns minutos?`;
  }

  try {
    const tamanho = resposta.length;
    const delay = tamanho < 80 ? 1000 : tamanho < 200 ? 2000 : 3000;
    await new Promise(resolve => setTimeout(resolve, delay));
    await enviarTexto(phone, resposta);
    await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: resposta });
    console.log(`Mila respondeu pro lead ${lead.id} (delay: ${delay}ms)`);
    const totalMensagens = historicoBruto.length;
    if (totalMensagens % 3 === 0 || totalMensagens <= 3) {
      const historicoCompleto = [...historicoFormatado, { role: 'user', content: mensagemComContexto }, { role: 'assistant', content: resposta }];
      extrairEAtualizarPerfil(lead.id, historicoCompleto).catch((e) => console.error('Extracao de perfil:', e.message));
    }
  } catch (error) {
    console.error('Erro ao enviar resposta:', error.message);
    await gravarLog({ contexto: 'zapi', mensagem: 'Erro ao enviar resposta', telefone: phone, leadId: lead.id, payload: { erro: error.message } });
  }
}
