import fetch from 'node-fetch';

const EVO_BASE = 'https://evo-integracao-api.w12app.com.br/api/v1';
const EVO_DNS = 'ciafitness';
const EVO_TOKEN = '59EA5FCF-5622-483A-B720-2C180A57887A';
const AUTH = 'Basic ' + Buffer.from(`${EVO_DNS}:${EVO_TOKEN}`).toString('base64');

const headers = {
  'Authorization': AUTH,
  'accept': 'application/json',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function evoGet(path) {
  const res = await fetch(`${EVO_BASE}${path}`, { headers });
  if (res.status === 429) {
    console.log('⏳ Rate limit EVO — aguardando 60s...');
    await sleep(61000);
    return evoGet(path);
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`EVO API ${path} → ${res.status}: ${txt}`);
  }
  return res.json();
}

// Cache em memória — evita buscar múltiplas vezes na mesma execução
let _cacheMembros = null;
let _cacheProspects = null;
let _cacheRecebiveis = null;
let _cacheTs = null;

function cacheValido() {
  return _cacheTs && (Date.now() - _cacheTs) < 5 * 60 * 1000; // 5 minutos
}

function limparCache() {
  _cacheMembros = null;
  _cacheProspects = null;
  _cacheRecebiveis = null;
  _cacheTs = null;
}

// Extrai telefone celular
function extrairTelefone(member) {
  if (!member.contacts) return null;
  const cel = member.contacts.find(c =>
    c.contactType === 'Cellphone' || c.idContactType === 2
  );
  if (!cel) return null;
  const ddi = cel.ddi || '55';
  const num = cel.description.replace(/\D/g, '');
  if (num.length < 10) return null;
  return `${ddi}${num}`;
}

function primeiroNome(member) {
  const nome = member.usePreferredName
    ? (member.firstName || member.registerName)
    : member.registerName;
  return (nome || '').trim().split(' ')[0];
}

function nomeInstrutor(member) {
  if (!member.nameEmployeeInstructor) return null;
  return member.nameEmployeeInstructor.trim().split(' ')[0];
}

function diasEntre(dataISO) {
  const d1 = new Date(dataISO);
  const d2 = new Date();
  d1.setHours(0, 0, 0, 0);
  d2.setHours(0, 0, 0, 0);
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
}

// Busca TODOS os membros ativos de uma vez com pausa entre páginas
async function buscarTodosMembrosAtivos() {
  if (_cacheMembros && cacheValido()) return _cacheMembros;

  const membros = [];
  let skip = 0;
  const take = 50;
  console.log('📡 Buscando membros ativos no EVO...');
  while (true) {
    const lote = await evoGet(`/members?take=${take}&skip=${skip}&membershipStatus=Active`);
    if (!lote || lote.length === 0) break;
    membros.push(...lote);
    console.log(`  → ${membros.length} membros carregados`);
    if (lote.length < take) break;
    skip += take;
    await sleep(1500); // pausa entre páginas para não estourar rate limit
  }
  _cacheMembros = membros;
  _cacheTs = Date.now();
  console.log(`✅ Total de membros ativos: ${membros.length}`);
  return membros;
}

async function buscarTodosProspects() {
  if (_cacheProspects && cacheValido()) return _cacheProspects;

  const lista = [];
  let skip = 0;
  const take = 50;
  console.log('📡 Buscando prospects no EVO...');
  while (true) {
    const lote = await evoGet(`/prospects?take=${take}&skip=${skip}`);
    if (!lote || lote.length === 0) break;
    lista.push(...lote);
    if (lote.length < take) break;
    skip += take;
    await sleep(1500);
  }
  _cacheProspects = lista;
  console.log(`✅ Total de prospects: ${lista.length}`);
  return lista;
}

async function buscarRecebiveisAtrasados() {
  if (_cacheRecebiveis && cacheValido()) return _cacheRecebiveis;

  const lista = [];
  let skip = 0;
  const take = 50;
  console.log('📡 Buscando recebíveis atrasados no EVO...');
  while (true) {
    const lote = await evoGet(`/receivables?take=${take}&skip=${skip}&accountStatus=4&idBranch=1`);
    if (!lote || lote.length === 0) break;
    lista.push(...lote);
    if (lote.length < take) break;
    skip += take;
    await sleep(1500);
  }
  _cacheRecebiveis = lista;
  console.log(`✅ Total de recebíveis atrasados: ${lista.length}`);
  return lista;
}

// ================================================
// FUNÇÃO PRINCIPAL — busca tudo uma vez e processa
// ================================================

