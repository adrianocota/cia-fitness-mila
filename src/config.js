import dotenv from 'dotenv';

// Carrega variáveis de ambiente do arquivo .env (apenas em desenvolvimento local)
dotenv.config();

/**
 * Validação de variáveis obrigatórias.
 * Se faltar alguma, o sistema não inicia e mostra erro claro.
 */
const requiredEnvVars = [
  'OPENAI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'ZAPI_INSTANCE_ID',
  'ZAPI_TOKEN',
  'ZAPI_CLIENT_TOKEN',
  'MILA_PHONE_NUMBER',
];

const missingVars = requiredEnvVars.filter((v) => !process.env[v]);

if (missingVars.length > 0) {
  console.error('❌ Variáveis de ambiente ausentes:');
  missingVars.forEach((v) => console.error(`   - ${v}`));
  console.error('\n💡 Verifique se todas as variáveis estão configuradas no Railway.');
  process.exit(1);
}

/**
 * Configurações centralizadas do projeto.
 * Todo arquivo que precisar de credencial ou config importa daqui.
 */
export const config = {
  // OpenAI
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4o-mini',
    maxTokens: 500,
    temperature: 0.5,
  },

  // Supabase
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
  },

  // Z-API (WhatsApp)
  zapi: {
    instanceId: process.env.ZAPI_INSTANCE_ID,
    token: process.env.ZAPI_TOKEN,
    clientToken: process.env.ZAPI_CLIENT_TOKEN,
    baseUrl: `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}`,
  },

  // Identidade da Mila
  mila: {
    phoneNumber: process.env.MILA_PHONE_NUMBER,
    name: 'Mila',
    company: 'Cia do Fitness',
  },

  // Grupo de notificação de leads quentes
  group: {
    leadsId: process.env.GROUP_LEADS_ID || '',
  },

  // Modo operacional
  mode: process.env.MILA_MODE || 'test',
  testPhoneNumber: process.env.TEST_PHONE_NUMBER || '',

  // Servidor
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    env: process.env.NODE_ENV || 'development',
  },

  // Janela de horário para disparar follow-ups (24h)
  followup: {
    horarios: {
      dia1: { inicio: 14, fim: 18 },
      dia3: { inicio: 14, fim: 18 },
      dia7: { inicio: 10, fim: 12 },
      dia14: { inicio: 16, fim: 18 },
    },
    diasPermitidos: [1, 2, 3, 4, 5, 6], // Segunda a sábado (0 = domingo, 6 = sábado)
    horaMinima: 9,
    horaMaxima: 20,
  },
};

/**
 * Helpers úteis pra usar nos handlers
 */
export const isTestMode = () => config.mode === 'test';
export const isProductionMode = () => config.mode === 'production';

console.log(`✅ Config carregada. Modo: ${config.mode.toUpperCase()}`);
