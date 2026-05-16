import axios from 'axios';
import { config } from '../config.js';

// Cliente HTTP configurado com baseURL e token da Z-API
const zapi = axios.create({
  baseURL: config.zapi.baseUrl,
  headers: {
    'Content-Type': 'application/json',
    'Client-Token': config.zapi.clientToken,
  },
  timeout: 15000, // 15 segundos
});

/**
 * Envia mensagem de texto pra um número.
 *
 * @param {string} phone - Número no formato 5531999999999 (sem + nem espaços)
 * @param {string} message - Texto da mensagem
 * @returns {Promise<Object>} resposta da Z-API
 */
export async function enviarTexto(phone, message) {
  try {
    const response = await zapi.post('/send-text', {
      phone,
      message,
    });

    console.log(`📤 Mensagem enviada pra ${phone}`);
    return response.data;
  } catch (error) {
    console.error(`❌ Erro ao enviar texto pra ${phone}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Envia imagem pra um número (a partir de URL pública).
 *
 * @param {string} phone - Número destino
 * @param {string} imageUrl - URL pública da imagem (deve ser acessível externamente)
 * @param {string} caption - Legenda opcional
 * @returns {Promise<Object>}
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
 *
 * @param {string} groupId - ID do grupo (formato: 120363xxxxxxxxxxxxx@g.us)
 * @param {string} message - Mensagem a enviar
 * @returns {Promise<Object>}
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
 *
 * @returns {Promise<boolean>}
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
 * Detecta se uma mensagem recebida via webhook foi enviada pelo próprio número da Mila
 * (humano operando manualmente pelo painel).
 *
 * @param {Object} webhook - Dados do webhook recebido
 * @returns {boolean} true se foi humano operando manualmente
 */
export function ehMensagemDeHumano(webhook) {
  // Se a mensagem foi enviada pelo próprio número da Mila (não recebida),
  // significa que um humano usou o painel da Z-API ou o WhatsApp Business diretamente
  return webhook?.fromMe === true && webhook?.isStatusReply !== true;
}

/**
 * Extrai dados úteis de um webhook de mensagem recebida.
 * Padroniza o formato dos campos pra usar no resto do código.
 *
 * @param {Object} webhook - Body do webhook da Z-API
 * @returns {Object|null} mensagem padronizada ou null se inválida
 */
export function parsearWebhook(webhook) {
  if (!webhook || typeof webhook !== 'object') return null;

  // Ignora mensagens de status, atualizações, etc.
  if (webhook.isStatusReply || webhook.isGroup) return null;

  // Ignora mensagens próprias (já tratadas em ehMensagemDeHumano)
  if (webhook.fromMe) return null;

  // Pega o número do remetente
  const phone = webhook.phone;
  if (!phone) return null;

  // Pega o conteúdo da mensagem (pode ser texto ou outro tipo)
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
    return null; // Tipo desconhecido, ignora
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
