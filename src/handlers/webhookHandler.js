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
import { gerarResposta, detectarEscalacao } from '../services/openai.js';
import { montarSystemPrompt, formatarHistorico } from '../lib/promptBuilder.js';
import { classificarMensagem, querFecharMatricula } from '../lib/messageClassifier.js';
import { transferirParaHumano, encerrarLead } from '../lib/escalation.js';

const FLUXOGRAMA_URL = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/fluxo_alunos_2026_tv_2%20(2).png';
const TABELA_PLANOS_URL = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/tabela%20cia%20do%20fitness.png';
const TABELA_COMPLETA_URL = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/compare%20os%20planos.png';
const QUADRO_AULAS_URL = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/Quadro%20de%20Horario%20NOVO.png';

const TEXTO_TABELA_PLANOS = 'A Assinatura Mensal é R$ 149/mês, sem fidelidade, com acesso livre a musculação e aulas coletivas. A Assinatura Anual é R$ 119/mês, horário livre, aulas coletivas e consulta nutricional inclusa, sem taxa de adesão. Qual delas faz mais sentido pra você?';
const TEXTO_TABELA_COMPLETA = 'Aqui tá a comparação completa entre todos os planos. Qual deles faz mais sentido pro seu perfil?';
const TEXTO_QUADRO_AULAS = 'Aqui tá a grade fixa das aulas coletivas Fast Training. São aulas de 30 minutos, alta intensidade. Você pode fazer mais de uma por dia.';
const TEXTO_REENVIO_QUADRO = 'Já te enviei o quadro de aulas antes. Quer que eu mande novamente?';
const TEXTO_FLUXO = 'Essa tabela representa uma média de frequência dos alunos. Claro que há dias mais cheios e mais vazios — início de semana e dias quentes tendem a ser mais movimentados, enquanto sexta-feira e dias frios costumam ser mais tranquilos. No geral, entre 10h e 15h e depois das 20h você encontra menos movimento.';
const TEXTO_REENVIO_FLUXO = 'Já te enviei o fluxograma antes. Quer que eu mande novamente?';
const SUFIXO_OFERTA_QUADRO = 'Quer que eu envie o quadro de horários?';

const MODALIDADES_CONFIRMADAS = ['jump', 'combat', 'zumba', 'funcional', 'cardiomix', 'cardio mix'];
const TERMOS_CONTEXTO_PLANO = /(econômic|economic|mensal|anual|plano|assinatura|clube\+|clube plus)/i;
const TERMOS_AVALIANDO = /(avaliando|comparando|pesquisando|ainda.{0,15}decid|ainda.{0,15}pens)/i;

function detectarModalidadeMencionada(texto) {
  if (!texto) return null;
  const lower = texto.toLowerCase();
  const todasModalidades = [
    'jump', 'combat', 'zumba', 'funcional', 'cardiomix', 'cardio mix',
    'ritbox', 'ritboxe', 'pilates', 'yoga', 'spinning', 'crossfit',
    'muay thai', 'boxe', 'dance', 'aeróbica', 'aerobica', 'step',
    'hiit', 'tabata', 'localizada', 'alongamento', 'stretching',
    'barre', 'pole', 'aqua', 'natação', 'ciclismo', 'rpm',
    'body pump', 'body combat', 'body attack', 'kung fu', 'kungfu',
    'capoeira', 'jiu jitsu', 'jiujitsu', 'karate', 'judô', 'judo',
    'dança', 'danca', 'ballet', 'forró', 'forro', 'sertanejo',
  ];
  for (const modalidade of todasModalidades) {
    if (lower.includes(modalidade)) return modalidade;
  }
  return null;
}

function modalidadeEConfirmada(modalidade) {
  if (!modalidade) return true;
  return MODALIDADES_CONFIRMADAS.some((m) => modalidade.includes(m) || m.includes(modalidade));
}

