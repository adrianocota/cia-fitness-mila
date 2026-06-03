import fetch from 'node-fetch';

const EVO_BASE = 'https://evo-integracao-api.w12app.com.br/api/v1';
const EVO_BASE_V2 = 'https://evo-integracao-api.w12app.com.br/api/v2';
const EVO_DNS  = 'ciafitness';
const EVO_TOKEN = '59EA5FCF-5622-483A-B720-2C180A57887A';
const AUTH = 'Basic ' + Buffer.from(`${EVO_DNS}:${EVO_TOKEN}`).toString('base64');

const headers = { 'Authorization': AUTH, 'accept': 'application/json' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
// status=1 → ativos | status=2 → inativos
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

function mapear(m, gatilho, extra = {}) {
  return { telefone: tel(m), nome: nome(m), instrutor: instrutor(m), gatilho, ...extra };
}

// ─────────────────────────────────────────────
// GATILHOS — ALUNOS ATIVOS
// ─────────────────────────────────────────────

// 1. 9 dias sem presença
export async function gatilho_9diasSemPresenca() {
  const data = dataISO(9);
  const lista = await buscarMembros(`&lastAccessStart=${data}&lastAccessEnd=${data}`, 1);
  return lista.map(m => mapear(m, '9_dias_sem_presenca')).filter(m => m.telefone);
}

// 2. 18 dias sem presença
export async function gatilho_18diasSemPresenca() {
  const data = dataISO(18);
  const lista = await buscarMembros(`&lastAccessStart=${data}&lastAccessEnd=${data}`, 1);
  return lista.map(m => mapear(m, '18_dias_sem_presenca')).filter(m => m.telefone);
}

// 3. Aniversariante hoje
export async function gatilho_aniversario() {
  const md = dataMD(0);
  const lista = await buscarMembros(`&birthdayStart=${md}&birthdayEnd=${md}`, 1);
  return lista.map(m => mapear(m, 'aniversario')).filter(m => m.telefone);
}

// 4. 1 dia após matrícula
export async function gatilho_1diaAposMatricula() {
  const data = dataISO(1);
  const lista = await buscarMembros(`&registerDateStart=${data}&registerDateEnd=${data}`, 1);
  return lista.map(m => mapear(m, '1_dia_apos_matricula')).filter(m => m.telefone);
}

// 5. 30 dias após matrícula
export async function gatilho_30diasAposMatricula() {
  const data = dataISO(30);
  const lista = await buscarMembros(`&registerDateStart=${data}&registerDateEnd=${data}`, 1);
  return lista.map(m => mapear(m, '30_dias_apos_matricula')).filter(m => m.telefone);
}

// 6. 16 dias antes do vencimento
export async function gatilho_16diasAntesVencimento() {
  const data = dataFutura(16);
  const lista = await buscarMembros(`&endDateStart=${data}&endDateEnd=${data}`, 1);
  return lista.map(m => mapear(m, '16_dias_antes_vencimento', { vencimento: data })).filter(m => m.telefone);
}

// 7. 5 dias após vencimento
export async function gatilho_5diasAposVencimento() {
  const data = dataISO(5);
  const lista = await buscarMembros(`&endDateStart=${data}&endDateEnd=${data}`, 1);
  return lista.map(m => mapear(m, '5_dias_apos_vencimento', { vencimento: data })).filter(m => m.telefone);
}

// 8. 30 dias após vencimento — ex-aluno (status=2 = inativo)
export async function gatilho_30diasAposVencimento() {
  const data = dataISO(30);
  const lista = await buscarMembros(`&endDateStart=${data}&endDateEnd=${data}`, 2);
  return lista.map(m => mapear(m, '30_dias_apos_vencimento')).filter(m => m.telefone);
}

// ─────────────────────────────────────────────
// GATILHOS — COBRANÇA RECUSADA
// ─────────────────────────────────────────────

async function buscarMembroPorId(idMember) {
  try {
    const data = await evoGet(`/members/${idMember}`, EVO_BASE_V2);
    return data;
  } catch {
    return null;
  }
}

async function cobrancasPorData(data) {
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

  const resultado = [];
  for (const r of lista) {
    if (!r.idMemberPayer) continue;
    const membro = await buscarMembroPorId(r.idMemberPayer);
    const telefone = membro ? tel(membro) : null;
    if (!telefone) continue;
    resultado.push({
      telefone,
      nome:   r.payerName ? r.payerName.split(' ')[0] : (membro ? nome(membro) : 'você'),
      valor:  r.ammount,
      gatilho: null,
    });
    await sleep(2000);
  }
  return resultado;
}

// 9. Cobrança recusada — dia 0
export async function gatilho_cobrancaRecusada() {
  const lista = await cobrancasPorData(dataISO(0));
  return lista.map(r => ({ ...r, gatilho: 'cobranca_recusada' }));
}

// 10. Cobrança recusada — 3 dias
export async function gatilho_cobrancaRecusada3d() {
  const lista = await cobrancasPorData(dataISO(3));
  return lista.map(r => ({ ...r, gatilho: 'cobranca_recusada_3d' }));
}

// 11. Cobrança recusada — 7 dias
export async function gatilho_cobrancaRecusada7d() {
  const lista = await cobrancasPorData(dataISO(7));
  return lista.map(r => ({ ...r, gatilho: 'cobranca_recusada_7d' }));
}

// ─────────────────────────────────────────────
// GATILHOS — OPORTUNIDADES / PROSPECTS
// ─────────────────────────────────────────────

// 12. Pós-visita — visitou ontem
export async function gatilho_posVisita() {
  const data = dataISO(1);
  const lista = await buscarProspects(`&registerDateStart=${data}&registerDateEnd=${data}&prospectStatus=Visit`);
  return lista.map(p => ({
    telefone: tel({ contacts: p.contacts }),
    nome:     (p.name || p.firstName || '').split(' ')[0] || 'você',
    gatilho:  'pos_visita',
  })).filter(p => p.telefone);
}

// 13. 7 dias após cadastro de oportunidade
export async function gatilho_7diasAposOportunidade() {
  const data = dataISO(7);
  const lista = await buscarProspects(`&registerDateStart=${data}&registerDateEnd=${data}`);
  return lista.map(p => ({
    telefone: tel({ contacts: p.contacts }),
    nome:     (p.name || p.firstName || '').split(' ')[0] || 'você',
    gatilho:  '7_dias_apos_oportunidade',
  })).filter(p => p.telefone);
}

// ─────────────────────────────────────────────
// LEGADO — não usado
// ─────────────────────────────────────────────
export async function buscarDadosCRM() {
  return {};
}
