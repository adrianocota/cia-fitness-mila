import { gravarLog } from '../services/supabase.js';
import { enviarTexto, enviarImagem } from '../services/zapi.js';
import {
  gatilho_9diasSemPresenca,
  gatilho_18diasSemPresenca,
  gatilho_aniversario,
  gatilho_1diaAposMatricula,
  gatilho_30diasAposMatricula,
  gatilho_16diasAntesVencimento,
  gatilho_5diasAposVencimento,
  gatilho_7diasAposOportunidade,
  gatilho_cobrancaRecusada,
} from './evoService.js';

const BASE_IMG = 'https://hyvmfmynyjpocdtjayml.supabase.co/storage/v1/object/public/Imagens/';

// ─────────────────────────────────────────────
// IMAGENS
// ─────────────────────────────────────────────
const IMAGENS = {
  '9_dias_sem_presenca':     BASE_IMG + '9%20dias%20sem%20presenca.png',
  '18_dias_sem_presenca':    BASE_IMG + '18%20dias%20sem%20presenca.png',
  'cobranca_recusada':       BASE_IMG + 'atualize%20seu%20pagamento.png',
  'cobranca_recusada_3d':    BASE_IMG + 'atualize%20seu%20pagamento%203%20dias.png',
  'cobranca_recusada_7d':    BASE_IMG + 'atualize%20seu%20pagamento.png',
  '16_dias_antes_vencimento':BASE_IMG + 'renove%20suas%20metas.png',
  '5_dias_apos_vencimento':  BASE_IMG + '5%20dias%20pos%20vencimento.png',
  '30_dias_apos_vencimento': BASE_IMG + '30%20dias%20apos%20venc%20contr.png',
  '1_dia_apos_matricula':    BASE_IMG + 'seja%20muito%20bem%20vindo.png',
  '30_dias_apos_matricula':  BASE_IMG + '1%20mes%20com%20a%20gente.png',
  'aniversario':             BASE_IMG + 'feliz%20aniversario.png',
  'pos_visita':              BASE_IMG + 'pos%20visita%20oportunidade%201%20dia.png',
  '7_dias_apos_oportunidade':BASE_IMG + 'vamos%20comecar.png',
  'reativacao':              BASE_IMG + 'que%20tal%20voltar.png',
};

// ─────────────────────────────────────────────
// MENSAGENS
// ─────────────────────────────────────────────
const MENSAGENS = {
  '9_dias_sem_presenca': (nome) =>
    `Oi ${nome}! Sentimos sua falta por aqui. Tá tudo bem? O treino te espera quando você quiser voltar 💪`,

  '18_dias_sem_presenca': (nome) =>
    `${nome}, faz quase 3 semanas que você não aparece na Cia. A gente sente de verdade. Tem algo que esteja te impedindo? Pode contar com a gente.`,

  'cobranca_recusada': (nome) =>
    `Oi ${nome}! Notamos que a cobrança da sua mensalidade não foi processada. Pode ser algo simples como limite ou dados desatualizados. Clica aqui para regularizar 👉 https://evo-totem.w12app.com.br/CIAFITNESS/1/site/checkout/`,

  'cobranca_recusada_3d': (nome) =>
    `${nome}, sua mensalidade ainda está em aberto. Para não perder seu acesso, regularize pelo link abaixo. Qualquer dúvida é só chamar! 👉 https://evo-totem.w12app.com.br/CIAFITNESS/1/site/checkout/`,

  'cobranca_recusada_7d': (nome) =>
    `${nome}, é o último aviso antes do seu acesso ser suspenso. Se precisar de ajuda para regularizar ou quiser conversar sobre outra forma de pagamento, estamos aqui. 👉 https://evo-totem.w12app.com.br/CIAFITNESS/1/site/checkout/`,

  '16_dias_antes_vencimento': (nome) =>
    `Oi ${nome}! Seu plano vence em breve. Aproveite para renovar com antecedência e não ter nenhuma interrupção nos seus treinos. 👉 https://evo-totem.w12app.com.br/CIAFITNESS/1/site/checkout/`,

  '5_dias_apos_vencimento': (nome) =>
    `${nome}, seu plano venceu há 5 dias. Para continuar treinando sem interrupção, renove agora. 👉 https://evo-totem.w12app.com.br/CIAFITNESS/1/site/checkout/`,

  '30_dias_apos_vencimento': (nome) =>
    `Oi ${nome}! Quanto tempo. A gente sentiu sua falta na Cia do Fitness. Sem pressão, só queria saber como você tá. Se em algum momento quiser voltar a treinar, pode contar com a gente — temos condições especiais pra quem está retornando. Um abraço!`,

  '1_dia_apos_matricula': (nome) =>
    `Oi ${nome}, seja muito bem-vindo à Cia do Fitness! 🎉 Estamos felizes em ter você aqui. Qualquer dúvida sobre horários, aulas ou estrutura, é só chamar!`,

  '30_dias_apos_matricula': (nome) =>
    `${nome}, já faz um mês que você está treinando com a gente! Como está sendo a experiência? Conta pra gente 💪`,

  'aniversario': (nome) =>
    `Feliz aniversário, ${nome}! 🎂 Toda a equipe da Cia do Fitness deseja um dia incrível pra você. Hoje é dia de comemorar!`,

  'pos_visita': (nome) =>
    `Oi ${nome}! Foi um prazer te receber aqui na Cia do Fitness. O que achou? Ficou alguma dúvida? Posso te ajudar 😊`,

  '7_dias_apos_oportunidade': (nome) =>
    `${nome}, vi que você se cadastrou na Cia do Fitness há uma semana. Ainda não fechou sua matrícula? Posso te ajudar a tirar qualquer dúvida ou agendar uma visita!`,

  'reativacao': (nome) =>
    `Oi ${nome}! Faz um tempo que você não treina com a gente. Sentimos sua falta. Se quiser voltar, temos uma condição especial esperando por você. 🏋️ É só chamar!`,
};

