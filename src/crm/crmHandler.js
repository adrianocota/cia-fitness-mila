import { buscarDadosCRM, gatilho_9diasSemPresenca, gatilho_18diasSemPresenca, gatilho_aniversario, gatilho_1diaAposMatricula, gatilho_30diasAposMatricula, gatilho_16diasAntesVencimento, gatilho_5diasAposVencimento, gatilho_7diasAposOportunidade, gatilho_cobrancaRecusada } from './evoService.js';
import { montarMensagem } from './mensagens.js';
import { enviarTexto, enviarImagem } from '../services/zapi.js';
import { gravarLog } from '../services/supabase.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const INTERVALO_MS = 4000;
const disparadosHoje = new Set();

function chaveDisparo(telefone, gatilho) {
  return `${new Date().toISOString().split('T')[0]}:${telefone}:${gatilho}`;
}

async function dispararParaLista(lista, gatilho) {
  let enviados = 0, erros = 0;
  for (const lead of lista) {
    const chave = chaveDisparo(lead.telefone, gatilho);
    if (disparadosHoje.has(chave)) continue;
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
      console.error(`❌ Erro ao disparar ${lead.telefone}:`, error.message);
      await gravarLog({ contexto: 'crm', mensagem: `Erro no gatilho ${gatilho}`, telefone: lead.telefone, payload: { erro: error.message } });
    }
  }
  return { enviados, erros };
}

export async function rodarCRM() {
  console.log('📋 CRM: buscando dados do EVO...');
  const { membros, prospects, recebiveis } = await buscarDadosCRM();

  const gatilhos = [
    { nome: '9_dias_sem_presenca',      lista: gatilho_9diasSemPresenca(membros) },
    { nome: '18_dias_sem_presenca',     lista: gatilho_18diasSemPresenca(membros) },
    { nome: 'aniversario',              lista: gatilho_aniversario(membros) },
    { nome: '1_dia_apos_matricula',     lista: gatilho_1diaAposMatricula(membros) },
    { nome: '30_dias_apos_matricula',   lista: gatilho_30diasAposMatricula(membros) },
    { nome: '16_dias_antes_vencimento', lista: gatilho_16diasAntesVencimento(membros) },
    { nome: '5_dias_apos_vencimento',   lista: gatilho_5diasAposVencimento(membros) },
    { nome: '7_dias_apos_oportunidade', lista: gatilho_7diasAposOportunidade(prospects) },
    { nome: 'cobranca_recusada',        lista: gatilho_cobrancaRecusada(recebiveis, membros) },
  ];

  const resultado = {};
  for (const g of gatilhos) {
    console.log(`🔍 ${g.nome}: ${g.lista.length} lead(s)`);
    if (g.lista.length > 0) {
      const stats = await dispararParaLista(g.lista, g.nome);
      resultado[g.nome] = { encontrados: g.lista.length, ...stats };
    } else {
      resultado[g.nome] = { encontrados: 0, enviados: 0, erros: 0 };
    }
  }
  console.log('✅ CRM concluído', resultado);
  return resultado;
}

export async function rodarTransmissao({ lista, texto, imagemUrl = null }) {
  console.log(`📢 Transmissão: ${lista.length} destinatários`);
  let enviados = 0, erros = 0;
  for (const lead of lista) {
    const textoFinal = texto.replace(/{nome}/g, lead.nome || 'você');
    try {
      if (imagemUrl) {
        await enviarImagem(lead.telefone, imagemUrl, textoFinal);
      } else {
        await enviarTexto(lead.telefone, textoFinal);
      }
      enviados++;
      await sleep(INTERVALO_MS);
    } catch (error) {
      erros++;
      console.error(`❌ Erro transmissão ${lead.telefone}:`, error.message);
    }
  }
  return { enviados, erros, total: lista.length };
}
