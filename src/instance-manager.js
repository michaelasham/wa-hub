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
const idempotencyStore = require('./idempotency-store');
const { withTypingIndicator } = require('./utils/typingIndicator');

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
    
    // Send loop state
    this.sendLoopRunning = false;
    this.sendLoopInterval = null;
    
    // Counters for observability
    this.counters = {
      sent24h: [], // Array of timestamps (last 24 hours)
      sent1h: [], // Array of timestamps (last hour)
      newChats24h: [], // Array of timestamps
      failures1h: [], // Array of timestamps
      disconnects1h: [], // Array of timestamps
    };
    
    // Rate limiting tracking
    this.sendHistory1min = []; // Timestamps of sends in last minute
    this.sendHistory1hour = []; // Timestamps of sends in last hour
    
    // Typing indicator configuration
    this.typingIndicatorEnabled = webhookConfig.typingIndicatorEnabled !== undefined 
      ? webhookConfig.typingIndicatorEnabled 
      : config.typingIndicatorEnabledDefault;
    this.applyTypingTo = webhookConfig.applyTypingTo || ['customer']; // ['customer'] or ['customer', 'merchant']
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
      // Start send loop when ready
      startSendLoop(this.id);
    } else if (newState === InstanceState.DISCONNECTED) {
      this.lastDisconnectAt = new Date();
      // Stop send loop
      stopSendLoop(this.id);
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
    } else if (newState === InstanceState.NEEDS_QR || newState === InstanceState.ERROR) {
      // Stop send loop on terminal states
      stopSendLoop(this.id);
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
  
  /**
   * Record a successful send (for rate limiting and counters)
   */
  recordSend() {
    const now = Date.now();
    this.sendHistory1min.push(now);
    this.sendHistory1hour.push(now);
    this.counters.sent24h.push(now);
    this.counters.sent1h.push(now);
    
    // Clean old entries
    const oneMinAgo = now - 60000;
    const oneHourAgo = now - 3600000;
    const oneDayAgo = now - 86400000;
    
    this.sendHistory1min = this.sendHistory1min.filter(ts => ts > oneMinAgo);
    this.sendHistory1hour = this.sendHistory1hour.filter(ts => ts > oneHourAgo);
    this.counters.sent1h = this.counters.sent1h.filter(ts => ts > oneHourAgo);
    this.counters.sent24h = this.counters.sent24h.filter(ts => ts > oneDayAgo);
  }
  
  /**
   * Record a failure
   */
  recordFailure() {
    const now = Date.now();
    this.counters.failures1h.push(now);
    
    // Clean old entries
    const oneHourAgo = now - 3600000;
    this.counters.failures1h = this.counters.failures1h.filter(ts => ts > oneHourAgo);
  }
  
  /**
   * Record a disconnect
   */
  recordDisconnect() {
    const now = Date.now();
    this.counters.disconnects1h.push(now);
    
    // Clean old entries
    const oneHourAgo = now - 3600000;
    this.counters.disconnects1h = this.counters.disconnects1h.filter(ts => ts > oneHourAgo);
  }
  
  /**
   * Check if rate limit exceeded (per minute)
   */
  isRateLimitedPerMinute() {
    return this.sendHistory1min.length >= config.maxSendsPerMinute;
  }
  
  /**
   * Check if rate limit exceeded (per hour)
   */
  isRateLimitedPerHour() {
    return this.sendHistory1hour.length >= config.maxSendsPerHour;
  }
  
  /**
   * Get next allowed send time (for rate limiting)
   */
  getNextAllowedSendTime() {
    if (this.sendHistory1min.length >= config.maxSendsPerMinute) {
      // Next send allowed when oldest entry in 1min window expires
      const oldest = Math.min(...this.sendHistory1min);
      return oldest + 60000; // 1 minute from oldest entry
    }
    
    if (this.sendHistory1hour.length >= config.maxSendsPerHour) {
      // Next send allowed when oldest entry in 1hour window expires
      const oldest = Math.min(...this.sendHistory1hour);
      return oldest + 3600000; // 1 hour from oldest entry
    }
    
    return null; // No rate limit
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
  
  // Use default LocalAuth path (same as old sessions.js) for backward compatibility
  // When dataPath is not specified, LocalAuth uses: .wwebjs_auth/session-{clientId}/
  // This matches the old behavior where instances auto-reconnected after restart
  const sanitizedClientId = sanitizeInstanceId(instanceId);
  
  // Build Puppeteer config with robust args for headless Linux environments
  const puppeteerConfig = {
    headless: true,
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
      // Additional flags for headless Linux environments (fixes xdg-settings and snap issues)
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--disable-accelerated-2d-canvas',
      '--disable-accelerated-video-decode',
      '--disable-background-downloads',
      '--disable-client-side-phishing-detection',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-features=AudioServiceOutOfProcess',
      '--disable-hang-monitor',
      '--disable-popup-blocking',
      '--disable-speech-api',
      '--disable-web-resources',
      '--ignore-certificate-errors',
      '--ignore-certificate-errors-spki-list',
      '--ignore-ssl-errors',
      '--log-level=3', // Suppress non-fatal errors
      '--no-default-browser-check',
      '--no-pings',
      '--use-gl=swiftshader',
      '--window-size=1920,1080',
      // Fix for xdg-settings and snap cgroup issues
      '--disable-x11-autolaunch',
      '--disable-application-cache',
      '--disable-plugins-discovery',
    ],
  };
  
  // Only set executablePath if explicitly configured (avoid snap-installed Chromium issues)
  // If chromePath is set and exists, use it; otherwise let Puppeteer find Chromium
  if (config.chromePath && config.chromePath !== '/usr/bin/chromium-browser') {
    try {
      await fs.access(config.chromePath);
      puppeteerConfig.executablePath = config.chromePath;
      console.log(`[${instanceId}] Using explicit Chrome path: ${config.chromePath}`);
    } catch (error) {
      console.warn(`[${instanceId}] Chrome path ${config.chromePath} not accessible, letting Puppeteer find Chromium`);
    }
  } else {
    // Try common Chromium paths, fallback to letting Puppeteer find it
    const commonPaths = [
      '/usr/bin/chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
    ];
    
    let foundPath = null;
    for (const testPath of commonPaths) {
      try {
        await fs.access(testPath);
        foundPath = testPath;
        break;
      } catch (error) {
        // Path doesn't exist, continue
      }
    }
    
    if (foundPath) {
      puppeteerConfig.executablePath = foundPath;
      console.log(`[${instanceId}] Using detected Chrome path: ${foundPath}`);
    } else {
      console.log(`[${instanceId}] Letting Puppeteer auto-detect Chromium executable`);
    }
  }
  
  return new Client({
    authStrategy: new LocalAuth({
      clientId: sanitizedClientId,
      // Don't specify dataPath - use LocalAuth default (.wwebjs_auth/session-{clientId}/)
      // This ensures backward compatibility with existing session data
    }),
    puppeteer: puppeteerConfig,
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
    
    // Start send loop on ready (steady drain)
    startSendLoop(instanceId);
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
    instance.recordDisconnect();
    
    // Stop send loop
    stopSendLoop(instanceId);
    
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
 * Process a single queue item (with idempotency, rate limiting, error handling)
 */
async function processQueueItem(instanceId, item) {
  const instance = instances.get(instanceId);
  if (!instance || !instance.client) {
    return false; // Cannot process
  }
  
  // Check if item is ready to process (nextAttemptAt)
  const now = Date.now();
  if (item.nextAttemptAt && now < item.nextAttemptAt) {
    return false; // Not ready yet
  }
  
  // Check idempotency - skip if already sent
  const isSent = await idempotencyStore.isSent(item.idempotencyKey);
  if (isSent) {
    console.log(`[${instanceId}] Skipping item ${item.id} - already sent (idempotency: ${item.idempotencyKey.substring(0, 20)}...)`);
    return true; // Remove from queue (already sent)
  }
  
  // Check rate limits
  if (instance.isRateLimitedPerMinute() || instance.isRateLimitedPerHour()) {
    const nextAllowed = instance.getNextAllowedSendTime();
    if (nextAllowed) {
      item.nextAttemptAt = nextAllowed;
      console.log(`[${instanceId}] Rate limited - deferring item ${item.id} until ${new Date(nextAllowed).toISOString()}`);
      return false; // Keep in queue, but defer
    }
  }
  
  // Ensure instance is ready
  if (instance.state !== InstanceState.READY) {
    // Trigger ensureReady if not terminal
    if (instance.state !== InstanceState.NEEDS_QR && instance.state !== InstanceState.ERROR) {
      ensureReady(instanceId).catch(err => {
        console.error(`[${instanceId}] ensureReady failed:`, err);
      });
    }
    return false; // Cannot process now
  }
  
  // Send the message/poll with optional typing indicator
  try {
    let sentMessage;
    
    // Determine if typing should be applied
    const shouldApplyTyping = instance.state === InstanceState.READY &&
                              instance.typingIndicatorEnabled &&
                              item.uxTyping !== false; // Default true, but can be disabled per message
    
    // Wrap send with typing indicator if enabled
    const sendFn = async () => {
      if (item.type === 'message') {
        return await instance.client.sendMessage(item.payload.chatId, item.payload.message, { sendSeen: false });
      } else if (item.type === 'poll') {
        const { Poll } = require('whatsapp-web.js');
        const poll = new Poll(item.payload.caption, item.payload.options, {
          allowMultipleAnswers: item.payload.multipleAnswers === true,
        });
        return await instance.client.sendMessage(item.payload.chatId, poll, { sendSeen: false });
      }
    };
    
    if (shouldApplyTyping) {
      sentMessage = await withTypingIndicator(
        instance.client,
        item.payload.chatId,
        sendFn,
        {
          enabled: true,
          timeoutMs: config.typingIndicatorMaxTotalMs,
          instanceName: instance.name,
        }
      );
    } else {
      // Send without typing indicator
      sentMessage = await sendFn();
    }
    
    // Success: mark as sent
    const messageId = sentMessage?.id?._serialized || sentMessage?.id || null;
    await idempotencyStore.markSent(item.idempotencyKey, messageId);
    instance.recordSend();
    
    console.log(`[${instanceId}] ✓ Sent ${item.type} (idempotency: ${item.idempotencyKey.substring(0, 20)}..., messageId: ${messageId})`);
    return true; // Remove from queue
    
  } catch (error) {
    item.attemptCount++;
    const errorMsg = error.message || String(error);
    item.lastError = errorMsg;
    instance.recordFailure();
    
    // Classify error
    const isDisconnectError = errorMsg.includes('Session closed') || 
                              errorMsg.includes('disconnected') ||
                              errorMsg.includes('null') ||
                              errorMsg.includes('evaluate') ||
                              errorMsg.includes('Failed to launch');
    
    if (isDisconnectError) {
      // Terminal disconnect - stop sending, trigger reconnection
      console.error(`[${instanceId}] ✗ Disconnect error during send: ${errorMsg}`);
      instance.transitionTo(InstanceState.DISCONNECTED, 'Disconnected during send');
      
      // Calculate backoff
      const backoffMs = Math.min(
        config.retryBaseBackoffMs * Math.pow(2, item.attemptCount - 1),
        config.retryMaxBackoffMs
      );
      item.nextAttemptAt = now + backoffMs;
      
      // Trigger reconnection
      if (instance.state !== InstanceState.NEEDS_QR) {
        ensureReady(instanceId).catch(err => {
          console.error(`[${instanceId}] Reconnection failed:`, err);
        });
      }
      
      return false; // Keep in queue, will retry after reconnect
    }
    
    // Other errors: retry with backoff
    const backoffMs = Math.min(
      config.retryBaseBackoffMs * Math.pow(2, item.attemptCount - 1),
      config.retryMaxBackoffMs
    );
    item.nextAttemptAt = now + backoffMs;
    
    console.error(`[${instanceId}] ✗ Send failed (attempt ${item.attemptCount}): ${errorMsg}. Retry at ${new Date(item.nextAttemptAt).toISOString()}`);
    
    // Mark as failed in idempotency store (but keep in queue for retry)
    if (item.attemptCount >= 5) { // After 5 attempts, mark as failed
      await idempotencyStore.markFailed(item.idempotencyKey, errorMsg);
    }
    
    return false; // Keep in queue for retry
  }
}

/**
 * Continuous send loop (steady drain scheduler)
 * Runs continuously when instance is READY, processing queue items with rate limiting
 */
async function runSendLoop(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance) {
    return; // Instance deleted
  }
  
  // Only run if READY and queue has items
  if (instance.state !== InstanceState.READY || instance.queue.length === 0) {
    instance.sendLoopRunning = false;
    return;
  }
  
  // Process items in queue (but respect rate limits and nextAttemptAt)
  const itemsToProcess = instance.queue.filter(item => {
    const now = Date.now();
    return !item.nextAttemptAt || now >= item.nextAttemptAt;
  });
  
  if (itemsToProcess.length === 0) {
    // All items are deferred - wait a bit before checking again
    instance.sendLoopRunning = false;
    setTimeout(() => {
      startSendLoop(instanceId);
    }, 1000); // Check again in 1 second
    return;
  }
  
  // Process first eligible item
  const item = itemsToProcess[0];
  const shouldRemove = await processQueueItem(instanceId, item);
  
  if (shouldRemove) {
    // Remove from queue
    const index = instance.queue.findIndex(q => q.id === item.id);
    if (index !== -1) {
      instance.queue.splice(index, 1);
    }
  }
  
  // Continue loop (recursive call after small delay for steady flow)
  // This ensures we don't send too fast even if rate limits allow
  setTimeout(() => {
    runSendLoop(instanceId);
  }, 500); // 500ms between sends for steady flow
}

/**
 * Start the send loop if not already running
 */
function startSendLoop(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance) {
    return;
  }
  
  // Only start if READY and not already running
  if (instance.state !== InstanceState.READY) {
    instance.sendLoopRunning = false;
    return;
  }
  
  if (instance.sendLoopRunning) {
    return; // Already running
  }
  
  if (instance.queue.length === 0) {
    instance.sendLoopRunning = false;
    return; // Nothing to process
  }
  
  instance.sendLoopRunning = true;
  runSendLoop(instanceId).catch(err => {
    console.error(`[${instanceId}] Send loop error:`, err);
    instance.sendLoopRunning = false;
  });
}

/**
 * Stop the send loop
 */
function stopSendLoop(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance) {
    return;
  }
  
  instance.sendLoopRunning = false;
  if (instance.sendLoopInterval) {
    clearInterval(instance.sendLoopInterval);
    instance.sendLoopInterval = null;
  }
}

