import fetch from 'node-fetch';

const EVO_BASE = 'https://evo-integracao-api.w12app.com.br/api/v1';
const EVO_DNS = 'ciafitness';
const EVO_TOKEN = '59EA5FCF-5622-483A-B720-2C180A57887A';
const AUTH = 'Basic ' + Buffer.from(`${EVO_DNS}:${EVO_TOKEN}`).toString('base64');

const headers = {
  'Authorization': AUTH,
  'accept': 'application/json',
  'Content-Type': 'application/json',
};

async function evoGet(path) {
  const res = await fetch(`${EVO_BASE}${path}`, { headers });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`EVO API ${path} → ${res.status}: ${txt}`);
  }
  return res.json();
}

// Extrai telefone celular do membro (formato: 5531XXXXXXXXX)
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

// Primeiro nome
function primeiroNome(member) {
  const nome = member.usePreferredName
    ? (member.firstName || member.registerName)
    : member.registerName;
  return (nome || '').trim().split(' ')[0];
}

// Nome do instrutor responsável
function nomeInstrutor(member) {
  if (!member.nameEmployeeInstructor) return null;
  return member.nameEmployeeInstructor.trim().split(' ')[0];
}

// Data de hoje sem hora
function hoje() {
  return new Date().toISOString().split('T')[0];
}

// Diferença em dias entre duas datas
function diasEntre(dataISO, dataRef = new Date()) {
  const d1 = new Date(dataISO);
  const d2 = new Date(dataRef);
  d1.setHours(0, 0, 0, 0);
  d2.setHours(0, 0, 0, 0);
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
}

// Busca todos os membros ativos (paginado)
async function buscarMembrosAtivos() {
  const membros = [];
  let skip = 0;
  const take = 50;
  while (true) {
    const lote = await evoGet(
      `/members?take=${take}&skip=${skip}&membershipStatus=Active`
    );
    if (!lote || lote.length === 0) break;
    membros.push(...lote);
    if (lote.length < take) break;
    skip += take;
  }
  return membros;
}

// Busca todos os prospects (oportunidades)
async function buscarProspects() {
  const lista = [];
  let skip = 0;
  const take = 50;
  while (true) {
    const lote = await evoGet(`/prospects?take=${take}&skip=${skip}`);
    if (!lote || lote.length === 0) break;
    lista.push(...lote);
    if (lote.length < take) break;
    skip += take;
  }
  return lista;
}

// Busca recebíveis em atraso (cobrança recusada no recorrente)
async function buscarRecebiveisAtrasados() {
  const lista = [];
  let skip = 0;
  const take = 50;
  while (true) {
    const lote = await evoGet(
      `/receivables?take=${take}&skip=${skip}&accountStatus=4&idBranch=1`
    );
    if (!lote || lote.length === 0) break;
    lista.push(...lote);
    if (lote.length < take) break;
    skip += take;
  }
  return lista;
}

// ================================================
// 9 GATILHOS
// ================================================

// Gatilho 1: 9 dias sem presença
export async function gatilho_9diasSemPresenca() {
  const membros = await buscarMembrosAtivos();
  return membros
    .filter(m => {
      if (!m.lastAccessDate) return false;
      const dias = diasEntre(m.lastAccessDate);
      return dias === 9;
    })
    .map(m => ({
      telefone: extrairTelefone(m),
      nome: primeiroNome(m),
      instrutor: nomeInstrutor(m),
      diasSemPresenca: diasEntre(m.lastAccessDate),
      gatilho: '9_dias_sem_presenca',
    }))
    .filter(m => m.telefone);
}

// Gatilho 2: 18 dias sem presença
export async function gatilho_18diasSemPresenca() {
  const membros = await buscarMembrosAtivos();
  return membros
    .filter(m => {
      if (!m.lastAccessDate) return false;
      const dias = diasEntre(m.lastAccessDate);
      return dias === 18;
    })
    .map(m => ({
      telefone: extrairTelefone(m),
      nome: primeiroNome(m),
      instrutor: nomeInstrutor(m),
      diasSemPresenca: diasEntre(m.lastAccessDate),
      gatilho: '18_dias_sem_presenca',
    }))
    .filter(m => m.telefone);
}

// Gatilho 3: aniversariante do dia (cliente ativo)
export async function gatilho_aniversario() {
  const membros = await buscarMembrosAtivos();
  const agora = new Date();
  const mes = agora.getMonth() + 1;
  const dia = agora.getDate();
  return membros
    .filter(m => {
      if (!m.birthDate) return false;
      const d = new Date(m.birthDate);
      return d.getMonth() + 1 === mes && d.getDate() === dia;
    })
    .map(m => ({
      telefone: extrairTelefone(m),
      nome: primeiroNome(m),
      instrutor: nomeInstrutor(m),
      gatilho: 'aniversario',
    }))
    .filter(m => m.telefone);
}

