/**
 * Session manager for WhatsApp Web instances
 * Manages multiple whatsapp-web.js clients, one per session
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
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
    this.reconnecting = false; // Flag to prevent multiple simultaneous reconnection attempts
    this.lastReconnectAttempt = null; // Timestamp of last reconnection attempt
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

  // Save to disk (async, don't wait)
  saveInstancesToDisk().catch(err => console.error('[Persistence] Failed to save after create:', err.message));

  // Create WhatsApp client using centralized Chromium launch options (same as instance-manager)
  const { getChromiumLaunchArgs } = require('./browser/launchOptions');
  const puppeteerArgs = getChromiumLaunchArgs();
  puppeteerArgs.push('--remote-debugging-port=0');
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: sessionId,
    }),
    puppeteer: {
      headless: true,
      executablePath: config.chromePath,
      args: puppeteerArgs,
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
  client.on('disconnected', async (reason) => {
    console.log(`[${sessionId}] Disconnected:`, reason);
    session.status = 'disconnected';
    forwardWebhook(sessionId, 'disconnected', {
      reason: reason || 'unknown',
    });
    
    // Attempt automatic reconnection (with throttling to avoid loops)
    // Only reconnect if we're not already reconnecting and it's been at least 10 seconds since last attempt
    if (!session.reconnecting && 
        (!session.lastReconnectAttempt || Date.now() - session.lastReconnectAttempt > 10000)) {
      console.log(`[${sessionId}] Attempting automatic reconnection...`);
      try {
        await reconnectSession(sessionId);
      } catch (error) {
        console.error(`[${sessionId}] Automatic reconnection failed:`, error);
      }
    }
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
          // Phone number of the voter (normalized, without @c.us/@g.us)
          voter: extractPhoneNumber(vote.voter || vote.from || vote.chatId),
          // Selected options (array of option names/labels)
          selectedOptions: vote.selectedOptions || vote.selected_options || vote.options || [],
          // Timestamp of the vote (ms since epoch)
          timestamp: vote.timestamp || vote.interractedAtTs || Date.now(),
          // Poll message identifier (parent message key / id), for idempotency & correlation
          pollMessageId:
            (vote.parentMsgKey && (vote.parentMsgKey._serialized || vote.parentMsgKey.id || vote.parentMsgKey._serialized)) ||
            (vote.parentMessage && vote.parentMessage.id && (vote.parentMessage.id._serialized || vote.parentMessage.id)) ||
            (vote.id && (vote.id._serialized || vote.id)) ||
            null,
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
    
    // Save to disk (async, don't wait)
    saveInstancesToDisk().catch(err => console.error('[Persistence] Failed to save after delete:', err.message));
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

  // Save to disk (async, don't wait)
  saveInstancesToDisk().catch(err => console.error('[Persistence] Failed to save after update:', err.message));
}

/**
 * Reconnect a disconnected session by reinitializing the client
 * @param {string} sessionId - Session ID
 * @returns {Promise<void>}
 */
