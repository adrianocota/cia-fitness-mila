import { montarMensagem } from './mensagens.js';
import { enviarTexto, enviarImagem } from '../services/zapi.js';
import { gravarLog } from '../services/supabase.js';
import supabase from '../services/supabase.js';
import {
  gatilho_9diasSemPresenca,
  gatilho_18diasSemPresenca,
  gatilho_aniversario,
  gatilho_1diaAposMatricula,
  gatilho_30diasAposMatricula,
  gatilho_16diasAntesVencimento,
  gatilho_5diasAposVencimento,
  gatilho_30diasAposVencimento,
  gatilho_cobrancaRecusada,
  gatilho_cobrancaRecusada3d,
  gatilho_cobrancaRecusada7d,
  gatilho_posVisita,
  gatilho_7diasAposOportunidade,
} from './evoService.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const INTERVALO_WHATSAPP = 4000;

// ─── DEDUPLICAÇÃO PERSISTENTE ─────────────────────────────────────────────────

function dataHoje() {
  return new Date().toISOString().split('T')[0];
}

async function jaDisparado(telefone, gatilho) {
  try {
    const { data, error } = await supabase
      .from('crm_disparos')
      .select('id')
      .eq('data', dataHoje())
      .eq('telefone', telefone)
      .eq('gatilho', gatilho)
      .maybeSingle();
    if (error) { console.warn('⚠️ Erro ao verificar deduplicação CRM:', error.message); return false; }
    return !!data;
  } catch (e) {
    console.warn('⚠️ Erro inesperado na deduplicação CRM:', e.message);
    return false;
  }
}

async function registrarDisparo(telefone, nome, gatilho, status = 'enviado') {
  try {
    await supabase.from('crm_disparos').insert({
      data: dataHoje(),
      telefone,
      gatilho,
      nome: nome || null,
      status,
    });
  } catch (e) {
    console.warn('⚠️ Erro ao registrar disparo CRM:', e.message);
  }
}

// ─── DISPARADOR ───────────────────────────────────────────────────────────────

async function disparar(lista, gatilho) {
  let enviados = 0, erros = 0, pulados = 0;
  for (const lead of lista) {
    if (!lead.telefone) continue;
    const duplicado = await jaDisparado(lead.telefone, gatilho);
    if (duplicado) {
      console.log(`⏭️ [${gatilho}] já enviado hoje para ${lead.telefone}`);
      pulados++;
      continue;
    }
    const msg = montarMensagem(gatilho, lead);
    if (!msg) continue;
    try {
      if (msg.imagem) {
        await enviarImagem(lead.telefone, msg.imagem, '');
        await sleep(1500);
      }
      await enviarTexto(lead.telefone, msg.texto);
      await registrarDisparo(lead.telefone, lead.nome, gatilho, 'enviado');
      enviados++;
      console.log(`✅ [${gatilho}] ${lead.nome} (${lead.telefone})`);
      await sleep(INTERVALO_WHATSAPP);
    } catch (e) {
      erros++;
      console.error(`❌ ${lead.telefone}:`, e.message);
      await registrarDisparo(lead.telefone, lead.nome, gatilho, 'erro');
      await gravarLog({
        contexto: 'crm',
        mensagem: `Erro ${gatilho}`,
        telefone: lead.telefone,
        payload: { erro: e.message },
      });
    }
  }
  return { enviados, erros, pulados };
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

export async function rodarCRM() {
  console.log('📋 CRM iniciado —', new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }));

  const gatilhos = [
    { nome: '9_dias_sem_presenca',      fn: gatilho_9diasSemPresenca      },
    { nome: '18_dias_sem_presenca',     fn: gatilho_18diasSemPresenca     },
    { nome: 'aniversario',              fn: gatilho_aniversario            },
    { nome: '1_dia_apos_matricula',     fn: gatilho_1diaAposMatricula     },
    { nome: '30_dias_apos_matricula',   fn: gatilho_30diasAposMatricula   },
    { nome: '16_dias_antes_vencimento', fn: gatilho_16diasAntesVencimento },
    { nome: '5_dias_apos_vencimento',   fn: gatilho_5diasAposVencimento   },
    { nome: '30_dias_apos_vencimento',  fn: gatilho_30diasAposVencimento  },
    { nome: 'cobranca_recusada',        fn: gatilho_cobrancaRecusada      },
    { nome: 'cobranca_recusada_3d',     fn: gatilho_cobrancaRecusada3d    },
    { nome: 'cobranca_recusada_7d',     fn: gatilho_cobrancaRecusada7d    },
    { nome: 'pos_visita',               fn: gatilho_posVisita              },
    { nome: '7_dias_apos_oportunidade', fn: gatilho_7diasAposOportunidade },
  ];

  const resultado = {};
  for (const g of gatilhos) {
    try {
      console.log(`🔍 ${g.nome}...`);
      const lista = await g.fn();
      console.log(`  → ${lista.length} lead(s)`);
      if (lista.length > 0) {
        const stats = await disparar(lista, g.nome);
        resultado[g.nome] = { encontrados: lista.length, ...stats };
      } else {
        resultado[g.nome] = { encontrados: 0, enviados: 0, erros: 0, pulados: 0 };
      }
      await sleep(1000);
    } catch (e) {
      console.error(`❌ Gatilho ${g.nome}:`, e.message);
      resultado[g.nome] = { erro: e.message };
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
        await enviarImagem(lead.telefone, imagemUrl, '');
        await sleep(1500);
      }
      await enviarTexto(lead.telefone, textoFinal);
      enviados++;
      await sleep(INTERVALO_WHATSAPP);
    } catch (e) {
      erros++;
      console.error(`❌ ${lead.telefone}:`, e.message);
    }
  }
  console.log(`📢 Concluído: ${enviados} enviados, ${erros} erros`);
  return { enviados, erros, total: lista.length };
}
