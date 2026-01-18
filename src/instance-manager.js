/**
 * Production-grade Instance Manager for wa-hub
 * Implements state machine, event-driven readiness, queue system, and reconnection ladder
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { qrToBase64, extractPhoneNumber, sanitizeInstanceId } = require('./utils');

// State machine enum
const InstanceState = {
  READY: 'ready',
  CONNECTING: 'connecting',
  DISCONNECTED: 'disconnected',
  NEEDS_QR: 'needs_qr',
  ERROR: 'error',
};

/**
 * Instance context - stores all per-instance state, queue, and metadata
 */
class InstanceContext {
  constructor(id, name, webhookConfig) {
    // Basic info
    this.id = id;
    this.name = name;
    this.webhookUrl = webhookConfig.url;
    this.webhookEvents = webhookConfig.events || [];
    this.createdAt = new Date();
    
    // State machine
    this.state = InstanceState.CONNECTING;
    
    // WhatsApp client
    this.client = null;
    
    // Queue system
    this.queue = [];
    
    // Reconnection lock (mutex) - Promise that resolves when lock is released
    this.reconnectionLock = null;
    this.reconnectionLockResolver = null;
    
    // Metrics and tracking
    this.lastDisconnectAt = null;
    this.lastDisconnectReason = null;
    this.lastAuthFailureAt = null;
    this.lastReadyAt = null;
    this.restartAttempts = 0;
    this.lastRestartAt = null;
    this.lastEvent = null;
    this.qrReceivedDuringRestart = false;
    
    // Client info
    this.phoneNumber = null;
    this.displayName = null;
    this.qrCode = null;
    this.lastQrUpdate = null;
    
    // Event-driven readiness promise
    this.readyPromise = null;
    this.readyResolver = null;
    this.readyRejector = null;
    this.readyTimeout = null;
    
    // Restart tracking for rate limiting
    this.restartHistory = []; // Array of timestamps
  }
  
  /**
   * Transition to a new state (with logging)
   */
  transitionTo(newState, reason = '') {
    const oldState = this.state;
    this.state = newState;
    this.lastEvent = newState;
    
    console.log(`[${this.id}] State transition: ${oldState} -> ${newState}${reason ? ` (${reason})` : ''}`);
    
    // Handle state-specific actions
    if (newState === InstanceState.READY) {
      this.lastReadyAt = new Date();
      this.restartAttempts = 0; // Reset on successful ready
      this.restartHistory = []; // Clear restart history
      // Resolve ready promise if waiting
      if (this.readyResolver) {
        this.readyResolver();
        this.readyResolver = null;
        this.readyRejector = null;
        if (this.readyTimeout) {
          clearTimeout(this.readyTimeout);
          this.readyTimeout = null;
        }
      }
    } else if (newState === InstanceState.DISCONNECTED) {
      this.lastDisconnectAt = new Date();
      // Reject ready promise if waiting
      if (this.readyRejector) {
        this.readyRejector(new Error('Instance disconnected'));
        this.readyResolver = null;
        this.readyRejector = null;
        if (this.readyTimeout) {
          clearTimeout(this.readyTimeout);
          this.readyTimeout = null;
        }
      }
    }
  }
  
  /**
   * Acquire reconnection lock (mutex)
   */
  async acquireLock() {
    if (this.reconnectionLock) {
      // Wait for existing lock to release
      await this.reconnectionLock;
    }
    
    // Create new lock
    this.reconnectionLock = new Promise((resolve) => {
      this.reconnectionLockResolver = resolve;
    });
  }
  
  /**
   * Release reconnection lock
   */
  releaseLock() {
    if (this.reconnectionLockResolver) {
      this.reconnectionLockResolver();
      this.reconnectionLock = null;
      this.reconnectionLockResolver = null;
    }
  }
  
  /**
   * Check if restart rate limit exceeded
   */
  checkRestartRateLimit() {
    const now = Date.now();
    const windowMs = config.restartWindowMinutes * 60 * 1000;
    
    // Clean old entries
    this.restartHistory = this.restartHistory.filter(ts => now - ts < windowMs);
    
    return this.restartHistory.length >= config.maxRestartsPerWindow;
  }
  
  /**
   * Record restart attempt
   */
  recordRestartAttempt() {
    this.restartAttempts++;
    this.lastRestartAt = new Date();
    this.restartHistory.push(Date.now());
  }
  
