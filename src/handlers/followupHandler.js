import { config } from '../config.js';
import {
  buscarLeadsParaFollowup,
  registrarFollowup,
  salvarMensagem,
  ultimaMensagemFoiHumana,
  atualizarStatusLead,
} from '../services/supabase.js';
import { enviarTexto } from '../services/zapi.js';
import { gerarResposta } from '../services/openai.js';
import { buscarPerfil, formatarPerfilParaPrompt } from '../services/leadProfile.js';

// ─── CONTEXTO DE CADA DIA ─────────────────────────────────────────────────────
// Define o objetivo e tom de cada follow-up. O GPT usa isso junto com o perfil
// para gerar uma mensagem personalizada — nunca igual para dois leads.

const CONTEXTO_FOLLOWUP = {
  1: {
    objetivo: 'Check-in leve. O lead demonstrou interesse mas não respondeu. Verificar se ficou alguma dúvida pendente.',
    tom: 'Descontraído e acolhedor. Curto — 1 frase.',
  },
  3: {
    objetivo: 'Quebrar a inércia. Sugerir uma visita presencial como próximo passo natural, sem pressão.',
    tom: 'Amigável e convidativo. 2 frases no máximo.',
  },
  7: {
    objetivo: 'Criar urgência emocional. Lembrar que adiar a decisão de cuidar da saúde tem um custo real.',
    tom: 'Motivacional mas sem ser agressivo. 2-3 frases.',
  },
  14: {
    objetivo: 'Mensagem de despedida. Encerrar o contato com leveza, deixando a porta aberta para o futuro.',
    tom: 'Gentil e sem ressentimento. 1-2 frases. Esta é a última mensagem.',
  },
};

// ─── FALLBACK (caso o GPT falhe) ─────────────────────────────────────────────

const MENSAGENS_FALLBACK = {
  1: (nome) =>
    `Oi${nome ? ', ' + nome : ''}! Tudo bem? Passando aqui pra ver se ficou alguma dúvida sobre a Cia do Fitness. Pode me chamar!`,
  3: (nome) =>
    `Oi${nome ? ', ' + nome : ''}! Se ficou alguma dúvida sobre o plano, uma coisa que ajuda muito é vir conhecer a academia pessoalmente. Pode passar quando quiser, ou se preferir, te agendo um horário com nossa equipe pra te receber direitinho. Topa?`,
  7: (nome) =>
    `Oi${nome ? ', ' + nome : ''}! Sabe o que a maioria dos nossos alunos novos fala depois? Que se arrependem de ter demorado tanto pra começar. Se você tá adiando essa decisão, vale a pena destravar agora. Se quiser dar o primeiro passo, é só me chamar.`,
  14: (nome) =>
    `Oi${nome ? ', ' + nome : ''}! Vou parar de te chamar aqui pra não atrapalhar. Se um dia tiver vontade de começar a treinar, é só chamar a Mila aqui que te ajudo. Abraço e tudo de bom!`,
};

// ─── GERADOR DE MENSAGEM PERSONALIZADA ───────────────────────────────────────