function primeiroNome(nomeCompleto) {
  if (!nomeCompleto) return null;
  return nomeCompleto.trim().split(' ')[0];
}

const PALAVRAS_CRISE = [
  /suicid/i, /me matar/i, /quero morrer/i, /n[ãa]o quero mais viver/i,
  /tirar minha vida/i, /automutila/i, /me machucar/i, /n[ãa]o aguento mais/i,
  /acabar com tudo/i, /desaparecer para sempre/i,
];

function detectarCrise(texto) {
  if (!texto) return false;
  return PALAVRAS_CRISE.some((r) => r.test(texto));
}

const PALAVRAS_FLUXO = [
  /fluxo/i, /movimento/i, /lotad/i, /chei/i, /vazi/i, /tranquil/i, /fila/i,
  /quantos alunos/i, /horário.{0,20}vaz/i, /horário.{0,20}tranquil/i,
  /horário.{0,20}menos gente/i, /menos movimentad/i, /mais calmo/i,
  /quando.{0,20}vaz/i, /quando.{0,20}menos/i, /horário.{0,20}cheio/i,
  /horário.{0,20}lotad/i,
];

function detectarPerguntaFluxo(texto) {
  if (!texto) return false;
  return PALAVRAS_FLUXO.some((r) => r.test(texto));
}

const TERMOS_PLANOS = /(plano|planos|mensalidade|mensalidades|preç|valor|valores|quanto.{0,15}custa|quanto.{0,15}fica|quanto.{0,15}é|quanto.{0,15}sai|quanto.{0,15}paga)/i;
const INDICADORES_PEDIDO = /(quer|queria|gostaria|preciso|me fala|me diz|me passa|me informa|me manda|me envia|saber|conhecer|informaç|opç|quais|que tipo|tem|tô interessad|to interessad|estou interessad|sobre|me explica|como funciona|diferen[çc]|diferente|entre os|entre eles|compara|comparar|qual|quanto|o que muda|o que inclui)/i;
// Termos que indicam pedido de grade/quadro de aulas — bloqueiam detecção de planos
const TERMOS_GRADE_AULAS = /(quadro.{0,20}hor|grade.{0,20}hor|hor[aá]rio.{0,20}aula|hor[aá]rio.{0,20}coletiv|quadro.{0,20}aula|ver.{0,20}quadro|manda.{0,20}quadro|envia.{0,20}quadro|quarto.{0,20}hor)/i;

function detectarPerguntaPlanos(texto) {
  if (!texto) return false;
  if (TERMOS_AVALIANDO.test(texto)) return false;
  // Se o lead está pedindo o quadro/grade de aulas, não é pergunta de planos
  if (TERMOS_GRADE_AULAS.test(texto)) return false;
  return TERMOS_PLANOS.test(texto) && INDICADORES_PEDIDO.test(texto);
}

const REGEX_COMPARACAO_TODOS = /(todos.{0,20}planos|comparaç|comparar|tabela.{0,20}planos|todos.{0,20}opç|ver todos|mostra todos|quais.{0,20}todos|entre todos|comparativo)/i;

function detectarPedidoComparacaoCompleta(texto) {
  if (!texto) return false;
  return REGEX_COMPARACAO_TODOS.test(texto);
}

function todosOsPlanosCitados(historico) {
  const textoCompleto = historico
    .map((m) => m.conteudo || '')
    .join(' ')
    .toLowerCase();

  const mensal = /assinatura mensal|r\$\s*149/.test(textoCompleto);
  const anual = /assinatura anual|r\$\s*119/.test(textoCompleto);
  const economica = /econômic|econômica anual|r\$\s*95/.test(textoCompleto);
  const clube = /clube\+|clube plus|12x|r\$\s*109/.test(textoCompleto);

  return mensal && anual && economica && clube;
}