  /**
   * Get sanitized data path for this instance
   */
  getAuthDataPath() {
    const sanitizedId = sanitizeInstanceId(this.id);
    return path.join(config.authBaseDir, sanitizedId);
  }
}

// Instance storage
const instances = new Map();

/**
 * Forward webhook event
 */
async function forwardWebhook(instanceId, event, data) {
  const instance = instances.get(instanceId);
  if (!instance || !instance.webhookUrl) return;
  
  if (instance.webhookEvents.length > 0 && !instance.webhookEvents.includes(event)) {
    return;
  }
  
  const payload = { event, instanceId, data };
  
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (config.webhookSecret) {
      const crypto = require('crypto');
      const hmac = crypto.createHmac('sha256', config.webhookSecret);
      const signature = hmac.update(JSON.stringify(payload)).digest('hex');
      headers['x-wa-hub-signature'] = signature;
    }
    await axios.post(instance.webhookUrl, payload, { headers });
    console.log(`[${instanceId}] Webhook forwarded: ${event}`);
  } catch (error) {
    console.error(`[${instanceId}] Webhook forwarding failed:`, error.message);
  }
}

/**
 * Migrate old session data from shared directory to per-instance directory (backward compatibility)
 */
async function migrateOldSessionData(instanceId, newAuthPath) {
  const oldAuthBase = config.sessionDataPath || './.wwebjs_auth';
  const sanitizedId = sanitizeInstanceId(instanceId);
  
  // LocalAuth creates folders like "session-{clientId}" or just "{clientId}"
  const possibleOldPaths = [
    path.join(oldAuthBase, `session-${sanitizedId}`),
    path.join(oldAuthBase, sanitizedId),
    path.join(oldAuthBase, `Default-${sanitizedId}`),
  ];
  
  const newSessionPath = path.join(newAuthPath, `session-${sanitizedId}`);
  
  for (const oldPath of possibleOldPaths) {
    try {
      const stat = await fs.stat(oldPath);
      if (stat.isDirectory()) {
        // Check if new path already has data
        try {
          await fs.access(newSessionPath);
          console.log(`[${instanceId}] New session path already exists, skipping migration`);
          return; // Already migrated or exists
        } catch {
          // New path doesn't exist, proceed with migration
        }
        
        // Copy old session data to new location
        console.log(`[${instanceId}] Migrating session data from ${oldPath} to ${newSessionPath}`);
        await fs.mkdir(newSessionPath, { recursive: true });
        
        // Copy all files/directories from old to new
        const entries = await fs.readdir(oldPath, { withFileTypes: true });
        for (const entry of entries) {
          const srcPath = path.join(oldPath, entry.name);
          const destPath = path.join(newSessionPath, entry.name);
          
          if (entry.isDirectory()) {
            await copyDirectory(srcPath, destPath);
          } else {
            await fs.copyFile(srcPath, destPath);
          }
        }
        
        console.log(`[${instanceId}] Session data migration completed`);
        return; // Successfully migrated
      }
    } catch (error) {
      // Old path doesn't exist, try next one
      continue;
    }
  }
}

/**
 * Helper to recursively copy directory
 */
async function copyDirectory(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Create WhatsApp client with isolated LocalAuth
 */
async function createClient(instanceId, instanceName) {
  const authDataPath = path.join(config.authBaseDir, sanitizeInstanceId(instanceId));
  
  // Ensure auth directory exists
  try {
    await fs.mkdir(authDataPath, { recursive: true });
  } catch (error) {
    console.warn(`[${instanceId}] Could not create auth directory:`, error.message);
  }
  
  // Migrate old session data if it exists (backward compatibility)
  await migrateOldSessionData(instanceId, authDataPath).catch(err => {
    console.warn(`[${instanceId}] Session migration failed (non-critical):`, err.message);
  });
  
  return new Client({
    authStrategy: new LocalAuth({
      clientId: sanitizeInstanceId(instanceId),
      dataPath: authDataPath,
    }),
    puppeteer: {
      headless: true,
      executablePath: config.chromePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--disable-notifications',
        '--disable-prompt-on-repost',
        '--disable-renderer-backgrounding',
        '--disable-sync',
        '--enable-features=NetworkService,NetworkServiceInProcess',
        '--force-color-profile=srgb',
        '--hide-scrollbars',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-first-run',
        '--disable-blink-features=AutomationControlled',
      ],
    },
  });
}

