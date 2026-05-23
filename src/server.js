import express from 'express';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import path from 'path';
import { config } from './config.js';
import { processarWebhook } from './handlers/webhookHandler.js';
import { rodarFollowups } from './handlers/followupHandler.js';
import { verificarConexao } from './services/zapi.js';
import { limparCache } from './lib/promptBuilder.js';
import { rodarCRM, rodarTransmissao } from './crm/crmHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));

// ================================================
// ROTAS
// ================================================

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Cia Fitness Mila',
    mode: config.mode,
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', async (req, res) => {
  try {
    const zapiConectado = await verificarConexao();
    res.json({
      status: 'ok',
      zapi: zapiConectado ? 'conectado' : 'desconectado',
      mode: config.mode,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ status: 'erro', message: error.message });
  }
});

app.post('/webhook', async (req, res) => {
  res.status(200).json({ received: true });
  try {
    await processarWebhook(req.body);
  } catch (error) {
    console.error('❌ Erro no webhook:', error.message);
  }
});

app.post('/trigger-followup', async (req, res) => {
  const token = req.headers['x-secret-token'];
  if (token !== config.zapi.token) return res.status(403).json({ error: 'forbidden' });
  try {
    await rodarFollowups();
    res.json({ status: 'follow-up executado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/admin/cache/clear', (req, res) => {
  const token = req.headers['x-secret-token'];
  if (token !== config.zapi.token) return res.status(403).json({ error: 'forbidden' });
  try {
    limparCache();
    res.json({ status: 'ok', message: 'Cache limpo com sucesso.', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard_mila_v2.html'));
});

// ================================================
// ROTAS CRM
// ================================================

// Disparo manual dos gatilhos (para teste)
app.post('/crm/rodar', async (req, res) => {
  const token = req.headers['x-secret-token'];
  if (token !== config.zapi.token) return res.status(403).json({ error: 'forbidden' });
  try {
    const resultado = await rodarCRM();
    res.json({ status: 'ok', resultado });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Transmissão manual via dashboard
app.post('/crm/transmissao', async (req, res) => {
  const token = req.headers['x-secret-token'];
  if (token !== config.zapi.token) return res.status(403).json({ error: 'forbidden' });
  const { lista, texto, imagemUrl } = req.body;
  if (!lista || !texto) return res.status(400).json({ error: 'lista e texto são obrigatórios' });
  try {
    const resultado = await rodarTransmissao({ lista, texto, imagemUrl });
    res.json({ status: 'ok', resultado });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================================================
// CRONS
// ================================================

if (config.server.env === 'production') {

  // Follow-up: todo hora
  cron.schedule('0 * * * *', async () => {
    console.log('⏰ Cron follow-up disparado');
    try { await rodarFollowups(); }
    catch (error) { console.error('❌ Erro no follow-up:', error.message); }
  }, { timezone: 'America/Sao_Paulo' });

  // CRM: todo dia às 8h
  cron.schedule('0 8 * * *', async () => {
    console.log('📋 Cron CRM disparado');
    try { await rodarCRM(); }
    catch (error) { console.error('❌ Erro no CRM:', error.message); }
  }, { timezone: 'America/Sao_Paulo' });

  console.log('✅ Cron follow-up agendado (a cada hora)');
  console.log('✅ Cron CRM agendado (todo dia às 8h)');

} else {
  console.log('🧪 Modo development: crons desabilitados');
}

// ================================================
// INICIA SERVIDOR
// ================================================

const PORT = config.server.port;
app.listen(PORT, () => {
  console.log('═══════════════════════════════════════');
  console.log('🚀 Cia Fitness Mila — Backend iniciado');
  console.log('═══════════════════════════════════════');
  console.log(`📍 Porta: ${PORT}`);
  console.log(`🌍 Ambiente: ${config.server.env}`);
  console.log(`🎯 Modo Mila: ${config.mode.toUpperCase()}`);
  console.log(`📞 Número Mila: ${config.mila.phoneNumber}`);
  console.log(`🔌 Webhook: POST /webhook`);
  console.log(`📊 Dashboard: GET /dashboard`);
  console.log(`📋 CRM: POST /crm/rodar`);
  console.log(`📢 Transmissão: POST /crm/transmissao`);
  console.log(`🧹 Cache: POST /admin/cache/clear`);
  console.log('═══════════════════════════════════════');
});

process.on('uncaughtException', (error) => { console.error('💥 Uncaught:', error); });
process.on('unhandledRejection', (reason) => { console.error('💥 Rejection:', reason); });
