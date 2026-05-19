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

const TEXTO_TABELA_PLANOS = 'Na Assinatura Mensal a adesão é R$ 69 e você treina sem fidelidade. Na Assinatura Anual a adesão é grátis e inclui matrícula, avaliação física e consulta nutricional. Qual delas faz mais sentido pra você?';

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

/**
 * Detecta se o lead está pedindo informação sobre planos, preços ou valores
 * de forma genérica (não pergunta específica sobre um plano).
 *
 * Lógica: a mensagem precisa conter um TERMO sobre planos/preços E um
 * INDICADOR de pedido de informação. Os dois juntos = pedido de tabela.
 */
const TERMOS_PLANOS = /(plano|planos|mensalidade|mensalidades|preç|valor|valores|quanto.{0,15}custa|quanto.{0,15}fica|quanto.{0,15}é|quanto.{0,15}sai|quanto.{0,15}paga)/i;

const INDICADORES_PEDIDO = /(quer|queria|gostaria|preciso|me fala|me diz|me passa|me informa|me manda|me envia|saber|conhecer|informaç|opç|quais|que tipo|tem|tô interessad|to interessad|estou interessad|sobre|me explica|como funciona)/i;

function detectarPerguntaPlanos(texto) {
  if (!texto) return false;
  return TERMOS_PLANOS.test(texto) && INDICADORES_PEDIDO.test(texto);
}