async function reconnectSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  // Prevent multiple simultaneous reconnection attempts
  if (session.reconnecting) {
    console.log(`[${sessionId}] Reconnection already in progress, skipping...`);
    return;
  }

  // Throttle reconnection attempts (max once every 10 seconds)
  if (session.lastReconnectAttempt && Date.now() - session.lastReconnectAttempt < 10000) {
    console.log(`[${sessionId}] Reconnection attempt throttled (too soon after last attempt)`);
    return;
  }

  session.reconnecting = true;
  session.lastReconnectAttempt = Date.now();

  // Save session metadata we need to preserve (declare outside try for catch block access)
  const name = session.name;
  const webhookUrl = session.webhookUrl;
  const webhookEvents = session.webhookEvents;

  try {
    console.log(`[${sessionId}] Reconnecting session...`);

    // Validate webhook URL is present
    if (!webhookUrl) {
      throw new Error(`Cannot reconnect session ${sessionId}: webhook URL is missing`);
    }

    // Clean up old client if it exists
    if (session.client) {
      try {
        // Try to destroy the client gracefully, but don't fail if it's already destroyed
        await session.client.destroy().catch((err) => {
          console.log(`[${sessionId}] Destroy returned error (may already be destroyed):`, err.message);
        });
        console.log(`[${sessionId}] Old client destroyed`);
      } catch (destroyError) {
        // If destroy fails completely, that's okay - we'll create a new client anyway
        console.log(`[${sessionId}] Destroy error handled:`, destroyError.message);
      }
    }

    // Remove old session from map temporarily (similar to delete then recreate)
    sessions.delete(sessionId);

    // Small delay to ensure cleanup is complete
    await new Promise(resolve => setTimeout(resolve, 500));

    // Recreate the session (similar to what happens when user creates instance with same name)
    // This will use the same LocalAuth session if valid
    const newSession = await createSession(sessionId, name, {
      url: webhookUrl,
      events: webhookEvents,
    });

    console.log(`[${sessionId}] Reconnection initiated successfully`);
    return newSession;
  } catch (error) {
    console.error(`[${sessionId}] Reconnection failed:`, error.message || error);
    
    // Restore session entry if it doesn't exist (createSession might have failed)
    if (!sessions.has(sessionId)) {
      // Create a minimal session entry to restore state
      const restoredSession = new SessionInfo(sessionId, name);
      restoredSession.webhookUrl = webhookUrl;
      restoredSession.webhookEvents = webhookEvents || [];
      restoredSession.status = 'disconnected';
      sessions.set(sessionId, restoredSession);
      console.log(`[${sessionId}] Session restored after failed reconnection`);
    } else {
      // Session exists, just update status
      const existingSession = sessions.get(sessionId);
      if (existingSession) {
        existingSession.status = 'disconnected';
      }
    }
    
    throw error;
  } finally {
    // Clear reconnecting flag from new session if it exists
    const session = sessions.get(sessionId);
    if (session) {
      session.reconnecting = false;
    }
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

/**
 * Save instance metadata to disk for persistence across restarts
 * @returns {Promise<void>}
 */
async function saveInstancesToDisk() {
  try {
    const instancesData = Array.from(sessions.values()).map(session => ({
      id: session.id,
      name: session.name,
      webhookUrl: session.webhookUrl,
      webhookEvents: session.webhookEvents || [],
      createdAt: session.createdAt ? session.createdAt.toISOString() : null,
    }));

    const dataDir = path.dirname(config.instancesDataPath);
    try {
      await fs.mkdir(dataDir, { recursive: true });
    } catch (error) {
      // Directory might already exist, that's fine
    }

    await fs.writeFile(config.instancesDataPath, JSON.stringify(instancesData, null, 2));
    console.log(`[Persistence] Saved ${instancesData.length} instance(s) to disk`);
  } catch (error) {
    console.error('[Persistence] Error saving instances to disk:', error.message);
    // Don't throw - persistence failures shouldn't break the service
  }
}

/**
 * Load instance metadata from disk and restore instances
 * @returns {Promise<void>}
 */
async function loadInstancesFromDisk() {
  try {
    const data = await fs.readFile(config.instancesDataPath, 'utf8');
    const instancesData = JSON.parse(data);

    if (!Array.isArray(instancesData) || instancesData.length === 0) {
      console.log('[Persistence] No instances found on disk to restore');
      return;
    }

    console.log(`[Persistence] Found ${instancesData.length} instance(s) to restore from disk`);

    // Restore each instance asynchronously (don't block startup)
    const restorePromises = instancesData.map(async (instanceData) => {
      try {
        const { id, name, webhookUrl, webhookEvents } = instanceData;
        
        if (!id || !name || !webhookUrl) {
          console.warn(`[Persistence] Skipping invalid instance data:`, instanceData);
          return;
        }

        // Create session (will use existing LocalAuth session if valid)
        await createSession(id, name, {
          url: webhookUrl,
          events: webhookEvents || [],
        });
        console.log(`[Persistence] Restored instance: ${name} (${id})`);
      } catch (error) {
        console.error(`[Persistence] Failed to restore instance ${instanceData.id}:`, error.message);
        // Continue with other instances even if one fails
      }
    });

    // Wait for all restorations to complete (but don't fail if some fail)
    await Promise.allSettled(restorePromises);
    console.log('[Persistence] Instance restoration completed');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('[Persistence] No instances file found - starting fresh');
    } else {
      console.error('[Persistence] Error loading instances from disk:', error.message);
    }
    // Don't throw - if file doesn't exist or is invalid, we start fresh
  }
}

module.exports = {
  createSession,
  getSession,
  getAllSessions,
  deleteSession,
  updateWebhookConfig,
  getClientState,
  reconnectSession,
  saveInstancesToDisk,
  loadInstancesFromDisk,
};

