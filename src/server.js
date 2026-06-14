import express from 'express';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import path from 'path';
import { config } from './config.js';
import { processarWebhook } from './handlers/webhookHandler.js';
import { rodarFollowups } from './handlers/followupHandler.js';
import { verificarConexao } from './services/zapi.js';
import { limparCache } from './lib/promptBuilder.js';
import { rodarTransmissao, rodarCRM } from './crm/crmHandler.js';
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

// Rota para disparar CRM manualmente (testes/emergência)
app.post('/trigger-crm', async (req, res) => {
  if (req.headers['x-secret-token'] !== config.zapi.token) return res.status(403).json({ error: 'forbidden' });
  try { await rodarCRM(); res.json({ status: 'ok' }); }
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
// ROTA WEBHOOK — API OFICIAL WHATSAPP (META)
// ================================================

const WEBHOOK_META_TOKEN = 'mila_cia_fitness_2026';

// GET — verificação do webhook pelo Meta
app.get('/webhook-meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('🔍 Meta webhook verify:', { mode, token });

  if (mode === 'subscribe' && token === WEBHOOK_META_TOKEN) {
    console.log('✅ Meta webhook verificado com sucesso');
    res.status(200).send(challenge);
  } else {
    console.warn('❌ Meta webhook token inválido');
    res.status(403).send('Forbidden');
  }
});

// POST — recebe mensagens da API Oficial
app.post('/webhook-meta', async (req, res) => {
  res.status(200).json({ received: true });
  try {
    const body = req.body;
    console.log('📨 Meta webhook recebido:', JSON.stringify(body).slice(0, 500));

    // Extrai mensagens do payload Meta
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages?.length) return; // ping de status, ignora

    const msg = value.messages[0];
    const contato = value.contacts?.[0];
    const telefone = msg.from; // formato: 5531999999999
    const nome = contato?.profile?.name || '';
    const tipo = msg.type;

    let texto = '';
    if (tipo === 'text') {
      texto = msg.text?.body || '';
    } else if (tipo === 'audio') {
      texto = '[audio]';
    } else if (tipo === 'image') {
      texto = '[imagem]';
    } else {
      texto = `[${tipo}]`;
    }

    console.log(`📱 Meta | ${telefone} (${nome}): ${texto}`);

    // Monta payload no formato esperado pelo webhookHandler (compatível com Z-API)
    const payloadCompativel = {
      _source: 'meta', // marcador para diferenciar de Z-API
      phone: telefone,
      name: nome,
      text: { message: texto },
      isGroup: false,
      fromMe: false,
      momment: Date.now(),
      messageId: msg.id,
      type: tipo,
    };

    await processarWebhook(payloadCompativel);
  } catch (e) {
    console.error('❌ Meta webhook:', e.message);
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
  // Follow-up: a cada hora, apenas entre 9h e 20h, seg a sáb
  cron.schedule('0 9-20 * * 1-6', async () => {
    try { await rodarFollowups(); }
    catch (e) { console.error('❌ Follow-up:', e.message); }
  }, { timezone: 'America/Sao_Paulo' });

  // CRM automático: todos os dias às 08h
  cron.schedule('0 8 * * *', async () => {
    console.log('⏰ Iniciando CRM automático das 08h...');
    try { await rodarCRM(); }
    catch (e) { console.error('❌ CRM automático:', e.message); }
  }, { timezone: 'America/Sao_Paulo' });

  console.log('✅ Cron follow-up agendado (9h–20h, seg–sáb)');
  console.log('✅ Cron CRM agendado (08h diário)');
  console.log('✅ CRM via webhook EVO CRM 2.0 — aguardando eventos em /evo-crm');
  console.log('✅ API Oficial WhatsApp — aguardando eventos em /webhook-meta');
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
  console.log('🔌 /webhook (Z-API) | /webhook-meta (Meta) | 📋 /evo-crm (EVO) | 📊 /dashboard');
  console.log('═══════════════════════════════════════');
});

process.on('uncaughtException', (e) => console.error('💥', e));
process.on('unhandledRejection', (e) => console.error('💥', e));