const TERMOS_AULAS = /(aula|aulas|coletiv|fast training|fast.training|modalidade|modalidades|jump|zumba|combat|funcional|cardiomix|cardio mix|quadro.{0,20}hor|grade.{0,20}hor|ver.{0,15}quadro|manda.{0,15}quadro|quero.{0,15}quadro|cad[eê].{0,15}quadro|tabela.{0,20}atividade|tabela.{0,20}aula|horário.{0,20}atividade)/i;
const INDICADORES_GRADE = /(horário|hora|grade|quadro|quando|que dia|qual dia|dias|tabela|cronograma|tem.{0,10}aula|tem.{0,10}coletiv|que aulas|quais aulas|quais.{0,15}modalidade|tem.{0,15}modalidade)/i;

function detectarPerguntaAulas(texto) {
  if (!texto) return false;
  if (TERMOS_CONTEXTO_PLANO.test(texto)) return false;
  return TERMOS_AULAS.test(texto) && INDICADORES_GRADE.test(texto);
}

const CONFIRMACOES_REENVIO = [
  /^sim$/i, /^s$/i, /^yes$/i, /^pode$/i, /^pode ser$/i,
  /^manda$/i, /^manda sim$/i, /^por favor$/i, /^por fav$/i,
  /^claro$/i, /^quero$/i, /^quero sim$/i, /^tá$/i, /^ta$/i,
  /^ok$/i, /^isso$/i, /^manda novamente$/i, /^manda de novo$/i,
  /^envia$/i, /^envia sim$/i, /^sim por favor$/i, /^sim, por favor$/i,
  /^quero sim$/i, /^quero$/i, /^manda sim$/i, /^pode mandar$/i,
  /^vai$/i, /^bora$/i, /^isso aí$/i,
];

function detectarConfirmacaoReenvio(texto) {
  if (!texto) return false;
  const limpo = texto.trim().toLowerCase();
  return CONFIRMACOES_REENVIO.some((r) => r.test(limpo));
}

function tabelaJaFoiEnviada(historico) {
  return historico.some((m) =>
    m.conteudo === '[tabela planos enviada]' || m.conteudo === '[tabela completa enviada]'
  );
}

function tabelaCompletaJaFoiEnviada(historico) {
  return historico.some((m) => m.conteudo === '[tabela completa enviada]');
}

function quadroAulasJaFoiEnviado(historico) {
  return historico.some((m) =>
    m.conteudo === '[quadro aulas enviado]' || m.conteudo === '[quadro aulas reenviado]'
  );
}

function fluxogramaJaFoiEnviado(historico) {
  return historico.some((m) => m.conteudo === '[fluxograma enviado]');
}

function ultimaMensagemMilaFoiOfertaDeQuadro(historico) {
  const saidaMila = historico
    .filter((m) => m.direcao === 'saida' && m.origem === 'mila')
    .slice(-1)[0];
  if (!saidaMila?.conteudo) return false;
  const c = saidaMila.conteudo;
  // Detecta qualquer variação de oferta do quadro de horários
  const padroes = [
    'Quer que eu envie o quadro de horários?',
    'posso te enviar o quadro de horários',
    'envio o quadro de horários',
    'quer o quadro de horários',
    'mando o quadro de horários',
    'te mando o quadro',
    'quadro de horários!',
    TEXTO_REENVIO_QUADRO,
  ];
  return padroes.some((p) => c.includes(p));
}

function ultimaMensagemMilaFoiOfertaDeFluxo(historico) {
  const saidaMila = historico
    .filter((m) => m.direcao === 'saida' && m.origem === 'mila')
    .slice(-1)[0];
  if (!saidaMila?.conteudo) return false;
  return saidaMila.conteudo === TEXTO_REENVIO_FLUXO;
}

function dentroJanelaSilencio(lead) {
  if (lead.status !== 'transferido') return false;
  if (!lead.ultima_interacao_em) return false;
  const JANELA_HORAS = 2;
  const ultimaInteracao = new Date(lead.ultima_interacao_em).getTime();
  const agora = Date.now();
  return (agora - ultimaInteracao) / (1000 * 60 * 60) < JANELA_HORAS;
}