/**
 * Set up event listeners for WhatsApp client
 */
function setupEventListeners(instanceId, client) {
  const instance = instances.get(instanceId);
  if (!instance) return;
  
  // QR code event
  client.on('qr', async (qr) => {
    console.log(`[${instanceId}] Event: qr`);
    instance.qrReceivedDuringRestart = true;
    
    try {
      const qrBase64 = await qrToBase64(qr);
      instance.qrCode = qrBase64;
      instance.lastQrUpdate = new Date();
      instance.transitionTo(InstanceState.NEEDS_QR, 'QR code received');
      
      await forwardWebhook(instanceId, 'qr', { qr: qrBase64 });
    } catch (error) {
      console.error(`[${instanceId}] Error processing QR:`, error);
    }
  });
  
  // Authenticated event
  client.on('authenticated', () => {
    console.log(`[${instanceId}] Event: authenticated`);
    instance.lastEvent = 'authenticated';
    forwardWebhook(instanceId, 'authenticated', {});
  });
  
  // Ready event
  client.on('ready', async () => {
    console.log(`[${instanceId}] Event: ready`);
    instance.lastEvent = 'ready';
    
    try {
      const info = client.info;
      if (info) {
        instance.displayName = info.pushname || null;
        instance.phoneNumber = info.wid?.user || null;
      }
    } catch (error) {
      console.error(`[${instanceId}] Error getting client info:`, error);
    }
    
    instance.transitionTo(InstanceState.READY);
    await forwardWebhook(instanceId, 'ready', { status: 'ready' });
    
    // Flush queue on ready
    flushQueue(instanceId).catch(err => {
      console.error(`[${instanceId}] Error flushing queue:`, err);
    });
  });
  
  // Auth failure
  client.on('auth_failure', (msg) => {
    console.error(`[${instanceId}] Event: auth_failure - ${msg}`);
    instance.lastAuthFailureAt = new Date();
    instance.transitionTo(InstanceState.NEEDS_QR, `Auth failure: ${msg}`);
    forwardWebhook(instanceId, 'auth_failure', { message: msg });
  });
  
  // Disconnected
  client.on('disconnected', (reason) => {
    console.log(`[${instanceId}] Event: disconnected - ${reason}`);
    instance.lastDisconnectAt = new Date();
    instance.lastDisconnectReason = reason || 'unknown';
    instance.lastEvent = 'disconnected';
    
    // Check if terminal disconnect reason
    const terminalReasons = ['LOGOUT', 'UNPAIRED', 'CONFLICT', 'TIMEOUT'];
    const reasonUpper = (reason || '').toUpperCase();
    const isTerminal = terminalReasons.some(term => reasonUpper.includes(term));
    
    if (isTerminal) {
      instance.transitionTo(InstanceState.NEEDS_QR, `Terminal disconnect: ${reason}`);
    } else {
      instance.transitionTo(InstanceState.DISCONNECTED, reason);
      // Auto-reconnect on non-terminal disconnect (with throttling)
      if (!instance.reconnectionLock && !instance.checkRestartRateLimit()) {
        ensureReady(instanceId).catch(err => {
          console.error(`[${instanceId}] Auto-reconnect failed:`, err);
        });
      }
    }
    
    forwardWebhook(instanceId, 'disconnected', { reason: reason || 'unknown' });
  });
  
  // State change
  client.on('change_state', (state) => {
    console.log(`[${instanceId}] Event: change_state - ${state}`);
    instance.lastEvent = `change_state:${state}`;
    forwardWebhook(instanceId, 'change_state', { status: state });
  });
  
  // Message
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
      await forwardWebhook(instanceId, 'message', messageData);
    } catch (error) {
      console.error(`[${instanceId}] Error processing message:`, error);
    }
  });
  
  // Vote update
  client.on('vote_update', async (vote) => {
    try {
      const voteData = {
        vote: {
          voter: extractPhoneNumber(vote.voter || vote.from || vote.chatId),
          selectedOptions: vote.selectedOptions || vote.selected_options || vote.options || [],
          timestamp: vote.timestamp || vote.interractedAtTs || Date.now(),
          pollMessageId:
            (vote.parentMsgKey && (vote.parentMsgKey._serialized || vote.parentMsgKey.id || vote.parentMsgKey._serialized)) ||
            (vote.parentMessage && vote.parentMessage.id && (vote.parentMessage.id._serialized || vote.parentMessage.id)) ||
            (vote.id && (vote.id._serialized || vote.id)) ||
            null,
        },
      };
      await forwardWebhook(instanceId, 'vote_update', voteData);
    } catch (error) {
      console.error(`[${instanceId}] Error processing vote:`, error);
    }
  });
}

