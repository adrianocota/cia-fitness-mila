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

const FLUXOGRAMA_URL = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/fluxo_alunos_2026_tv.jpg';
const TABELA_PLANOS_URL = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/tabela%20cia%20do%20fitness.png';
const QUADRO_AULAS_URL = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/Quadro%20de%20Horario%20NOVO.png';

const TEXTO_TABELA_PLANOS = 'Na Assinatura Mensal a adesão é R$ 69 e você treina sem fidelidade. Na Assinatura Anual a adesão é grátis e inclui matrícula, avaliação física e consulta nutricional. Qual delas faz mais sentido pra você?';
const TEXTO_QUADRO_AULAS = 'Aqui tá a grade fixa das aulas coletivas Fast Training. São aulas de 30 minutos, alta intensidade. Você pode fazer mais de uma por dia.';
const TEXTO_REENVIO_QUADRO = 'Já te enviei o quadro de aulas antes. Quer que eu mande novamente?';

function primeiroNome(nomeCompleto) {
  if (!nomeCompleto) return null;
  return nomeCompleto.trim().split(' ')[0];
}

const PALAVRAS_CRISE = [
  /suicid/i,
  /me matar/i,
  /quero morrer/i,
  /n[ãa]o quero mais viver/i,
  /tirar minha vida/i,
  /automutila/i,
  /me machucar/i,
  /n[ãa]o aguento mais/i,
  /acabar com tudo/i,
  /desaparecer para sempre/i,
];

function detectarCrise(texto) {
  if (!texto) return false;
  return PALAVRAS_CRISE.some((r) => r.test(texto));
}

const PALAVRAS_FLUXO = [
  /fluxo/i,
  /movimento/i,
  /lotad/i,
  /chei/i,
  /vazi/i,
  /tranquil/i,
  /fila/i,
  /quantos alunos/i,
  /horário.{0,20}vaz/i,
  /horário.{0,20}tranquil/i,
  /horário.{0,20}menos gente/i,
  /menos movimentad/i,
  /mais calmo/i,
  /quando.{0,20}vaz/i,
  /quando.{0,20}menos/i,
  /horário.{0,20}cheio/i,
  /horário.{0,20}lotad/i,
];

function detectarPerguntaFluxo(texto) {
  if (!texto) return false;
  return PALAVRAS_FLUXO.some((r) => r.test(texto));
}

const TERMOS_PLANOS = /(plano|planos|mensalidade|mensalidades|preç|valor|valores|quanto.{0,15}custa|quanto.{0,15}fica|quanto.{0,15}é|quanto.{0,15}sai|quanto.{0,15}paga)/i;
const INDICADORES_PEDIDO = /(quer|queria|gostaria|preciso|me fala|me diz|me passa|me informa|me manda|me envia|saber|conhecer|informaç|opç|quais|que tipo|tem|tô interessad|to interessad|estou interessad|sobre|me explica|como funciona)/i;

function detectarPerguntaPlanos(texto) {
  if (!texto) return false;
  return TERMOS_PLANOS.test(texto) && INDICADORES_PEDIDO.test(texto);
}

const TERMOS_AULAS = /(aula|aulas|coletiv|fast training|fast.training|modalidade|modalidades|jump|zumba|combat|funcional|cardiomix|cardio mix)/i;
const INDICADORES_GRADE = /(horário|hora|grade|quadro|quando|que dia|qual dia|dias|tabela|cronograma|tem.{0,10}aula|tem.{0,10}coletiv|que aulas|quais aulas|quais.{0,15}modalidade|tem.{0,15}modalidade)/i;

function detectarPerguntaAulas(texto) {
  if (!texto) return false;
  return TERMOS_AULAS.test(texto) && INDICADORES_GRADE.test(texto);
}

/**
 * Detecta se o lead está confirmando que quer receber o quadro de aulas
 * após a Mila ter perguntado se quer que ela mande novamente.
 */