/**
 * Legacy flushQueue - now just starts the send loop
 * Kept for backward compatibility
 */
async function flushQueue(instanceId) {
  startSendLoop(instanceId);
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
 * Generate idempotency key for order confirmation poll
 */
function generateIdempotencyKey(type, instanceName, params) {
  if (type === 'poll' && params.orderId && params.shop) {
    return `order:${params.shop}:${params.orderId}:confirmPoll:v1`;
  }
  if (type === 'message' && params.orderId && params.shop && params.action) {
    return `order:${params.shop}:${params.orderId}:${params.action}:v1`;
  }
  // Fallback: generate from payload hash
  const payloadStr = JSON.stringify({ type, ...params });
  const hash = crypto.createHash('sha256').update(payloadStr).digest('hex').substring(0, 16);
  return `${type}:${instanceName}:${hash}:v1`;
}

/**
 * Enqueue message or poll
 */
async function enqueueItem(instanceId, type, payload, idempotencyKey = null) {
  const instance = instances.get(instanceId);
  if (!instance) {
    throw new Error(`Instance ${instanceId} not found`);
  }
  
  if (instance.queue.length >= config.maxQueueSize) {
    throw new Error(`Queue full (${config.maxQueueSize} items). Instance: ${instanceId}`);
  }
  
  // Generate idempotency key if not provided
  if (!idempotencyKey) {
    idempotencyKey = generateIdempotencyKey(type, instance.name, payload);
  }
  
  // Check idempotency before queuing
  const isSent = await idempotencyStore.isSent(idempotencyKey);
  if (isSent) {
    throw new Error(`Message already sent (idempotency key: ${idempotencyKey})`);
  }
  
  const isQueued = await idempotencyStore.isQueued(idempotencyKey);
  if (isQueued) {
    throw new Error(`Message already queued (idempotency key: ${idempotencyKey})`);
  }
  
  const itemId = crypto.randomBytes(16).toString('hex');
  const item = {
    id: itemId,
    type,
    payload,
    idempotencyKey,
    createdAt: new Date(),
    attemptCount: 0,
    nextAttemptAt: Date.now(), // Can send immediately
    lastError: null,
    uxTyping: payload.uxTyping !== undefined ? payload.uxTyping : true, // Default true for customer messages
  };
  
  instance.queue.push(item);
  
  // Persist to idempotency store
  await idempotencyStore.upsert({
    idempotencyKey,
    instanceName: instance.name,
    queueItemId: itemId,
    status: 'QUEUED',
  });
  
  console.log(`[${instanceId}] Queued ${type} (idempotency: ${idempotencyKey.substring(0, 20)}..., queue depth: ${instance.queue.length})`);
  
  // Trigger send loop if not running
  startSendLoop(instanceId).catch(err => {
    console.error(`[${instanceId}] Failed to start send loop:`, err);
  });
  
  return item;
}

/**
 * Send message (always enqueue for steady drain)
 */
async function sendMessage(instanceId, chatId, message, idempotencyKey = null) {
  const instance = instances.get(instanceId);
  if (!instance) {
    throw new Error(`Instance ${instanceId} not found`);
  }
  
  // Generate idempotency key if not provided
  if (!idempotencyKey) {
    idempotencyKey = generateIdempotencyKey('message', instance.name, { chatId, message });
  }
  
  // Check idempotency first - if already sent, return success
  const isSent = await idempotencyStore.isSent(idempotencyKey);
  if (isSent) {
    const record = await idempotencyStore.get(idempotencyKey);
    return {
      status: 'sent', // Already sent previously
      instanceState: instance.state,
      queueDepth: instance.queue.length,
      messageId: record?.providerMessageId || null,
      idempotent: true,
    };
  }
  
  // Enqueue for steady drain (no immediate send to prevent bursts)
  const item = await enqueueItem(instanceId, 'message', { chatId, message }, idempotencyKey);
  
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
    idempotencyKey: idempotencyKey.substring(0, 30) + '...', // Truncated for response
  };
}

