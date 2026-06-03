import express from 'express';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import path from 'path';
import { config } from './config.js';
import { processarWebhook } from './handlers/webhookHandler.js';
import { rodarFollowups } from './handlers/followupHandler.js';
import { verificarConexao } from './services/zapi.js';
import { limparCache } from './lib/promptBuilder.js';
import { rodarTransmissao } from './crm/crmHandler.js';
import { processarEvoCRM } from './crm/evoCrmWebhook.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));

// ================================================
// ROTAS BASE
// ================================================

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Cia Fitness Mila', mode: config.mode, timestamp: new Date().toISOString() });
});

app.get('/health', async (req, res) => {
  try {
    const zapiConectado = await verificarConexao();
    res.json({ status: 'ok', zapi: zapiConectado ? 'conectado' : 'desconectado', mode: config.mode, timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ status: 'erro', message: e.message });
  }
});

app.post('/webhook', async (req, res) => {
  res.status(200).json({ received: true });
  try { await processarWebhook(req.body); }
  catch (e) { console.error('❌ Webhook:', e.message); }
});

app.post('/trigger-followup', async (req, res) => {
  if (req.headers['x-secret-token'] !== config.zapi.token) return res.status(403).json({ error: 'forbidden' });
  try { await rodarFollowups(); res.json({ status: 'ok' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/cache/clear', (req, res) => {
  if (req.headers['x-secret-token'] !== config.zapi.token) return res.status(403).json({ error: 'forbidden' });
  try { limparCache(); res.json({ status: 'ok', timestamp: new Date().toISOString() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard_mila_v2.html'));
});

// ================================================
// ROTA CRM — WEBHOOK DO EVO CRM 2.0
// O EVO chama esta rota quando um gatilho dispara
// ================================================

app.post('/evo-crm', async (req, res) => {
  res.status(200).json({ received: true });
  try {
    console.log('📋 EVO CRM recebido:', JSON.stringify(req.body).slice(0, 500));
    await processarEvoCRM(req.body, req.headers['x-secret-token']);
  } catch (e) {
    console.error('❌ EVO CRM:', e.message);
  }
});

// ================================================
// ROTA TRANSMISSÃO MANUAL
// ================================================

app.post('/crm/transmissao', async (req, res) => {
  if (req.headers['x-secret-token'] !== config.zapi.token) return res.status(403).json({ error: 'forbidden' });
  const { lista, texto, imagemUrl } = req.body;
  if (!lista || !texto) return res.status(400).json({ error: 'lista e texto são obrigatórios' });
  try { res.json({ status: 'ok', resultado: await rodarTransmissao({ lista, texto, imagemUrl }) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ================================================
// CRONS
// ================================================

if (config.server.env === 'production') {
  // Follow-up: a cada hora
  cron.schedule('0 * * * *', async () => {
    try { await rodarFollowups(); }
    catch (e) { console.error('❌ Follow-up:', e.message); }
  }, { timezone: 'America/Sao_Paulo' });

  console.log('✅ Cron follow-up agendado (a cada hora)');
  console.log('✅ CRM via webhook EVO CRM 2.0 — aguardando eventos em /evo-crm');
} else {
  console.log('🧪 Development: crons desabilitados');
}

// ================================================
// SERVIDOR
// ================================================

const PORT = config.server.port;
app.listen(PORT, () => {
  console.log('═══════════════════════════════════════');
  console.log('🚀 Cia Fitness Mila — Backend iniciado');
  console.log(`📍 ${PORT} | 🌍 ${config.server.env} | 🎯 ${config.mode.toUpperCase()}`);
  console.log('🔌 /webhook (Z-API) | 📋 /evo-crm (EVO) | 📊 /dashboard');
  console.log('═══════════════════════════════════════');
});

process.on('uncaughtException', (e) => console.error('💥', e));
process.on('unhandledRejection', (e) => console.error('💥', e));