const CONFIRMACOES_REENVIO = [
  /^sim$/i,
  /^s$/i,
  /^yes$/i,
  /^pode$/i,
  /^pode ser$/i,
  /^manda$/i,
  /^manda sim$/i,
  /^por favor$/i,
  /^por fav$/i,
  /^claro$/i,
  /^quero$/i,
  /^quero sim$/i,
  /^tá$/i,
  /^ta$/i,
  /^ok$/i,
  /^isso$/i,
  /^manda novamente$/i,
  /^manda de novo$/i,
  /^envia$/i,
  /^envia sim$/i,
];

function detectarConfirmacaoReenvio(texto) {
  if (!texto) return false;
  const limpo = texto.trim().toLowerCase();
  return CONFIRMACOES_REENVIO.some((r) => r.test(limpo));
}

function tabelaJaFoiEnviada(historico) {
  return historico.some((m) => m.conteudo === '[tabela planos enviada]');
}

function quadroAulasJaFoiEnviado(historico) {
  return historico.some((m) => m.conteudo === '[quadro aulas enviado]');
}

/**
 * Verifica se a última mensagem da Mila foi a pergunta de reenvio do quadro.
 * Isso detecta se o lead está respondendo à pergunta "quer que eu mande novamente?".
 */
function ultimaMensagemMilaFoiPerguntaReenvio(historico) {
  const saidaMila = historico
    .filter((m) => m.direcao === 'saida' && m.origem === 'mila')
    .slice(-1)[0];
  return saidaMila?.conteudo === TEXTO_REENVIO_QUADRO;
}