/**
 * Send poll (always enqueue for steady drain)
 */
async function sendPoll(instanceId, chatId, caption, options, multipleAnswers, idempotencyKey = null) {
  const instance = instances.get(instanceId);
  if (!instance) {
    throw new Error(`Instance ${instanceId} not found`);
  }
  
  // Generate idempotency key if not provided
  if (!idempotencyKey) {
    idempotencyKey = generateIdempotencyKey('poll', instance.name, { chatId, caption, options });
  }
  
  // Check idempotency first - if already sent, return success
  const isSent = await idempotencyStore.isSent(idempotencyKey);
  if (isSent) {
    const record = await idempotencyStore.get(idempotencyKey);
    return {
      status: 'sent', // Already sent previously
      instanceState: instance.state,
      queueDepth: instance.queue.length,
      messageId: record?.providerMessageId || null,
      idempotent: true,
    };
  }
  
  // Enqueue for steady drain (no immediate send to prevent bursts)
  const item = await enqueueItem(instanceId, 'poll', { chatId, caption, options, multipleAnswers }, idempotencyKey);
  
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
    idempotencyKey: idempotencyKey.substring(0, 30) + '...', // Truncated for response
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
 * Update webhook config (and typing indicator settings)
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
  
  // Typing indicator settings
  if (webhookConfig.typingIndicatorEnabled !== undefined) {
    instance.typingIndicatorEnabled = webhookConfig.typingIndicatorEnabled;
  }
  if (webhookConfig.applyTypingTo) {
    instance.applyTypingTo = webhookConfig.applyTypingTo;
  }
  
  saveInstancesToDisk().catch(err => console.error('[Persistence] Save failed:', err.message));
}

/**
 * Clear message/poll queue for an instance
 */
function clearQueue(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance) {
    throw new Error(`Instance ${instanceId} not found`);
  }
  
  const queueSize = instance.queue.length;
  instance.queue = [];
  console.log(`[${instanceId}] Cleared queue (${queueSize} items removed)`);
  
  return {
    cleared: queueSize,
    queueDepth: 0,
  };
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
      typingIndicatorEnabled: inst.typingIndicatorEnabled,
      applyTypingTo: inst.applyTypingTo || ['customer'],
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
          typingIndicatorEnabled: data.typingIndicatorEnabled,
          applyTypingTo: data.applyTypingTo,
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
  clearQueue,
};