// ─────────────────────────────────────────────
// ENVIO INDIVIDUAL
// ─────────────────────────────────────────────
async function enviar(telefone, nome, gatilho) {
  const fnMensagem = MENSAGENS[gatilho];
  const imgUrl     = IMAGENS[gatilho];

  if (!fnMensagem) {
    console.warn(`⚠️ CRM: mensagem não definida para gatilho "${gatilho}"`);
    return;
  }

  const texto = fnMensagem(nome);

  try {
    if (imgUrl) {
      await enviarImagem(telefone, imgUrl, '');
      await new Promise(r => setTimeout(r, 1500));
    }
    await enviarTexto(telefone, texto);
    console.log(`✅ CRM [${gatilho}] → ${nome} (${telefone})`);
  } catch (err) {
    console.error(`❌ CRM [${gatilho}] erro:`, err.message);
    await gravarLog({
      contexto: 'evo_crm',
      mensagem: `Erro ao enviar ${gatilho}`,
      telefone,
      payload: { erro: err.message, gatilho },
    });
  }
}

// ─────────────────────────────────────────────
// PROCESSAMENTO DE LISTA
// ─────────────────────────────────────────────
async function processarLista(lista, gatilho) {
  if (!lista || lista.length === 0) return;
  console.log(`📋 CRM [${gatilho}]: ${lista.length} aluno(s)`);
  for (const item of lista) {
    if (!item.telefone) continue;
    await enviar(item.telefone, item.nome || 'você', gatilho);
    await new Promise(r => setTimeout(r, 2000)); // pausa entre envios
  }
}

// ─────────────────────────────────────────────
// HANDLER PRINCIPAL — chamado pelo cron
// ─────────────────────────────────────────────
export async function rodarCrmAutomacoes() {
  console.log('🚀 CRM automações iniciadas —', new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }));

  const tarefas = [
    { fn: gatilho_9diasSemPresenca,      gatilho: '9_dias_sem_presenca'      },
    { fn: gatilho_18diasSemPresenca,     gatilho: '18_dias_sem_presenca'     },
    { fn: gatilho_aniversario,           gatilho: 'aniversario'              },
    { fn: gatilho_1diaAposMatricula,     gatilho: '1_dia_apos_matricula'     },
    { fn: gatilho_30diasAposMatricula,   gatilho: '30_dias_apos_matricula'   },
    { fn: gatilho_16diasAntesVencimento, gatilho: '16_dias_antes_vencimento' },
    { fn: gatilho_5diasAposVencimento,   gatilho: '5_dias_apos_vencimento'   },
    { fn: gatilho_7diasAposOportunidade, gatilho: '7_dias_apos_oportunidade' },
    { fn: gatilho_cobrancaRecusada,      gatilho: 'cobranca_recusada'        },
  ];

  for (const { fn, gatilho } of tarefas) {
    try {
      const lista = await fn();
      await processarLista(lista, gatilho);
    } catch (err) {
      console.error(`❌ CRM tarefa [${gatilho}] falhou:`, err.message);
      await gravarLog({
        contexto: 'evo_crm',
        mensagem: `Falha na tarefa ${gatilho}`,
        payload: { erro: err.message },
      });
    }
    await new Promise(r => setTimeout(r, 3000)); // pausa entre gatilhos
  }

  console.log('✅ CRM automações concluídas');
}
