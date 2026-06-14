import axios from 'axios';
import { config } from '../config.js';

const META_API_VERSION = 'v20.0';
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const TOKEN = process.env.META_TOKEN;

const metaApi = axios.create({
  baseURL: `https://graph.facebook.com/${META_API_VERSION}/${PHONE_NUMBER_ID}`,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${TOKEN}`,
  },
  timeout: 15000,
});

// ================================================
// ENVIAR TEXTO
// ================================================

export async function enviarTextoMeta(phone, message) {
  try {
    const response = await metaApi.post('/messages', {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'text',
      text: {
        preview_url: false,
        body: message,
      },
    });
    console.log(`📤 [Meta] Mensagem enviada pra ${phone}`);
    return response.data;
  } catch (error) {
    const errData = error.response?.data || error.message;
    console.error(`❌ [Meta] Erro ao enviar texto pra ${phone}:`, errData);
    throw error;
  }
}

// ================================================
// ENVIAR IMAGEM
// ================================================

export async function enviarImagemMeta(phone, imageUrl, caption = '') {
  try {
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'image',
      image: {
        link: imageUrl,
      },
    };
    if (caption) body.image.caption = caption;

    const response = await metaApi.post('/messages', body);
    console.log(`🖼️ [Meta] Imagem enviada pra ${phone}`);
    return response.data;
  } catch (error) {
    const errData = error.response?.data || error.message;
    console.error(`❌ [Meta] Erro ao enviar imagem pra ${phone}:`, errData);
    throw error;
  }
}

// ================================================
// MARCAR MENSAGEM COMO LIDA
// ================================================

export async function marcarComoLida(messageId) {
  try {
    await metaApi.post('/messages', {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    });
  } catch (error) {
    // Silencioso — não crítico
  }
}

// ================================================
// PARSEAR WEBHOOK DO META
// ================================================

export function parsearWebhookMeta(body) {
  try {
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages?.length) return null;

    const msg = value.messages[0];
    const contato = value.contacts?.[0];
    const phone = msg.from; // formato: 5531999999999
    const nome = contato?.profile?.name || null;
    const tipo = msg.type;
    const messageId = msg.id;

    let conteudo = '';
    let tipoNormalizado = 'texto';

    if (tipo === 'text') {
      conteudo = msg.text?.body || '';
      tipoNormalizado = 'texto';
    } else if (tipo === 'audio') {
      conteudo = '[áudio]';
      tipoNormalizado = 'audio';
    } else if (tipo === 'image') {
      conteudo = msg.image?.caption || '[imagem]';
      tipoNormalizado = 'imagem';
    } else if (tipo === 'video') {
      conteudo = msg.video?.caption || '[vídeo]';
      tipoNormalizado = 'video';
    } else if (tipo === 'document') {
      conteudo = '[documento]';
      tipoNormalizado = 'documento';
    } else if (tipo === 'sticker') {
      conteudo = '[sticker]';
      tipoNormalizado = 'texto';
    } else {
      return null;
    }

    return {
      phone,
      nome,
      conteudo: conteudo.trim(),
      tipo: tipoNormalizado,
      timestamp: parseInt(msg.timestamp) * 1000 || Date.now(),
      messageId,
      _source: 'meta',
    };
  } catch (e) {
    console.error('❌ [Meta] Erro ao parsear webhook:', e.message);
    return null;
  }
}

export default metaApi;
