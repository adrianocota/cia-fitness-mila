import { config } from '../config.js';
import {
  buscarLeadsParaFollowup,
  registrarFollowup,
  salvarMensagem,
  ultimaMensagemFoiHumana,
  atualizarStatusLead,
} from '../services/supabase.js';
import { enviarTexto } from '../services/zapi.js';

const MENSAGENS_FOLLOWUP = {
  1: (nome) =>
    `Oi${nome ? ', ' + nome : ''}! Tudo bem? Passando aqui pra ver se ficou alguma dúvida sobre a Cia do Fitness. Pode me chamar!`,
  3: (nome) =>
    `Oi${nome ? ', ' + nome : ''}! Se ficou alguma dúvida sobre o plano, uma coisa que ajuda muito é vir conhecer a academia pessoalmente. Pode passar quando quiser, ou se preferir, te agendo um horário com nossa equipe pra te receber direitinho. Topa?`,
  7: (nome) =>
    `Oi${nome ? ', ' + nome : ''}! Sabe o que a maioria dos nossos alunos novos fala depois? Que se arrependem de ter demorado tanto pra começar. Se você tá adiando essa decisão, vale a pena destravar agora. Se quiser dar o primeiro passo, é só me chamar.`,
  14: (nome) =>
    `Oi${nome ? ', ' + nome : ''}! Vou parar de te chamar aqui pra não atrapalhar. Se um dia tiver vontade de começar a treinar, é só chamar a Mila aqui que te ajudo. Abraço e tudo de bom!`,
};

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
      const humanoAtivo = await ultimaMensagemFoiHumana(lead.id);
      if (humanoAtivo) {
        console.log(`👤 Lead ${lead.id} está com humano. Pulando.`);
        continue;
      }

      const mensagem = MENSAGENS_FOLLOWUP[dia](lead.nome);
      await enviarTexto(lead.telefone, mensagem);
      await salvarMensagem({
        leadId: lead.id,
        direcao: 'saida',
        origem: 'mila',
        conteudo: mensagem,
      });
      await registrarFollowup(lead.id, dia);
      console.log(`✅ Follow-up dia ${dia} enviado pro lead ${lead.id}`);

      // Após o último follow-up (dia 14), marca como perdido
      if (dia === 14) {
        await atualizarStatusLead(lead.id, 'perdido', 'Sem resposta após follow-up dia 14');
        console.log(`🔴 Lead ${lead.id} marcado como perdido após follow-up dia 14`);
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`❌ Erro ao processar follow-up do lead ${lead.id}:`, error.message);
    }
  }
}

export async function rodarFollowups() {
  console.log('🚀 Iniciando ciclo de follow-ups');
  console.log(`Hora atual: ${new Date().toLocaleString('pt-BR')}`);
  for (const dia of [1, 3, 7, 14]) {
    await processarFollowupDia(dia);
  }
  console.log('✅ Ciclo de follow-ups finalizado');
}