function dentroJanelaSilencio(lead) {
  if (lead.status !== 'transferido') return false;
  if (!lead.ultima_interacao_em) return false;
  const JANELA_HORAS = 2;
  const ultimaInteracao = new Date(lead.ultima_interacao_em).getTime();
  const agora = Date.now();
  const diferencaHoras = (agora - ultimaInteracao) / (1000 * 60 * 60);
  return diferencaHoras < JANELA_HORAS;
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
    console.log('👤 Mensagem manual de humano detectada. Mila não vai responder nessa conversa.');
    const phone = webhookBody.phone;
    if (phone) {
      try {
        const lead = await buscarOuCriarLead({ telefone: phone });
        const conteudo = webhookBody.text?.message || '[mensagem do humano]';
        await salvarMensagem({
          leadId: lead.id,
          direcao: 'saida',
          origem: 'humano',
          conteudo,
        });
      } catch (error) {
        console.error('Erro ao salvar mensagem do humano:', error.message);
        await gravarLog({
          contexto: 'webhook',
          mensagem: 'Erro ao salvar mensagem do humano',
          telefone: webhookBody.phone,
          payload: { erro: error.message },
        });
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
    console.log(`🧪 Modo teste ativo. Ignorando mensagem de ${phone} (autorizado: ${config.testPhoneNumber}).`);
    return;
  }

  let lead;
  try {
    lead = await buscarOuCriarLead({
      telefone: phone,
      nome: primeiroNome(nome),
      campanhaOrigem: null,
    });
  } catch (error) {
    console.error('❌ Erro ao buscar/criar lead:', error.message);
    await gravarLog({
      contexto: 'supabase',
      mensagem: 'Erro ao buscar ou criar lead',
      telefone: phone,
      payload: { erro: error.message },
    });
    return;
  }

  if (detectarCrise(conteudo)) {
    console.log(`🆘 Crise emocional detectada para lead ${lead.id}.`);
    try {
      await enviarTexto(
        phone,
        `Fico feliz que você compartilhou isso comigo. Pensamentos assim são pesados de carregar, e faz sentido querer mudar algo na vida.\n\nSe precisar conversar com alguém especializado, o CVV atende 24h pelo 188 ou pelo chat em cvv.org.br, de graça e com sigilo total.\n\nAqui na Cia, o treino pode ser um caminho pra se cuidar também. Mas o mais importante agora é você estar bem.`
      );
      await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });
      await transferirParaHumano({ lead, motivo: 'situação de cuidado emocional — lead mencionou pensamentos graves' });
      await gravarLog({ nivel: 'aviso', contexto: 'webhook', mensagem: 'Protocolo de crise emocional acionado', telefone: phone, leadId: lead.id });
    } catch (error) {
      console.error('❌ Erro ao tratar crise emocional:', error.message);
      await gravarLog({ contexto: 'webhook', mensagem: 'Erro ao tratar crise emocional', telefone: phone, leadId: lead.id, payload: { erro: error.message } });
    }
    return;
  }

  if (tipo === 'audio' || tipo === 'imagem') {
    console.log(`🎵 Mensagem do tipo ${tipo} recebida. Enviando resposta padrão.`);
    await enviarTexto(phone, 'Oi! Não consigo ouvir áudios ou ver imagens por aqui, mas pode me mandar em texto que te respondo na hora! 😊');
    await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo: `[${tipo}]`, tipo });
    return;
  }

  if (lead.status === 'encerrado') {
    console.log(`🔄 Lead ${lead.id} encerrado voltou a falar.`);
    try {
      const { lead: leadReativado, retomandoContexto, diasPassados } = await reativarLead(lead);
      lead = leadReativado;

      await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });

      const systemPrompt = montarSystemPrompt();
      let historicoFormatado = [];

      if (retomandoContexto) {
        const historicoBruto = await buscarHistorico(lead.id, 10);
        const historicoSemUltima = historicoBruto.slice(0, -1);
        historicoFormatado = formatarHistorico(historicoSemUltima);
      }

      const resposta = await gerarResposta({
        systemPrompt,
        historico: historicoFormatado,
        mensagemNova: retomandoContexto
          ? `[CONTEXTO INTERNO — NÃO MENCIONE ISSO NA RESPOSTA: Este lead já conversou com você há ${diasPassados} dias e a conversa foi encerrada. Ele voltou agora. Cumprimente de forma natural, mencione que já conversaram antes se fizer sentido, e retome o assunto de onde parou.]\n\nMensagem do lead: ${conteudo}`
          : conteudo,
      });

      await enviarTexto(phone, resposta);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: resposta });
    } catch (error) {
      console.error('❌ Erro ao reabrir lead:', error.message);
      await gravarLog({ contexto: 'webhook', mensagem: 'Erro ao reabrir lead encerrado', telefone: phone, leadId: lead.id, payload: { erro: error.message } });
    }
    return;
  }

  if (dentroJanelaSilencio(lead)) {
    console.log(`🤝 Lead ${lead.id} dentro da janela de silêncio. Mila em silêncio.`);
    await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });
    return;
  }

  if (lead.status === 'transferido') {
    const humanoAtivo = await ultimaMensagemFoiHumana(lead.id);
    if (humanoAtivo) {
      console.log(`🤝 Lead ${lead.id} sendo atendido por humano. Mila em silêncio.`);
      await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });
      return;
    }
    console.log(`🔄 Lead ${lead.id} transferido há mais de 2h sem resposta humana. Mila retomando.`);
  }

  await salvarMensagem({ leadId: lead.id, direcao: 'entrada', origem: 'lead', conteudo, tipo });

  if (querFecharMatricula(conteudo)) {
    console.log('🎯 Lead quer fechar matrícula. Transferindo.');
    await transferirParaHumano({ lead, motivo: 'lead quer fechar matrícula' });
    return;
  }

  const classificacao = await classificarMensagem(conteudo);
  if (classificacao === 'encerramento') {
    console.log('🛑 Lead pediu pra encerrar.');
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
    mensagemComContexto = `[CONTEXTO INTERNO — NÃO MENCIONE ISSO NA RESPOSTA: Este lead ficou ${dias} dias sem responder e voltou agora. Cumprimente de forma natural e calorosa, como "Oi [nome]! Que bom te ver por aqui." e em seguida retome o assunto de onde parou. Não seja dramático, não pergunte por que sumiu.]\n\nMensagem do lead: ${conteudo}`;
  }

  const { escalar, motivo } = await detectarEscalacao({ historico: historicoFormatado, mensagemNova: conteudo });
  if (escalar) {
    console.log(`🔥 Escalação detectada: ${motivo}`);
    await transferirParaHumano({ lead, motivo: motivo || 'gatilho detectado' });
    return;
  }

  if (detectarPerguntaFluxo(conteudo)) {
    console.log(`📊 Pergunta sobre fluxo. Enviando fluxograma.`);
    try {
      await enviarImagem(phone, FLUXOGRAMA_URL, ' ');
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: '[fluxograma enviado]' });
    } catch (error) {
      console.error('❌ Erro ao enviar fluxograma:', error.message);
    }
    const textoFluxo = 'A academia funciona de segunda a sexta, das 6h às 22h, e sábado das 8h às 12h. Os horários mais vazios são entre 11h e 15h e depois das 20h. Se você puder treinar nesse período, vai encontrar mais espaço e menos movimento.';
    try {
      await enviarTexto(phone, textoFluxo);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: textoFluxo });
    } catch (error) {
      console.error('❌ Erro ao enviar texto do fluxograma:', error.message);
    }
    return;
  }

  // Quadro de aulas — lógica com reenvio
  if (detectarPerguntaAulas(conteudo)) {
    if (!quadroAulasJaFoiEnviado(historicoBruto)) {
      // Primeira vez — envia o quadro
      console.log(`🗓️ Primeira pergunta sobre aulas. Enviando quadro.`);
      try {
        await enviarImagem(phone, QUADRO_AULAS_URL, ' ');
        await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: '[quadro aulas enviado]' });
      } catch (error) {
        console.error('❌ Erro ao enviar quadro de aulas:', error.message);
      }
      try {
        await enviarTexto(phone, TEXTO_QUADRO_AULAS);
        await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: TEXTO_QUADRO_AULAS });
      } catch (error) {
        console.error('❌ Erro ao enviar texto do quadro:', error.message);
      }
    } else {
      // Já foi enviado — pergunta se quer de novo
      console.log(`🗓️ Quadro já enviado. Perguntando se quer reenvio.`);
      try {
        await enviarTexto(phone, TEXTO_REENVIO_QUADRO);
        await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: TEXTO_REENVIO_QUADRO });
      } catch (error) {
        console.error('❌ Erro ao enviar pergunta de reenvio:', error.message);
      }
    }
    return;
  }

  // Lead confirmou que quer receber o quadro de novo
  if (
    quadroAulasJaFoiEnviado(historicoBruto) &&
    ultimaMensagemMilaFoiPerguntaReenvio(historicoBruto) &&
    detectarConfirmacaoReenvio(conteudo)
  ) {
    console.log(`🗓️ Lead confirmou reenvio do quadro de aulas.`);
    try {
      await enviarImagem(phone, QUADRO_AULAS_URL, ' ');
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: '[quadro aulas reenviado]' });
    } catch (error) {
      console.error('❌ Erro ao reenviar quadro de aulas:', error.message);
    }
    try {
      await enviarTexto(phone, TEXTO_QUADRO_AULAS);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: TEXTO_QUADRO_AULAS });
    } catch (error) {
      console.error('❌ Erro ao enviar texto do reenvio:', error.message);
    }
    return;
  }

  if (detectarPerguntaPlanos(conteudo) && !tabelaJaFoiEnviada(historicoBruto)) {
    console.log(`📋 Pergunta sobre planos. Enviando tabela.`);
    try {
      await enviarImagem(phone, TABELA_PLANOS_URL, ' ');
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: '[tabela planos enviada]' });
    } catch (error) {
      console.error('❌ Erro ao enviar tabela de planos:', error.message);
    }
    try {
      await enviarTexto(phone, TEXTO_TABELA_PLANOS);
      await salvarMensagem({ leadId: lead.id, direcao: 'saida', origem: 'mila', conteudo: TEXTO_TABELA_PLANOS });
    } catch (error) {
      console.error('❌ Erro ao enviar texto da tabela:', error.message);
    }
    return;
  }

  let resposta;
  try {
    const systemPrompt = montarSystemPrompt();
    resposta = await gerarResposta({
      systemPrompt,
      historico: historicoFormatado,
      mensagemNova: mensagemComContexto,
    });
  } catch (error) {
    console.error('❌ Erro ao gerar resposta da Mila:', error.message);
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
