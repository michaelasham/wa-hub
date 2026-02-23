/**
 * Configuration module for wa-hub service
 * Loads environment variables and provides configuration
 */

require('dotenv').config();

const config = {
  // Server configuration
  port: process.env.PORT || 3000,
  
  // Webhook configuration
  webhookBaseUrl: process.env.MAIN_APP_WEBHOOK_BASE || process.env.WEBHOOK_BASE_URL,
  webhookSecret: process.env.WEBHOOK_SECRET || process.env.MAIN_APP_WEBHOOK_SECRET,
  // Optional: bypass deployment protection (e.g. Vercel) - send this header with webhook POSTs
  webhookProtectionBypass: process.env.WEBHOOK_PROTECTION_BYPASS || process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
  // Optional: Bearer token for webhook receivers that require API-key auth (fixes 401 on protected endpoints)
  webhookAuthToken: process.env.WEBHOOK_AUTH_TOKEN || process.env.WEBHOOK_BEARER_TOKEN,
  
  // API key for authentication (required for all endpoints except /health)
  apiKey: process.env.API_KEY,
  
  // WhatsApp session storage path
  sessionDataPath: process.env.SESSION_DATA_PATH || './.wwebjs_auth',
  
  // Instance metadata persistence file (for restoring instances on restart)
  instancesDataPath: process.env.INSTANCES_DATA_PATH || './.wwebjs_instances.json',
  
  // LocalAuth base directory (per-instance auth directories will be created under this)
  // NEVER mutate or delete contents while wa-hub is running - Chromium may crash or hang
  authBaseDir: process.env.AUTH_BASE_DIR || process.env.SESSION_DATA_PATH || './.wwebjs_auth',
  
  // Chromium/Chrome executable path (for Puppeteer)
  chromePath: process.env.CHROME_PATH || '/usr/bin/chromium-browser', // Fallback: /usr/bin/chromium
  // Only add --no-sandbox when explicitly set (e.g. Docker); default false for security
  chromeDisableSandbox: process.env.CHROME_DISABLE_SANDBOX === '1' || process.env.CHROME_DISABLE_SANDBOX === 'true',
  chromeArgsExtra: process.env.CHROME_ARGS_EXTRA || '',
  wahubLogChromeArgs: process.env.WAHUB_LOG_CHROME_ARGS === '1' || process.env.WAHUB_LOG_CHROME_ARGS === 'true',
  
  // Instance lifecycle configuration
  maxQueueSize: parseInt(process.env.MAX_QUEUE_SIZE || '200', 10),
  readyTimeoutMs: parseInt(process.env.READY_TIMEOUT_MS || '180000', 10), // 3 minutes
  restartBackoffMs: parseInt(process.env.RESTART_BACKOFF_MS || '300000', 10), // 5 min initial (was 2s)
  maxRestartsPerWindow: parseInt(process.env.MAX_RESTARTS_PER_WINDOW || '2', 10),
  restartWindowMinutes: parseInt(process.env.RESTART_WINDOW_MINUTES || '60', 10),
  restartBackoffSequenceMs: (process.env.RESTART_BACKOFF_SEQUENCE_MS || '300000,900000,3600000').split(',').map(s => parseInt(s.trim(), 10)), // 5min, 15min, 60min
  restartRateLimitExtraHours: parseInt(process.env.RESTART_RATE_LIMIT_EXTRA_HOURS || '1', 10), // +1h pause on rate limit hit
  
  // Soft/Hard restart timeouts
  softRestartTimeoutMs: parseInt(process.env.SOFT_RESTART_TIMEOUT_MS || '180000', 10), // 3 minutes
  hardRestartTimeoutMs: parseInt(process.env.HARD_RESTART_TIMEOUT_MS || '180000', 10), // 3 minutes

  // CreateInstance: time to get QR or ready on first init (slow VMs need 60-120s)
  initTimeoutMs: parseInt(process.env.INIT_TIMEOUT_MS || '120000', 10), // 2 minutes default
  
  // Rate limiting (per instance)
  maxSendsPerMinute: parseInt(process.env.MAX_SENDS_PER_MINUTE_PER_INSTANCE || '3', 10),
  maxSendsPerHour: parseInt(process.env.MAX_SENDS_PER_HOUR_PER_INSTANCE || '30', 10),
  
  // Retry backoff
  retryBaseBackoffMs: parseInt(process.env.RETRY_BASE_BACKOFF_MS || '5000', 10),
  retryMaxBackoffMs: parseInt(process.env.RETRY_MAX_BACKOFF_MS || '120000', 10),
  
  // Idempotency
  idempotencyDataPath: process.env.IDEMPOTENCY_DATA_PATH || './.wwebjs_idempotency.json',
  
  // Typing indicator configuration
  typingIndicatorEnabledDefault: process.env.TYPING_INDICATOR_ENABLED_DEFAULT !== 'false', // Default: true (enabled)
  typingIndicatorMinMs: parseInt(process.env.TYPING_INDICATOR_MIN_MS || '1000', 10), // 1 second
  typingIndicatorMaxMs: parseInt(process.env.TYPING_INDICATOR_MAX_MS || '3000', 10), // 3 seconds
  typingIndicatorMaxTotalMs: parseInt(process.env.TYPING_INDICATOR_MAX_TOTAL_MS || '4500', 10), // typing + send buffer

  // Selective read receipts (blue ticks) - humanity layer, low-risk
  markSeenAfterSend: process.env.MARK_SEEN_AFTER_SEND !== 'false', // Default: true
  markSeenOnRelevantIncoming: process.env.MARK_SEEN_ON_RELEVANT_INCOMING !== 'false', // Default: true
  markSeenProbabilityIncoming: parseFloat(process.env.MARK_SEEN_PROBABILITY_INCOMING || '0.4', 10), // 0-1
  markSeenAfterSendDelayMinMs: parseInt(process.env.MARK_SEEN_AFTER_SEND_DELAY_MIN_MS || '1000', 10), // 1-3s
  markSeenAfterSendDelayMaxMs: parseInt(process.env.MARK_SEEN_AFTER_SEND_DELAY_MAX_MS || '3000', 10),
  readingDelayMinMs: parseInt(process.env.READING_DELAY_MIN_MS || '2000', 10), // 2-6s
  readingDelayMaxMs: parseInt(process.env.READING_DELAY_MAX_MS || '6000', 10),
  
  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // Debug patch: disable auto-reconnect to isolate disconnect causes
  disableAutoReconnect: process.env.DISABLE_AUTO_RECONNECT === 'true',

  // Debug patch: watchdog timeout for ready event (ms) - emit ready_timeout if not ready within this
  readyWatchdogMs: parseInt(process.env.READY_WATCHDOG_MS || '600000', 10), // 10 min default

  // Fallback: poll client.info when ready event never fires (whatsapp-web.js bug)
  readyPollIntervalMs: parseInt(process.env.READY_POLL_INTERVAL_MS || '15000', 10), // 15 sec default

  // Fallback: poll unread messages when message events fail (whatsapp-web.js v1.34 bug)
  messageFallbackPollIntervalMs: parseInt(process.env.MESSAGE_FALLBACK_POLL_INTERVAL_MS || '15000', 10), // 15 sec default
  messageFallbackPollEnabled: process.env.MESSAGE_FALLBACK_POLL_ENABLED !== 'false', // Default: true

  // Watchdog: if CONNECTING or NEEDS_QR for this long with no progress, restart client (extended for low reconnect frequency)
  connectingWatchdogMs: parseInt(process.env.CONNECTING_WATCHDOG_MS || '600000', 10), // 10 min default (was 3)
  connectingWatchdogMaxRestarts: parseInt(process.env.CONNECTING_WATCHDOG_MAX_RESTARTS || '2', 10), // After this many, move to ERROR

  // Disconnect cooldown: pause ALL sends + auto-reconnect for this duration on ANY disconnect
  minDisconnectCooldownMs: parseInt(process.env.MIN_DISCONNECT_COOLDOWN_MS || '300000', 10), // 5 min default

  // Restriction: if detected (reason or page text), full pause for this many hours
  extendedRestrictionCooldownHours: parseInt(process.env.EXTENDED_RESTRICTION_COOLDOWN_HOURS || '72', 10),

  // Health check: periodic when READY (no auto-restart, just detect zombie)
  healthCheckIntervalMin: parseInt(process.env.HEALTH_CHECK_INTERVAL_MIN || '20', 10),
  zombieInactivityThresholdMin: parseInt(process.env.ZOMBIE_INACTIVITY_THRESHOLD_MIN || '30', 10),
  readyTimeoutPauseMin: parseInt(process.env.READY_TIMEOUT_PAUSE_MIN || '10', 10), // Pause before retry on ready_timeout

  // Delete: timeout for client.destroy() before purge (ms)
  deleteDestroyTimeoutMs: parseInt(process.env.DELETE_DESTROY_TIMEOUT_MS || '15000', 10), // 15s default

  // View Live Session (founder-only, testing/debugging) - always enabled
  viewSessionEnabled: true,
  viewSessionTimeoutMin: parseInt(process.env.VIEW_SESSION_TIMEOUT_MIN || '10', 10),
  viewSessionJwtSecret: process.env.VIEW_SESSION_JWT_SECRET || process.env.WEBHOOK_SECRET || process.env.API_KEY || 'view-session-fallback',

  // Low-power mode: outbound queue during SYNCING
  maxOutboundQueue: parseInt(process.env.MAX_OUTBOUND_QUEUE || '200', 10),
  outboundQueueTtlMs: parseInt(process.env.OUTBOUND_QUEUE_TTL_MS || '300000', 10), // 5 min
  outboundDrainDelayMs: parseInt(process.env.OUTBOUND_DRAIN_DELAY_MS || '350', 10), // between actions

  // Low-power mode: inbound buffer during SYNCING
  inboundFlushBatch: parseInt(process.env.INBOUND_FLUSH_BATCH || '50', 10),
  inboundFlushIntervalMs: parseInt(process.env.INBOUND_FLUSH_INTERVAL_MS || '500', 10),
  inboundMaxBuffer: parseInt(process.env.INBOUND_MAX_BUFFER || '2000', 10),

  // Sync-lite: block heavy resources for syncing instance
  syncLiteBlockImages: process.env.SYNC_LITE_BLOCK_IMAGES === '1',
  syncLiteBlockMedia: process.env.SYNC_LITE_BLOCK_MEDIA === '1',
  syncLiteBlockFonts: process.env.SYNC_LITE_BLOCK_FONTS === '1',
  syncLiteBlockStyles: process.env.SYNC_LITE_BLOCK_STYLES === '1',

  // NEEDS_QR timeout & recovery: prevent global SYNCING from being held by stuck QR
  qrSyncGraceMs: parseInt(process.env.QR_SYNC_GRACE_MS || '30000', 10),       // NEEDS_QR keeps SYNCING only this long
  qrStaleMs: parseInt(process.env.QR_STALE_MS || '90000', 10),                // no QR event for this long = stale
  qrTtlMs: parseInt(process.env.QR_TTL_MS || '300000', 10),                  // NEEDS_QR longer than this = timeout
  qrMaxRecoveryAttempts: parseInt(process.env.QR_MAX_RECOVERY_ATTEMPTS || '3', 10),
  qrRecoveryWatchdogIntervalMs: parseInt(process.env.QR_RECOVERY_WATCHDOG_INTERVAL_MS || '10000', 10), // 10s
  qrRecoveryBackoffMs: (process.env.QR_RECOVERY_BACKOFF_MS || '10000,30000,60000').split(',').map(s => parseInt(s.trim(), 10)),

  // Puppeteer/Chromium launch diagnostics and executable
  puppeteerExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '',
  puppeteerDumpio: process.env.PUPPETEER_DUMPIO === '1',
  puppeteerDebugLaunch: process.env.PUPPETEER_DEBUG_LAUNCH === '1',
  chromeLaunchTimeoutMs: parseInt(process.env.CHROME_LAUNCH_TIMEOUT_MS || '60000', 10),

  // Sequential restore (prevent stampede)
  restoreConcurrency: parseInt(process.env.RESTORE_CONCURRENCY || '1', 10),
  restoreCooldownMs: parseInt(process.env.RESTORE_COOLDOWN_MS || '30000', 10),
  restoreMinFreeMemMb: parseInt(process.env.RESTORE_MIN_FREE_MEM_MB || '800', 10),
  restoreMaxAttempts: parseInt(process.env.RESTORE_MAX_ATTEMPTS || '5', 10),
  restoreBackoffBaseMs: parseInt(process.env.RESTORE_BACKOFF_BASE_MS || '15000', 10),
};

// No default webhook URL - each instance must specify its own webhook URL

if (!config.webhookSecret) {
  console.warn('WARNING: WEBHOOK_SECRET not set. Webhook requests will not include shared secret header.');
}

module.exports = config;

