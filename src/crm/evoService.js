import fetch from 'node-fetch';

const EVO_BASE = 'https://evo-integracao-api.w12app.com.br/api/v1';
const EVO_DNS = 'ciafitness';
const EVO_TOKEN = '59EA5FCF-5622-483A-B720-2C180A57887A';
const AUTH = 'Basic ' + Buffer.from(`${EVO_DNS}:${EVO_TOKEN}`).toString('base64');

const headers = { 'Authorization': AUTH, 'accept': 'application/json' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Formata data ISO para YYYY-MM-DD
function dataISO(diasAtras = 0) {
  const d = new Date();
  d.setDate(d.getDate() - diasAtras);
  return d.toISOString().split('T')[0];
}

// Formata data para MM-DD (aniversário)
function dataMD(diasAtras = 0) {
  const d = new Date();
  d.setDate(d.getDate() - diasAtras);
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${mes}-${dia}`;
}

// Formata data futura
function dataFutura(diasAFrente) {
  const d = new Date();
  d.setDate(d.getDate() + diasAFrente);
  return d.toISOString().split('T')[0];
}

async function evoGet(path) {
  await sleep(500); // pausa entre requisições
  const res = await fetch(`${EVO_BASE}${path}`, { headers });
  if (res.status === 429) {
    console.log('⏳ Rate limit — aguardando 30s...');
    await sleep(30000);
    return evoGet(path);
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`EVO ${path} → ${res.status}: ${txt}`);
  }
  return res.json();
}

// Busca paginada com filtros
async function buscarMembros(filtros = '') {
  const lista = [];
  let skip = 0;
  const take = 50;
  while (true) {
    const lote = await evoGet(`/members?take=${take}&skip=${skip}&membershipStatus=Active${filtros}`);
    if (!lote || lote.length === 0) break;
    lista.push(...lote);
    if (lote.length < take) break;
    skip += take;
    await sleep(500);
  }
  return lista;
}

// Extrai telefone
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
  return m.nameEmployeeInstructor ? m.nameEmployeeInstructor.trim().split(' ')[0] : null;
}

function mapear(m, gatilho, extra = {}) {
  return { telefone: tel(m), nome: nome(m), instrutor: instrutor(m), gatilho, ...extra };
}

// ================================================
// 9 GATILHOS — cada um busca só quem interessa
// ================================================

// Gatilho 1: 9 dias sem presença — busca quem acessou exatamente 9 dias atrás
export async function gatilho_9diasSemPresenca() {
  const data = dataISO(9);
  const lista = await buscarMembros(`&lastAccessStart=${data}&lastAccessEnd=${data}`);
  return lista.map(m => mapear(m, '9_dias_sem_presenca')).filter(m => m.telefone);
}

// Gatilho 2: 18 dias sem presença
export async function gatilho_18diasSemPresenca() {
  const data = dataISO(18);
  const lista = await buscarMembros(`&lastAccessStart=${data}&lastAccessEnd=${data}`);
  return lista.map(m => mapear(m, '18_dias_sem_presenca')).filter(m => m.telefone);
}

// Gatilho 3: aniversariante hoje
export async function gatilho_aniversario() {
  const md = dataMD(0);
  const lista = await buscarMembros(`&birthdayStart=${md}&birthdayEnd=${md}`);
  return lista.map(m => mapear(m, 'aniversario')).filter(m => m.telefone);
}

// Gatilho 4: 1 dia após matrícula — matriculou ontem
export async function gatilho_1diaAposMatricula() {
  const data = dataISO(1);
  const lista = await buscarMembros(`&registerDateStart=${data}&registerDateEnd=${data}`);
  return lista.map(m => mapear(m, '1_dia_apos_matricula')).filter(m => m.telefone);
}

// Gatilho 5: 30 dias após matrícula
export async function gatilho_30diasAposMatricula() {
  const data = dataISO(30);
  const lista = await buscarMembros(`&registerDateStart=${data}&registerDateEnd=${data}`);
  return lista.map(m => mapear(m, '30_dias_apos_matricula')).filter(m => m.telefone);
}

// Gatilho 6: 16 dias antes do vencimento — vence daqui 16 dias
export async function gatilho_16diasAntesVencimento() {
  const data = dataFutura(16);
  const lista = await buscarMembros(`&endDateStart=${data}&endDateEnd=${data}`);
  return lista.map(m => mapear(m, '16_dias_antes_vencimento', { vencimento: data })).filter(m => m.telefone);
}

// Gatilho 7: 5 dias após vencimento — venceu há 5 dias
export async function gatilho_5diasAposVencimento() {
  const data = dataISO(5);
  const lista = await buscarMembros(`&endDateStart=${data}&endDateEnd=${data}`);
  return lista.map(m => mapear(m, '5_dias_apos_vencimento', { vencimento: data })).filter(m => m.telefone);
}

// Gatilho 8: 7 dias após cadastro de oportunidade
export async function gatilho_7diasAposOportunidade() {
  const data = dataISO(7);
  const lista = [];
  let skip = 0;
  while (true) {
    const lote = await evoGet(`/prospects?take=50&skip=${skip}&registerDateStart=${data}&registerDateEnd=${data}`);
    if (!lote || lote.length === 0) break;
    lista.push(...lote);
    if (lote.length < 50) break;
    skip += 50;
    await sleep(500);
  }
  return lista.map(p => ({
    telefone: tel({ contacts: p.contacts }),
    nome: (p.name || p.firstName || '').split(' ')[0],
    gatilho: '7_dias_apos_oportunidade',
  })).filter(p => p.telefone);
}

// Gatilho 9: cobrança recusada hoje
export async function gatilho_cobrancaRecusada() {
  const hoje = dataISO(0);
  const lista = [];
  let skip = 0;
  while (true) {
    const lote = await evoGet(`/receivables?take=50&skip=${skip}&accountStatus=4&dueDateStart=${hoje}&dueDateEnd=${hoje}&idBranch=1`);
    if (!lote || lote.length === 0) break;
    lista.push(...lote);
    if (lote.length < 50) break;
    skip += 50;
    await sleep(500);
  }
  return lista
    .filter(r => r.idMemberPayer)
    .map(r => ({
      telefone: null, // telefone vem do membro — busca abaixo se necessário
      nome: r.payerName ? r.payerName.split(' ')[0] : 'você',
      valor: r.ammount,
      idMember: r.idMemberPayer,
      gatilho: 'cobranca_recusada',
    }));
}

// Função principal — cada gatilho busca só quem interessa
export async function buscarDadosCRM() {
  return {}; // não usado mais — cada gatilho é independente
}