function tabelaJaFoiEnviada(historico) {
  return historico.some((m) => m.conteudo === '[tabela planos enviada]');
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
    console.log(`🆘 Crise emocional detectada para lead ${lead.id}. Acionando protocolo de cuidado.`);
    try {
      await enviarTexto(
        phone,
        `Fico feliz que você compartilhou isso comigo. Pensamentos assim são pesados de carregar, e faz sentido querer mudar algo na vida.\n\nSe precisar conversar com alguém especializado, o CVV atende 24h pelo 188 ou pelo chat em cvv.org.br, de graça e com sigilo total.\n\nAqui na Cia, o treino pode ser um caminho pra se cuidar também. Mas o mais importante agora é você estar bem.`
      );
      await salvarMensagem({
        leadId: lead.id,
        direcao: 'entrada',
        origem: 'lead',
        conteudo,
        tipo,
      });
      await transferirParaHumano({
        lead,
        motivo: 'situação de cuidado emocional — lead mencionou pensamentos graves',
      });
      await gravarLog({
        nivel: 'aviso',
        contexto: 'webhook',
        mensagem: 'Protocolo de crise emocional acionado',
        telefone: phone,
        leadId: lead.id,
      });
    } catch (error) {
      console.error('❌ Erro ao tratar crise emocional:', error.message);
      await gravarLog({
        contexto: 'webhook',
        mensagem: 'Erro ao tratar crise emocional',
        telefone: phone,
        leadId: lead.id,
        payload: { erro: error.message },
      });
    }
    return;
  }

  if (tipo === 'audio' || tipo === 'imagem') {
    console.log(`🎵 Mensagem do tipo ${tipo} recebida. Enviando resposta padrão.`);
    await enviarTexto(phone, 'Oi! Não consigo ouvir áudios ou ver imagens por aqui, mas pode me mandar em texto que te respondo na hora! 😊');
    await salvarMensagem({
      leadId: lead.id,
      direcao: 'entrada',
      origem: 'lead',
      conteudo: `[${tipo}]`,
      tipo,
    });
    return;
  }

  if (lead.status === 'encerrado') {
    console.log(`🔄 Lead ${lead.id} encerrado voltou a falar. Avaliando reabertura.`);
    try {
      const { lead: leadReativado, retomandoContexto, diasPassados } = await reativarLead(lead);
      lead = leadReativado;

      await salvarMensagem({
        leadId: lead.id,
        direcao: 'entrada',
        origem: 'lead',
        conteudo,
        tipo,
      });

      const systemPrompt = montarSystemPrompt();
      let historicoFormatado = [];

      if (retomandoContexto) {
        console.log(`📋 Retomando contexto (${diasPassados} dias atrás).`);
        const historicoBruto = await buscarHistorico(lead.id, 10);
        const historicoSemUltima = historicoBruto.slice(0, -1);
        historicoFormatado = formatarHistorico(historicoSemUltima);
      } else {
        console.log(`🆕 Mais de 30 dias (${diasPassados} dias). Iniciando conversa do zero.`);
        historicoFormatado = [];
      }

      const resposta = await gerarResposta({
        systemPrompt,
        historico: historicoFormatado,
        mensagemNova: retomandoContexto
          ? `[CONTEXTO INTERNO — NÃO MENCIONE ISSO NA RESPOSTA: Este lead já conversou com você há ${diasPassados} dias e a conversa foi encerrada. Ele voltou agora. Cumprimente de forma natural, mencione que já conversaram antes se fizer sentido, e retome o assunto de onde parou.]\n\nMensagem do lead: ${conteudo}`
          : conteudo,
      });

      await enviarTexto(phone, resposta);
      await salvarMensagem({
        leadId: lead.id,
        direcao: 'saida',
        origem: 'mila',
        conteudo: resposta,
      });
      console.log(`✅ Lead reaberto e respondido.`);
    } catch (error) {
      console.error('❌ Erro ao reabrir lead:', error.message);
      await gravarLog({
        contexto: 'webhook',
        mensagem: 'Erro ao reabrir lead encerrado',
        telefone: phone,
        leadId: lead.id,
        payload: { erro: error.message },
      });
    }
    return;
  }

  if (dentroJanelaSilencio(lead)) {
    console.log(`🤝 Lead ${lead.id} transferido e dentro da janela de silêncio. Mila em silêncio.`);
    await salvarMensagem({
      leadId: lead.id,
      direcao: 'entrada',
      origem: 'lead',
      conteudo,
      tipo,
    });
    return;
  }

  if (lead.status === 'transferido') {
    const humanoAtivo = await ultimaMensagemFoiHumana(lead.id);
    if (humanoAtivo) {
      console.log(`🤝 Lead ${lead.id} sendo atendido por humano. Mila em silêncio.`);
      await salvarMensagem({
        leadId: lead.id,
        direcao: 'entrada',
        origem: 'lead',
        conteudo,
        tipo,
      });
      return;
    }
    console.log(`🔄 Lead ${lead.id} transferido há mais de 2h sem resposta humana. Mila retomando.`);
  }

  await salvarMensagem({
    leadId: lead.id,
    direcao: 'entrada',
    origem: 'lead',
    conteudo,
    tipo,
  });

  if (querFecharMatricula(conteudo)) {
    console.log('🎯 Lead quer fechar matrícula. Transferindo direto pro humano.');
    await transferirParaHumano({ lead, motivo: 'lead quer fechar matrícula' });
    return;
  }

  const classificacao = await classificarMensagem(conteudo);

  if (classificacao === 'encerramento') {
    console.log('🛑 Lead pediu pra encerrar. Despedindo.');
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
    console.log(`💤 Lead ${lead.id} ficou ${dias} dias sem responder. Injetando contexto de retomada.`);
    mensagemComContexto = `[CONTEXTO INTERNO — NÃO MENCIONE ISSO NA RESPOSTA: Este lead ficou ${dias} dias sem responder e voltou agora. Cumprimente de forma natural e calorosa, como "Oi [nome]! Que bom te ver por aqui." e em seguida retome o assunto de onde parou. Não seja dramático, não pergunte por que sumiu.]\n\nMensagem do lead: ${conteudo}`;
  }

  const { escalar, motivo } = await detectarEscalacao({
    historico: historicoFormatado,
    mensagemNova: conteudo,
  });

  if (escalar) {
    console.log(`🔥 Escalação detectada pela IA: ${motivo}`);
    await transferirParaHumano({ lead, motivo: motivo || 'gatilho detectado' });
    return;
  }

  if (detectarPerguntaFluxo(conteudo)) {
    console.log(`📊 Pergunta sobre fluxo detectada. Enviando fluxograma.`);
    try {
      await enviarImagem(phone, FLUXOGRAMA_URL, ' ');
      await salvarMensagem({
        leadId: lead.id,
        direcao: 'saida',
        origem: 'mila',
        conteudo: '[fluxograma enviado]',
      });
    } catch (error) {
      console.error('❌ Erro ao enviar fluxograma:', error.message);
    }
    const textoFluxo = 'A academia funciona de segunda a sexta, das 6h às 22h, e sábado das 8h às 12h. Os horários mais vazios são entre 11h e 15h e depois das 20h. Se você puder treinar nesse período, vai encontrar mais espaço e menos movimento.';
    try {
      await enviarTexto(phone, textoFluxo);
      await salvarMensagem({
        leadId: lead.id,
        direcao: 'saida',
        origem: 'mila',
        conteudo: textoFluxo,
      });
    } catch (error) {
      console.error('❌ Erro ao enviar texto do fluxograma:', error.message);
    }
    return;
  }

  if (detectarPerguntaPlanos(conteudo) && !tabelaJaFoiEnviada(historicoBruto)) {
    console.log(`📋 Pergunta sobre planos detectada. Enviando tabela.`);
    try {
      await enviarImagem(phone, TABELA_PLANOS_URL, ' ');
      await salvarMensagem({
        leadId: lead.id,
        direcao: 'saida',
        origem: 'mila',
        conteudo: '[tabela planos enviada]',
      });
    } catch (error) {
      console.error('❌ Erro ao enviar tabela de planos:', error.message);
    }
    try {
      await enviarTexto(phone, TEXTO_TABELA_PLANOS);
      await salvarMensagem({
        leadId: lead.id,
        direcao: 'saida',
        origem: 'mila',
        conteudo: TEXTO_TABELA_PLANOS,
      });
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
    await gravarLog({
      contexto: 'openai',
      mensagem: 'Erro ao gerar resposta',
      telefone: phone,
      leadId: lead.id,
      payload: { erro: error.message },
    });
    resposta = `Oi${lead.nome ? ', ' + lead.nome : ''}! Tive uma instabilidade aqui. Pode me chamar de novo em alguns minutos? 🙏`;
  }

  try {
    await enviarTexto(phone, resposta);
    await salvarMensagem({
      leadId: lead.id,
      direcao: 'saida',
      origem: 'mila',
      conteudo: resposta,
    });
    console.log(`✅ Mila respondeu pro lead ${lead.id}`);
  } catch (error) {
    console.error('❌ Erro ao enviar resposta:', error.message);
    await gravarLog({
      contexto: 'zapi',
      mensagem: 'Erro ao enviar resposta pro lead',
      telefone: phone,
      leadId: lead.id,
      payload: { erro: error.message, resposta },
    });
  }
}