/**
 * Wait for instance to become ready (event-driven, not polling)
 */
function waitForReadyEvent(instanceId, timeoutMs = config.readyTimeoutMs) {
  const instance = instances.get(instanceId);
  if (!instance) {
    return Promise.reject(new Error(`Instance ${instanceId} not found`));
  }
  
  // If already ready, return immediately
  if (instance.state === InstanceState.READY) {
    return Promise.resolve();
  }
  
  // If terminal state, reject immediately
  if (instance.state === InstanceState.NEEDS_QR || instance.state === InstanceState.ERROR) {
    return Promise.reject(new Error(`Instance in terminal state: ${instance.state}`));
  }
  
  // If promise already exists, return it
  if (instance.readyPromise) {
    return instance.readyPromise;
  }
  
  // Create new promise
  instance.readyPromise = new Promise((resolve, reject) => {
    instance.readyResolver = resolve;
    instance.readyRejector = reject;
    
    // Timeout
    instance.readyTimeout = setTimeout(() => {
      instance.readyResolver = null;
      instance.readyRejector = null;
      instance.readyPromise = null;
      instance.readyTimeout = null;
      reject(new Error(`Timeout waiting for instance ${instanceId} to become ready (${timeoutMs}ms)`));
    }, timeoutMs);
  });
  
  return instance.readyPromise;
}

/**
 * Soft restart: destroy then reinitialize same client
 */
async function softRestartAndWaitReady(instanceId, timeoutMs = config.readyTimeoutMs) {
  const instance = instances.get(instanceId);
  if (!instance || !instance.client) {
    throw new Error(`Instance ${instanceId} not found or no client`);
  }
  
  console.log(`[${instanceId}] Starting soft restart...`);
  instance.transitionTo(InstanceState.CONNECTING, 'soft restart');
  instance.qrReceivedDuringRestart = false;
  
  try {
    // Destroy existing client
    try {
      await instance.client.destroy();
    } catch (err) {
      console.log(`[${instanceId}] Destroy error (ignoring):`, err.message);
    }
    
    // Reinitialize
    await instance.client.initialize();
    
    // Wait for ready event
    await waitForReadyEvent(instanceId, timeoutMs);
    console.log(`[${instanceId}] Soft restart successful`);
    return true;
  } catch (error) {
    console.error(`[${instanceId}] Soft restart failed:`, error.message);
    throw error;
  }
}

/**
 * Hard restart: create new Client object and initialize
 */
async function hardRestartAndWaitReady(instanceId, timeoutMs = config.readyTimeoutMs) {
  const instance = instances.get(instanceId);
  if (!instance) {
    throw new Error(`Instance ${instanceId} not found`);
  }
  
  console.log(`[${instanceId}] Starting hard restart...`);
  instance.transitionTo(InstanceState.CONNECTING, 'hard restart');
  instance.qrReceivedDuringRestart = false;
  
  // Clean up old client
  if (instance.client) {
    try {
      // Remove old event listeners by destroying
      await instance.client.destroy().catch(() => {});
    } catch (err) {
      // Ignore errors
    }
    instance.client = null;
  }
  
  // Create new client
  const client = await createClient(instanceId, instance.name);
  instance.client = client;
  
  // Setup event listeners
  setupEventListeners(instanceId, client);
  
  try {
    // Initialize
    await client.initialize();
    
    // Wait for ready event
    await waitForReadyEvent(instanceId, timeoutMs);
    console.log(`[${instanceId}] Hard restart successful`);
    return true;
  } catch (error) {
    console.error(`[${instanceId}] Hard restart failed:`, error.message);
    throw error;
  }
}

/**
 * Ensure instance is ready (single-flight reconnection with ladder)
 */
