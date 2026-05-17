import axios from 'axios';
import { config } from '../config.js';

// Cliente HTTP configurado com baseURL e token da Z-API
const zapi = axios.create({
  baseURL: config.zapi.baseUrl,
  headers: {
    'Content-Type': 'application/json',
    'Client-Token': config.zapi.clientToken,
  },
  timeout: 15000,
});

/**
 * Calcula delay realista baseado no tamanho da mensagem.
 * Simula tempo de digitação humana.
 *
 * @param {string} message - Texto da mensagem
 * @returns {number} delay em milissegundos
 */
function calcularDelayDigitacao(message) {
  const chars = message.length;
  // 1 segundo por cada 30 caracteres, mínimo 2s, máximo 8s
  const delay = Math.min(Math.max(Math.floor(chars / 30) * 1000, 2000), 8000);
  return delay;
}

/**
 * Aguarda N milissegundos.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Envia o status "digitando..." pro número via Z-API.
 *
 * @param {string} phone - Número destino
 * @param {string} status - 'composing' (digitando) ou 'available' (parou)
 */
async function enviarPresenca(phone, status) {
  try {
    await zapi.post('/presence', {
      phone,
      status,
    });
  } catch (error) {
    // Não quebra o fluxo se falhar — é só cosmético
    console.warn(`⚠️ Falha ao enviar presença (${status}):`, error.message);
  }
}

/**
 * Envia mensagem de texto pra um número.
 * Simula digitação humana antes de enviar.
 *
 * @param {string} phone - Número no formato 5531999999999
 * @param {string} message - Texto da mensagem
 * @returns {Promise<Object>} resposta da Z-API
 */
export async function enviarTexto(phone, message) {
  try {
    const delay = calcularDelayDigitacao(message);

    // 1. Ativa "digitando..."
    await enviarPresenca(phone, 'composing');

    // 2. Aguarda tempo proporcional ao tamanho da mensagem
    await sleep(delay);

    // 3. Envia a mensagem de fato
    const response = await zapi.post('/send-text', {
      phone,
      message,
    });

    // 4. Para o "digitando..."
    await enviarPresenca(phone, 'available');

    console.log(`📤 Mensagem enviada pra ${phone} (delay: ${delay}ms)`);
    return response.data;
  } catch (error) {
    // Garante que o "digitando" para mesmo se der erro
    await enviarPresenca(phone, 'available').catch(() => {});
    console.error(`❌ Erro ao enviar texto pra ${phone}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Envia imagem pra um número (a partir de URL pública).
 */
export async function enviarImagem(phone, imageUrl, caption = '') {
  try {
    const response = await zapi.post('/send-image', {
      phone,
      image: imageUrl,
      caption,
    });

    console.log(`🖼️ Imagem enviada pra ${phone}`);
    return response.data;
  } catch (error) {
    console.error(`❌ Erro ao enviar imagem pra ${phone}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Envia mensagem pra um grupo do WhatsApp.
 * Sem delay de digitação — notificações internas não precisam parecer humanas.
 */
export async function enviarMensagemGrupo(groupId, message) {
  try {
    const response = await zapi.post('/send-text', {
      phone: groupId,
      message,
    });

    console.log(`📤 Mensagem enviada pro grupo ${groupId}`);
    return response.data;
  } catch (error) {
    console.error(`❌ Erro ao enviar pro grupo:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Verifica se a instância da Z-API está conectada com o WhatsApp.
 */
export async function verificarConexao() {
  try {
    const response = await zapi.get('/status');
    const conectado = response.data?.connected === true;

    console.log(`🔌 Status Z-API: ${conectado ? 'CONECTADO' : 'DESCONECTADO'}`);
    return conectado;
  } catch (error) {
    console.error('❌ Erro ao verificar conexão Z-API:', error.message);
    return false;
  }
}

/**
 * Detecta se uma mensagem recebida via webhook foi enviada pelo próprio número da Mila.
 */
export function ehMensagemDeHumano(webhook) {
  return webhook?.fromMe === true && webhook?.isStatusReply !== true;
}

/**
 * Extrai dados úteis de um webhook de mensagem recebida.
 */
export function parsearWebhook(webhook) {
  if (!webhook || typeof webhook !== 'object') return null;

  if (webhook.isStatusReply || webhook.isGroup) return null;
  if (webhook.fromMe) return null;

  const phone = webhook.phone;
  if (!phone) return null;

  let conteudo = '';
  let tipo = 'texto';

  if (webhook.text?.message) {
    conteudo = webhook.text.message;
    tipo = 'texto';
  } else if (webhook.image) {
    conteudo = webhook.image.caption || '[imagem]';
    tipo = 'imagem';
  } else if (webhook.audio) {
    conteudo = '[áudio]';
    tipo = 'audio';
  } else if (webhook.video) {
    conteudo = webhook.video.caption || '[vídeo]';
    tipo = 'video';
  } else if (webhook.document) {
    conteudo = '[documento]';
    tipo = 'documento';
  } else {
    return null;
  }

  return {
    phone,
    nome: webhook.senderName || webhook.chatName || null,
    conteudo: conteudo.trim(),
    tipo,
    timestamp: webhook.momment || Date.now(),
  };
}

export default zapi;
