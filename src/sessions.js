/**
 * Session manager for WhatsApp Web instances
 * Manages multiple whatsapp-web.js clients, one per session
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const axios = require('axios');
const config = require('./config');
const { qrToBase64, extractPhoneNumber } = require('./utils');

// In-memory session storage
const sessions = new Map();

/**
 * Session metadata structure
 */
class SessionInfo {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.client = null;
    this.status = 'initializing'; // initializing, qr, ready, authenticated, disconnected, auth_failure
    this.qrCode = null;
    this.phoneNumber = null;
    this.displayName = null;
    this.webhookUrl = null;
    this.webhookEvents = [];
    this.createdAt = new Date();
    this.lastQrUpdate = null;
  }
}

/**
 * Forward webhook event to main app
 * @param {string} sessionId - Session ID
 * @param {string} event - Event type
 * @param {object} data - Event data
 */
async function forwardWebhook(sessionId, event, data) {
  const session = sessions.get(sessionId);
  if (!session || !session.webhookUrl) {
    return;
  }

  // Check if event is configured
  if (session.webhookEvents.length > 0 && !session.webhookEvents.includes(event)) {
    return;
  }

  const payload = {
    event,
    instanceId: sessionId,
    data,
  };

  try {
    const headers = {
      'Content-Type': 'application/json',
    };

    // Add shared secret header if configured
    if (config.webhookSecret) {
      const crypto = require('crypto');
      const hmac = crypto.createHmac('sha256', config.webhookSecret);
      const signature = hmac.update(JSON.stringify(payload)).digest('hex');
      headers['x-wa-hub-signature'] = signature;
    }

    await axios.post(session.webhookUrl, payload, { headers });
    console.log(`[${sessionId}] Webhook forwarded: ${event}`);
  } catch (error) {
    console.error(`[${sessionId}] Webhook forwarding failed:`, error.message);
    // Don't throw - webhook failures should not break the service
  }
}

/**
 * Create and initialize a new WhatsApp session
 * @param {string} sessionId - Session ID
 * @param {string} name - Session name
 * @param {object} webhookConfig - Webhook configuration
 * @returns {Promise<SessionInfo>} Session info
 */
async function createSession(sessionId, name, webhookConfig = {}) {
  if (sessions.has(sessionId)) {
    throw new Error(`Instance with name "${name}" already exists (ID: ${sessionId}). Use the existing instance instead of creating a duplicate.`);
  }

  console.log(`[${sessionId}] Creating new session: ${name}`);

  const sessionInfo = new SessionInfo(sessionId, name);
  // Each instance must provide its own webhook URL (no default)
  if (!webhookConfig.url) {
    throw new Error('Webhook URL is required. Provide it in the webhook.url field when creating the instance.');
  }
  sessionInfo.webhookUrl = webhookConfig.url;
  sessionInfo.webhookEvents = webhookConfig.events || [];

  // Create WhatsApp client using system Chromium
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: sessionId,
    }),
    puppeteer: {
      headless: true,
      executablePath: config.chromePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    },
  });

  sessionInfo.client = client;
  sessionInfo.status = 'initializing';
  sessions.set(sessionId, sessionInfo);

  // Set up event listeners
  setupEventListeners(sessionId, client);

  // Initialize client
  try {
    await client.initialize();
  } catch (error) {
    console.error(`[${sessionId}] Failed to initialize client:`, error);
    sessionInfo.status = 'auth_failure';
    throw error;
  }

  return sessionInfo;
}

/**
 * Set up event listeners for a WhatsApp client
 * @param {string} sessionId - Session ID
 * @param {Client} client - WhatsApp client
 */