async function ensureReady(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance) {
    throw new Error(`Instance ${instanceId} not found`);
  }
  
  // Terminal states: don't auto-restart
  if (instance.state === InstanceState.NEEDS_QR) {
    throw new Error(`Instance ${instanceId} needs QR code. Manual intervention required.`);
  }
  
  if (instance.state === InstanceState.ERROR) {
    throw new Error(`Instance ${instanceId} is in ERROR state. Check logs.`);
  }
  
  // If ready, return immediately
  if (instance.state === InstanceState.READY) {
    return;
  }
  
  // Check rate limit
  if (instance.checkRestartRateLimit()) {
    instance.transitionTo(InstanceState.ERROR, 'Restart rate limit exceeded');
    throw new Error(`Instance ${instanceId}: too many restart attempts. Rate limit exceeded.`);
  }
  
  // Acquire lock (mutex)
  await instance.acquireLock();
  
  try {
    // Double-check state after acquiring lock
    if (instance.state === InstanceState.READY) {
      return;
    }
    
    instance.recordRestartAttempt();
    
    // Attempt #1: Soft restart
    try {
      await new Promise(resolve => setTimeout(resolve, config.restartBackoffMs));
      await softRestartAndWaitReady(instanceId);
      return; // Success
    } catch (softError) {
      console.log(`[${instanceId}] Soft restart failed, trying hard restart...`);
    }
    
    // Attempt #2: Hard restart
    try {
      await new Promise(resolve => setTimeout(resolve, config.restartBackoffMs * 2));
      await hardRestartAndWaitReady(instanceId);
      return; // Success
    } catch (hardError) {
      // Both failed
      if (instance.qrReceivedDuringRestart) {
        instance.transitionTo(InstanceState.NEEDS_QR, 'QR received during restart attempts');
      } else {
        instance.transitionTo(InstanceState.ERROR, `Restart failed: ${hardError.message}`);
      }
      throw hardError;
    }
  } finally {
    instance.releaseLock();
  }
}

/**
 * Flush message/poll queue sequentially
 */
async function flushQueue(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance || instance.state !== InstanceState.READY) {
    return;
  }
  
  if (instance.queue.length === 0) {
    return;
  }
  
  console.log(`[${instanceId}] Flushing queue (${instance.queue.length} items)...`);
  
  while (instance.queue.length > 0 && instance.state === InstanceState.READY) {
    const item = instance.queue.shift();
    
    try {
      if (item.type === 'message') {
        await instance.client.sendMessage(item.payload.chatId, item.payload.message, { sendSeen: false });
      } else if (item.type === 'poll') {
        const { Poll } = require('whatsapp-web.js');
        const poll = new Poll(item.payload.caption, item.payload.options, {
          allowMultipleAnswers: item.payload.multipleAnswers === true,
        });
        await instance.client.sendMessage(item.payload.chatId, poll, { sendSeen: false });
      }
      
      console.log(`[${instanceId}] Queued item processed: ${item.id}`);
    } catch (error) {
      console.error(`[${instanceId}] Error processing queued item ${item.id}:`, error.message);
      
      // If disconnect/null client error, stop flushing and trigger reconnection
      const errorMsg = error.message || String(error);
      if (errorMsg.includes('Session closed') || 
          errorMsg.includes('disconnected') ||
          errorMsg.includes('null') ||
          errorMsg.includes('evaluate') ||
          errorMsg.includes('Failed to launch')) {
        instance.transitionTo(InstanceState.DISCONNECTED, 'Disconnected during queue flush');
        // Re-queue failed item
        instance.queue.unshift(item);
        // Trigger reconnection
        ensureReady(instanceId).catch(err => {
          console.error(`[${instanceId}] Reconnection after queue error failed:`, err);
        });
        break;
      }
      // For other errors, continue with next item (don't block queue)
    }
  }
  
  console.log(`[${instanceId}] Queue flush completed. Remaining: ${instance.queue.length}`);
}

/**
 * Create and initialize a new instance
 */
