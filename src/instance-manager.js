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

/**
 * Debug patch: structured JSON log for debugging disconnect/ready delays
 */
function debugLog(instanceId, event, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    instanceId,
    event,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

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

    // Debug patch: watchdog for ready_timeout
    this.readyWatchdogTimer = null;
    this.readyWatchdogStartAt = null;
    this.readyWatchdogRestarted = false; // Only restart once on timeout
    this.authenticatedAt = null; // For measuring authenticated -> ready duration
    // Fallback: poll client.info when ready event never fires (whatsapp-web.js bug)
    this.readyPollTimer = null;
    this.readyPollAttempts = 0;
    this.lastReadyPollError = null;
    // Ready diagnostics (observable)
    this.readySource = null; // 'event' | 'poll' | null
    this.readyAt = null;
    this.authenticatedToReadyMs = null;
    this.readyInProgress = false; // Guard against double-entry into markReady

    // Diagnostic: last webhook delivery
    this.lastWebhookEvent = null;
    this.lastWebhookStatus = null; // 'ok' | 'failed'
    this.lastWebhookAt = null;
    this.lastWebhookError = null;

    // Diagnostic: last error
    this.lastError = null;
    this.lastErrorAt = null;
    this.lastErrorStack = null;

    // CONNECTING watchdog: restart if stuck > N minutes
    this.connectingWatchdogTimer = null;
    this.connectingWatchdogStartAt = null;
    this.connectingWatchdogRestartCount = 0; // Reset on READY/NEEDS_QR

    // Diagnostics: last lifecycle event (for whatsapp-web.js audit)
    this.lastLifecycleEvent = null;
    this.lastLifecycleEventAt = null;
  }
  
  /**
   * Transition to a new state (with logging)
   */
  transitionTo(newState, reason = '') {
    const oldState = this.state;
    this.state = newState;
    this.lastEvent = newState;
    const ts = new Date().toISOString();

    debugLog(this.id, 'state_transition', { from: oldState, to: newState, reason: reason || undefined });
    console.log(`[${ts}] [${this.id}] State transition: ${oldState} -> ${newState}${reason ? ` (${reason})` : ''}`);
    
    // Handle state-specific actions
    if (newState === InstanceState.READY) {
      this.lastReadyAt = new Date();
      this.restartAttempts = 0; // Reset on successful ready
      this.restartHistory = []; // Clear restart history
      this.connectingWatchdogRestartCount = 0;
      this.clearReadyWatchdog();
      this.clearConnectingWatchdog();
      if (this.authenticatedAt) {
        const ms = this.lastReadyAt - this.authenticatedAt;
        debugLog(this.id, 'ready_after_authenticated_ms', { ms, authenticatedAt: this.authenticatedAt.toISOString() });
      }
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
      // Start send loop when ready (if queue has items)
      if (this.queue.length > 0) {
        console.log(`[${this.id}] Instance READY with ${this.queue.length} queued items - starting send loop`);
        startSendLoop(this.id);
      }
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
      this.clearConnectingWatchdog();
      this.connectingWatchdogRestartCount = 0;
      // Reject ready promise so createInstance can return when QR is received (QR = success for init)
      if (this.readyRejector) {
        this.readyRejector(new Error(`Instance in ${newState} state`));
        this.readyResolver = null;
        this.readyRejector = null;
        if (this.readyTimeout) {
          clearTimeout(this.readyTimeout);
          this.readyTimeout = null;
        }
      }
    }
    // Note: CONNECTING watchdog started only in softRestart/hardRestart, not in createInstance
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
   * Debug patch: clear ready watchdog timer
   */
  clearReadyWatchdog() {
    if (this.readyWatchdogTimer) {
      clearTimeout(this.readyWatchdogTimer);
      this.readyWatchdogTimer = null;
    }
    this.readyWatchdogStartAt = null;
  }

  /**
   * Fallback: clear ready poll (client.info check when ready event never fires)
   */
  clearReadyPoll() {
    if (this.readyPollTimer) {
      clearInterval(this.readyPollTimer);
      this.readyPollTimer = null;
    }
  }

  /**
   * Debug patch: start ready watchdog (call on qr/authenticated)
   */
  startReadyWatchdog() {
    this.clearReadyWatchdog();
    this.readyWatchdogStartAt = new Date();
    this.readyWatchdogTimer = setTimeout(() => {
      this.readyWatchdogTimer = null;
      onReadyWatchdogTimeout(this.id);
    }, config.readyWatchdogMs);
  }

  /**
   * Clear CONNECTING watchdog
   */
  clearConnectingWatchdog() {
    if (this.connectingWatchdogTimer) {
      clearTimeout(this.connectingWatchdogTimer);
      this.connectingWatchdogTimer = null;
    }
    this.connectingWatchdogStartAt = null;
  }

  /**
   * Start CONNECTING watchdog: if stuck in CONNECTING/NEEDS_QR for too long, restart
   * Count is NOT reset here - only when we reach READY or NEEDS_QR (progress)
   */
  startConnectingWatchdog() {
    this.clearConnectingWatchdog();
    this.connectingWatchdogStartAt = new Date();
    this.connectingWatchdogTimer = setTimeout(() => {
      this.connectingWatchdogTimer = null;
      onConnectingWatchdogTimeout(this.id);
    }, config.connectingWatchdogMs);
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
 * Debug patch: called when ready watchdog fires (ready not received within timeout)
 */
async function onReadyWatchdogTimeout(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance || instance.state === InstanceState.READY) return;

  const elapsedMs = instance.readyWatchdogStartAt ? Date.now() - instance.readyWatchdogStartAt.getTime() : 0;
  debugLog(instanceId, 'ready_timeout', {
    elapsedMs,
    authenticatedAt: instance.authenticatedAt ? instance.authenticatedAt.toISOString() : null,
    state: instance.state,
  });
  console.error(`[${instanceId}] ready_timeout: ready event not fired after ${elapsedMs}ms`);
  void forwardWebhook(instanceId, 'ready_timeout', {
    elapsedMs,
    authenticatedAt: instance.authenticatedAt ? instance.authenticatedAt.toISOString() : null,
    state: instance.state,
  }).catch(err => recordWebhookError(instanceId, err));

  if (!instance.readyWatchdogRestarted) {
    instance.readyWatchdogRestarted = true;
    instance.clearReadyWatchdog();
    instance.clearReadyPoll();
    console.log(`[${instanceId}] ready_timeout: restarting client once`);
    try {
      if (instance.client) {
        await softRestartAndWaitReady(instanceId).catch(err => {
          console.error(`[${instanceId}] ready_timeout restart failed:`, err.message);
        });
      }
    } catch (err) {
      console.error(`[${instanceId}] ready_timeout restart error:`, err);
    }
  }
}

/**
 * CONNECTING watchdog: instance stuck in CONNECTING or NEEDS_QR for too long - restart
 * After max restarts, transition to ERROR (no more restarts)
 */
async function onConnectingWatchdogTimeout(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance) return;
  if (instance.state !== InstanceState.CONNECTING && instance.state !== InstanceState.NEEDS_QR) return;

  instance.connectingWatchdogRestartCount = (instance.connectingWatchdogRestartCount || 0) + 1;
  const elapsedMs = instance.connectingWatchdogStartAt ? Date.now() - instance.connectingWatchdogStartAt.getTime() : 0;
  debugLog(instanceId, 'connecting_watchdog_timeout', { elapsedMs, state: instance.state, restartCount: instance.connectingWatchdogRestartCount });
  console.error(`[${instanceId}] connecting_watchdog: stuck in ${instance.state} for ${elapsedMs}ms (restart #${instance.connectingWatchdogRestartCount})`);

  if (instance.connectingWatchdogRestartCount >= config.connectingWatchdogMaxRestarts) {
    instance.lastError = `Stuck in ${instance.state} for ${elapsedMs}ms - max watchdog restarts (${config.connectingWatchdogMaxRestarts}) exceeded`;
    instance.lastErrorAt = new Date();
    instance.lastErrorStack = 'connecting_watchdog_max_restarts';
    instance.clearConnectingWatchdog();
    instance.transitionTo(InstanceState.ERROR, instance.lastError);
    console.error(`[${instanceId}] connecting_watchdog: moved to ERROR state - manual intervention required`);
    return;
  }

  instance.lastError = `Stuck in ${instance.state} for ${elapsedMs}ms`;
  instance.lastErrorAt = new Date();
  instance.lastErrorStack = 'connecting_watchdog_timeout';

  instance.clearConnectingWatchdog();
  try {
    if (instance.client) {
      await hardRestartAndWaitReady(instanceId).catch(err => {
        console.error(`[${instanceId}] connecting_watchdog restart failed:`, err.message);
        instance.lastError = err.message;
        instance.lastErrorStack = err.stack;
      });
    }
  } catch (err) {
    console.error(`[${instanceId}] connecting_watchdog restart error:`, err);
  }
}