// Gatilho 4: 1 dia após matrícula
export async function gatilho_1diaAposMatricula() {
  const membros = await buscarMembrosAtivos();
  return membros
    .filter(m => {
      if (!m.registerDate) return false;
      return diasEntre(m.registerDate) === 1;
    })
    .map(m => ({
      telefone: extrairTelefone(m),
      nome: primeiroNome(m),
      instrutor: nomeInstrutor(m),
      gatilho: '1_dia_apos_matricula',
    }))
    .filter(m => m.telefone);
}

// Gatilho 5: 30 dias após matrícula
export async function gatilho_30diasAposMatricula() {
  const membros = await buscarMembrosAtivos();
  return membros
    .filter(m => {
      if (!m.registerDate) return false;
      return diasEntre(m.registerDate) === 30;
    })
    .map(m => ({
      telefone: extrairTelefone(m),
      nome: primeiroNome(m),
      instrutor: nomeInstrutor(m),
      gatilho: '30_dias_apos_matricula',
    }))
    .filter(m => m.telefone);
}

// Gatilho 6: 16 dias antes do vencimento do contrato
export async function gatilho_16diasAntesVencimento() {
  const membros = await buscarMembrosAtivos();
  const alvo = [];
  for (const m of membros) {
    if (!m.memberships || m.memberships.length === 0) continue;
    const contrato = m.memberships[m.memberships.length - 1];
    if (!contrato.endDate) continue;
    const diasAteVencer = -diasEntre(contrato.endDate); // negativo = futuro
    if (diasAteVencer === 16) {
      alvo.push({
        telefone: extrairTelefone(m),
        nome: primeiroNome(m),
        instrutor: nomeInstrutor(m),
        vencimento: contrato.endDate,
        gatilho: '16_dias_antes_vencimento',
      });
    }
  }
  return alvo.filter(m => m.telefone);
}

// Gatilho 7: 5 dias após vencimento do contrato
export async function gatilho_5diasAposVencimento() {
  const membros = await buscarMembrosAtivos();
  const alvo = [];
  for (const m of membros) {
    if (!m.memberships || m.memberships.length === 0) continue;
    const contrato = m.memberships[m.memberships.length - 1];
    if (!contrato.endDate) continue;
    const diasAposVencer = diasEntre(contrato.endDate);
    if (diasAposVencer === 5) {
      alvo.push({
        telefone: extrairTelefone(m),
        nome: primeiroNome(m),
        instrutor: nomeInstrutor(m),
        vencimento: contrato.endDate,
        gatilho: '5_dias_apos_vencimento',
      });
    }
  }
  return alvo.filter(m => m.telefone);
}

// Gatilho 8: 7 dias após cadastro de oportunidade
export async function gatilho_7diasAposOportunidade() {
  const prospects = await buscarProspects();
  return prospects
    .filter(p => {
      if (!p.registerDate) return false;
      return diasEntre(p.registerDate) === 7;
    })
    .map(p => ({
      telefone: extrairTelefone({ contacts: p.contacts }),
      nome: (p.name || p.firstName || '').split(' ')[0],
      gatilho: '7_dias_apos_oportunidade',
    }))
    .filter(p => p.telefone);
}

// Gatilho 9: cobrança recusada no crédito recorrente
export async function gatilho_cobrancaRecusada() {
  const recebíveis = await buscarRecebiveisAtrasados();
  const hoje_data = hoje();
  // Só dispara para cobranças que venceram hoje
  const deHoje = recebíveis.filter(r => {
    if (!r.dueDate) return false;
    return r.dueDate.startsWith(hoje_data);
  });

  // Busca dados do membro para cada recebível
  const alvo = [];
  for (const r of deHoje) {
    if (!r.idMemberPayer) continue;
    try {
      const membros = await evoGet(
        `/members?take=1&skip=0&idMember=${r.idMemberPayer}`
      );
      if (!membros || membros.length === 0) continue;
      const m = membros[0];
      if (m.membershipStatus !== 'Active') continue;
      alvo.push({
        telefone: extrairTelefone(m),
        nome: primeiroNome(m),
        valor: r.ammount,
        vencimento: r.dueDate,
        gatilho: 'cobranca_recusada',
      });
    } catch (e) {
      console.error(`Erro ao buscar membro ${r.idMemberPayer}:`, e.message);
    }
  }
  return alvo.filter(a => a.telefone);
}
