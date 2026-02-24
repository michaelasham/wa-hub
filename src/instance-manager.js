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
const { startPopupDismisser } = require('./utils/whatsappWebPopupDismisser');
const { markSeenAfterSend, markSeenOnRelevantIncoming } = require('./utils/selectiveSeen');
const sentry = require('./observability/sentry');
const systemMode = require('./systemMode');
const inboundBuffer = require('./queues/inboundBuffer');

/** Hash identifier for breadcrumbs (no PII). */
function hashForBreadcrumb(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex').slice(0, 10);
}

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
  STARTING_BROWSER: 'starting_browser', // Launching Chromium (before CONNECTING)
  CONNECTING: 'connecting',
  DISCONNECTED: 'disconnected',
  NEEDS_QR: 'needs_qr',
  ERROR: 'error',
  RESTRICTED: 'restricted',  // Detected restriction - long cooldown, no reconnect
  PAUSED: 'paused',          // Cooldown or rate limit - pause sends, no reconnect until window expires
  FAILED_QR_TIMEOUT: 'failed_qr_timeout', // Stuck in NEEDS_QR past TTL / max recovery attempts
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
    this.lastQrAt = null; // Last time we received a QR event (for stale detection)

    // NEEDS_QR timeout & recovery
    this.needsQrSince = null;       // When instance entered NEEDS_QR
    this.qrRecoveryAttempts = 0;    // Number of recovery attempts for this NEEDS_QR session
    this.nextQrRecoveryAt = null;   // Earliest time to run next recovery (backoff)
    this.lastStateChangeAt = new Date();
    
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

    // Restore scheduler: attempts and backoff (for sequential restore)
    this.restoreAttempts = 0;
    this.lastRestoreAttemptAt = null;

    // CONNECTING watchdog: restart if stuck > N minutes
    this.connectingWatchdogTimer = null;
    this.connectingWatchdogStartAt = null;
    this.connectingWatchdogRestartCount = 0; // Reset on READY/NEEDS_QR

    // Diagnostics: last lifecycle event (for whatsapp-web.js audit)
    this.lastLifecycleEvent = null;
    this.lastLifecycleEventAt = null;

    // Incoming message dedupe (LRU, max 2000) - shared by event listeners and fallback poller
    this.recentMessageIds = new Map(); // key -> timestamp
    this.lastIncomingMessageAt = null;

    // Fallback poller (when message events fail - whatsapp-web.js v1.34 bug)
    this.messageFallbackPollTimer = null;
    this.lastFallbackPollAt = null;
    this.fallbackPollRuns = 0;
    this.fallbackPollLastError = null;

    // Listener attachment tracking (diagnostics)
    this.listenersAttached = false;

    // Disconnect cooldown: no reconnect/sends until this timestamp
    this.disconnectCooldownUntil = null;
    // Restriction cooldown: 72h pause when restriction detected
    this.restrictedUntil = null;
    // Zombie detection: last activity timestamp (send or incoming message)
    this.lastActivityAt = null;
    // Health check timer
    this.healthCheckTimer = null;
    // Ready timeout: pause until this before retry (instead of immediate soft restart)
    this.readyTimeoutPauseUntil = null;
    // Scheduled ensureReady after disconnect cooldown
    this.disconnectCooldownTimer = null;
    // Scheduled ensureReady after restart rate limit PAUSED
    this.rateLimitWakeTimer = null;
    // Idle health check: last time we logged idle (rate-limited)
    this.lastIdleLogAt = null;

    // View Live Session (founder-only, ephemeral): wsEndpoint when viewSessionEnabled + remote-debugging
    this.debugWsEndpoint = null;
  }
  
  /**
   * Transition to a new state (with logging)
   */
  transitionTo(newState, reason = '') {
    const oldState = this.state;
    this.state = newState;
    this.lastEvent = newState;
    this.lastStateChangeAt = new Date();
    const ts = new Date().toISOString();

    debugLog(this.id, 'state_transition', { from: oldState, to: newState, reason: reason || undefined });
    console.log(`[${ts}] [${this.id}] State transition: ${oldState} -> ${newState}${reason ? ` (${reason})` : ''}`);

    if (newState === InstanceState.NEEDS_QR) {
      this.needsQrSince = new Date();
      this.lastQrAt = null;
      this.qrRecoveryAttempts = 0;
      this.nextQrRecoveryAt = null;
    }
    if (newState === InstanceState.STARTING_BROWSER || newState === InstanceState.CONNECTING || newState === InstanceState.NEEDS_QR) {
      systemMode.enterSyncing(this.id);
    }
    systemMode.recomputeFromInstances(() => Array.from(instances.values()));
    
    // Handle state-specific actions
    if (newState === InstanceState.READY) {
      this.lastReadyAt = new Date();
      this.lastActivityAt = new Date();
      this.restartAttempts = 0; // Reset on successful ready
      this.restartHistory = []; // Clear restart history
      this.connectingWatchdogRestartCount = 0;
      this.disconnectCooldownUntil = null;
      this.clearReadyWatchdog();
      this.clearConnectingWatchdog();
      this.clearDisconnectCooldownTimer();
      this.clearRateLimitWakeTimer();
      this.clearHealthCheck();
      startHealthCheck(this.id);
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
      this.clearHealthCheck();
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
    } else if (newState === InstanceState.NEEDS_QR || newState === InstanceState.ERROR || newState === InstanceState.RESTRICTED || newState === InstanceState.PAUSED || newState === InstanceState.FAILED_QR_TIMEOUT) {
      // Stop send loop on terminal / hold states
      stopSendLoop(this.id);
      if (newState !== InstanceState.PAUSED) {
        this.clearConnectingWatchdog();
        this.clearRateLimitWakeTimer();
        this.connectingWatchdogRestartCount = 0;
      }
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
   * Clear scheduled ensureReady after disconnect cooldown
   */
  clearDisconnectCooldownTimer() {
    if (this.disconnectCooldownTimer) {
      clearTimeout(this.disconnectCooldownTimer);
      this.disconnectCooldownTimer = null;
    }
  }

  /**
   * Clear scheduled ensureReady after restart rate limit PAUSED
   */
  clearRateLimitWakeTimer() {
    if (this.rateLimitWakeTimer) {
      clearTimeout(this.rateLimitWakeTimer);
      this.rateLimitWakeTimer = null;
    }
  }

  /**
   * Clear health check timer
   */
  clearHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Fallback: clear message poller (unread messages when message events fail)
   */
  clearMessageFallbackPoller() {
    if (this.messageFallbackPollTimer) {
      clearInterval(this.messageFallbackPollTimer);
      this.messageFallbackPollTimer = null;
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

// View session tokens: ephemeral, founder-only (testing only)
const viewTokens = new Map(); // token -> { instanceId, exp }

/** Restriction-like phrases in disconnect reason or page content */
const RESTRICTION_INDICATORS = ['restricted', '24 hours', '24h', 'logout', 'conflict', 'timeout', 'your account is restricted', 'account restricted'];

/**
 * Check if disconnect reason or text indicates WhatsApp restriction
 * @param {string} reasonOrText - disconnect reason or page content
 * @returns {boolean}
 */
function looksLikeRestriction(reasonOrText) {
  if (!reasonOrText || typeof reasonOrText !== 'string') return false;
  const lower = reasonOrText.toLowerCase();
  return RESTRICTION_INDICATORS.some(term => lower.includes(term));
}

/**
 * Ready watchdog: ready event not fired within timeout.
 * New behavior: log, pause 10min, retry ensureReady only if queue has pending messages.
 */
async function onReadyWatchdogTimeout(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance || instance.state === InstanceState.READY) return;

  const elapsedMs = instance.readyWatchdogStartAt ? Date.now() - instance.readyWatchdogStartAt.getTime() : 0;
  const pauseMin = config.readyTimeoutPauseMin || 10;
  debugLog(instanceId, 'ready_timeout', {
    elapsedMs,
    authenticatedAt: instance.authenticatedAt ? instance.authenticatedAt.toISOString() : null,
    state: instance.state,
  });
  console.error(`[${instanceId}] ready_timeout: ready event not fired after ${elapsedMs}ms - pausing ${pauseMin}min (no auto-restart)`);
  void forwardWebhook(instanceId, 'ready_timeout', {
    elapsedMs,
    authenticatedAt: instance.authenticatedAt ? instance.authenticatedAt.toISOString() : null,
    state: instance.state,
  }).catch(err => recordWebhookError(instanceId, err));

  instance.clearReadyWatchdog();
  instance.clearReadyPoll();
  instance.clearMessageFallbackPoller();
  instance.readyTimeoutPauseUntil = new Date(Date.now() + pauseMin * 60000);

  const pauseMs = pauseMin * 60000;
  setTimeout(() => {
    const inst = instances.get(instanceId);
    if (!inst || inst.state === InstanceState.READY) return;
    inst.readyTimeoutPauseUntil = null;
    if (inst.queue.length === 0) {
      console.log(`[${instanceId}] ready_timeout: pause expired, queue empty - skipping ensureReady (manual intervention preferred)`);
      return;
    }
    console.log(`[${instanceId}] ready_timeout: pause expired, ${inst.queue.length} queued - trying ensureReady`);
    Promise.resolve(ensureReady(instanceId)).catch(err => {
      console.error(`[${instanceId}] ready_timeout ensureReady failed:`, err.message);
    });
  }, pauseMs);
}

/** Idle log minimum interval (avoid spam for low-traffic instances) */
const IDLE_LOG_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Start periodic health check when instance is READY.
 * Warm mode: inactivity alone does NOT pause. We keep READY instances warm.
 * If idle > threshold: log (rate-limited) and optionally run keepalive (getState).
 * If keepalive fails: treat as real failure → PAUSED with disconnect-cooldown-like auto-wake.
 */
function startHealthCheck(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance || instance.state !== InstanceState.READY || instance.healthCheckTimer) return;

  const intervalMs = (config.healthCheckIntervalMin || 20) * 60000;
  const idleThresholdMin = config.zombieInactivityThresholdMin || 30;

  instance.healthCheckTimer = setInterval(async () => {
    if (!systemMode.shouldRunBackgroundTask('health_check')) return;
    const inst = instances.get(instanceId);
    if (!inst || inst.state !== InstanceState.READY) return;

    const last = inst.lastActivityAt?.getTime() || 0;
    const inactiveMin = (Date.now() - last) / 60000;

    if (inactiveMin > idleThresholdMin) {
      // Idle: do NOT pause. Log (rate-limited) and run keepalive check.
      const now = Date.now();
      const lastLog = inst.lastIdleLogAt?.getTime() || 0;
      if (now - lastLog >= IDLE_LOG_INTERVAL_MS) {
        inst.lastIdleLogAt = new Date();
        console.log(`[${instanceId}] [HealthCheck] idle ${Math.round(inactiveMin)}m, keeping READY (warm mode)`);
      }
      debugLog(instanceId, 'health_check_idle', { inactiveMin: Math.round(inactiveMin * 10) / 10 });

      // Soft keepalive: client.getState() (no messages sent)
      if (inst.client) {
        try {
          await inst.client.getState();
        } catch (err) {
          // Real failure: treat like disconnect, PAUSE with auto-wake
          console.warn(`[${instanceId}] [HealthCheck] keepalive failed: ${err?.message || err} - pausing with auto-wake`);
          inst.clearHealthCheck();
          const cooldownMs = config.minDisconnectCooldownMs;
          inst.disconnectCooldownUntil = new Date(Date.now() + cooldownMs);
          inst.transitionTo(InstanceState.PAUSED, `Health check keepalive failed: ${err?.message || err}`);
          inst.disconnectCooldownTimer = setTimeout(() => {
            inst.disconnectCooldownTimer = null;
            const i = instances.get(instanceId);
            if (!i || i.state === InstanceState.RESTRICTED) return;
            if (i.restrictedUntil && Date.now() < i.restrictedUntil.getTime()) return;
            if (i.checkRestartRateLimit()) {
              const extraMs = config.restartRateLimitExtraHours * 3600000;
              const windowMs = config.restartWindowMinutes * 60 * 1000;
              const pauseMs = windowMs + extraMs;
              const jitterMs = Math.floor(Math.random() * 31000);
              i.disconnectCooldownUntil = new Date(Date.now() + pauseMs);
              console.log(`[${instanceId}] Keepalive wake: rate limit hit - staying PAUSED, scheduling auto-wake in ${Math.round((pauseMs + jitterMs) / 60000)}min`);
              i.clearRateLimitWakeTimer();
              i.rateLimitWakeTimer = setTimeout(() => {
                i.rateLimitWakeTimer = null;
                const inst2 = instances.get(instanceId);
                if (!inst2 || inst2.state === InstanceState.RESTRICTED) return;
                console.log(`[${instanceId}] Rate limit wake (from keepalive): attempting ensureReady`);
                Promise.resolve(ensureReady(instanceId)).catch(e => {
                  console.error(`[${instanceId}] ensureReady after rate limit wake failed:`, e?.message);
                });
              }, pauseMs + jitterMs);
              return;
            }
            i.transitionTo(InstanceState.DISCONNECTED, 'keepalive wake');
            Promise.resolve(ensureReady(instanceId)).catch(e => {
              console.error(`[${instanceId}] ensureReady after keepalive wake failed:`, e?.message);
            });
          }, cooldownMs);
        }
      }
      return;
    }
    debugLog(instanceId, 'health_check', { inactiveMin: Math.round(inactiveMin * 10) / 10 });
  }, intervalMs);
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

/** Backoff sequence for QR recovery (seconds): 10s, 30s, 60s */
const QR_RECOVERY_BACKOFF_MS = [10000, 30000, 60000];

/**
 * Recover a stuck NEEDS_QR instance: soft (reload page), hard (destroy+recreate), or nuclear (logout+purge+recreate).
 * Increments qrRecoveryAttempts and sets nextQrRecoveryAt. Logs + Sentry.
 */
async function recoverNeedsQrInstance(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance || instance.state !== InstanceState.NEEDS_QR) return;

  const attempt = (instance.qrRecoveryAttempts || 0) + 1;
  const maxAttempts = config.qrMaxRecoveryAttempts || 3;
  if (attempt > maxAttempts) return;

  const backoffArr = config.qrRecoveryBackoffMs || QR_RECOVERY_BACKOFF_MS;
  const backoffMs = backoffArr[Math.min(attempt - 1, backoffArr.length - 1)] ?? backoffArr[backoffArr.length - 1];

  const shop = (instanceId || '').replace(/^WASP-/, '').slice(0, 32);
  sentry.captureMessage('QR recovery attempt', 'info', {
    instanceId,
    shop,
    attempt,
    maxAttempts: maxAttempts,
  });
  console.log(`[${instanceId}] QR recovery attempt ${attempt}/${maxAttempts} (backoff after: ${backoffMs}ms)`);

  instance.qrRecoveryAttempts = attempt;
  instance.nextQrRecoveryAt = new Date(Date.now() + backoffMs);

  try {
    if (attempt === 1) {
      // Soft: reload WA page to re-trigger QR
      if (instance.client?.pupPage && !instance.client.pupPage.isClosed?.()) {
        await instance.client.pupPage.reload({ waitUntil: 'domcontentloaded' }).catch((err) => {
          console.warn(`[${instanceId}] QR recovery soft (reload) failed:`, err.message);
        });
      } else {
        console.warn(`[${instanceId}] QR recovery soft skipped (no page)`);
      }
    } else if (attempt === 2) {
      // Hard: destroy client and recreate + initialize (no wait for ready)
      instance.clearReadyWatchdog();
      instance.clearReadyPoll();
      instance.clearMessageFallbackPoller();
      instance.clearConnectingWatchdog();
      if (instance.client) {
        try {
          await instance.client.destroy().catch(() => {});
        } catch (_) {}
        instance.client = null;
        instance.debugWsEndpoint = null;
      }
      const client = await createClient(instanceId, instance.name);
      instance.client = client;
      setupEventListeners(instanceId, client);
      startPopupDismisser(client, `[${instanceId}]`);
      instance.transitionTo(InstanceState.CONNECTING, 'QR recovery hard restart');
      instance.startConnectingWatchdog();
      await client.initialize().catch((err) => {
        console.error(`[${instanceId}] QR recovery hard initialize error:`, err.message);
      });
      require('./utils/syncLiteInterception').enableSyncLiteInterception(client, instanceId);
    } else {
      // Nuclear: logout (best-effort), destroy, purge auth, recreate + initialize
      instance.clearReadyWatchdog();
      instance.clearReadyPoll();
      instance.clearMessageFallbackPoller();
      instance.clearConnectingWatchdog();
      if (instance.client) {
        try {
          await instance.client.logout();
        } catch (_) {}
        try {
          await instance.client.destroy().catch(() => {});
        } catch (_) {}
        instance.client = null;
        instance.debugWsEndpoint = null;
      }
      await purgeLocalAuthSession(instanceId);
      const client = await createClient(instanceId, instance.name);
      instance.client = client;
      setupEventListeners(instanceId, client);
      startPopupDismisser(client, `[${instanceId}]`);
      instance.transitionTo(InstanceState.CONNECTING, 'QR recovery nuclear (auth purged)');
      instance.startConnectingWatchdog();
      await client.initialize().catch((err) => {
        console.error(`[${instanceId}] QR recovery nuclear initialize error:`, err.message);
      });
      require('./utils/syncLiteInterception').enableSyncLiteInterception(client, instanceId);
    }
  } catch (err) {
    console.error(`[${instanceId}] QR recovery attempt ${attempt} failed:`, err.message);
    sentry.captureException(err, { tags: { instanceId, shop, attempt: String(attempt) } });
  }
}

let needsQrWatchdogTimer = null;

/**
 * NEEDS_QR watchdog: detect stuck/stale QR and run recovery or mark FAILED_QR_TIMEOUT.
 * Runs every QR_RECOVERY_WATCHDOG_INTERVAL_MS.
 */
function runNeedsQrWatchdog() {
  if (!systemMode.shouldRunBackgroundTask('needs_qr_watchdog')) return;
  const now = Date.now();
  const staleMs = config.qrStaleMs || 90000;
  const ttlMs = config.qrTtlMs || 300000;
  const maxAttempts = config.qrMaxRecoveryAttempts || 3;

  for (const instance of instances.values()) {
    if (instance.state !== InstanceState.NEEDS_QR) continue;

    const needsQrSince = instance.needsQrSince ? new Date(instance.needsQrSince).getTime() : 0;
    const lastQrAt = instance.lastQrAt ? new Date(instance.lastQrAt).getTime() : 0;
    const ageMs = needsQrSince > 0 ? now - needsQrSince : 0;
    const sinceLastQrMs = lastQrAt > 0 ? now - lastQrAt : Infinity;

    const isStale = (lastQrAt === 0 || sinceLastQrMs > staleMs) || ageMs > ttlMs;
    if (!isStale) continue;

    const attempts = instance.qrRecoveryAttempts || 0;
    const nextAt = instance.nextQrRecoveryAt ? new Date(instance.nextQrRecoveryAt).getTime() : 0;
    const mayRecover = attempts < maxAttempts && (nextAt === 0 || now >= nextAt);

    if (mayRecover) {
      void recoverNeedsQrInstance(instance.id);
    } else if (attempts >= maxAttempts) {
      instance.clearConnectingWatchdog();
      instance.lastError = `NEEDS_QR timeout: no progress after ${maxAttempts} recovery attempts (age ${Math.round(ageMs / 1000)}s)`;
      instance.lastErrorAt = new Date();
      console.error(`[${instance.id}] NEEDS_QR timeout: marking FAILED_QR_TIMEOUT (attempts=${attempts}, age=${Math.round(ageMs / 1000)}s)`);
      instance.transitionTo(InstanceState.FAILED_QR_TIMEOUT, instance.lastError);
      sentry.captureMessage('NEEDS_QR timeout', 'warning', {
        instanceId: instance.id,
        attempts,
        ageSeconds: Math.round(ageMs / 1000),
      });
    }
  }
}

/**
 * Start the NEEDS_QR watchdog interval. Idempotent.
 */
function startNeedsQrWatchdog() {
  if (needsQrWatchdogTimer) return;
  const intervalMs = config.qrRecoveryWatchdogIntervalMs || 10000;
  needsQrWatchdogTimer = setInterval(runNeedsQrWatchdog, intervalMs);
  console.log(`[NeedsQrWatchdog] Started (interval=${intervalMs}ms)`);
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
 * Serialize message for webhook payload
 */
function serializeMessage(message) {
  const from = extractPhoneNumber(message.from);
  const body = message.body || message.text || '';
  const msgId = message.id?._serialized || message.id || null;
  return {
    from,
    body,
    text: body,
    type: message.type || 'text',
    timestamp: message.timestamp,
    id: msgId,
  };
}

/**
 * Dedupe key for incoming messages (LRU cache)
 */
function getMessageDedupeKey(message) {
  const msgId = message.id?._serialized || message.id;
  if (msgId) return String(msgId);
  const from = extractPhoneNumber(message.from);
  const to = extractPhoneNumber(message.to || message.id?.remote || '');
  const ts = message.timestamp || 0;
  const body = (message.body || message.text || '').substring(0, 100);
  const hash = crypto.createHash('md5').update(body).digest('hex').substring(0, 8);
  return `${from}_${to}_${ts}_${hash}`;
}

const DEDUPE_MAX_SIZE = 2000;
const FALLBACK_MAX_MESSAGES_PER_TICK = 50;
const FALLBACK_MAX_CHATS_PER_TICK = 10;

/**
 * Process incoming message: dedupe, log, forward webhook.
 * Called by both event listeners and fallback poller. Never blocks.
 */
function processIncomingMessage(instanceId, message) {
  const instance = instances.get(instanceId);
  if (!instance || !instance.webhookUrl) return;
  instance.lastActivityAt = new Date();
  const fromMe = message.fromMe === true || (message.id && message.id.fromMe === true);
  if (fromMe) return; // Ignore outgoing for incoming webhooks

  const key = getMessageDedupeKey(message);
  const now = Date.now();
  if (instance.recentMessageIds.has(key)) return;
  instance.recentMessageIds.set(key, now);
  if (instance.recentMessageIds.size > DEDUPE_MAX_SIZE) {
    // Evict oldest (first inserted in Map)
    const first = instance.recentMessageIds.keys().next().value;
    if (first) instance.recentMessageIds.delete(first);
  }

  instance.lastIncomingMessageAt = new Date();
  const from = extractPhoneNumber(message.from);
  const msgId = message.id?._serialized || message.id || null;
  const msgType = message.type || 'text';
  console.log(`[${instanceId}] incoming message id=${msgId || 'n/a'} from=${from} type=${msgType}`);

  const messageData = { message: serializeMessage(message) };
  void forwardWebhook(instanceId, 'message', messageData).catch(err => recordWebhookError(instanceId, err));

  // Selective read receipt: ~40% probability for order-related incoming, 2-6s reading delay
  const instanceRef = instances.get(instanceId);
  if (instanceRef?.client) {
    void markSeenOnRelevantIncoming(instanceRef.client, message, `[${instanceId}]`).catch(() => {});
  }
}

/**
 * Perform the actual webhook HTTP POST (shared by forwardWebhook and deliverBufferedInbound).
 */
async function deliverWebhookPost(instanceId, event, data, webhookUrl) {
  const instance = instances.get(instanceId);
  const payload = { event, instanceId, data };
  const headers = { 'Content-Type': 'application/json' };
  if (config.webhookSecret) {
    const hmac = crypto.createHmac('sha256', config.webhookSecret);
    hmac.update(JSON.stringify(payload));
    headers['x-wa-hub-signature'] = hmac.digest('hex');
  }
  if (config.webhookProtectionBypass) {
    headers['x-vercel-protection-bypass'] = config.webhookProtectionBypass;
  }
  if (config.webhookAuthToken) {
    headers['Authorization'] = `Bearer ${config.webhookAuthToken}`;
  }
  await axios.post(webhookUrl, payload, { headers });
  if (instance) {
    instance.lastWebhookEvent = event;
    instance.lastWebhookStatus = 'ok';
    instance.lastWebhookAt = new Date();
    instance.lastWebhookError = null;
  }
  console.log(`[${new Date().toISOString()}] [${instanceId}] Webhook forwarded: ${event}`);
}

/**
 * Forward webhook event (never blocks state transitions - failures are logged only).
 * During SYNCING, message and vote_update are buffered; others are sent immediately.
 */
async function forwardWebhook(instanceId, event, data) {
  const instance = instances.get(instanceId);
  if (!instance || !instance.webhookUrl) return;

  const alwaysSend = ['authenticated', 'ready', 'ready_timeout'];
  const shouldSend = alwaysSend.includes(event) ||
    instance.webhookEvents.length === 0 ||
    instance.webhookEvents.includes(event);
  if (!shouldSend) return;

  if (systemMode.getSystemMode().mode === 'syncing' && (event === 'message' || event === 'vote_update')) {
    const minimalData = event === 'message' && data?.message
      ? { message: { ...data.message, body: (data.message.body || '').substring(0, 500) } }
      : data;
    inboundBuffer.push({ instanceId, eventType: event, data: minimalData, webhookUrl: instance.webhookUrl });
    return;
  }

  try {
    await deliverWebhookPost(instanceId, event, data, instance.webhookUrl);
  } catch (error) {
    instance.lastWebhookEvent = event;
    instance.lastWebhookStatus = 'failed';
    instance.lastWebhookAt = new Date();
    instance.lastWebhookError = error.message;
    recordWebhookError(instanceId, error);
  }
}

/**
 * Deliver a single buffered inbound event (used when flushing after SYNCING).
 */
async function deliverBufferedInbound(entry) {
  await deliverWebhookPost(entry.instanceId, entry.eventType, entry.data, entry.webhookUrl);
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
  const { getPuppeteerLaunchOptions, getChosenExecutablePath, logLaunchContext } = require('./browser/launchOptions');

  const puppeteerOpts = getPuppeteerLaunchOptions(instanceId);
  const puppeteerArgs = [...(puppeteerOpts.args || []), '--remote-debugging-port=0'];

  const puppeteerConfig = {
    headless: puppeteerOpts.headless !== false,
    args: puppeteerArgs,
    timeout: puppeteerOpts.timeout,
    dumpio: puppeteerOpts.dumpio || false,
  };

  const { path: chosenPath, exists: chosenExists } = getChosenExecutablePath();
  if (chosenPath) {
    puppeteerConfig.executablePath = chosenPath;
    console.log(`[${instanceId}] [Chromium] chosen executable=${chosenPath} exists=${chosenExists}`);
  } else {
    console.log(`[${instanceId}] [Chromium] no system executable found, using Puppeteer bundled`);
  }

  logLaunchContext(instanceId, {
    executablePath: puppeteerConfig.executablePath || 'bundled',
    executablePathExists: chosenPath ? chosenExists : undefined,
    headless: puppeteerConfig.headless,
    argsCount: puppeteerArgs.length,
    args: puppeteerArgs,
  });

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

  sentry.addBreadcrumb({ category: 'whatsapp', message: 'client_init', level: 'info', data: { instanceId } });

  const guard = () => !instances.has(instanceId);

  // QR code event - state transition FIRST, webhook fire-and-forget (never block lifecycle)
  client.on('qr', (qr) => {
    if (guard()) return;
    // Ignore spurious QR when already READY (WhatsApp Web can emit QR briefly during refresh/reconnect)
    if (instance.state === InstanceState.READY) {
      console.log(`[${instanceId}] Event: qr (ignored, already READY)`);
      return;
    }
    const ts = new Date().toISOString();
    instance.lastLifecycleEvent = 'qr';
    instance.lastLifecycleEventAt = new Date();
    debugLog(instanceId, 'qr', {});
    console.log(`[${ts}] [${instanceId}] Event: qr`);
    sentry.addBreadcrumb({ category: 'whatsapp', message: 'qr_generated', level: 'info', data: { instanceId } });
    instance.qrReceivedDuringRestart = true;
    instance.readyWatchdogRestarted = false;
    instance.startReadyWatchdog();
    instance.clearConnectingWatchdog();
    instance.connectingWatchdogRestartCount = 0; // Progress: got QR
    instance.transitionTo(InstanceState.NEEDS_QR, 'QR code received');
    instance.lastQrAt = new Date();
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
      if (client.pupBrowser) {
        try {
          const ws = client.pupBrowser.wsEndpoint?.();
          if (ws) instance.debugWsEndpoint = ws;
        } catch (_) { /* ignore */ }
      }
      void forwardWebhook(instanceId, 'ready', { status: 'ready' }).catch(err =>
        recordWebhookError(instanceId, err)
      );
      startSendLoop(instanceId);
      startMessageFallbackPoller();
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

  // Fallback: poll unread messages when message events fail (whatsapp-web.js v1.34 bug)
  async function runMessageFallbackPoll() {
    if (!systemMode.shouldRunBackgroundTask('message_fallback_poll')) return;
    if (!instances.has(instanceId)) return;
    const inst = instances.get(instanceId);
    if (!inst || inst.state !== InstanceState.READY || !inst.client) return;
    inst.fallbackPollRuns = (inst.fallbackPollRuns || 0) + 1;
    inst.lastFallbackPollAt = new Date();
    try {
      const chats = await client.getChats();
      const unreadChats = chats.filter(c => (c.unreadCount || 0) > 0).slice(0, FALLBACK_MAX_CHATS_PER_TICK);
      let processed = 0;
      for (const chat of unreadChats) {
        if (processed >= FALLBACK_MAX_MESSAGES_PER_TICK) break;
        try {
          const messages = await chat.fetchMessages({ limit: 5 });
          const incoming = messages.filter(m => !m.fromMe && !(m.id && m.id.fromMe));
          for (const msg of incoming) {
            if (processed >= FALLBACK_MAX_MESSAGES_PER_TICK) break;
            processIncomingMessage(instanceId, msg);
            processed++;
          }
        } catch (chatErr) {
          inst.fallbackPollLastError = chatErr.message;
        }
      }
      if (processed > 0) inst.fallbackPollLastError = null;
    } catch (err) {
      inst.fallbackPollLastError = err.message;
      const msg = err && (err.message || String(err)) || '';
      const isContextDestroyed = msg.includes('Execution context was destroyed') || msg.includes('Protocol error') || err.name === 'ProtocolError' || msg.includes('getChat');
      if (isContextDestroyed) {
        inst.clearMessageFallbackPoller();
        if (inst.state === InstanceState.READY) {
          inst.transitionTo(InstanceState.DISCONNECTED, 'Context destroyed during fallback poll');
          Promise.resolve(ensureReady(instanceId)).catch(e => console.error(`[${instanceId}] Reconnection failed:`, e?.message));
        }
      }
    }
  }

  function startMessageFallbackPoller() {
    instance.clearMessageFallbackPoller();
    if (!config.messageFallbackPollEnabled) return;
    const intervalMs = config.messageFallbackPollIntervalMs;
    console.log(`[${instanceId}] fallback poller started @ ${intervalMs}ms`);
    instance.messageFallbackPollTimer = setInterval(() => {
      void runMessageFallbackPoll().catch(() => {});
    }, intervalMs);
  }

  // Authenticated event - transition from NEEDS_QR to CONNECTING (syncing) until ready
  client.on('authenticated', () => {
    if (guard()) return;
    sentry.addBreadcrumb({ category: 'whatsapp', message: 'authenticated', level: 'info', data: { instanceId } });
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
    sentry.addBreadcrumb({ category: 'whatsapp', message: 'ready', level: 'info', data: { instanceId } });
    markReady('event');
  });
  
  // Auth failure - state transition FIRST, webhook fire-and-forget
  client.on('auth_failure', (msg) => {
    if (guard()) return;
    sentry.addBreadcrumb({ category: 'whatsapp', message: 'auth_failure', level: 'warning', data: { instanceId } });
    sentry.captureMessage('WhatsApp auth_failure', 'warning', { instanceId, reason: String(msg).slice(0, 200) });
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
    instance.clearMessageFallbackPoller();
    instance.clearConnectingWatchdog();
    instance.transitionTo(InstanceState.NEEDS_QR, `Auth failure: ${msg}`);
    void forwardWebhook(instanceId, 'auth_failure', { message: msg }).catch(err => recordWebhookError(instanceId, err));
  });
  
  // Disconnected - aggressive cooldown, restriction detection, no immediate reconnect
  client.on('disconnected', (reason) => {
    if (guard()) return;
    const reasonStr = reason || 'unknown';
    sentry.addBreadcrumb({ category: 'whatsapp', message: 'disconnected', level: 'warning', data: { instanceId } });
    sentry.captureMessage('WhatsApp disconnected', 'warning', { instanceId, reason: reasonStr.slice(0, 200) });
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
    instance.clearMessageFallbackPoller();
    instance.clearDisconnectCooldownTimer();
    stopSendLoop(instanceId);

    // 1. Restriction detection: force 72h full pause, no reconnect
    if (looksLikeRestriction(reasonStr)) {
      const hours = config.extendedRestrictionCooldownHours;
      instance.restrictedUntil = new Date(Date.now() + hours * 3600000);
      instance.transitionTo(InstanceState.RESTRICTED, `Restriction detected: ${reasonStr}`);
      const msg = `24h+ hold to avoid escalation. No reconnect for ${hours}h. Manual intervention required.`;
      console.error(`[${instanceId}] RESTRICTED: ${msg}`);
      void forwardWebhook(instanceId, 'restricted', {
        reason: reasonStr,
        restrictedUntil: instance.restrictedUntil.toISOString(),
        message: msg,
      }).catch(err => recordWebhookError(instanceId, err));
      void forwardWebhook(instanceId, 'disconnected', { reason: reasonStr }).catch(err => recordWebhookError(instanceId, err));
      return;
    }

    const terminalReasons = ['LOGOUT', 'UNPAIRED', 'CONFLICT', 'TIMEOUT'];
    const reasonUpper = reasonStr.toUpperCase();
    const isTerminal = terminalReasons.some(term => reasonUpper.includes(term));

    if (isTerminal) {
      instance.transitionTo(InstanceState.NEEDS_QR, `Terminal disconnect: ${reasonStr}`);
      void forwardWebhook(instanceId, 'disconnected', { reason: reasonStr }).catch(err => recordWebhookError(instanceId, err));
      return;
    }

    // 2. Non-terminal: aggressive cooldown - pause ALL sends + delay reconnect
    if (config.disableAutoReconnect) {
      instance.transitionTo(InstanceState.DISCONNECTED, reasonStr);
      console.log(`[${instanceId}] Auto-reconnect disabled (DISABLE_AUTO_RECONNECT=true)`);
      return;
    }
    const cooldownMs = config.minDisconnectCooldownMs;
    instance.disconnectCooldownUntil = new Date(Date.now() + cooldownMs);
    instance.transitionTo(InstanceState.PAUSED, `Disconnect cooldown: ${reasonStr}`);
    console.log(`[${instanceId}] Disconnect cooldown: pausing ${cooldownMs / 60000}min before reconnect attempt`);

    instance.disconnectCooldownTimer = setTimeout(() => {
      instance.disconnectCooldownTimer = null;
      const inst = instances.get(instanceId);
      if (!inst || inst.state === InstanceState.RESTRICTED) return;
      if (inst.restrictedUntil && Date.now() < inst.restrictedUntil.getTime()) return;
      if (inst.checkRestartRateLimit()) {
        const extraMs = config.restartRateLimitExtraHours * 3600000;
        const windowMs = config.restartWindowMinutes * 60 * 1000;
        const pauseMs = windowMs + extraMs;
        const jitterMs = Math.floor(Math.random() * 31000);
        inst.disconnectCooldownUntil = new Date(Date.now() + pauseMs);
        console.log(`[${instanceId}] Cooldown expired but rate limit hit - staying PAUSED, scheduling auto-wake in ${Math.round((pauseMs + jitterMs) / 60000)}min`);
        inst.clearRateLimitWakeTimer();
        inst.rateLimitWakeTimer = setTimeout(() => {
          inst.rateLimitWakeTimer = null;
          const i = instances.get(instanceId);
          if (!i || i.state === InstanceState.RESTRICTED) return;
          console.log(`[${instanceId}] Rate limit wake (from disconnect cooldown): attempting ensureReady`);
          Promise.resolve(ensureReady(instanceId)).catch(err => {
            console.error(`[${instanceId}] ensureReady after rate limit wake failed:`, err?.message);
          });
        }, pauseMs + jitterMs);
        return;
      }
      inst.transitionTo(InstanceState.DISCONNECTED, reasonStr);
      Promise.resolve(ensureReady(instanceId)).catch(err => {
        console.error(`[${instanceId}] Auto-reconnect after cooldown failed:`, err);
      });
    }, cooldownMs);
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
  // Listen to BOTH 'message' and 'message_create' (whatsapp-web.js v1.34: message can be unreliable; message_create fires for both incoming/outgoing)
  // Do NOT gate listener attachment by webhook.events - always attach both for reliability
  const onIncomingMessage = (message) => {
    if (guard()) return;
    processIncomingMessage(instanceId, message);
  };
  const onMessageCreate = (message) => {
    if (guard()) return;
    // message_create fires for outgoing too - ignore fromMe for incoming webhooks
    if (message.fromMe === true || (message.id && message.id.fromMe === true)) return;
    processIncomingMessage(instanceId, message);
  };
  client.on('message', onIncomingMessage);
  client.on('message_create', onMessageCreate);
  instance.listenersAttached = true;
  console.log(`[${instanceId}] listeners attached: message,message_create`);

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
  if (instance.state === InstanceState.NEEDS_QR || instance.state === InstanceState.ERROR || instance.state === InstanceState.RESTRICTED || instance.state === InstanceState.FAILED_QR_TIMEOUT) {
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
  instance.clearMessageFallbackPoller();
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
    
    // Auto-dismiss popup when page reloads (runs in parallel with initialize)
    startPopupDismisser(instance.client, `[${instanceId}]`);
    
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
  
  sentry.addBreadcrumb({ category: 'whatsapp', message: 'browser_restart', level: 'info', data: { instanceId } });
  console.log(`[${instanceId}] Starting hard restart...`);
  instance.clearReadyWatchdog();
  instance.clearReadyPoll();
  instance.clearMessageFallbackPoller();
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
    instance.debugWsEndpoint = null;
  }
  
  // Create new client
  const client = await createClient(instanceId, instance.name);
  instance.client = client;
  
  // Setup event listeners
  setupEventListeners(instanceId, client);
  
  // Auto-dismiss "A fresh look for WhatsApp Web" popup
  startPopupDismisser(client, `[${instanceId}]`);
  
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
 * Uses exponential backoff, rate limit → PAUSED, no reconnect when RESTRICTED.
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
  if (instance.state === InstanceState.ERROR || instance.state === InstanceState.FAILED_QR_TIMEOUT) {
    throw new Error(`Instance ${instanceId} is in ${instance.state} state. Check logs.`);
  }
  if (instance.state === InstanceState.RESTRICTED) {
    const until = instance.restrictedUntil?.toISOString() || 'unknown';
    throw new Error(`Instance ${instanceId} is RESTRICTED until ${until}. No reconnect.`);
  }

  // If ready, return immediately
  if (instance.state === InstanceState.READY) {
    return;
  }

  // PAUSED: only proceed if cooldowns expired
  if (instance.state === InstanceState.PAUSED) {
    const now = Date.now();
    if (instance.restrictedUntil && now < instance.restrictedUntil.getTime()) {
      throw new Error(`Instance ${instanceId} in restriction cooldown until ${instance.restrictedUntil.toISOString()}`);
    }
    if (instance.disconnectCooldownUntil && now < instance.disconnectCooldownUntil.getTime()) {
      throw new Error(`Instance ${instanceId} in disconnect cooldown until ${instance.disconnectCooldownUntil.toISOString()}`);
    }
  }

  // Rate limit: transition to PAUSED for full window + extra, schedule auto-wake
  if (instance.checkRestartRateLimit()) {
    const extraMs = config.restartRateLimitExtraHours * 3600000;
    const windowMs = config.restartWindowMinutes * 60 * 1000;
    const pauseMs = windowMs + extraMs;
    const jitterMs = Math.floor(Math.random() * 31000); // 0–30s
    instance.disconnectCooldownUntil = new Date(Date.now() + pauseMs);
    instance.transitionTo(InstanceState.PAUSED, 'Restart rate limit exceeded');
    const msg = `Rate limit: ${instance.restartHistory.length} restarts in ${config.restartWindowMinutes}min window. Paused for ${config.restartWindowMinutes}min + ${config.restartRateLimitExtraHours}h. Auto-wake in ${Math.round((pauseMs + jitterMs) / 60000)}min.`;
    console.error(`[${instanceId}] ${msg}`);

    instance.clearRateLimitWakeTimer();
    instance.rateLimitWakeTimer = setTimeout(() => {
      instance.rateLimitWakeTimer = null;
      const inst = instances.get(instanceId);
      if (!inst || inst.state === InstanceState.RESTRICTED) return;
      console.log(`[${instanceId}] Rate limit wake: attempting ensureReady`);
      Promise.resolve(ensureReady(instanceId)).catch(err => {
        console.error(`[${instanceId}] Rate limit wake ensureReady failed:`, err?.message);
      });
    }, pauseMs + jitterMs);

    throw new Error(`Instance ${instanceId}: ${msg}`);
  }

  // Acquire lock (mutex)
  await instance.acquireLock();

  try {
    if (instance.state === InstanceState.READY) return;
    if (instance.state === InstanceState.RESTRICTED) return;

    instance.recordRestartAttempt();
    const countInWindow = instance.restartHistory.length;
    const seq = config.restartBackoffSequenceMs || [config.restartBackoffMs];
    const backoffMs = seq[Math.min(countInWindow - 1, seq.length - 1)] ?? seq[seq.length - 1];
    const backoffMin = Math.round(backoffMs / 60000);
    console.log(`[${instanceId}] ensureReady: count=${countInWindow} in window, backoff=${backoffMin}min, attempt=soft`);

    // Attempt #1: Soft restart
    try {
      await new Promise(resolve => setTimeout(resolve, backoffMs));
      await softRestartAndWaitReady(instanceId);
      console.log(`[${instanceId}] ensureReady: soft restart succeeded`);
      return;
    } catch (softError) {
      const backoff2 = seq[Math.min(countInWindow, seq.length - 1)] ?? seq[seq.length - 1];
      const backoff2Min = Math.round(backoff2 / 60000);
      console.log(`[${instanceId}] ensureReady: soft failed, backoff=${backoff2Min}min, attempt=hard`);
      await new Promise(resolve => setTimeout(resolve, backoff2));
    }

    // Attempt #2: Hard restart
    try {
      await hardRestartAndWaitReady(instanceId);
      console.log(`[${instanceId}] ensureReady: hard restart succeeded`);
      return;
    } catch (hardError) {
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
    if (instance.state === InstanceState.PAUSED || instance.state === InstanceState.RESTRICTED || instance.state === InstanceState.FAILED_QR_TIMEOUT) {
      return false; // Defer - cooldown/restriction, no ensureReady (manual intervention preferred)
    }
    if (instance.state !== InstanceState.NEEDS_QR && instance.state !== InstanceState.ERROR && instance.state !== InstanceState.FAILED_QR_TIMEOUT) {
      console.log(`[${instanceId}] Instance not READY (state: ${instance.state}), triggering ensureReady to reconnect`);
      Promise.resolve(ensureReady(instanceId)).catch(err => {
        console.error(`[${instanceId}] ensureReady failed:`, err);
      });
    } else {
      console.log(`[${instanceId}] Cannot process item - instance is in terminal state (${instance.state})`);
    }
    return false; // Cannot process now
  }
  
  // Send the message/poll with optional typing indicator (custom span for tracing)
  const toHash = hashForBreadcrumb(item.payload.chatId);
  sentry.addBreadcrumb({
    category: 'send',
    message: 'send_attempt',
    level: 'info',
    data: { instanceId, toHash, type: item.type },
  });

  return await sentry.startSpan(
    { op: 'whatsapp.send', name: `send_${item.type}` },
    (span) => {
      span.setAttribute('instance_id', instanceId);
      span.setAttribute('to_hash', toHash);
      span.setAttribute('type', item.type);
      return (async () => {
        try {
          let sentMessage;

          const shouldApplyTyping = instance.state === InstanceState.READY &&
                                    instance.typingIndicatorEnabled &&
                                    item.uxTyping !== false;

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
            sentMessage = await sendFn();
          }

          const messageId = sentMessage?.id?._serialized || sentMessage?.id || null;
          await idempotencyStore.markSent(item.idempotencyKey, messageId);
          instance.recordSend();
          instance.lastActivityAt = new Date();

          span.setAttribute('outcome', 'success');
          sentry.addBreadcrumb({
            category: 'send',
            message: 'send_success',
            level: 'info',
            data: { instanceId, toHash, type: item.type },
          });

          void markSeenAfterSend(instance.client, item.payload.chatId, `[${instanceId}]`).catch(() => {});

          console.log(`[${instanceId}] ✓ Sent ${item.type} (idempotency: ${item.idempotencyKey.substring(0, 20)}..., messageId: ${messageId})`);
          return true;
        } catch (error) {
          item.attemptCount++;
          const errorMsg = error.message || String(error);
          item.lastError = errorMsg;
          instance.recordFailure();

          span.setAttribute('outcome', 'error');
          span.setAttribute('error_name', error.name || 'Error');
          sentry.addBreadcrumb({
            category: 'send',
            message: 'send_fail',
            level: 'error',
            data: { instanceId, toHash, type: item.type, attempt: item.attemptCount },
          });
          sentry.withScope((scope) => {
            scope.setFingerprint(['send_message', error.name || 'Error']);
            sentry.captureException(error, { instanceId, toHash, type: item.type, attempt: item.attemptCount });
          });

          const isDisconnectError = errorMsg.includes('Session closed') ||
                                    errorMsg.includes('disconnected') ||
                                    errorMsg.includes('null') ||
                                    errorMsg.includes('evaluate') ||
                                    errorMsg.includes('Execution context was destroyed') ||
                                    errorMsg.includes('Protocol error') ||
                                    (error.name === 'ProtocolError') ||
                                    errorMsg.includes('Failed to launch') ||
                                    errorMsg.includes('getChat') ||
                                    errorMsg.includes('Cannot read properties of undefined');

          if (isDisconnectError) {
            console.error(`[${instanceId}] ✗ Disconnect error during send: ${errorMsg}`);
            instance.transitionTo(InstanceState.DISCONNECTED, 'Disconnected during send');

            const backoffMs = Math.min(
              config.retryBaseBackoffMs * Math.pow(2, item.attemptCount - 1),
              config.retryMaxBackoffMs
            );
            item.nextAttemptAt = now + backoffMs;

            if (instance.state !== InstanceState.NEEDS_QR) {
              Promise.resolve(ensureReady(instanceId)).catch(err => {
                console.error(`[${instanceId}] Reconnection failed:`, err);
              });
            }

            return false;
          }

          const backoffMs = Math.min(
            config.retryBaseBackoffMs * Math.pow(2, item.attemptCount - 1),
            config.retryMaxBackoffMs
          );
          item.nextAttemptAt = now + backoffMs;

          console.error(`[${instanceId}] ✗ Send failed (attempt ${item.attemptCount}): ${errorMsg}. Retry at ${new Date(item.nextAttemptAt).toISOString()}`);

          if (item.attemptCount >= 5) {
            await idempotencyStore.markFailed(item.idempotencyKey, errorMsg);
          }

          return false;
        }
      })();
    }
  );
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
      // Create client (builds Client; launch happens in initialize())
      client = await createClient(instanceId, name);
      instance.client = client;

      setupEventListeners(instanceId, client);
      startPopupDismisser(client, `[${instanceId}]`);

      if (attempt > 1) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      }

      instance.transitionTo(InstanceState.STARTING_BROWSER, `launching browser (attempt ${attempt}/${maxAttempts})`);
      console.log(`[${instanceId}] Initializing client (attempt ${attempt}/${maxAttempts})...`);

      await client.initialize();

      instance.transitionTo(InstanceState.CONNECTING, `initializing (attempt ${attempt}/${maxAttempts})`);
      const { enableSyncLiteInterception } = require('./utils/syncLiteInterception');
      enableSyncLiteInterception(client, instanceId);

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
      const { buildLaunchFailureMessage, logLaunchFailure } = require('./browser/launchOptions');
      const launchErrorMsg = buildLaunchFailureMessage(error, instanceId);
      instance.lastError = launchErrorMsg;
      instance.lastErrorAt = new Date();
      instance.lastErrorStack = error.stack;
      logLaunchFailure(instanceId, error, launchErrorMsg);
      console.error(`[${instanceId}] Initialization attempt ${attempt}/${maxAttempts} failed:`, error.message);

      if (client) {
        try {
          if (client.pupPage) client.pupPage.removeAllListeners();
          if (client.pupBrowser) await client.pupBrowser.close().catch(() => {});
        } catch (cleanupError) {
          console.warn(`[${instanceId}] Error during cleanup:`, cleanupError.message);
        }
        instance.client = null;
      }

      if (attempt === maxAttempts) {
        // Session logged out (WhatsApp redirected to post_logout) → purge session and allow retry to get fresh QR.
        // Only use the actual error.message (not the Chromium log tail in launchErrorMsg) so we don't purge based on
        // stale log file content that might mention post_logout from a previous run.
        const msg = (error && (error.message || String(error))) || '';
        const isSessionLoggedOut =
          msg.includes('Execution context was destroyed') &&
          (msg.includes('because of a navigation') || msg.includes('post_logout'));
        if (isSessionLoggedOut) {
          console.warn(`[${instanceId}] Session logged out (post_logout/navigation). Purging session and re-queuing for fresh QR.`);
          try {
            await purgeLocalAuthSession(instanceId);
          } catch (purgeErr) {
            console.warn(`[${instanceId}] Purge session failed:`, purgeErr.message);
          }
          instances.delete(instanceId);
          systemMode.recomputeFromInstances(() => getAllInstances());
          throw new Error(`Session logged out; purged session. Retry will show QR. Original: ${error.message}`);
        }
        instance.transitionTo(InstanceState.ERROR, launchErrorMsg);
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

const LAUNCHPAD_POLL_MS = 5000;
const LAUNCHPAD_MAX_ATTEMPTS = 2;

/**
 * Create instance via launchpad VM: start VM, POST /onboard on launchpad, wait for ready
 * (blocking), then download zip (extract session dir to authBaseDir), merge instances.json,
 * stop VM, and resume locally with createInstance().
 * Uses config.useLaunchpadForOnboarding; requires GCP_PROJECT_ID, GCS_BUCKET_NAME, LAUNCHPAD_INTERNAL_SECRET.
 */
async function createInstanceViaLaunchpad(instanceId, name, webhookConfig) {
  const gcpManager = require('./gcp-manager');
  for (let attempt = 1; attempt <= LAUNCHPAD_MAX_ATTEMPTS; attempt++) {
    try {
      sentry.addBreadcrumb({ category: 'launchpad', message: 'Starting launchpad VM', level: 'info', data: { attempt } });
      // Always use the URL returned by startLaunchpad(); do not use config.launchpadInternalUrl
      const { baseUrl } = await gcpManager.startLaunchpad();
      if (!baseUrl) throw new Error('Launchpad base URL not available');
      const secret = config.launchpadInternalSecret;
      const headers = { 'Content-Type': 'application/json', 'X-Launchpad-Secret': secret };

      // POST /onboard on launchpad (blocks until ready or timeout)
      const onboardRes = await axios.post(`${baseUrl}/onboard`, { instanceId, name, webhookConfig }, { headers, timeout: config.launchpadSyncTimeoutMs });

      if (onboardRes.data?.ready) {
        const gcsSessionPath = onboardRes.data.gcsSessionPath || `sessions/${instanceId}.zip`;
        const gcsInstancesPath = onboardRes.data.gcsInstancesPath || `instances/onboard-${instanceId}.json`;
        sentry.addBreadcrumb({ category: 'launchpad', message: 'Downloading session and instances from GCS', level: 'info' });

        // Download zip and extract session dir into authBaseDir (zip root is session-{id}/)
        await gcpManager.downloadZipFromGCS(gcsSessionPath, config.authBaseDir);

        // Download instances.json from launchpad and merge into local INSTANCES_DATA_PATH
        const tempInstances = path.join(require('os').tmpdir(), `wa-hub-onboard-${instanceId}-instances.json`);
        await gcpManager.downloadFileFromGCS(gcsInstancesPath, tempInstances);
        const launchpadList = JSON.parse(await fs.readFile(tempInstances, 'utf8'));
        const newEntry = Array.isArray(launchpadList) ? launchpadList.find((e) => e.id === instanceId) : null;
        if (newEntry) {
          let currentList = [];
          try {
            const data = await fs.readFile(config.instancesDataPath, 'utf8');
            currentList = JSON.parse(data);
          } catch (_) {}
          if (!Array.isArray(currentList)) currentList = [];
          const filtered = currentList.filter((e) => e.id !== instanceId);
          filtered.push({ ...newEntry, id: instanceId, name, webhookUrl: webhookConfig.url, webhookEvents: webhookConfig.events || [], typingIndicatorEnabled: newEntry.typingIndicatorEnabled, applyTypingTo: newEntry.applyTypingTo || ['customer'], createdAt: new Date().toISOString() });
          const dataDir = path.dirname(config.instancesDataPath);
          await fs.mkdir(dataDir, { recursive: true }).catch(() => {});
          await fs.writeFile(config.instancesDataPath, JSON.stringify(filtered, null, 2));
        }

        await gcpManager.stopLaunchpad().catch((err) => console.error('[Launchpad] Stop error:', err.message));
        sentry.addBreadcrumb({ category: 'launchpad', message: 'Resuming instance locally', level: 'info' });
        const instance = await createInstance(instanceId, name, webhookConfig);
        return instance;
      }
      throw new Error(onboardRes.data?.error || 'Onboard did not return ready');
    } catch (err) {
      sentry.captureException(err, { phase: 'createInstanceViaLaunchpad', attempt, instanceId });
      if (attempt === LAUNCHPAD_MAX_ATTEMPTS) {
        await gcpManager.stopLaunchpad().catch(() => {});
        throw err;
      }
      await gcpManager.stopLaunchpad().catch(() => {});
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error('Launchpad onboarding failed after retries');
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
    // Trigger ensureReady if not terminal/paused (safety net - sendMessage/sendPoll also do this)
    if (instance.state !== InstanceState.NEEDS_QR && instance.state !== InstanceState.ERROR && instance.state !== InstanceState.RESTRICTED && instance.state !== InstanceState.PAUSED && instance.state !== InstanceState.FAILED_QR_TIMEOUT) {
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
  
  // Trigger reconnection if not terminal/paused (only if newly queued)
  if (!wasAlreadyQueued && instance.state !== InstanceState.NEEDS_QR && instance.state !== InstanceState.ERROR && instance.state !== InstanceState.RESTRICTED && instance.state !== InstanceState.PAUSED && instance.state !== InstanceState.FAILED_QR_TIMEOUT) {
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
  
  // Trigger reconnection if not terminal/paused (only if newly queued)
  if (!wasAlreadyQueued && instance.state !== InstanceState.NEEDS_QR && instance.state !== InstanceState.ERROR && instance.state !== InstanceState.RESTRICTED && instance.state !== InstanceState.PAUSED && instance.state !== InstanceState.FAILED_QR_TIMEOUT) {
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
    instance.clearMessageFallbackPoller();
    instance.clearConnectingWatchdog();
    instance.clearHealthCheck();
    instance.clearDisconnectCooldownTimer();
    instance.clearRateLimitWakeTimer();
    stopSendLoop(instanceId);

    const instanceName = instance.name;
    const client = instance.client;

    await idempotencyStore.deleteByInstanceName(instanceName).catch((err) => {
      result.warnings.push(`idempotency: ${err.message}`);
      console.warn(`[${instanceId}] Idempotency cleanup warning:`, err.message);
    });
    revokeViewSessionTokensByInstanceId(instanceId);
    const { deleteChromiumLogForInstance } = require('./browser/launchOptions');
    await deleteChromiumLogForInstance(instanceId).catch(() => {});

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
 * Tear down an existing instance so the restore scheduler can run createInstance again (retry).
 * Used when a previous createInstance failed and left the instance in the map; without this,
 * retries would hit "Instance already exists" and never re-run init.
 * Does not purge session or update the persisted instances file.
 */
async function teardownInstanceForRestoreRetry(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance) return;
  instance.clearReadyWatchdog();
  instance.clearReadyPoll();
  instance.clearMessageFallbackPoller();
  instance.clearConnectingWatchdog();
  instance.clearHealthCheck();
  instance.clearDisconnectCooldownTimer();
  instance.clearRateLimitWakeTimer();
  stopSendLoop(instanceId);
  const client = instance.client;
  if (client) {
    try {
      if (client.pupPage) client.pupPage.removeAllListeners();
      if (client.pupBrowser) await client.pupBrowser.close().catch(() => {});
    } catch (err) {
      console.warn(`[${instanceId}] Teardown for retry: close browser warning:`, err.message);
    }
    instance.client = null;
  }
  instances.delete(instanceId);
  systemMode.recomputeFromInstances(() => getAllInstances());
  console.log(`[${instanceId}] Teardown for restore retry (instance removed from map)`);
}

/**
 * Create a stub instance in ERROR state (e.g. after RESTORE_MAX_ATTEMPTS). No browser launch.
 */
function createInstanceStub(instanceId, name, webhookConfig, errorMessage) {
  if (instances.has(instanceId)) return instances.get(instanceId);
  const instance = new InstanceContext(instanceId, name, webhookConfig);
  instance.state = InstanceState.ERROR;
  instance.lastError = errorMessage || 'RESTORE_MAX_ATTEMPTS';
  instance.lastErrorAt = new Date();
  instance.restoreAttempts = config.restoreMaxAttempts ?? 5;
  instances.set(instanceId, instance);
  saveInstancesToDisk().catch((err) => console.error('[Persistence] Save failed:', err.message));
  systemMode.recomputeFromInstances(() => getAllInstances());
  return instance;
}

/**
 * Load instances from disk and enqueue for sequential restore (no stampede).
 */
async function loadInstancesFromDisk() {
  const restoreScheduler = require('./restoreScheduler');
  try {
    const data = await fs.readFile(config.instancesDataPath, 'utf8');
    const instancesData = JSON.parse(data);

    if (!Array.isArray(instancesData) || instancesData.length === 0) {
      console.log('[Persistence] No instances to restore');
      return;
    }

    console.log(`[Persistence] Restoring ${instancesData.length} instance(s) sequentially (no stampede)...`);
    const concurrency = config.restoreConcurrency ?? 1;
    if (concurrency !== 1) {
      console.warn('[Persistence] RESTORE_CONCURRENCY should be 1 for small VMs; using sequential restore.');
    }

    for (const d of instancesData) {
      restoreScheduler.enqueue({
        id: d.id,
        name: d.name,
        webhookUrl: d.webhookUrl,
        webhookEvents: d.webhookEvents || [],
        typingIndicatorEnabled: d.typingIndicatorEnabled,
        applyTypingTo: d.applyTypingTo,
      });
    }

    const createFn = async (item) => {
      if (item.type === 'retry') {
        const r = await retryInstance(item.instanceId);
        if (!r.ok) throw new Error(r.error || 'Retry failed');
        return;
      }
      // If a previous attempt left this instance in the map (e.g. init failed), tear it down so we can run createInstance fresh
      if (instances.has(item.id)) {
        await teardownInstanceForRestoreRetry(item.id);
      }
      await createInstance(item.id, item.name, {
        url: item.webhookUrl,
        events: item.webhookEvents || [],
        typingIndicatorEnabled: item.typingIndicatorEnabled,
        applyTypingTo: item.applyTypingTo,
      });
    };
    const markFailedFn = (item, message) => {
      createInstanceStub(item.id, item.name, {
        url: item.webhookUrl,
        events: item.webhookEvents || [],
        typingIndicatorEnabled: item.typingIndicatorEnabled,
        applyTypingTo: item.applyTypingTo,
      }, message);
    };
    restoreScheduler.startSchedulerLoop(createFn, markFailedFn);
    console.log('[Persistence] Restoration queued; scheduler will process one at a time.');
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
 * Retry initializing an instance that is in ERROR or FAILED_QR_TIMEOUT.
 * Destroys existing client (if any), creates new client, and runs initialize (async).
 * Does not await ready; caller gets immediate success and state updates via events.
 * @param {string} instanceId
 * @returns {{ ok: boolean; message?: string; error?: string }}
 */
async function retryInstance(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance) {
    return { ok: false, error: 'Instance not found' };
  }
  if (instance.state !== InstanceState.ERROR && instance.state !== InstanceState.FAILED_QR_TIMEOUT) {
    return { ok: false, error: `Instance is not in ERROR/FAILED_QR_TIMEOUT (state: ${instance.state}). Use restart for other states.` };
  }

  instance.clearReadyWatchdog();
  instance.clearReadyPoll();
  instance.clearMessageFallbackPoller();
  instance.clearConnectingWatchdog();
  instance.clearHealthCheck();

  if (instance.client) {
    try {
      await instance.client.destroy().catch(() => {});
    } catch (_) {}
    instance.client = null;
    instance.debugWsEndpoint = null;
  }

  instance.transitionTo(InstanceState.CONNECTING, 'retry after ERROR');
  instance.startConnectingWatchdog();
  instance.qrReceivedDuringRestart = false;

  try {
    const client = await createClient(instanceId, instance.name);
    instance.client = client;
    setupEventListeners(instanceId, client);
    startPopupDismisser(client, `[${instanceId}]`);
    await client.initialize();
    const { enableSyncLiteInterception } = require('./utils/syncLiteInterception');
    enableSyncLiteInterception(client, instanceId);
    console.log(`[${instanceId}] Retry: client initialized, waiting for events`);
    return { ok: true, message: 'Retry started; instance is initializing.' };
  } catch (err) {
    const { buildLaunchFailureMessage, logLaunchFailure } = require('./browser/launchOptions');
    const launchErrorMsg = buildLaunchFailureMessage(err, instanceId);
    instance.lastError = launchErrorMsg;
    instance.lastErrorAt = new Date();
    instance.lastErrorStack = err.stack;
    logLaunchFailure(instanceId, err, launchErrorMsg);
    console.error(`[${instanceId}] Retry failed:`, err.message);
    instance.transitionTo(InstanceState.ERROR, launchErrorMsg);
    return { ok: false, error: err.message };
  }
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

    // Incoming message diagnostics
    listenersAttached: instance.listenersAttached || false,
    fallbackPollEnabled: config.messageFallbackPollEnabled,
    fallbackPollIntervalMs: config.messageFallbackPollIntervalMs,
    lastFallbackPollAt: instance.lastFallbackPollAt ? instance.lastFallbackPollAt.toISOString() : null,
    fallbackPollRuns: instance.fallbackPollRuns || 0,
    fallbackPollLastError: instance.fallbackPollLastError,
    lastIncomingMessageAt: instance.lastIncomingMessageAt ? instance.lastIncomingMessageAt.toISOString() : null,
    dedupeCacheSize: instance.recentMessageIds ? instance.recentMessageIds.size : 0,
  };
}

/**
 * Get CPU and memory usage for an instance's browser process (if running).
 * @param {string} instanceId
 * @returns {Promise<{ cpuPercent: number, memoryMB: number } | null>}
 */
async function getInstanceProcessUsage(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance?.client?.pupBrowser) return null;
  let pid;
  try {
    const proc = instance.client.pupBrowser.process();
    pid = proc?.pid;
  } catch (_) {
    return null;
  }
  if (!pid) return null;
  try {
    const pidusage = require('pidusage');
    const stat = await pidusage(pid);
    return {
      cpuPercent: Math.round((stat.cpu ?? 0) * 10) / 10,
      memoryMB: Math.round((stat.memory ?? 0) / 1048576),
    };
  } catch (_) {
    return null;
  }
}

/**
 * Create a short-lived view session token for founder-only "View Live Session" (testing/debugging).
 * @param {string} instanceId
 * @param {string} dashboardBaseUrl - e.g. https://dashboard.example.com
 * @returns {{ success: boolean; viewUrl?: string; expiresIn?: number; error?: string }}
 */
function createViewSessionToken(instanceId, dashboardBaseUrl) {
  const instance = instances.get(instanceId);
  if (!instance) return { success: false, error: 'Instance not found' };
  if (!instance.debugWsEndpoint) {
    return { success: false, error: 'Instance has no debug session (remote debugging not available)' };
  }
  const expMs = config.viewSessionTimeoutMin * 60 * 1000;
  const exp = Date.now() + expMs;
  const token = crypto.randomBytes(32).toString('hex');
  viewTokens.set(token, { instanceId, exp });
  const viewUrl = `${dashboardBaseUrl.replace(/\/$/, '')}/viewer?token=${token}`;
  console.log(`[${instanceId}] View session created (expires in ${config.viewSessionTimeoutMin}min)`);
  return { success: true, viewUrl, expiresIn: config.viewSessionTimeoutMin * 60 };
}

/**
 * Validate view session token and return instanceId or null.
 * Cleans up expired tokens.
 */
function validateViewSessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const entry = viewTokens.get(token);
  if (!entry) return null;
  if (Date.now() > entry.exp) {
    viewTokens.delete(token);
    return null;
  }
  return entry.instanceId;
}

/**
 * Capture screenshot for view session (founder-only, ephemeral).
 * @param {string} token
 * @returns {Promise<Buffer|null>} PNG buffer or null
 */
async function captureViewSessionScreenshot(token) {
  const instanceId = validateViewSessionToken(token);
  if (!instanceId) return null;
  const instance = instances.get(instanceId);
  if (!instance?.client?.pupPage) return null;
  try {
    const page = instance.client.pupPage;
    if (page.isClosed?.()) return null;
    return await page.screenshot({ type: 'png', fullPage: false });
  } catch (err) {
    console.warn(`[${instanceId}] View session screenshot failed:`, err.message);
    return null;
  }
}

/**
 * Inject click at coordinates (for interactive view).
 * @param {string} token
 * @param {number} x
 * @param {number} y
 * @returns {Promise<{ success: boolean; error?: string }>}
 */
async function injectViewSessionClick(token, x, y) {
  const instanceId = validateViewSessionToken(token);
  if (!instanceId) return { success: false, error: 'Invalid or expired token' };
  const instance = instances.get(instanceId);
  if (!instance?.client?.pupPage) return { success: false, error: 'Instance not ready' };
  try {
    const page = instance.client.pupPage;
    if (page.isClosed?.()) return { success: false, error: 'Page closed' };
    await page.mouse.click(Number(x), Number(y));
    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message || 'Click failed' };
  }
}

/**
 * Inject scroll at coordinates (for interactive view).
 * @param {string} token
 * @param {number} x
 * @param {number} y
 * @param {number} deltaY
 * @returns {Promise<{ success: boolean; error?: string }>}
 */
async function injectViewSessionScroll(token, x, y, deltaY) {
  const instanceId = validateViewSessionToken(token);
  if (!instanceId) return { success: false, error: 'Invalid or expired token' };
  const instance = instances.get(instanceId);
  if (!instance?.client?.pupPage) return { success: false, error: 'Instance not ready' };
  try {
    const page = instance.client.pupPage;
    if (page.isClosed?.()) return { success: false, error: 'Page closed' };
    await page.mouse.move(Number(x), Number(y));
    await page.mouse.wheel({ deltaY: Number(deltaY) || 0 });
    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message || 'Scroll failed' };
  }
}

/**
 * Revoke a view session token (call when user closes viewer).
 */
function revokeViewSessionToken(token) {
  if (!token || typeof token !== 'string') return false;
  const had = viewTokens.has(token);
  viewTokens.delete(token);
  return had;
}

/**
 * Revoke all view session tokens for an instance (call when instance is deleted).
 * @param {string} instanceId
 * @returns {number} Number of tokens revoked
 */
function revokeViewSessionTokensByInstanceId(instanceId) {
  if (!instanceId) return 0;
  let revoked = 0;
  for (const [token, entry] of viewTokens.entries()) {
    if (entry.instanceId === instanceId) {
      viewTokens.delete(token);
      revoked++;
    }
  }
  if (revoked > 0) console.log(`[${instanceId}] Revoked ${revoked} view session token(s)`);
  return revoked;
}

/**
 * Cleanup expired view tokens (call periodically)
 */
function cleanupExpiredViewTokens() {
  const now = Date.now();
  for (const [token, entry] of viewTokens.entries()) {
    if (now > entry.exp) viewTokens.delete(token);
  }
}

/**
 * Run a single outbound action from the low-power queue (drain phase).
 * @param {{ actionType: string; instanceId: string; payload: object }} item
 */
async function runOutboundAction(item) {
  const { actionType, instanceId, payload } = item;
  if (actionType === 'send_message') {
    await sendMessage(instanceId, payload.formattedChatId, payload.message);
  } else if (actionType === 'send_poll') {
    await sendPoll(instanceId, payload.formattedChatId, payload.caption, payload.options, payload.multipleAnswers);
  } else {
    throw new Error(`Unknown outbound action: ${actionType}`);
  }
}

module.exports = {
  InstanceState,
  createInstance,
  createInstanceViaLaunchpad,
  getInstance,
  getAllInstances,
  getInstanceCount,
  deleteInstance,
  updateWebhookConfig,
  sendMessage,
  sendPoll,
  ensureReady,
  waitForReadyEvent,
  createInstanceStub,
  loadInstancesFromDisk,
  saveInstancesToDisk,
  clearQueue,
  getQueueDetails,
  triggerSendLoop,
  getInstanceDiagnostics,
  getInstanceProcessUsage,
  createViewSessionToken,
  validateViewSessionToken,
  captureViewSessionScreenshot,
  injectViewSessionClick,
  injectViewSessionScroll,
  revokeViewSessionToken,
  cleanupExpiredViewTokens,
  runOutboundAction,
  deliverBufferedInbound,
  startNeedsQrWatchdog,
  retryInstance,
};
