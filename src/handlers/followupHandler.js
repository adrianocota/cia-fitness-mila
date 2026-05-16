import { config } from '../config.js';
import {
  buscarLeadsParaFollowup,
  registrarFollowup,
  salvarMensagem,
  ultimaMensagemFoiHumana,
} from '../services/supabase.js';
import { enviarTexto } from '../services/zapi.js';

/**
 * As 4 mensagens da sequência de follow-up.
 * Substituições: {nome}, {campanha}
 */
const MENSAGENS_FOLLOWUP = {
  1: (nome, campanha) =>
    `Oi${nome ? ', ' + nome : ''}! Tudo bem? Passando aqui pra ver se você ficou com alguma dúvida sobre a ${campanha || 'nossa campanha'}. Se precisar de qualquer informação, é só me chamar, tô por aqui!`,

  3: (nome) =>
    `Oi${nome ? ', ' + nome : ''}! Se ficou alguma dúvida sobre o plano, uma coisa que ajuda muito é vir conhecer a academia pessoalmente. Pode passar quando quiser, ou se preferir, te agendo um horário com nossa equipe pra te receber direitinho. Topa?`,

  7: (nome) =>
    `Oi${nome ? ', ' + nome : ''}! Sabe o que a maioria dos nossos alunos novos fala depois? Que se arrependem de ter demorado tanto pra começar. Se você tá adiando essa decisão, vale a pena destravar agora. Tô aqui pra te ajudar no que precisar.`,

  14: (nome) =>
    `Oi${nome ? ', ' + nome : ''}! Vou parar de te chamar aqui pra não atrapalhar. Se um dia tiver vontade de começar a treinar, é só chamar a Mila aqui que te ajudo. Abraço e tudo de bom!`,
};

/**
 * Verifica se a hora atual está dentro da janela permitida pro follow-up do dia X.
 */
function dentroDaJanela(dia) {
  const agora = new Date();
  const hora = agora.getHours();
  const diaSemana = agora.getDay(); // 0 = domingo, 6 = sábado

  // Não dispara em domingo
  if (diaSemana === 0) return false;

  // Não dispara sábado depois das 12h
  if (diaSemana === 6 && hora >= 12) return false;

  // Verifica janela específica do dia
  const janela = config.followup.horarios[`dia${dia}`];
  if (!janela) return false;

  return hora >= janela.inicio && hora < janela.fim;
}

/**
 * Processa follow-up de um dia específico (1, 3, 7 ou 14).
 *
 * @param {number} dia
 */
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
      // Verifica se humano não tá conduzindo a conversa
      const humanoAtivo = await ultimaMensagemFoiHumana(lead.id);
      if (humanoAtivo) {
        console.log(`👤 Lead ${lead.id} está com humano. Pulando.`);
        continue;
      }

      // Monta mensagem
      const mensagem = MENSAGENS_FOLLOWUP[dia](lead.nome, lead.campanha_origem);

      // Envia via Z-API
      await enviarTexto(lead.telefone, mensagem);

      // Salva no histórico
      await salvarMensagem({
        leadId: lead.id,
        direcao: 'saida',
        origem: 'mila',
        conteudo: mensagem,
      });

      // Registra follow-up disparado
      await registrarFollowup(lead.id, dia);

      console.log(`✅ Follow-up dia ${dia} enviado pro lead ${lead.id}`);

      // Espera 2 segundos entre disparos (anti-spam)
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`❌ Erro ao processar follow-up do lead ${lead.id}:`, error.message);
    }
  }
}

/**
 * Função pública chamada pelo cron.
 * Processa todos os dias (1, 3, 7, 14) na sequência.
 */
export async function rodarFollowups() {
  console.log('🚀 Iniciando ciclo de follow-ups');
  console.log(`Hora atual: ${new Date().toLocaleString('pt-BR')}`);

  for (const dia of [1, 3, 7, 14]) {
    await processarFollowupDia(dia);
  }

  console.log('✅ Ciclo de follow-ups finalizado');
}
