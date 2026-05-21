import axios from 'axios';
import { config } from '../config.js';

const zapi = axios.create({
  baseURL: config.zapi.baseUrl,
  headers: {
    'Content-Type': 'application/json',
    'Client-Token': config.zapi.clientToken,
  },
  timeout: 15000,
});

function calcularDelayDigitacao(message) {
  const chars = message.length;
  // delayTyping é em segundos (1-15)
  const segundos = Math.min(Math.max(Math.ceil(chars / 60), 1), 8);
  return segundos;
}

export async function enviarTexto(phone, message) {
  const delayTyping = calcularDelayDigitacao(message);

  try {
    const response = await zapi.post('/send-text', {
      phone,
      message,
      delayTyping,
    });

    console.log(`📤 Mensagem enviada pra ${phone} (digitando: ${delayTyping}s)`);
    return response.data;
  } catch (error) {
    console.error(`❌ Erro ao enviar texto pra ${phone}:`, error.response?.data || error.message);
    throw error;
  }
}

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

export function ehMensagemDeHumano(webhook) {
  return webhook?.fromMe === true && webhook?.isStatusReply !== true;
}

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
