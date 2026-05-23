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
import { montarMensagem } from './mensagens.js';
import { enviarTexto, enviarImagem } from '../services/zapi.js';
import { gravarLog } from '../services/supabase.js';

// Intervalo entre mensagens (ms) — evita bloqueio do WhatsApp
const INTERVALO_MS = 4000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Controle de duplicatas em memória (por dia)
const disparadosHoje = new Set();

function chaveDisparo(telefone, gatilho) {
  const dia = new Date().toISOString().split('T')[0];
  return `${dia}:${telefone}:${gatilho}`;
}

async function dispararParaLista(lista, gatilho) {
  let enviados = 0;
  let erros = 0;

  for (const lead of lista) {
    const chave = chaveDisparo(lead.telefone, gatilho);
    if (disparadosHoje.has(chave)) {
      console.log(`⏭️ Já disparado hoje: ${lead.telefone} (${gatilho})`);
      continue;
    }

    const msg = montarMensagem(gatilho, lead);
    if (!msg) continue;

    try {
      if (msg.imagem) {
        await enviarImagem(lead.telefone, msg.imagem, msg.texto);
      } else {
        await enviarTexto(lead.telefone, msg.texto);
      }
      disparadosHoje.add(chave);
      enviados++;
      console.log(`✅ [${gatilho}] → ${lead.nome} (${lead.telefone})`);
      await sleep(INTERVALO_MS);
    } catch (error) {
      erros++;
      console.error(`❌ Erro ao disparar para ${lead.telefone}:`, error.message);
      await gravarLog({
        contexto: 'crm',
        mensagem: `Erro no gatilho ${gatilho}`,
        telefone: lead.telefone,
        payload: { erro: error.message },
      });
    }
  }

  return { enviados, erros };
}

// ================================================
// EXECUTOR PRINCIPAL — chamado pelo cron
// ================================================

export async function rodarCRM() {
  console.log('📋 CRM: iniciando verificação dos gatilhos...');
  const inicio = Date.now();
  const resultado = {};

  const gatilhos = [
    { nome: '9_dias_sem_presenca',      fn: gatilho_9diasSemPresenca },
    { nome: '18_dias_sem_presenca',     fn: gatilho_18diasSemPresenca },
    { nome: 'aniversario',              fn: gatilho_aniversario },
    { nome: '1_dia_apos_matricula',     fn: gatilho_1diaAposMatricula },
    { nome: '30_dias_apos_matricula',   fn: gatilho_30diasAposMatricula },
    { nome: '16_dias_antes_vencimento', fn: gatilho_16diasAntesVencimento },
    { nome: '5_dias_apos_vencimento',   fn: gatilho_5diasAposVencimento },
    { nome: '7_dias_apos_oportunidade', fn: gatilho_7diasAposOportunidade },
    { nome: 'cobranca_recusada',        fn: gatilho_cobrancaRecusada },
  ];

  for (const g of gatilhos) {
    try {
      console.log(`🔍 Verificando: ${g.nome}`);
      const lista = await g.fn();
      console.log(`  → ${lista.length} lead(s) encontrado(s)`);

      if (lista.length > 0) {
        const stats = await dispararParaLista(lista, g.nome);
        resultado[g.nome] = { encontrados: lista.length, ...stats };
      } else {
        resultado[g.nome] = { encontrados: 0, enviados: 0, erros: 0 };
      }
    } catch (error) {
      console.error(`❌ Erro no gatilho ${g.nome}:`, error.message);
      resultado[g.nome] = { erro: error.message };
      await gravarLog({
        contexto: 'crm',
        mensagem: `Erro ao executar gatilho ${g.nome}`,
        payload: { erro: error.message },
      });
    }
  }

  const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
  console.log(`✅ CRM concluído em ${duracao}s`, resultado);
  return resultado;
}

// ================================================
// TRANSMISSÃO MANUAL
// Recebe lista de {telefone, nome} e uma mensagem
// ================================================

export async function rodarTransmissao({ lista, texto, imagemUrl = null }) {
  console.log(`📢 Transmissão: ${lista.length} destinatários`);
  let enviados = 0;
  let erros = 0;

  for (const lead of lista) {
    // Personaliza {nome} se presente no texto
    const textoFinal = texto.replace(/{nome}/g, lead.nome || 'você');

    try {
      if (imagemUrl) {
        await enviarImagem(lead.telefone, imagemUrl, textoFinal);
      } else {
        await enviarTexto(lead.telefone, textoFinal);
      }
      enviados++;
      console.log(`✅ Transmissão → ${lead.nome} (${lead.telefone})`);
      await sleep(INTERVALO_MS);
    } catch (error) {
      erros++;
      console.error(`❌ Erro transmissão ${lead.telefone}:`, error.message);
    }
  }

  console.log(`📢 Transmissão concluída: ${enviados} enviados, ${erros} erros`);
  return { enviados, erros, total: lista.length };
}