async function createInstance(instanceId, name, webhookConfig) {
  if (instances.has(instanceId)) {
    throw new Error(`Instance ${instanceId} already exists`);
  }
  
  if (!webhookConfig.url) {
    throw new Error('Webhook URL is required');
  }
  
  console.log(`[${instanceId}] Creating instance: ${name}`);
  
  // Create context
  const instance = new InstanceContext(instanceId, name, webhookConfig);
  instances.set(instanceId, instance);
  
  // Create client
  const client = await createClient(instanceId, name);
  instance.client = client;
  
  // Setup event listeners
  setupEventListeners(instanceId, client);
  
  // Initialize
  try {
    instance.transitionTo(InstanceState.CONNECTING, 'initializing');
    await client.initialize();
    // Wait for ready or QR
    await waitForReadyEvent(instanceId).catch(() => {
      // QR is acceptable, don't throw
    });
  } catch (error) {
    console.error(`[${instanceId}] Failed to initialize:`, error);
    instance.transitionTo(InstanceState.ERROR, `Initialization failed: ${error.message}`);
    throw error;
  }
  
  // Save to disk
  saveInstancesToDisk().catch(err => console.error('[Persistence] Save failed:', err.message));
  
  return instance;
}

/**
 * Enqueue message or poll
 */
function enqueueItem(instanceId, type, payload) {
  const instance = instances.get(instanceId);
  if (!instance) {
    throw new Error(`Instance ${instanceId} not found`);
  }
  
  if (instance.queue.length >= config.maxQueueSize) {
    throw new Error(`Queue full (${config.maxQueueSize} items). Instance: ${instanceId}`);
  }
  
  const item = {
    id: crypto.randomBytes(16).toString('hex'), // Generate random ID
    type,
    payload,
    createdAt: new Date(),
    attemptCount: 0,
  };
  
  instance.queue.push(item);
  console.log(`[${instanceId}] Queued ${type} (queue depth: ${instance.queue.length})`);
  
  return item;
}

/**
 * Send message (immediate if ready, else queue)
 */
async function sendMessage(instanceId, chatId, message) {
  const instance = instances.get(instanceId);
  if (!instance) {
    throw new Error(`Instance ${instanceId} not found`);
  }
  
  // If ready, send immediately (with error handling)
  if (instance.state === InstanceState.READY && instance.client) {
    try {
      const sentMessage = await instance.client.sendMessage(chatId, message, { sendSeen: false });
      return {
        status: 'sent',
        instanceState: instance.state,
        queueDepth: instance.queue.length,
        messageId: sentMessage.id?._serialized || sentMessage.id || null,
      };
    } catch (sendError) {
      // If send fails due to client being null/unavailable, queue instead
      const errorMsg = sendError.message || String(sendError);
      if (errorMsg.includes('null') || errorMsg.includes('evaluate') || errorMsg.includes('Session closed')) {
        console.warn(`[${instanceId}] Send failed (client unavailable), queuing instead:`, errorMsg);
        instance.transitionTo(InstanceState.DISCONNECTED, 'Send failed - client unavailable');
        // Fall through to queue logic below
      } else {
        throw sendError;
      }
    }
  }
  
  // Otherwise, queue and trigger ensureReady
  const item = enqueueItem(instanceId, 'message', { chatId, message });
  
  // Trigger reconnection if not terminal
  if (instance.state !== InstanceState.NEEDS_QR && instance.state !== InstanceState.ERROR) {
    ensureReady(instanceId).catch(err => {
      console.error(`[${instanceId}] Background ensureReady failed:`, err);
    });
  }
  
  return {
    status: 'queued',
    instanceState: instance.state,
    queueDepth: instance.queue.length,
    queueId: item.id,
  };
}

/**
 * Send poll (immediate if ready, else queue)
 */