function setupEventListeners(sessionId, client) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // QR code event
  client.on('qr', async (qr) => {
    console.log(`[${sessionId}] QR code received`);
    try {
      const qrBase64 = await qrToBase64(qr);
      session.qrCode = qrBase64;
      session.status = 'qr';
      session.lastQrUpdate = new Date();
      
      // Forward QR webhook
      await forwardWebhook(sessionId, 'qr', {
        qr: qrBase64,
      });
    } catch (error) {
      console.error(`[${sessionId}] Error processing QR code:`, error);
    }
  });

  // Authenticated event
  client.on('authenticated', () => {
    console.log(`[${sessionId}] Authenticated`);
    session.status = 'authenticated';
    forwardWebhook(sessionId, 'authenticated', {});
  });

  // Ready event
  client.on('ready', async () => {
    console.log(`[${sessionId}] Client ready`);
    session.status = 'ready';
    
    // Get client info
    try {
      const info = client.info;
      if (info) {
        session.displayName = info.pushname || null;
        session.phoneNumber = info.wid?.user || null;
      }
    } catch (error) {
      console.error(`[${sessionId}] Error getting client info:`, error);
    }
    
    await forwardWebhook(sessionId, 'ready', {
      status: 'ready',
    });
  });

  // Authentication failure
  client.on('auth_failure', (msg) => {
    console.error(`[${sessionId}] Authentication failure:`, msg);
    session.status = 'auth_failure';
    forwardWebhook(sessionId, 'auth_failure', {
      message: msg,
    });
  });

  // Disconnected event
  client.on('disconnected', (reason) => {
    console.log(`[${sessionId}] Disconnected:`, reason);
    session.status = 'disconnected';
    forwardWebhook(sessionId, 'disconnected', {
      reason: reason || 'unknown',
    });
  });

  // State change event
  client.on('change_state', (state) => {
    console.log(`[${sessionId}] State changed:`, state);
    forwardWebhook(sessionId, 'change_state', {
      status: state,
    });
  });

  // Message event
  client.on('message', async (message) => {
    try {
      const messageData = {
        message: {
          from: extractPhoneNumber(message.from),
          body: message.body || message.text || '',
          text: message.body || message.text || '',
          type: message.type || 'text',
          timestamp: message.timestamp,
          id: message.id?._serialized || message.id || null,
        },
      };
      
      await forwardWebhook(sessionId, 'message', messageData);
    } catch (error) {
      console.error(`[${sessionId}] Error processing message:`, error);
    }
  });

  // Poll vote event (vote_update)
  client.on('vote_update', async (vote) => {
    try {
      const voteData = {
        vote: {
          voter: extractPhoneNumber(vote.voter || vote.from || vote.chatId),
          selectedOptions: vote.selectedOptions || vote.selected_options || vote.options || [],
          timestamp: vote.timestamp || Date.now(),
        },
      };
      
      await forwardWebhook(sessionId, 'vote_update', voteData);
    } catch (error) {
      console.error(`[${sessionId}] Error processing vote:`, error);
    }
  });
}

/**
 * Get session by ID
 * @param {string} sessionId - Session ID
 * @returns {SessionInfo|null} Session info or null
 */
function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

/**
 * Get all sessions
 * @returns {Array<SessionInfo>} Array of session info
 */
function getAllSessions() {
  return Array.from(sessions.values());
}

/**
 * Delete a session (logs out WhatsApp client, destroys it, and removes from memory)
 * This is called by both DELETE /instances/:id and POST /instances/:id/client/action/logout
 * @param {string} sessionId - Session ID
 * @returns {Promise<void>}
 */
async function deleteSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  console.log(`[${sessionId}] Deleting session (logout and destroy)`);

  try {
    if (session.client) {
      // Step 1: Logout from WhatsApp (disconnects the session)
      try {
        await session.client.logout();
        console.log(`[${sessionId}] Client logged out`);
      } catch (error) {
        console.error(`[${sessionId}] Error during logout:`, error);
      }
      
      // Step 2: Destroy the client instance (cleanup resources)
      try {
        await session.client.destroy();
        console.log(`[${sessionId}] Client destroyed`);
      } catch (error) {
        console.error(`[${sessionId}] Error destroying client:`, error);
      }
    }
  } catch (error) {
    console.error(`[${sessionId}] Error cleaning up session:`, error);
  } finally {
    // Step 3: Remove session from memory (instance is now completely destroyed)
    sessions.delete(sessionId);
    console.log(`[${sessionId}] Session removed from memory`);
  }
}

/**
 * Update session webhook configuration
 * @param {string} sessionId - Session ID
 * @param {object} webhookConfig - Webhook configuration
 */
function updateWebhookConfig(sessionId, webhookConfig) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  if (webhookConfig.url) {
    session.webhookUrl = webhookConfig.url;
  }
  
  if (webhookConfig.events && Array.isArray(webhookConfig.events)) {
    session.webhookEvents = webhookConfig.events;
  }
}

/**
 * Get client state
 * @param {string} sessionId - Session ID
 * @returns {Promise<string>} Client state
 */
async function getClientState(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || !session.client) {
    return null;
  }

  try {
    const state = await session.client.getState();
    return state;
  } catch (error) {
    console.error(`[${sessionId}] Error getting client state:`, error);
    return null;
  }
}

module.exports = {
  createSession,
  getSession,
  getAllSessions,
  deleteSession,
  updateWebhookConfig,
  getClientState,
};

