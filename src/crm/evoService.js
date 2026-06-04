import fetch from 'node-fetch';

const EVO_BASE = 'https://evo-integracao-api.w12app.com.br/api/v1';
const EVO_BASE_V2 = 'https://evo-integracao-api.w12app.com.br/api/v2';
const EVO_DNS  = 'ciafitness';
const EVO_TOKEN = '59EA5FCF-5622-483A-B720-2C180A57887A';
const AUTH = 'Basic ' + Buffer.from(`${EVO_DNS}:${EVO_TOKEN}`).toString('base64');

const headers = { 'Authorization': AUTH, 'accept': 'application/json' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const LINK_CHECKOUT_GENERICO = 'https://evo-totem.w12app.com.br/CIAFITNESS/1/site/checkout/';

// ─── CACHE DE MEMBROS ─────────────────────────────────────────────────────────
// Evita múltiplas requisições individuais nos gatilhos de cobrança recusada.
// Carregado uma vez por execução do CRM e reutilizado em todos os gatilhos.

let _cacheMembros = null; // Map<idMember, { telefone, nome, linkPagamento }>

async function obterCacheMembros() {
  if (_cacheMembros) {
    console.log(`📦 Cache de membros reutilizado (${_cacheMembros.size} entradas)`);
    return _cacheMembros;
  }

  console.log('🔄 Carregando cache de membros EVO...');
  const mapa = new Map();
  let skip = 0;

  // Busca ativos e inativos para cobrir inadimplentes de ambos os status
  for (const status of [1, 2]) {
    skip = 0;
    while (true) {
      const lote = await evoGet(`/members?take=50&skip=${skip}&status=${status}`, EVO_BASE_V2);
      if (!lote || lote.length === 0) break;
      for (const m of lote) {
        const telefone = tel(m);
        if (telefone) {
          mapa.set(m.idMember, {
            telefone,
            nome: nome(m),
            linkPagamento: linkPagamento(m),
          });
        }
      }
      if (lote.length < 50) break;
      skip += 50;
      await sleep(1500);
    }
  }

  _cacheMembros = mapa;
  console.log(`✅ Cache de membros carregado: ${mapa.size} entradas`);
  return mapa;
}

export function limparCacheMembros() {
  _cacheMembros = null;
}

// ─────────────────────────────────────────────
// HELPERS DE DATA
// ─────────────────────────────────────────────

function dataISO(diasAtras = 0) {
  const d = new Date();
  d.setDate(d.getDate() - diasAtras);
  return d.toISOString().split('T')[0];
}

function dataMD(diasAtras = 0) {
  const d = new Date();
  d.setDate(d.getDate() - diasAtras);
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${mes}-${dia}`;
}

function dataFutura(diasAFrente) {
  const d = new Date();
  d.setDate(d.getDate() + diasAFrente);
  return d.toISOString().split('T')[0];
}

// ─────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────

async function evoGet(path, base = EVO_BASE) {
  await sleep(2000);
  const res = await fetch(`${base}${path}`, { headers });
  if (res.status === 429) {
    console.log('⏳ Rate limit — aguardando 60s...');
    await sleep(60000);
    return evoGet(path, base);
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`EVO ${path} → ${res.status}: ${txt}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────
// BUSCA PAGINADA — MEMBROS (v2)
// ─────────────────────────────────────────────

async function buscarMembros(filtros = '', status = 1) {
  const lista = [];
  let skip = 0;
  const take = 50;
  while (true) {
    const lote = await evoGet(
      `/members?take=${take}&skip=${skip}&status=${status}${filtros}`,
      EVO_BASE_V2
    );
    if (!lote || lote.length === 0) break;
    lista.push(...lote);
    if (lote.length < take) break;
    skip += take;
    await sleep(2000);
  }
  return lista;
}

async function buscarProspects(filtros = '') {
  const lista = [];
  let skip = 0;
  while (true) {
    const lote = await evoGet(`/prospects?take=50&skip=${skip}${filtros}`);
    if (!lote || lote.length === 0) break;
    lista.push(...lote);
    if (lote.length < 50) break;
    skip += 50;
    await sleep(2000);
  }
  return lista;
}

// ─────────────────────────────────────────────
// EXTRATORES
// ─────────────────────────────────────────────

function tel(member) {
  if (!member.contacts) return null;
  const cel = member.contacts.find(c => c.contactType === 'Cellphone' || c.idContactType === 2);
  if (!cel) return null;
  const num = cel.description.replace(/\D/g, '');
  if (num.length < 10) return null;
  return `${cel.ddi || '55'}${num}`;
}

function nome(m) {
  const n = m.usePreferredName ? (m.firstName || m.registerName) : m.registerName;
  return (n || '').trim().split(' ')[0];
}

function instrutor(m) {
  return m.nameEmployeeInstructor
    ? m.nameEmployeeInstructor.trim().split(' ')[0]
    : null;
}

function linkPagamento(m) {
  if (!m.memberships || m.memberships.length === 0) return LINK_CHECKOUT_GENERICO;
  const ativo = m.memberships
    .filter(ms => ms.membershipStatus === 'active' && ms.contractSigningUrl)
    .sort((a, b) => new Date(b.startDate) - new Date(a.startDate))[0];
  if (ativo) return ativo.contractSigningUrl;
  const comUrl = m.memberships.find(ms => ms.contractSigningUrl);
  return comUrl ? comUrl.contractSigningUrl : LINK_CHECKOUT_GENERICO;
}

function mapear(m, gatilho, extra = {}) {
  return { telefone: tel(m), nome: nome(m), instrutor: instrutor(m), gatilho, ...extra };
}

// ─────────────────────────────────────────────
// GATILHOS — ALUNOS ATIVOS
// ─────────────────────────────────────────────

export async function gatilho_9diasSemPresenca() {
  const data = dataISO(9);
  const lista = await buscarMembros(`&lastAccessStart=${data}&lastAccessEnd=${data}`, 1);
  return lista.map(m => mapear(m, '9_dias_sem_presenca')).filter(m => m.telefone);
}

export async function gatilho_18diasSemPresenca() {
  const data = dataISO(18);
  const lista = await buscarMembros(`&lastAccessStart=${data}&lastAccessEnd=${data}`, 1);
  return lista.map(m => mapear(m, '18_dias_sem_presenca')).filter(m => m.telefone);
}

export async function gatilho_aniversario() {
  const md = dataMD(0);
  const lista = await buscarMembros(`&birthdayStart=${md}&birthdayEnd=${md}`, 1);
  return lista.map(m => mapear(m, 'aniversario')).filter(m => m.telefone);
}

export async function gatilho_1diaAposMatricula() {
  const data = dataISO(1);
  const lista = await buscarMembros(`&registerDateStart=${data}&registerDateEnd=${data}`, 1);
  return lista.map(m => mapear(m, '1_dia_apos_matricula')).filter(m => m.telefone);
}

export async function gatilho_30diasAposMatricula() {
  const data = dataISO(30);
  const lista = await buscarMembros(`&registerDateStart=${data}&registerDateEnd=${data}`, 1);
  return lista.map(m => mapear(m, '30_dias_apos_matricula')).filter(m => m.telefone);
}

export async function gatilho_16diasAntesVencimento() {
  const data = dataFutura(16);
  const lista = await buscarMembros(`&endDateStart=${data}&endDateEnd=${data}`, 1);
  return lista.map(m => mapear(m, '16_dias_antes_vencimento', { vencimento: data })).filter(m => m.telefone);
}

export async function gatilho_5diasAposVencimento() {
  const data = dataISO(5);
  const lista = await buscarMembros(`&endDateStart=${data}&endDateEnd=${data}`, 1);
  return lista.map(m => mapear(m, '5_dias_apos_vencimento', {
    vencimento: data,
    linkPagamento: linkPagamento(m),
  })).filter(m => m.telefone);
}

export async function gatilho_30diasAposVencimento() {
  const data = dataISO(30);
  const lista = await buscarMembros(`&endDateStart=${data}&endDateEnd=${data}`, 2);
  return lista.map(m => mapear(m, '30_dias_apos_vencimento')).filter(m => m.telefone);
}

// ─────────────────────────────────────────────
// GATILHOS — COBRANÇA RECUSADA (com cache)
// ─────────────────────────────────────────────

async function cobrancasPorData(data) {
  // Busca lista de cobranças recusadas
  const lista = [];
  let skip = 0;
  while (true) {
    const lote = await evoGet(
      `/receivables?take=50&skip=${skip}&accountStatus=4&dueDateStart=${data}&dueDateEnd=${data}&idBranch=1`
    );
    if (!lote || lote.length === 0) break;
    lista.push(...lote);
    if (lote.length < 50) break;
    skip += 50;
    await sleep(2000);
  }

  if (lista.length === 0) return [];

  // Usa cache de membros — sem requisições individuais
  const cacheMembros = await obterCacheMembros();

  const resultado = [];
  for (const r of lista) {
    if (!r.idMemberPayer) continue;
    const membro = cacheMembros.get(r.idMemberPayer);
    if (!membro?.telefone) continue;
    resultado.push({
      telefone: membro.telefone,
      nome: r.payerName ? r.payerName.split(' ')[0] : membro.nome,
      valor: r.ammount,
      linkPagamento: membro.linkPagamento,
      gatilho: null,
    });
  }
  return resultado;
}

export async function gatilho_cobrancaRecusada() {
  const lista = await cobrancasPorData(dataISO(0));
  return lista.map(r => ({ ...r, gatilho: 'cobranca_recusada' }));
}

export async function gatilho_cobrancaRecusada3d() {
  const lista = await cobrancasPorData(dataISO(3));
  return lista.map(r => ({ ...r, gatilho: 'cobranca_recusada_3d' }));
}

export async function gatilho_cobrancaRecusada7d() {
  const lista = await cobrancasPorData(dataISO(7));
  return lista.map(r => ({ ...r, gatilho: 'cobranca_recusada_7d' }));
}

// ─────────────────────────────────────────────
// GATILHOS — OPORTUNIDADES / PROSPECTS
// ─────────────────────────────────────────────

export async function gatilho_posVisita() {
  const data = dataISO(1);
  const lista = await buscarProspects(`&registerDateStart=${data}&registerDateEnd=${data}&prospectStatus=Visit`);
  return lista.map(p => ({
    telefone: tel({ contacts: p.contacts }),
    nome: (p.name || p.firstName || '').split(' ')[0] || 'você',
    gatilho: 'pos_visita',
  })).filter(p => p.telefone);
}

export async function gatilho_7diasAposOportunidade() {
  const data = dataISO(7);
  const lista = await buscarProspects(`&registerDateStart=${data}&registerDateEnd=${data}`);
  return lista.map(p => ({
    telefone: tel({ contacts: p.contacts }),
    nome: (p.name || p.firstName || '').split(' ')[0] || 'você',
    gatilho: '7_dias_apos_oportunidade',
  })).filter(p => p.telefone);
}

// ─────────────────────────────────────────────
// LEGADO
// ─────────────────────────────────────────────
export async function buscarDadosCRM() {
  return {};
}