async function gerarMensagemFollowup(dia, lead, perfil) {
  const ctx = CONTEXTO_FOLLOWUP[dia];
  const perfilTexto = perfil ? formatarPerfilParaPrompt(perfil) : '';
  const nome = lead.nome ? lead.nome.split(' ')[0] : null;

  // Se não tem nada no perfil, usa fallback direto para economizar tokens
  if (!perfilTexto) {
    console.log(`📝 Lead ${lead.id} sem perfil — usando mensagem padrão dia ${dia}`);
    return MENSAGENS_FALLBACK[dia](nome);
  }

  const prompt = `Você é Mila, atendente virtual da Cia do Fitness em João Monlevade/MG.
Escreva uma mensagem de follow-up para um lead que demonstrou interesse mas não respondeu.

NOME DO LEAD: ${nome || 'não informado'}
DIA DO FOLLOW-UP: ${dia} (de uma sequência de 1, 3, 7, 14 dias)
OBJETIVO DESTA MENSAGEM: ${ctx.objetivo}
TOM: ${ctx.tom}
${perfilTexto}

REGRAS OBRIGATÓRIAS:
- Tom casual de WhatsApp brasileiro — sem formalidade, sem emojis excessivos (máximo 1)
- Use o nome do lead se disponível
- Se o perfil tiver objeção conhecida (ex: preço, horário), mencione algo que endereça essa objeção
- Se tiver objetivo declarado (ex: emagrecer), conecte a mensagem a esse objetivo
- Se tiver plano de interesse, mencione brevemente
- NUNCA pareça robótico ou como template
- NUNCA invente informações que não estão no perfil
- Responda APENAS com o texto da mensagem, sem aspas, sem explicações`;

  try {
    const resposta = await gerarResposta({
      systemPrompt: 'Você escreve mensagens de follow-up personalizadas para WhatsApp. Responda APENAS com o texto da mensagem.',
      historico: [],
      mensagemNova: prompt,
    });

    if (resposta && resposta.length > 10) {
      console.log(`✨ Mensagem personalizada gerada para lead ${lead.id} (dia ${dia})`);
      return resposta.trim();
    }

    throw new Error('Resposta vazia ou muito curta');
  } catch (e) {
    console.warn(`⚠️ Falha ao gerar mensagem personalizada para lead ${lead.id}: ${e.message}. Usando fallback.`);
    return MENSAGENS_FALLBACK[dia](nome);
  }
}

// ─── JANELA DE HORÁRIO ────────────────────────────────────────────────────────

function dentroDaJanela(dia) {
  const agora = new Date();
  const hora = agora.getHours();
  const diaSemana = agora.getDay();
  if (diaSemana === 0) return false;
  if (diaSemana === 6 && hora >= 12) return false;
  const janela = config.followup.horarios[`dia${dia}`];
  if (!janela) return false;
  return hora >= janela.inicio && hora < janela.fim;
}

// ─── PROCESSAR FOLLOW-UP POR DIA ─────────────────────────────────────────────

async function processarFollowupDia(dia) {
  if (!dentroDaJanela(dia)) {
    console.log(`⏰ Fora da janela do dia ${dia}. Pulando.`);
    return;
  }

  console.log(`🔍 Buscando leads pra follow-up dia ${dia}...`);
  const leads = await buscarLeadsParaFollowup(dia);

  if (leads.length === 0) {
    console.log(`✅ Nenhum lead pra follow-up dia ${dia}.`);
    return;
  }

  console.log(`📋 ${leads.length} leads pra follow-up dia ${dia}`);

  for (const lead of leads) {
    try {
      // Guard: lead já matriculado ou com visita agendada — não envia follow-up
      if (['matriculado', 'agendado', 'encerrado'].includes(lead.status)) {
        console.log(`⏭️ Lead ${lead.id} com status '${lead.status}'. Pulando follow-up.`);
        continue;
      }

      const humanoAtivo = await ultimaMensagemFoiHumana(lead.id);
      if (humanoAtivo) {
        console.log(`👤 Lead ${lead.id} está com humano. Pulando.`);
        continue;
      }

      // Busca perfil para personalização
      const perfil = await buscarPerfil(lead.id);

      // Gera mensagem personalizada (com fallback automático)
      const mensagem = await gerarMensagemFollowup(dia, lead, perfil);

      await enviarTexto(lead.telefone, mensagem);
      await salvarMensagem({
        leadId: lead.id,
        direcao: 'saida',
        origem: 'mila',
        conteudo: mensagem,
      });
      await registrarFollowup(lead.id, dia);
      console.log(`✅ Follow-up dia ${dia} enviado pro lead ${lead.id}`);

      // Após o último follow-up, marca como perdido
      if (dia === 14) {
        await atualizarStatusLead(lead.id, 'perdido', 'Sem resposta após follow-up dia 14');
        console.log(`🔴 Lead ${lead.id} marcado como perdido após follow-up dia 14`);
      }

      // Intervalo entre envios para não parecer spam
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`❌ Erro ao processar follow-up do lead ${lead.id}:`, error.message);
    }
  }
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

export async function rodarFollowups() {
  console.log('🚀 Iniciando ciclo de follow-ups');
  console.log(`Hora atual: ${new Date().toLocaleString('pt-BR')}`);
  for (const dia of [1, 3, 7, 14]) {
    await processarFollowupDia(dia);
  }
  console.log('✅ Ciclo de follow-ups finalizado');
}
