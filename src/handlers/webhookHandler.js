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

// URLs públicas das imagens
const FLUXOGRAMA_URL = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/fluxo_alunos_2026_tv.jpg';
const TABELA_PLANOS_URL = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/tabela%20cia%20do%20fitness.png';

// Texto fixo após tabela de planos
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

const PALAVRAS_PLANOS = [
  /quais.{0,20}planos/i,
  /que planos/i,
  /quero saber.{0,20}planos/i,
  /quero saber.{0,20}preços/i,
  /quero saber.{0,20}valores/i,
  /quanto.{0,10}mensalidade/i,
  /quanto.{0,10}custa/i,
  /quanto.{0,10}é.{0,10}academia/i,
  /me fala.{0,20}planos/i,
  /me fala.{0,20}preços/i,
  /opções.{0,20}planos/i,
  /outros planos/i,
  /mais planos/i,
  /tem outros/i,
];

function detectarPerguntaPlanos(texto) {
  if (!texto) return false;
  return PALAVRAS_PLANOS.some((r) => r.test(texto));
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

  // Deduplicação 1: por messageId do Z-API
  const messageId = webhookBody.messageId || webhookBody.id || null;
  if (messageId) {
    const duplicata = await verificarDuplicata(messageId);
    if (duplicata) return;
  }

  // Filtro: ignora mensagens de grupo
  const phoneOrigem = webhookBody.phone || '';
  if (phoneOrigem.includes('-group') || phoneOrigem.includes('@g.us') || webhookBody.isGroup) {
    console.log(`🔕 Mensagem de grupo ignorada (${phoneOrigem})`);
    return;
  }

  // Caso 1: Mensagem da própria Mila/humano operando manualmente
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

  // Caso 2: Mensagem de entrada (lead falou)
  const mensagem = parsearWebhook(webhookBody);
  if (!mensagem) {
    console.log('⚠️ Webhook ignorado (formato não reconhecido)');
    return;
  }

  const { phone, nome, conteudo, tipo } = mensagem;

  // Deduplicação 2: por telefone+conteúdo numa janela de 10 segundos.
  // Defende contra retry do Z-API com messageId diferente, webhooks
  // duplicados que escaparam do dedup por ID, e rajadas acidentais do lead.
  // Só aplica em texto — áudio/imagem/vídeo recebem placeholders genéricos
  // que poderiam falsamente bater no hash.
  if (tipo === 'texto') {
    const duplicataConteudo = await verificarDuplicataConteudo(phone, conteudo);
    if (duplicataConteudo) return;
  }

  // Validação modo teste
  if (isTestMode() && phone !== config.testPhoneNumber) {
    console.log(`🧪 Modo teste ativo. Ignorando mensagem de ${phone} (autorizado: ${config.testPhoneNumber}).`);
    return;
  }

  // Identifica ou cria lead
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

  // Tratamento de crise emocional — prioridade máxima
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

  // Tratamento de áudio e imagem
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

  // Reabertura de lead encerrado que voltou a falar
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

  // Janela de silêncio pós-escalação (