function diasDeSilencio(lead) {
  if (!lead.ultima_interacao_em) return 0;
  const ultimaInteracao = new Date(lead.ultima_interacao_em).getTime();
  const agora = Date.now();
  return (agora - ultimaInteracao) / (1000 * 60 * 60 * 24);
}

export async function processarWebhook(webhookBody) {
  console.log('📥 Webhook recebido');

  const messageId = webhookBody.messageId || webhookBody.id || null;
  if (messageId) {
    const duplicata = await verificarDuplicata(messageId);
    if (duplicata) return;
  }

  const phoneOrigem = webhookBody.phone || '';
  if (phoneOrigem.includes('-group') || phoneOrigem.includes('@g.us') || webhookBody.isGroup) {
    console.log(`🔕 Mensagem de grupo ignorada (${phoneOrigem})`);
    return;
  }

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

  if (tipo === 'texto') {
    const duplicataConteudo = await verificarDuplicataConteudo(phone, conteudo);
    if (duplicataConteudo) return;
  }

  if (isTestMode() && phone !== config.testPhoneNumber) {
    console.log(`🧪 Modo teste ativo. Ignorando ${phone}.`);
    return;
  }

  let lead;
  try {
    lead = await buscarOuCriarLead({ telefone: phone, nome: primeiroNome(nome), campanhaOrigem: null });
  } catch (error) {
    console.error('❌ Erro ao buscar/criar lead:', error.message);
    await gravarLog({ contexto: 'supabase', mensagem: 'Erro ao buscar ou criar lead', telefone: phone, payload: { erro: error.message } });
    return;
  }

  if (detectarCrise(conteudo)) {
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

  if (tipo === 'audio' || tipo === 'imagem') {
    await enviarTexto(phone, 'Oi! Não consigo ouvir áudios por aqui, mas pode me mandar em texto que te respondo na hora! 😊');
    await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo: `[${tipo}]`, tipo });
    return;
  }

  if (lead.status === 'encerrado') {
    try {
      const { lead: leadReativado, retomandoContexto, diasPassados } = await reativarLead(lead);
      lead = leadReativado;
      await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });
      const systemPrompt = montarSystemPrompt();
      let historicoFormatado = [];
      if (retomandoContexto) {
        const historicoBruto = await buscarHistorico(lead.id, 10);
        historicoFormatado = formatarHistorico(historicoBruto.slice(0, -1));
      }
      const resposta = await gerarResposta({
        systemPrompt,
        historico: historicoFormatado,
        mensagemNova: retomandoContexto
          ? `[CONTEXTO INTERNO: Este lead já conversou há ${diasPassados} dias e voltou. Cumprimente naturalmente e retome onde parou.]\n\nMensagem: ${conteudo}`
          : conteudo,
      });
      await enviarTexto(phone, resposta);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: resposta });
    } catch (error) {
      console.error('❌ Erro ao reabrir lead:', error.message);
      await gravarLog({ contexto: 'webhook', mensagem: 'Erro ao reabrir lead', telefone: phone, leadId: lead.id, payload: { erro: error.message } });
    }
    return;
  }

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

  await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });

  if (querFecharMatricula(conteudo)) {
    await transferirParaHumano({ lead, motivo: 'lead quer fechar matrícula' });
    return;
  }

  const classificacao = await classificarMensagem(conteudo);
  if (classificacao === 'encerramento') {
    await encerrarLead(lead, 'lead expressou desinteresse');
    return;
  }

  const historicoBruto = await buscarHistorico(lead.id, 10);
  const historicoSemUltima = historicoBruto.slice(0, -1);
  const historicoFormatado = formatarHistorico(historicoSemUltima);

  const silencio = diasDeSilencio(lead);
  let mensagemComContexto = conteudo;
  if (silencio >= 2) {
    const dias = Math.floor(silencio);
    mensagemComContexto = `[CONTEXTO INTERNO: Lead ficou ${dias} dias sem responder. Cumprimente calorosa e naturalmente e retome onde parou.]\n\nMensagem: ${conteudo}`;
  }

  // Guard: perguntas informativas sobre pagamento não são gatilho de escalada
  const PERGUNTAS_INFORMATIVAS = [
    /pix.{0,30}(anual|inteiro|vista)/i,
    /dinheiro.{0,30}(anual|inteiro|vista)/i,
    /preciso pagar.{0,30}vista/i,
    /pagar.{0,30}(anual|inteiro).{0,30}vista/i,
    /quanto.{0,20}(pix|dinheiro|vista)/i,
    /desconto.{0,20}(pix|dinheiro|vista)/i,
    /aceit.{0,20}dinheiro/i,
    /pagar.{0,20}dinheiro/i,
    /mensal.{0,20}dinheiro/i,
    /dinheiro.{0,20}mensal/i,
  ];
  const ePerguntaInformativa = PERGUNTAS_INFORMATIVAS.some((r) => r.test(conteudo));

  const { escalar, motivo } = await detectarEscalacao({ historico: historicoFormatado, mensagemNova: conteudo });
  if (escalar && !ePerguntaInformativa) {
    await transferirParaHumano({ lead, motivo: motivo || 'gatilho detectado' });
    return;
  }

  // Confirmação de reenvio do quadro de aulas
  if (ultimaMensagemMilaFoiOfertaDeQuadro(historicoBruto) && detectarConfirmacaoReenvio(conteudo)) {
    console.log(`🗓️ Lead confirmou envio do quadro.`);
    try {
      await enviarImagem(phone, QUADRO_AULAS_URL, ' ');
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: '[quadro aulas enviado]' });
      await enviarTexto(phone, TEXTO_QUADRO_AULAS);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: TEXTO_QUADRO_AULAS });
    } catch (error) {
      console.error('❌ Erro ao enviar quadro confirmado:', error.message);
    }
    return;
  }

  // Confirmação de reenvio do fluxograma
  if (ultimaMensagemMilaFoiOfertaDeFluxo(historicoBruto) && detectarConfirmacaoReenvio(conteudo)) {
    console.log(`📊 Lead confirmou reenvio do fluxograma.`);
    try {
      await enviarImagem(phone, FLUXOGRAMA_URL, ' ');
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: '[fluxograma enviado]' });
      await enviarTexto(phone, TEXTO_FLUXO);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: TEXTO_FLUXO });
    } catch (error) {
      console.error('❌ Erro ao reenviar fluxograma:', error.message);
    }
    return;
  }

  // Modalidade não confirmada
  const modalidadeMencionada = detectarModalidadeMencionada(conteudo);
  if (modalidadeMencionada && !modalidadeEConfirmada(modalidadeMencionada)) {
    console.log(`🚫 Modalidade não confirmada: ${modalidadeMencionada}`);
    const nomeFormatado = modalidadeMencionada.charAt(0).toUpperCase() + modalidadeMencionada.slice(1);
    const respostaModalidade = `${nomeFormatado} não temos. Nossas aulas coletivas são Jump, Combat, Zumba, Funcional e CardioMix, todas em formato Fast Training de 30 minutos. Quer que eu envie o quadro de horários?`;
    try {
      await enviarTexto(phone, respostaModalidade);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: respostaModalidade });
    } catch (error) {
      console.error('❌ Erro ao enviar resposta de modalidade:', error.message);
    }
    return;
  }

  // Fluxo de alunos
  if (detectarPerguntaFluxo(conteudo)) {
    if (!fluxogramaJaFoiEnviado(historicoBruto)) {
      try {
        await enviarImagem(phone, FLUXOGRAMA_URL, ' ');
        await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: '[fluxograma enviado]' });
        await enviarTexto(phone, TEXTO_FLUXO);
        await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: TEXTO_FLUXO });
      } catch (error) {
        console.error('❌ Erro ao enviar fluxograma:', error.message);
      }
    } else {
      try {
        await enviarTexto(phone, TEXTO_REENVIO_FLUXO);
        await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: TEXTO_REENVIO_FLUXO });
      } catch (error) {
        console.error('❌ Erro ao perguntar reenvio fluxograma:', error.message);
      }
    }
    return;
  }

  // Quadro de aulas
  if (detectarPerguntaAulas(conteudo)) {
    if (!quadroAulasJaFoiEnviado(historicoBruto)) {
      try {
        await enviarImagem(phone, QUADRO_AULAS_URL, ' ');
        await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: '[quadro aulas enviado]' });
        await enviarTexto(phone, TEXTO_QUADRO_AULAS);
        await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: TEXTO_QUADRO_AULAS });
      } catch (error) {
        console.error('❌ Erro ao enviar quadro:', error.message);
      }
    } else {
      try {
        await enviarTexto(phone, TEXTO_REENVIO_QUADRO);
        await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: TEXTO_REENVIO_QUADRO });
      } catch (error) {
        console.error('❌ Erro ao enviar pergunta de reenvio:', error.message);
      }
    }
    return;
  }

  // Tabela completa — só envia se todos os planos já foram citados OU lead pediu comparação explícita
  const pedidoComparacao = detectarPedidoComparacaoCompleta(conteudo);
  const todosPlanosCitados = todosOsPlanosCitados(historicoBruto);

  if ((pedidoComparacao || todosPlanosCitados) && !tabelaCompletaJaFoiEnviada(historicoBruto)) {
    console.log(`📊 Enviando tabela completa. Pedido explícito: ${pedidoComparacao}. Todos citados: ${todosPlanosCitados}`);
    try {
      await enviarImagem(phone, TABELA_COMPLETA_URL, ' ');
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: '[tabela completa enviada]' });
      await enviarTexto(phone, TEXTO_TABELA_COMPLETA);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: TEXTO_TABELA_COMPLETA });
    } catch (error) {
      console.error('❌ Erro ao enviar tabela completa:', error.message);
    }
    return;
  }

  // Tabela básica (Mensal + Anual) — primeira pergunta sobre planos
  if (detectarPerguntaPlanos(conteudo) && !tabelaJaFoiEnviada(historicoBruto)) {
    console.log(`📋 Enviando tabela básica de planos.`);
    try {
      await enviarImagem(phone, TABELA_PLANOS_URL, ' ');
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: '[tabela planos enviada]' });
      await enviarTexto(phone, TEXTO_TABELA_PLANOS);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: TEXTO_TABELA_PLANOS });
    } catch (error) {
      console.error('❌ Erro ao enviar tabela básica:', error.message);
    }
    return;
  }

  let resposta;
  try {
    const systemPrompt = montarSystemPrompt();
    resposta = await gerarResposta({ systemPrompt, historico: historicoFormatado, mensagemNova: mensagemComContexto });
  } catch (error) {
    console.error('❌ Erro ao gerar resposta:', error.message);
    await gravarLog({ contexto: 'openai', mensagem: 'Erro ao gerar resposta', telefone: phone, leadId: lead.id, payload: { erro: error.message } });
    resposta = `Oi${lead.nome ? ', ' + lead.nome : ''}! Tive uma instabilidade aqui. Pode me chamar de novo em alguns minutos? 🙏`;
  }

  try {
    await enviarTexto(phone, resposta);
    await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: resposta });
    console.log(`✅ Mila respondeu pro lead ${lead.id}`);
  } catch (error) {
    console.error('❌ Erro ao enviar resposta:', error.message);
    await gravarLog({ contexto: 'zapi', mensagem: 'Erro ao enviar resposta', telefone: phone, leadId: lead.id, payload: { erro: error.message, resposta } });
  }
}
