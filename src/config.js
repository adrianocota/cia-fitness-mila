import dotenv from 'dotenv';
dotenv.config();

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

export const config = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4.1-mini',
    maxTokens: 500,
    temperature: 0.5,
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
  },
  zapi: {
    instanceId: process.env.ZAPI_INSTANCE_ID,
    token: process.env.ZAPI_TOKEN,
    clientToken: process.env.ZAPI_CLIENT_TOKEN,
    baseUrl: `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}`,
  },
  meta: {
    token: process.env.META_TOKEN || '',
    phoneNumberId: process.env.META_PHONE_NUMBER_ID || '',
    wabaId: process.env.META_WABA_ID || '',
  },
  mila: {
    phoneNumber: process.env.MILA_PHONE_NUMBER,
    name: 'Mila',
    company: 'Cia do Fitness',
  },
  group: {
    leadsId: process.env.GROUP_LEADS_ID || '',
  },
  mode: process.env.MILA_MODE || 'test',
  testPhoneNumber: process.env.TEST_PHONE_NUMBER || '',
  adminPhones: (process.env.ADMIN_PHONES || '')
    .split(',')
    .map(p => p.trim().replace(/\D/g, ''))
    .filter(Boolean),
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    env: process.env.NODE_ENV || 'development',
  },
  followup: {
    horarios: {
      dia1: { inicio: 14, fim: 18 },
      dia3: { inicio: 14, fim: 18 },
      dia7: { inicio: 10, fim: 12 },
      dia14: { inicio: 16, fim: 18 },
    },
    diasPermitidos: [1, 2, 3, 4, 5, 6],
    horaMinima: 9,
    horaMaxima: 20,
  },
};

export const isTestMode = () => config.mode === 'test';
export const isProductionMode = () => config.mode === 'production';
export const isAdminPhone = (phone) => {
  const numLimpo = (phone || '').replace(/\D/g, '');
  return config.adminPhones.includes(numLimpo);
};

console.log(`✅ Config carregada. Modo: ${config.mode.toUpperCase()}`);
console.log(`✅ Admin phones: ${config.adminPhones.length > 0 ? config.adminPhones.join(', ') : 'nenhum configurado'}`);
console.log(`✅ Meta API: ${config.meta.phoneNumberId ? 'configurada' : 'não configurada'}`);