async function sendPoll(instanceId, chatId, caption, options, multipleAnswers) {
  const instance = instances.get(instanceId);
  if (!instance) {
    throw new Error(`Instance ${instanceId} not found`);
  }
  
  // If ready, send immediately (with error handling)
  if (instance.state === InstanceState.READY && instance.client) {
    try {
      const { Poll } = require('whatsapp-web.js');
      const poll = new Poll(caption, options, {
        allowMultipleAnswers: multipleAnswers === true,
      });
      const sentMessage = await instance.client.sendMessage(chatId, poll, { sendSeen: false });
      return {
        status: 'sent',
        instanceState: instance.state,
        queueDepth: instance.queue.length,
        messageId: sentMessage.id?._serialized || sentMessage.id || null,
      };
    } catch (sendError) {
      // If send fails due to client being null/unavailable, queue instead
      const errorMsg = sendError.message || String(sendError);
      if (errorMsg.includes('null') || errorMsg.includes('evaluate') || errorMsg.includes('Session closed')) {
        console.warn(`[${instanceId}] Send poll failed (client unavailable), queuing instead:`, errorMsg);
        instance.transitionTo(InstanceState.DISCONNECTED, 'Send failed - client unavailable');
        // Fall through to queue logic below
      } else {
        throw sendError;
      }
    }
  }
  
  // Otherwise, queue and trigger ensureReady
  const item = enqueueItem(instanceId, 'poll', { chatId, caption, options, multipleAnswers });
  
  // Trigger reconnection if not terminal
  if (instance.state !== InstanceState.NEEDS_QR && instance.state !== InstanceState.ERROR) {
    ensureReady(instanceId).catch(err => {
      console.error(`[${instanceId}] Background ensureReady failed:`, err);
    });
  }
  
  return {
    status: 'queued',
    instanceState: instance.state,
    queueDepth: instance.queue.length,
    queueId: item.id,
  };
}

/**
 * Get instance by ID
 */
function getInstance(instanceId) {
  return instances.get(instanceId) || null;
}

/**
 * Get all instances
 */
function getAllInstances() {
  return Array.from(instances.values());
}

/**
 * Delete instance
 */
async function deleteInstance(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance) {
    throw new Error(`Instance ${instanceId} not found`);
  }
  
  console.log(`[${instanceId}] Deleting instance`);
  
  if (instance.client) {
    try {
      await instance.client.logout();
    } catch (err) {
      // Ignore
    }
    try {
      await instance.client.destroy();
    } catch (err) {
      // Ignore
    }
  }
  
  instances.delete(instanceId);
  saveInstancesToDisk().catch(err => console.error('[Persistence] Save failed:', err.message));
}

/**
 * Update webhook config
 */
function updateWebhookConfig(instanceId, webhookConfig) {
  const instance = instances.get(instanceId);
  if (!instance) {
    throw new Error(`Instance ${instanceId} not found`);
  }
  
  if (webhookConfig.url) {
    instance.webhookUrl = webhookConfig.url;
  }
  if (webhookConfig.events) {
    instance.webhookEvents = webhookConfig.events;
  }
  
  saveInstancesToDisk().catch(err => console.error('[Persistence] Save failed:', err.message));
}

/**
 * Save instances to disk
 */
async function saveInstancesToDisk() {
  try {
    const instancesData = Array.from(instances.values()).map(inst => ({
      id: inst.id,
      name: inst.name,
      webhookUrl: inst.webhookUrl,
      webhookEvents: inst.webhookEvents || [],
      createdAt: inst.createdAt ? inst.createdAt.toISOString() : null,
    }));
    
    const dataDir = path.dirname(config.instancesDataPath);
    await fs.mkdir(dataDir, { recursive: true }).catch(() => {});
    await fs.writeFile(config.instancesDataPath, JSON.stringify(instancesData, null, 2));
    console.log(`[Persistence] Saved ${instancesData.length} instance(s)`);
  } catch (error) {
    console.error('[Persistence] Save error:', error.message);
  }
}

/**
 * Load instances from disk and restore
 */
async function loadInstancesFromDisk() {
  try {
    const data = await fs.readFile(config.instancesDataPath, 'utf8');
    const instancesData = JSON.parse(data);
    
    if (!Array.isArray(instancesData) || instancesData.length === 0) {
      console.log('[Persistence] No instances to restore');
      return;
    }
    
    console.log(`[Persistence] Restoring ${instancesData.length} instance(s)...`);
    
    for (const data of instancesData) {
      try {
        await createInstance(data.id, data.name, {
          url: data.webhookUrl,
          events: data.webhookEvents || [],
        });
      } catch (error) {
        console.error(`[Persistence] Failed to restore ${data.id}:`, error.message);
      }
    }
    
    console.log('[Persistence] Restoration completed');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('[Persistence] No instances file found - starting fresh');
    } else {
      console.error('[Persistence] Load error:', error.message);
    }
  }
}

module.exports = {
  InstanceState,
  createInstance,
  getInstance,
  getAllInstances,
  deleteInstance,
  updateWebhookConfig,
  sendMessage,
  sendPoll,
  ensureReady,
  waitForReadyEvent,
  loadInstancesFromDisk,
  saveInstancesToDisk,
};
