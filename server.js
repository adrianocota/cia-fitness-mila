import express from 'express';
import cron from 'node-cron';
import { config } from './config.js';
import { processarWebhook } from './handlers/webhookHandler.js';
import { rodarFollowups } from './handlers/followupHandler.js';
import { verificarConexao } from './services/zapi.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

// ================================================
// ROTAS
// ================================================

/**
 * Rota de saúde — usada pra verificar se o servidor está no ar.
 */
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Cia Fitness Mila',
    mode: config.mode,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Rota de health check com status da Z-API.
 */
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
    res.status(500).json({
      status: 'erro',
      message: error.message,
    });
  }
});

/**
 * Webhook principal — recebe notificações da Z-API.
 */
app.post('/webhook', async (req, res) => {
  res.status(200).json({ received: true });

  try {
    await processarWebhook(req.body);
  } catch (error) {
    console.error('❌ Erro no processamento do webhook:', error.message);
    console.error(error.stack);
  }
});

/**
 * Rota de gatilho manual de follow-up (pra testes).
 */
app.post('/trigger-followup', async (req, res) => {
  const token = req.headers['x-secret-token'];
  if (token !== config.zapi.token) {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    await rodarFollowups();
    res.json({ status: 'follow-up executado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================================================
// CRON DE FOLLOW-UP
// ================================================

if (config.server.env === 'production') {
  cron.schedule('0 * * * *', async () => {
    console.log('⏰ Cron de follow-up disparado');
    try {
      await rodarFollowups();
    } catch (error) {
      console.error('❌ Erro no cron de follow-up:', error.message);
    }
  }, {
    timezone: 'America/Sao_Paulo',
  });

  console.log('✅ Cron de follow-up agendado (a cada hora)');
} else {
  console.log('🧪 Modo development: cron de follow-up desabilitado');
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
  console.log('═══════════════════════════════════════');
});

// ================================================
// TRATAMENTO DE ERROS NÃO CAPTURADOS
// ================================================

process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled Rejection:', reason);
});
