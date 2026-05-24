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
import {
  gatilho_9diasSemPresenca,
  gatilho_18diasSemPresenca,
  gatilho_aniversario,
  gatilho_1diaAposMatricula,
  gatilho_30diasAposMatricula,
  gatilho_16diasAntesVencimento,
  gatilho_5diasAposVencimento,
  gatilho_7diasAposOportunidade,
  gatilho_cobrancaRecusada,
} from './crm/evoService.js';

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
// ROTAS CRM
// ================================================

app.post('/crm/rodar', async (req, res) => {
  if (req.headers['x-secret-token'] !== config.zapi.token) return res.status(403).json({ error: 'forbidden' });
  try { res.json({ status: 'ok', resultado: await rodarCRM() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/crm/transmissao', async (req, res) => {
  if (req.headers['x-secret-token'] !== config.zapi.token) return res.status(403).json({ error: 'forbidden' });
  const { lista, texto, imagemUrl } = req.body;
  if (!lista || !texto) return res.status(400).json({ error: 'lista e texto são obrigatórios' });
  try { res.json({ status: 'ok', resultado: await rodarTransmissao({ lista, texto, imagemUrl }) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Simulação — não envia mensagens, mostra quem seria atingido
app.get('/crm/simular', async (req, res) => {
  const token = req.headers['x-secret-token'] || req.query.token;
  if (token !== config.zapi.token) return res.status(403).json({ error: 'forbidden' });

  try {
    console.log('🔍 Simulação CRM iniciada...');
    const resultado = [];

    const gatilhos = [
      { label: '9 dias sem presença',      fn: gatilho_9diasSemPresenca },
      { label: '18 dias sem presença',     fn: gatilho_18diasSemPresenca },
      { label: 'Aniversário',              fn: gatilho_aniversario },
      { label: '1 dia após matrícula',     fn: gatilho_1diaAposMatricula },
      { label: '30 dias após matrícula',   fn: gatilho_30diasAposMatricula },
      { label: '16 dias antes vencimento', fn: gatilho_16diasAntesVencimento },
      { label: '5 dias após vencimento',   fn: gatilho_5diasAposVencimento },
      { label: '7 dias após oportunidade', fn: gatilho_7diasAposOportunidade },
      { label: 'Cobrança recusada',        fn: gatilho_cobrancaRecusada },
    ];

    for (const g of gatilhos) {
      try {
        console.log(`  → verificando: ${g.label}`);
        const lista = await g.fn();
        resultado.push({
          gatilho: g.label,
          total: lista.length,
          leads: lista.map(l => ({
            nome: l.nome,
            telefone: l.telefone ? l.telefone.slice(0, 6) + '****' : null,
          })),
        });
      } catch (e) {
        resultado.push({ gatilho: g.label, total: 0, erro: e.message });
      }
    }

    res.json({
      status: 'simulacao',
      aviso: 'Nenhuma mensagem foi enviada',
      data: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
      gatilhos: resultado,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

  // CRM: todo dia à 1h da madrugada (mais barato e menos impacto)
  cron.schedule('0 1 * * *', async () => {
    console.log('📋 Cron CRM disparado');
    try { await rodarCRM(); }
    catch (e) { console.error('❌ CRM:', e.message); }
  }, { timezone: 'America/Sao_Paulo' });

  console.log('✅ Crons: follow-up (hora) + CRM (1h madrugada)');
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
  console.log('🔌 /webhook | 📊 /dashboard | 📋 /crm/rodar | 🔍 /crm/simular');
  console.log('═══════════════════════════════════════');
});

process.on('uncaughtException', (e) => console.error('💥', e));
process.on('unhandledRejection', (e) => console.error('💥', e));