/**
 * Record webhook error for observability. Stores error, logs once per failure type (avoid spam).
 * Does NOT rethrow.
 */
function recordWebhookError(instanceId, err) {
  const instance = instances.get(instanceId);
  if (!instance) return;

  const msg = err?.message || String(err);
  const failureType = msg.length > 80 ? msg.substring(0, 80) + '...' : msg;
  instance.lastWebhookError = msg;
  instance.lastWebhookAt = new Date();
  instance.lastWebhookStatus = 'failed';

  // Log once per failure type per 5 min (avoid spam)
  const now = Date.now();
  const key = `${instanceId}:${failureType}`;
  if (!recordWebhookError._lastLog) recordWebhookError._lastLog = {};
  const last = recordWebhookError._lastLog[key];
  if (!last || now - last > 300000) {
    recordWebhookError._lastLog[key] = now;
    console.error(`[${new Date().toISOString()}] [${instanceId}] Webhook forwarding failed:`, msg);
  }
}

/**
 * Forward webhook event (never blocks state transitions - failures are logged only)
 * Callers use .catch(err => recordWebhookError(instanceId, err)) - do NOT rethrow.
 */
async function forwardWebhook(instanceId, event, data) {
  const instance = instances.get(instanceId);
  if (!instance || !instance.webhookUrl) return;

  // authenticated and ready always forwarded; other events follow webhookEvents filter
  const alwaysSend = ['authenticated', 'ready', 'ready_timeout'];
  const shouldSend = alwaysSend.includes(event) ||
    instance.webhookEvents.length === 0 ||
    instance.webhookEvents.includes(event);
  if (!shouldSend) return;

  const payload = { event, instanceId, data };

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (config.webhookSecret) {
      const crypto = require('crypto');
      const hmac = crypto.createHmac('sha256', config.webhookSecret);
      const signature = hmac.update(JSON.stringify(payload)).digest('hex');
      headers['x-wa-hub-signature'] = signature;
    }
    if (config.webhookProtectionBypass) {
      headers['x-vercel-protection-bypass'] = config.webhookProtectionBypass;
    }
    // Optional: send Bearer token if receiver requires API-key auth (fixes 401 on protected webhook endpoints)
    if (config.webhookAuthToken) {
      headers['Authorization'] = `Bearer ${config.webhookAuthToken}`;
    }
    await axios.post(instance.webhookUrl, payload, { headers });
    instance.lastWebhookEvent = event;
    instance.lastWebhookStatus = 'ok';
    instance.lastWebhookAt = new Date();
    instance.lastWebhookError = null;
    console.log(`[${new Date().toISOString()}] [${instanceId}] Webhook forwarded: ${event}`);
  } catch (error) {
    instance.lastWebhookEvent = event;
    instance.lastWebhookStatus = 'failed';
    instance.lastWebhookAt = new Date();
    instance.lastWebhookError = error.message;
    recordWebhookError(instanceId, error);
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
 *
 * WHY LOCALAUTH DIRECTORIES ARE IMMUTABLE: LocalAuth stores session tokens, encryption keys,
 * and browser profile data under dataPath. Deleting or mutating these while a client is running
 * causes Chromium to crash or hang. Cleanup must run only when the service is fully stopped.
 *
 * CANONICAL whatsapp-web.js: LocalAuth is the single source of truth for session persistence.
 * - clientId: unique per instance (LocalAuth creates session-{clientId}/ under dataPath)
 * - dataPath: config.authBaseDir (e.g. ./.wwebjs_auth/) - NEVER mutate this while client is running
 * - We do NOT set puppeteer.userDataDir - it would conflict with LocalAuth's session storage
 */
async function createClient(instanceId, instanceName) {
  const sanitizedClientId = sanitizeInstanceId(instanceId);
  
  // Build Puppeteer config with robust args for headless Linux environments
  // Keep args minimal to avoid conflicts that could cause "Execution context destroyed" errors
  const puppeteerConfig = {
    headless: true,
    args: [
      // Essential for headless Linux
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      
      // Basic headless optimizations
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
      '--force-color-profile=srgb',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--disable-blink-features=AutomationControlled',
      
      // Fix for xdg-settings and snap cgroup issues
      '--disable-x11-autolaunch',
      '--disable-application-cache',
      '--disable-plugins-discovery',
      
      // Network and security (minimal set)
      '--ignore-certificate-errors',
      '--ignore-certificate-errors-spki-list',
      '--no-default-browser-check',
      '--no-pings',
      
      // Display
      '--window-size=1920,1080',
      '--log-level=3', // Suppress non-fatal errors
      
      // Cache size limits (prevent disk bloat)
      '--disk-cache-size=104857600', // 100MB disk cache limit
      '--media-cache-size=104857600', // 100MB media cache limit (if supported)
    ],
  };
  
  // Use system Chromium when CHROME_PATH is set and exists (avoids Puppeteer bundled Chromium)
  // Bundled Chromium can cause 99% CPU renderer hangs on WhatsApp Web load
  const pathsToTry = config.chromePath
    ? [config.chromePath]
    : [
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
      ];
  let foundPath = null;
  for (const testPath of pathsToTry) {
    try {
      await fs.access(testPath);
      foundPath = testPath;
      break;
    } catch (error) {
      continue;
    }
  }
  if (foundPath) {
    puppeteerConfig.executablePath = foundPath;
    console.log(`[${instanceId}] Using Chrome: ${foundPath}`);
  } else {
    console.log(`[${instanceId}] No system Chrome found, using Puppeteer bundled Chromium`);
  }
  
  return new Client({
    authStrategy: new LocalAuth({
      clientId: sanitizedClientId,
      dataPath: config.authBaseDir,
    }),
    puppeteer: puppeteerConfig,
  });
}

/**
 * Set up event listeners for WhatsApp client
 *
 * WHY LIFECYCLE HANDLERS MUST BE SIDE-EFFECT SAFE: whatsapp-web.js emits qr, authenticated,
 * ready, auth_failure, disconnected, change_state synchronously. If we await webhooks or queues
 * inside these handlers, we block the event loop and delay further events. State transitions must
 * happen immediately; webhooks are fire-and-forget.
 */
function setupEventListeners(instanceId, client) {
  const instance = instances.get(instanceId);
  if (!instance) return;

  const guard = () => !instances.has(instanceId);

  // QR code event - state transition FIRST, webhook fire-and-forget (never block lifecycle)
  client.on('qr', (qr) => {
    if (guard()) return;
    const ts = new Date().toISOString();
    instance.lastLifecycleEvent = 'qr';
    instance.lastLifecycleEventAt = new Date();
    debugLog(instanceId, 'qr', {});
    console.log(`[${ts}] [${instanceId}] Event: qr`);
    instance.qrReceivedDuringRestart = true;
    instance.readyWatchdogRestarted = false;
    instance.startReadyWatchdog();
    instance.clearConnectingWatchdog();
    instance.connectingWatchdogRestartCount = 0; // Progress: got QR
    instance.transitionTo(InstanceState.NEEDS_QR, 'QR code received');
    qrToBase64(qr).then((qrBase64) => {
      if (guard()) return;
      instance.qrCode = qrBase64;
      instance.lastQrUpdate = new Date();
      void forwardWebhook(instanceId, 'qr', { qr: qrBase64 }).catch(err => recordWebhookError(instanceId, err));
    }).catch((error) => {
      if (guard()) return;
      console.error(`[${instanceId}] Error processing QR:`, error);
      instance.lastError = error.message;
      instance.lastErrorAt = new Date();
      instance.lastErrorStack = error.stack;
      void forwardWebhook(instanceId, 'qr', { error: error.message }).catch(err => recordWebhookError(instanceId, err));
    });
  });
  
  /**
   * Mark instance as ready. Idempotent: if already READY or readyInProgress, returns without side effects.
   * @param {string} source - 'event' | 'poll'
   */
  function markReady(source) {
    if (instance.state === InstanceState.READY || instance.readyInProgress) return;
    instance.readyInProgress = true;
    try {
      instance.clearReadyWatchdog();
      instance.clearReadyPoll();
      instance.readySource = source;
      instance.readyAt = new Date();
      instance.authenticatedToReadyMs = instance.authenticatedAt
        ? Date.now() - instance.authenticatedAt.getTime()
        : null;
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
      void forwardWebhook(instanceId, 'ready', { status: 'ready' }).catch(err =>
        recordWebhookError(instanceId, err)
      );
      startSendLoop(instanceId);
      instance.lastEvent = 'ready';
      instance.lastLifecycleEvent = 'ready';
      instance.lastLifecycleEventAt = new Date();
      debugLog(instanceId, 'ready', {
        readySource: source,
        authenticatedAt: instance.authenticatedAt ? instance.authenticatedAt.toISOString() : null,
        authenticatedToReadyMs: instance.authenticatedToReadyMs,
      });
      console.log(`[${new Date().toISOString()}] [${instanceId}] Event: ready (source=${source})`);
      if (instance.authenticatedToReadyMs != null) {
        debugLog(instanceId, 'ready_after_authenticated_ms', {
          ms: instance.authenticatedToReadyMs,
          authenticatedAt: instance.authenticatedAt ? instance.authenticatedAt.toISOString() : null,
        });
      }
    } finally {
      instance.readyInProgress = false;
    }
  }

  /**
   * Check contact info (client.info + getState). If both pass, mark ready.
   * Called immediately on authenticated and then every READY_POLL_INTERVAL_MS.
   */
  async function checkContactInfoAndMaybeReady() {
    if (!instances.has(instanceId) || instance.state === InstanceState.READY) return;
    if (!instance.authenticatedAt) return;
    instance.readyPollAttempts = (instance.readyPollAttempts || 0) + 1;
    try {
      const info = client.info;
      if (!info) return;
      const state = await client.getState();
      if (!state || typeof state !== 'string' || state.length === 0) {
        instance.lastReadyPollError = 'getState returned empty';
        return;
      }
      instance.lastReadyPollError = null;
      console.log(`[${new Date().toISOString()}] [${instanceId}] Ready poll: client.info + getState ok, treating as ready`);
      instance.clearReadyPoll();
      markReady('poll');
    } catch (e) {
      instance.lastReadyPollError = e.message;
    }
  }

  // Fallback: poll client.info + getState when ready event never fires (whatsapp-web.js bug)
  function startReadyPoll() {
    instance.clearReadyPoll();
    // Always check immediately when status is authenticated, then every interval
    void checkContactInfoAndMaybeReady().catch(() => {});
    instance.readyPollTimer = setInterval(() => {
      void checkContactInfoAndMaybeReady().catch(() => {});
    }, config.readyPollIntervalMs);
  }

  // Authenticated event - transition from NEEDS_QR to CONNECTING (syncing) until ready
  client.on('authenticated', () => {
    if (guard()) return;
    const ts = new Date().toISOString();
    instance.lastLifecycleEvent = 'authenticated';
    instance.lastLifecycleEventAt = new Date();
    instance.authenticatedAt = new Date();
    instance.readySource = null;
    instance.readyAt = null;
    instance.authenticatedToReadyMs = null;
    instance.readyPollAttempts = 0;
    instance.lastReadyPollError = null;
    debugLog(instanceId, 'authenticated', { authenticatedAt: instance.authenticatedAt.toISOString() });
    console.log(`[${ts}] [${instanceId}] Event: authenticated`);
    instance.lastEvent = 'authenticated';
    if (instance.state === InstanceState.NEEDS_QR) {
      instance.transitionTo(InstanceState.CONNECTING, 'authenticated, syncing');
    }
    instance.clearConnectingWatchdog();
    instance.connectingWatchdogRestartCount = 0; // Progress: authenticated
    instance.startReadyWatchdog();
    startReadyPoll(); // Runs immediate check + interval
    void forwardWebhook(instanceId, 'authenticated', {}).catch(err => recordWebhookError(instanceId, err));
  });
  
  // Ready event - state transition FIRST, webhook fire-and-forget (never block lifecycle)
  client.on('ready', () => {
    if (guard()) return;
    markReady('event');
  });
  
  // Auth failure - state transition FIRST, webhook fire-and-forget
  client.on('auth_failure', (msg) => {
    if (guard()) return;
    const ts = new Date().toISOString();
    instance.lastLifecycleEvent = 'auth_failure';
    instance.lastLifecycleEventAt = new Date();
    debugLog(instanceId, 'auth_failure', { error: String(msg) });
    console.error(`[${ts}] [${instanceId}] Event: auth_failure - ${msg}`);
    instance.lastAuthFailureAt = new Date();
    instance.lastError = String(msg);
    instance.lastErrorAt = new Date();
    instance.clearReadyWatchdog();
    instance.clearReadyPoll();
    instance.clearConnectingWatchdog();
    instance.transitionTo(InstanceState.NEEDS_QR, `Auth failure: ${msg}`);
    void forwardWebhook(instanceId, 'auth_failure', { message: msg }).catch(err => recordWebhookError(instanceId, err));
  });
  
  // Disconnected - state transition in handler, webhook fire-and-forget
  client.on('disconnected', (reason) => {
    if (guard()) return;
    const reasonStr = reason || 'unknown';
    instance.lastLifecycleEvent = 'disconnected';
    instance.lastLifecycleEventAt = new Date();
    debugLog(instanceId, 'disconnected', { reason: reasonStr });
    console.log(`[${instanceId}] Event: disconnected - ${reasonStr}`);
    instance.lastDisconnectAt = new Date();
    instance.lastDisconnectReason = reasonStr;
    instance.lastEvent = 'disconnected';
    instance.recordDisconnect();
    instance.clearReadyWatchdog();
    instance.clearReadyPoll();
    stopSendLoop(instanceId);
    const terminalReasons = ['LOGOUT', 'UNPAIRED', 'CONFLICT', 'TIMEOUT'];
    const reasonUpper = reasonStr.toUpperCase();
    const isTerminal = terminalReasons.some(term => reasonUpper.includes(term));
    if (isTerminal) {
      instance.transitionTo(InstanceState.NEEDS_QR, `Terminal disconnect: ${reasonStr}`);
    } else {
      instance.transitionTo(InstanceState.DISCONNECTED, reasonStr);
      // Auto-reconnect on non-terminal disconnect (skip if DISABLE_AUTO_RECONNECT)
      if (!config.disableAutoReconnect && !instance.reconnectionLock && !instance.checkRestartRateLimit()) {
        Promise.resolve(ensureReady(instanceId)).catch(err => {
          console.error(`[${instanceId}] Auto-reconnect failed:`, err);
        });
      } else if (config.disableAutoReconnect) {
        console.log(`[${instanceId}] Auto-reconnect disabled (DISABLE_AUTO_RECONNECT=true)`);
      }
    }
    void forwardWebhook(instanceId, 'disconnected', { reason: reasonStr }).catch(err => recordWebhookError(instanceId, err));
  });
  
  // State change (whatsapp-web.js internal state, not our InstanceState)
  client.on('change_state', (state) => {
    if (guard()) return;
    const ts = new Date().toISOString();
    instance.lastLifecycleEvent = `change_state:${state}`;
    instance.lastLifecycleEventAt = new Date();
    console.log(`[${ts}] [${instanceId}] Event: change_state - ${state}`);
    instance.lastEvent = `change_state:${state}`;
    void forwardWebhook(instanceId, 'change_state', { status: state }).catch(err => recordWebhookError(instanceId, err));
  });
  
  // Message - fire-and-forget webhook (never block lifecycle)
  // Listen to both 'message' and 'message_create' (whatsapp-web.js v1.34 emits message_create; message can be unreliable)
  const recentMessageIds = new Set();
  const MAX_RECENT_IDS = 200;
  const handleIncomingMessage = (message) => {
    if (guard()) return;
    const msgId = message.id?._serialized || message.id || null;
    if (msgId && recentMessageIds.has(msgId)) return; // dedupe when both events fire
    if (msgId) {
      recentMessageIds.add(msgId);
      if (recentMessageIds.size > MAX_RECENT_IDS) recentMessageIds.clear();
    }
    const from = extractPhoneNumber(message.from);
    console.log(`[${instanceId}] Received message (from: ${from}, type: ${message.type || 'text'}, id: ${msgId || 'n/a'})`);
    const messageData = {
      message: {
        from,
        body: message.body || message.text || '',
        text: message.body || message.text || '',
        type: message.type || 'text',
        timestamp: message.timestamp,
        id: msgId,
      },
    };
    void forwardWebhook(instanceId, 'message', messageData).catch(err => recordWebhookError(instanceId, err));
  };
  client.on('message', handleIncomingMessage);
  client.on('message_create', handleIncomingMessage);

  // Vote update - fire-and-forget webhook (never block lifecycle)
  client.on('vote_update', (vote) => {
    if (guard()) return;
    const voter = extractPhoneNumber(vote.voter || vote.from || vote.chatId);
    const options = vote.selectedOptions || vote.selected_options || vote.options || [];
    console.log(`[${instanceId}] Received vote_update event (voter: ${voter}, options: ${JSON.stringify(options)})`);
    const voteData = {
      vote: {
        voter,
        selectedOptions: options,
        timestamp: vote.timestamp || vote.interractedAtTs || Date.now(),
        pollMessageId:
          (vote.parentMsgKey && (vote.parentMsgKey._serialized || vote.parentMsgKey.id || vote.parentMsgKey._serialized)) ||
          (vote.parentMessage && vote.parentMessage.id && (vote.parentMessage.id._serialized || vote.parentMessage.id)) ||
          (vote.id && (vote.id._serialized || vote.id)) ||
          null,
      },
    };
    void forwardWebhook(instanceId, 'vote_update', voteData).catch(err => recordWebhookError(instanceId, err));
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
  instance.clearReadyWatchdog();
  instance.clearReadyPoll();
  instance.transitionTo(InstanceState.CONNECTING, 'soft restart');
  instance.qrReceivedDuringRestart = false;
  instance.startConnectingWatchdog();
  
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
  instance.clearReadyWatchdog();
  instance.clearReadyPoll();
  instance.transitionTo(InstanceState.CONNECTING, 'hard restart');
  instance.qrReceivedDuringRestart = false;
  instance.startConnectingWatchdog();
  
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
      console.log(`[${instanceId}] Instance not READY (state: ${instance.state}), triggering ensureReady to reconnect`);
      Promise.resolve(ensureReady(instanceId)).catch(err => {
        console.error(`[${instanceId}] ensureReady failed:`, err);
      });
    } else {
      console.log(`[${instanceId}] Cannot process item - instance is in terminal state (${instance.state})`);
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
        Promise.resolve(ensureReady(instanceId)).catch(err => {
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
    if (instance.queue.length > 0) {
      console.log(`[${instanceId}] runSendLoop: Stopped (state: ${instance.state}, queue: ${instance.queue.length} items)`);
    }
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
    console.log(`[${instanceId}] runSendLoop: All ${instance.queue.length} items deferred, will retry in 1s`);
    setTimeout(() => {
      startSendLoop(instanceId);
    }, 1000); // Check again in 1 second
    return;
  }
  
  // Process first eligible item
  try {
    const item = itemsToProcess[0];
    console.log(`[${instanceId}] runSendLoop: Processing item ${item.id} (${item.type}), ${itemsToProcess.length} eligible, ${instance.queue.length} total in queue`);
    const shouldRemove = await processQueueItem(instanceId, item);
    
    if (shouldRemove) {
      // Remove from queue
      const index = instance.queue.findIndex(q => q.id === item.id);
      if (index !== -1) {
        instance.queue.splice(index, 1);
        console.log(`[${instanceId}] Removed item ${item.id} from queue, ${instance.queue.length} items remaining`);
      }
    }
  } catch (error) {
    // Unexpected error in processQueueItem - log but continue loop
    console.error(`[${instanceId}] Unexpected error in runSendLoop:`, error);
    instance.sendLoopRunning = false;
    // Restart loop after a delay
    setTimeout(() => {
      startSendLoop(instanceId);
    }, 2000);
    return;
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
    console.warn(`[${instanceId}] startSendLoop: Instance not found`);
    return;
  }
  
  // Only start if READY and not already running
  if (instance.state !== InstanceState.READY) {
    instance.sendLoopRunning = false;
    console.log(`[${instanceId}] startSendLoop: Instance not READY (state: ${instance.state}), queue depth: ${instance.queue.length}`);
    return;
  }
  
  if (instance.sendLoopRunning) {
    console.log(`[${instanceId}] startSendLoop: Already running, queue depth: ${instance.queue.length}`);
    return; // Already running
  }
  
  if (instance.queue.length === 0) {
    instance.sendLoopRunning = false;
    console.log(`[${instanceId}] startSendLoop: Queue empty`);
    return; // Nothing to process
  }
  
  console.log(`[${instanceId}] Starting send loop with ${instance.queue.length} items in queue`);
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
  
  // Initialize with retry logic (max 2 attempts)
  const maxAttempts = 2;
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let client = null;
    
    try {
      // Create client
      client = await createClient(instanceId, name);
      instance.client = client;
      
      // Setup event listeners
      setupEventListeners(instanceId, client);
      
      // Small delay to let browser process stabilize
      if (attempt > 1) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      }
      
      // Initialize
      instance.transitionTo(InstanceState.CONNECTING, `initializing (attempt ${attempt}/${maxAttempts})`);
      console.log(`[${instanceId}] Initializing client (attempt ${attempt}/${maxAttempts})...`);
      
      await client.initialize();
      
      // Wait for ready or QR (with timeout)
      // On slow VMs, authenticated can take 20-30s; ready can take another 30-60s
      const readyTimeout = config.initTimeoutMs;
      await Promise.race([
        waitForReadyEvent(instanceId).catch(() => {
          // QR is acceptable, don't throw
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Initialization timeout - no QR or ready event')), readyTimeout)
        ),
      ]).catch((timeoutError) => {
        // If we get a QR event, that's fine - don't treat timeout as fatal
        if (instance.qrCode) {
          console.log(`[${instanceId}] QR code received, initialization proceeding...`);
          return;
        }
        throw timeoutError;
      });
      
      // Success - break out of retry loop
      console.log(`[${instanceId}] Client initialized successfully`);
      break;
      
    } catch (error) {
      lastError = error;
      console.error(`[${instanceId}] Initialization attempt ${attempt}/${maxAttempts} failed:`, error.message);
      
      // Clean up failed client
      if (client) {
        try {
          // Remove event listeners to prevent leaks
          if (client.pupPage) {
            client.pupPage.removeAllListeners();
          }
          if (client.pupBrowser) {
            await client.pupBrowser.close().catch(() => {});
          }
        } catch (cleanupError) {
          console.warn(`[${instanceId}] Error during cleanup:`, cleanupError.message);
        }
        instance.client = null;
      }
      
      // If this was the last attempt, throw the error
      if (attempt === maxAttempts) {
        instance.transitionTo(InstanceState.ERROR, `Initialization failed after ${maxAttempts} attempts: ${error.message}`);
        throw new Error(`Failed to initialize after ${maxAttempts} attempts: ${error.message}`);
      }
      
      // Wait before retry (exponential backoff)
      const backoffMs = 2000 * attempt;
      console.log(`[${instanceId}] Retrying in ${backoffMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
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
  
  // Check if already queued
  const isQueued = await idempotencyStore.isQueued(idempotencyKey);
  if (isQueued) {
    // Check if item is still in the actual queue
    const existingItem = instance.queue.find(item => item.idempotencyKey === idempotencyKey);
    if (existingItem) {
      // Item is still in queue - return it instead of throwing error
      console.log(`[${instanceId}] Message already queued (idempotency: ${idempotencyKey.substring(0, 20)}...), returning existing queue item`);
      return existingItem;
    }
    
    // Item is marked as queued in idempotency store but not in actual queue
    // This could happen if queue was cleared or item was removed but idempotency record wasn't updated
    // Since isQueued already checks for staleness, if it returns true, the item is not stale
    // But if it's not in the queue, we should allow re-queuing (queue might have been cleared)
    console.warn(`[${instanceId}] Item marked as queued but not in actual queue, allowing re-queue (idempotency: ${idempotencyKey.substring(0, 20)}...)`);
    // Continue to queue new item (will update idempotency record)
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
  
  console.log(`[${instanceId}] Queued ${type} (idempotency: ${idempotencyKey.substring(0, 20)}..., queue depth: ${instance.queue.length}, state: ${instance.state})`);
  
  // Trigger send loop if not running
  // Note: send loop will only start if instance is READY
  if (instance.state === InstanceState.READY) {
    Promise.resolve(startSendLoop(instanceId)).catch(err => {
      console.error(`[${instanceId}] Failed to start send loop:`, err);
    });
  } else {
    console.log(`[${instanceId}] Instance not READY (state: ${instance.state}), will attempt to make it ready`);
    // Trigger ensureReady if not terminal (safety net - sendMessage/sendPoll also do this)
    if (instance.state !== InstanceState.NEEDS_QR && instance.state !== InstanceState.ERROR) {
      Promise.resolve(ensureReady(instanceId)).catch(err => {
        console.error(`[${instanceId}] ensureReady failed in enqueueItem:`, err);
      });
    } else {
      console.log(`[${instanceId}] Instance is in terminal state (${instance.state}), cannot auto-reconnect`);
    }
  }
  
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
  
  // Check if this was an existing queued item (item created more than 2 seconds ago = existing)
  const itemAge = Date.now() - new Date(item.createdAt).getTime();
  const wasAlreadyQueued = itemAge > 2000; // More than 2 seconds old = existing item
  
  // Trigger reconnection if not terminal (only if newly queued)
  if (!wasAlreadyQueued && instance.state !== InstanceState.NEEDS_QR && instance.state !== InstanceState.ERROR) {
    Promise.resolve(ensureReady(instanceId)).catch(err => {
      console.error(`[${instanceId}] Background ensureReady failed:`, err);
    });
  }
  
  return {
    status: 'queued',
    instanceState: instance.state,
    queueDepth: instance.queue.length,
    queueId: item.id,
    idempotencyKey: idempotencyKey.substring(0, 30) + '...', // Truncated for response
    alreadyQueued: wasAlreadyQueued, // Indicate if this was already queued
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
  
  // Check if this was an existing queued item (item created more than 2 seconds ago = existing)
  const itemAge = Date.now() - new Date(item.createdAt).getTime();
  const wasAlreadyQueued = itemAge > 2000; // More than 2 seconds old = existing item
  
  // Trigger reconnection if not terminal (only if newly queued)
  if (!wasAlreadyQueued && instance.state !== InstanceState.NEEDS_QR && instance.state !== InstanceState.ERROR) {
    Promise.resolve(ensureReady(instanceId)).catch(err => {
      console.error(`[${instanceId}] Background ensureReady failed:`, err);
    });
  }
  
  return {
    status: 'queued',
    instanceState: instance.state,
    queueDepth: instance.queue.length,
    queueId: item.id,
    idempotencyKey: idempotencyKey.substring(0, 30) + '...', // Truncated for response
    alreadyQueued: wasAlreadyQueued, // Indicate if this was already queued
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
 * Purge LocalAuth session storage for an instance from disk.
 * Safe to call even when instance/client doesn't exist (idempotent).
 * Matches session dirs: session-{sanitizedId}, {sanitizedId}, Default-{sanitizedId}.
 * @param {string} instanceId - Instance ID
 * @returns {{ purged: boolean; purgedPaths: string[]; warnings: string[] }}
 */
async function purgeLocalAuthSession(instanceId) {
  const warnings = [];
  const purgedPaths = [];
  const sanitizedId = sanitizeInstanceId(instanceId);
  const authBase = config.authBaseDir;

  const candidateDirs = [
    `session-${sanitizedId}`,
    sanitizedId,
    `Default-${sanitizedId}`,
  ];

  for (const dirName of candidateDirs) {
    const dirPath = path.join(authBase, dirName);
    try {
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) continue;
      await fs.rm(dirPath, { recursive: true, force: true });
      purgedPaths.push(dirPath);
      console.log(`[${instanceId}] Purged LocalAuth session: ${dirPath}`);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      warnings.push(`Failed to purge ${dirPath}: ${err.message}`);
      console.warn(`[${instanceId}] Purge warning: ${dirPath}:`, err.message);
    }
  }

  return {
    purged: purgedPaths.length > 0,
    purgedPaths,
    warnings,
  };
}

/**
 * Delete instance (hard delete).
 * 1) Stop timers, destroy client (with timeout)
 * 2) Remove from runtime map + persisted list
 * 3) Purge LocalAuth session storage from disk
 * Idempotent: if instance not in map, still purges session dirs if they exist.
 * @param {string} instanceId
 * @returns {Promise<{ deleted: boolean; purged: boolean; purgedPaths: string[]; warnings: string[] }>}
 */
async function deleteInstance(instanceId) {
  console.log(`[${instanceId}] DELETE_INSTANCE start`);
  const result = { deleted: false, purged: false, purgedPaths: [], warnings: [] };
  const instance = instances.get(instanceId);

  if (instance) {
    instance.clearReadyWatchdog();
    instance.clearReadyPoll();
    instance.clearConnectingWatchdog();
    stopSendLoop(instanceId);

    const client = instance.client;
    instances.delete(instanceId);
    await saveInstancesToDisk().catch(err => {
      result.warnings.push(`Save failed: ${err.message}`);
      console.error('[Persistence] Save failed:', err.message);
    });

    if (client) {
      try {
        await client.logout();
      } catch (err) {
        result.warnings.push(`logout: ${err.message}`);
      }
      try {
        await Promise.race([
          client.destroy(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('destroy timeout')), config.deleteDestroyTimeoutMs)
          ),
        ]);
        console.log(`[${instanceId}] Client destroyed`);
      } catch (err) {
        result.warnings.push(`destroy: ${err.message}`);
        console.warn(`[${instanceId}] Destroy error (continuing with purge):`, err.message);
      }
    }
    result.deleted = true;
  } else {
    try {
      const rawData = await fs.readFile(config.instancesDataPath, 'utf8');
      const list = (() => {
        try {
          const parsed = JSON.parse(rawData);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();
      const filtered = list.filter((x) => x && x.id !== instanceId);
      if (filtered.length !== list.length) {
        const dataDir = path.dirname(config.instancesDataPath);
        await fs.mkdir(dataDir, { recursive: true }).catch(() => {});
        await fs.writeFile(config.instancesDataPath, JSON.stringify(filtered, null, 2));
        result.deleted = true;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        result.warnings.push(`instances file: ${err.message}`);
      }
    }
  }

  const purgeResult = await purgeLocalAuthSession(instanceId);
  result.purged = purgeResult.purged;
  result.purgedPaths = purgeResult.purgedPaths;
  result.warnings.push(...purgeResult.warnings);

  console.log(`[${instanceId}] DELETE_INSTANCE end`, {
    deleted: result.deleted,
    purged: result.purged,
    purgedPaths: result.purgedPaths,
  });
  return result;
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

/**
 * Get queue details for an instance
 */
function getQueueDetails(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance) {
    throw new Error(`Instance ${instanceId} not found`);
  }
  
  const now = Date.now();
  const items = instance.queue.map(item => ({
    id: item.id,
    type: item.type,
    idempotencyKey: item.idempotencyKey?.substring(0, 30) + '...',
    createdAt: item.createdAt,
    age: now - new Date(item.createdAt).getTime(),
    attemptCount: item.attemptCount,
    nextAttemptAt: item.nextAttemptAt,
    nextAttemptIn: item.nextAttemptAt ? Math.max(0, item.nextAttemptAt - now) : 0,
    lastError: item.lastError,
    isEligible: !item.nextAttemptAt || now >= item.nextAttemptAt,
  }));
  
  return {
    depth: instance.queue.length,
    sendLoopRunning: instance.sendLoopRunning,
    instanceState: instance.state,
    items,
    eligibleCount: items.filter(i => i.isEligible).length,
  };
}

/**
 * Manually trigger send loop for an instance
 */
function triggerSendLoop(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance) {
    throw new Error(`Instance ${instanceId} not found`);
  }
  
  console.log(`[${instanceId}] Manual send loop trigger requested (state: ${instance.state}, queue: ${instance.queue.length} items)`);
  
  if (instance.state !== InstanceState.READY) {
    return {
      success: false,
      message: `Instance is not READY (state: ${instance.state}). Send loop will start automatically when instance becomes READY.`,
      state: instance.state,
      queueDepth: instance.queue.length,
    };
  }
  
  if (instance.queue.length === 0) {
    return {
      success: false,
      message: 'Queue is empty. Nothing to send.',
      queueDepth: 0,
    };
  }
  
  // Force start send loop
  instance.sendLoopRunning = false; // Reset flag to allow restart
  startSendLoop(instanceId);
  
  return {
    success: true,
    message: 'Send loop triggered',
    queueDepth: instance.queue.length,
    sendLoopRunning: instance.sendLoopRunning,
  };
}

function getInstanceCount() {
  return instances.size;
}

/**
 * Get diagnostic info for an instance (for debugging stuck NEEDS_QR/CONNECTING)
 */
function getInstanceDiagnostics(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance) {
    return null;
  }
  return {
    instanceId: instance.id,
    name: instance.name,
    state: instance.state,
    lastLifecycleEvent: instance.lastLifecycleEvent,
    lastLifecycleEventAt: instance.lastLifecycleEventAt,
    lastEvent: instance.lastEvent,
    lastEventTimestamp: instance.lastLifecycleEventAt || instance.lastReadyAt || instance.lastDisconnectAt || instance.lastAuthFailureAt || instance.authenticatedAt,
    lastWebhookEvent: instance.lastWebhookEvent,
    lastWebhookStatus: instance.lastWebhookStatus,
    lastWebhookAt: instance.lastWebhookAt,
    lastWebhookError: instance.lastWebhookError,
    lastError: instance.lastError,
    lastErrorAt: instance.lastErrorAt,
    lastErrorStack: instance.lastErrorStack,
    readyWatchdogStartAt: instance.readyWatchdogStartAt,
    connectingWatchdogStartAt: instance.connectingWatchdogStartAt,
    connectingWatchdogRestartCount: instance.connectingWatchdogRestartCount || 0,
    qrReceivedDuringRestart: instance.qrReceivedDuringRestart,
    restartAttempts: instance.restartAttempts,
    restartCount: instance.restartAttempts,
    queueDepth: instance.queue.length,
    sendLoopRunning: instance.sendLoopRunning,
    activeForCleanup: !!(instance.client && (instance.state === InstanceState.READY || instance.state === InstanceState.CONNECTING || instance.state === InstanceState.DISCONNECTED)),
    // Ready-poll diagnostics
    readySource: instance.readySource,
    authenticatedAt: instance.authenticatedAt ? instance.authenticatedAt.toISOString() : null,
    readyAt: instance.readyAt ? instance.readyAt.toISOString() : null,
    authenticatedToReadyMs: instance.authenticatedToReadyMs,
    readyPollAttempts: instance.readyPollAttempts || 0,
    lastReadyPollError: instance.lastReadyPollError,
  };
}

module.exports = {
  InstanceState,
  createInstance,
  getInstance,
  getAllInstances,
  getInstanceCount,
  deleteInstance,
  updateWebhookConfig,
  sendMessage,
  sendPoll,
  ensureReady,
  waitForReadyEvent,
  loadInstancesFromDisk,
  saveInstancesToDisk,
  clearQueue,
  getQueueDetails,
  triggerSendLoop,
  getInstanceDiagnostics,
};