export async function buscarDadosCRM() {
  limparCache();
  const membros = await buscarTodosMembrosAtivos();
  await sleep(2000);
  const prospects = await buscarTodosProspects();
  await sleep(2000);
  const recebiveis = await buscarRecebiveisAtrasados();
  return { membros, prospects, recebiveis };
}

// ================================================
// 9 GATILHOS — todos recebem os dados já carregados
// ================================================

export function gatilho_9diasSemPresenca(membros) {
  return membros
    .filter(m => m.lastAccessDate && diasEntre(m.lastAccessDate) === 9)
    .map(m => ({ telefone: extrairTelefone(m), nome: primeiroNome(m), instrutor: nomeInstrutor(m), gatilho: '9_dias_sem_presenca' }))
    .filter(m => m.telefone);
}

export function gatilho_18diasSemPresenca(membros) {
  return membros
    .filter(m => m.lastAccessDate && diasEntre(m.lastAccessDate) === 18)
    .map(m => ({ telefone: extrairTelefone(m), nome: primeiroNome(m), instrutor: nomeInstrutor(m), gatilho: '18_dias_sem_presenca' }))
    .filter(m => m.telefone);
}

export function gatilho_aniversario(membros) {
  const agora = new Date();
  const mes = agora.getMonth() + 1;
  const dia = agora.getDate();
  return membros
    .filter(m => {
      if (!m.birthDate) return false;
      const d = new Date(m.birthDate);
      return d.getMonth() + 1 === mes && d.getDate() === dia;
    })
    .map(m => ({ telefone: extrairTelefone(m), nome: primeiroNome(m), instrutor: nomeInstrutor(m), gatilho: 'aniversario' }))
    .filter(m => m.telefone);
}

export function gatilho_1diaAposMatricula(membros) {
  return membros
    .filter(m => m.registerDate && diasEntre(m.registerDate) === 1)
    .map(m => ({ telefone: extrairTelefone(m), nome: primeiroNome(m), instrutor: nomeInstrutor(m), gatilho: '1_dia_apos_matricula' }))
    .filter(m => m.telefone);
}

export function gatilho_30diasAposMatricula(membros) {
  return membros
    .filter(m => m.registerDate && diasEntre(m.registerDate) === 30)
    .map(m => ({ telefone: extrairTelefone(m), nome: primeiroNome(m), instrutor: nomeInstrutor(m), gatilho: '30_dias_apos_matricula' }))
    .filter(m => m.telefone);
}

export function gatilho_16diasAntesVencimento(membros) {
  return membros
    .filter(m => {
      if (!m.memberships?.length) return false;
      const contrato = m.memberships[m.memberships.length - 1];
      if (!contrato.endDate) return false;
      return -diasEntre(contrato.endDate) === 16;
    })
    .map(m => {
      const contrato = m.memberships[m.memberships.length - 1];
      return { telefone: extrairTelefone(m), nome: primeiroNome(m), instrutor: nomeInstrutor(m), vencimento: contrato.endDate, gatilho: '16_dias_antes_vencimento' };
    })
    .filter(m => m.telefone);
}

export function gatilho_5diasAposVencimento(membros) {
  return membros
    .filter(m => {
      if (!m.memberships?.length) return false;
      const contrato = m.memberships[m.memberships.length - 1];
      if (!contrato.endDate) return false;
      return diasEntre(contrato.endDate) === 5;
    })
    .map(m => {
      const contrato = m.memberships[m.memberships.length - 1];
      return { telefone: extrairTelefone(m), nome: primeiroNome(m), instrutor: nomeInstrutor(m), vencimento: contrato.endDate, gatilho: '5_dias_apos_vencimento' };
    })
    .filter(m => m.telefone);
}

export function gatilho_7diasAposOportunidade(prospects) {
  return prospects
    .filter(p => p.registerDate && diasEntre(p.registerDate) === 7)
    .map(p => ({
      telefone: extrairTelefone({ contacts: p.contacts }),
      nome: (p.name || p.firstName || '').split(' ')[0],
      gatilho: '7_dias_apos_oportunidade',
    }))
    .filter(p => p.telefone);
}

export function gatilho_cobrancaRecusada(recebiveis, membros) {
  const hoje = new Date().toISOString().split('T')[0];
  return recebiveis
    .filter(r => r.dueDate?.startsWith(hoje) && r.idMemberPayer)
    .map(r => {
      const m = membros.find(x => x.idMember === r.idMemberPayer);
      if (!m || m.membershipStatus !== 'Active') return null;
      return {
        telefone: extrairTelefone(m),
        nome: primeiroNome(m),
        valor: r.ammount,
        vencimento: r.dueDate,
        gatilho: 'cobranca_recusada',
      };
    })
    .filter(x => x && x.telefone);
}
