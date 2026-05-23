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
import { buscarDadosCRM, gatilho_9diasSemPresenca, gatilho_18diasSemPresenca, gatilho_aniversario, gatilho_1diaAposMatricula, gatilho_30diasAposMatricula, gatilho_16diasAntesVencimento, gatilho_5diasAposVencimento, gatilho_7diasAposOportunidade, gatilho_cobrancaRecusada } from './crm/evoService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Cia Fitness Mila', mode: config.mode, timestamp: new Date().toISOString() });
});

app.get('/health', async (req, res) => {
  try {
    const zapiConectado = await verificarConexao();
    res.json({ status: 'ok', zapi: zapiConectado ? 'conectado' : 'desconectado', mode: config.mode, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ status: 'erro', message: error.message });
  }
});

app.post('/webhook', async (req, res) => {
  res.status(200).json({ received: true });
  try { await processarWebhook(req.body); }
  catch (error) { console.error('❌ Erro no webhook:', error.message); }
});

app.post('/trigger-followup', async (req, res) => {
  const token = req.headers['x-secret-token'];
  if (token !== config.zapi.token) return res.status(403).json({ error: 'forbidden' });
  try { await rodarFollowups(); res.json({ status: 'follow-up executado' }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/admin/cache/clear', (req, res) => {
  const token = req.headers['x-secret-token'];
  if (token !== config.zapi.token) return res.status(403).json({ error: 'forbidden' });
  try { limparCache(); res.json({ status: 'ok', message: 'Cache limpo.', timestamp: new Date().toISOString() }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard_mila_v2.html'));
});

app.post('/crm/rodar', async (req, res) => {
  const token = req.headers['x-secret-token'];
  if (token !== config.zapi.token) return res.status(403).json({ error: 'forbidden' });
  try { const resultado = await rodarCRM(); res.json({ status: 'ok', resultado }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/crm/transmissao', async (req, res) => {
  const token = req.headers['x-secret-token'];
  if (token !== config.zapi.token) return res.status(403).json({ error: 'forbidden' });
  const { lista, texto, imagemUrl } = req.body;
  if (!lista || !texto) return res.status(400).json({ error: 'lista e texto são obrigatórios' });
  try { const resultado = await rodarTransmissao({ lista, texto, imagemUrl }); res.json({ status: 'ok', resultado }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

// Simulação — busca dados uma vez, processa tudo localmente, sem disparar mensagens
app.get('/crm/simular', async (req, res) => {
  const token = req.headers['x-secret-token'] || req.query.token;
  if (token !== config.zapi.token) return res.status(403).json({ error: 'forbidden' });
  try {
    console.log('🔍 Simulação CRM iniciada...');
    const { membros, prospects, recebiveis } = await buscarDadosCRM();

    const gatilhos = [
      { label: '9 dias sem presença',      lista: gatilho_9diasSemPresenca(membros) },
      { label: '18 dias sem presença',     lista: gatilho_18diasSemPresenca(membros) },
      { label: 'Aniversário',              lista: gatilho_aniversario(membros) },
      { label: '1 dia após matrícula',     lista: gatilho_1diaAposMatricula(membros) },
      { label: '30 dias após matrícula',   lista: gatilho_30diasAposMatricula(membros) },
      { label: '16 dias antes vencimento', lista: gatilho_16diasAntesVencimento(membros) },
      { label: '5 dias após vencimento',   lista: gatilho_5diasAposVencimento(membros) },
      { label: '7 dias após oportunidade', lista: gatilho_7diasAposOportunidade(prospects) },
      { label: 'Cobrança recusada',        lista: gatilho_cobrancaRecusada(recebiveis, membros) },
    ];

    res.json({
      status: 'simulacao',
      aviso: 'Nenhuma mensagem foi enviada',
      data: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
      total_membros: membros.length,
      total_prospects: prospects.length,
      gatilhos: gatilhos.map(g => ({
        gatilho: g.label,
        total: g.lista.length,
        leads: g.lista.map(l => ({ nome: l.nome, telefone: l.telefone ? l.telefone.slice(0, 6) + '****' : null })),
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

if (config.server.env === 'production') {
  cron.schedule('0 * * * *', async () => {
    try { await rodarFollowups(); } catch (e) { console.error('❌ Follow-up:', e.message); }
  }, { timezone: 'America/Sao_Paulo' });

  cron.schedule('0 8 * * *', async () => {
    try { await rodarCRM(); } catch (e) { console.error('❌ CRM:', e.message); }
  }, { timezone: 'America/Sao_Paulo' });

  console.log('✅ Crons agendados: follow-up (hora) + CRM (8h)');
} else {
  console.log('🧪 Development: crons desabilitados');
}

const PORT = config.server.port;
app.listen(PORT, () => {
  console.log('═══════════════════════════════════════');
  console.log('🚀 Cia Fitness Mila — Backend iniciado');
  console.log(`📍 Porta: ${PORT} | 🌍 ${config.server.env} | 🎯 ${config.mode.toUpperCase()}`);
  console.log(`🔌 /webhook | 📊 /dashboard | 📋 /crm/rodar | 🔍 /crm/simular`);
  console.log('═══════════════════════════════════════');
});

process.on('uncaughtException', (e) => console.error('💥', e));
process.on('unhandledRejection', (e) => console.error('💥', e));
