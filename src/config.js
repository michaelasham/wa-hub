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
  
  // API key for authentication (required for all endpoints except /health)
  apiKey: process.env.API_KEY,
  
  // WhatsApp session storage path
  sessionDataPath: process.env.SESSION_DATA_PATH || './.wwebjs_auth',
  
  // Instance metadata persistence file (for restoring instances on restart)
  instancesDataPath: process.env.INSTANCES_DATA_PATH || './.wwebjs_instances.json',
  
  // LocalAuth base directory (per-instance auth directories will be created under this)
  authBaseDir: process.env.AUTH_BASE_DIR || process.env.SESSION_DATA_PATH || './.wwebjs_auth',
  
  // Chromium/Chrome executable path (for Puppeteer)
  chromePath: process.env.CHROME_PATH || '/usr/bin/chromium-browser', // Fallback: /usr/bin/chromium
  
  // Instance lifecycle configuration
  maxQueueSize: parseInt(process.env.MAX_QUEUE_SIZE || '200', 10),
  readyTimeoutMs: parseInt(process.env.READY_TIMEOUT_MS || '180000', 10), // 3 minutes
  restartBackoffMs: parseInt(process.env.RESTART_BACKOFF_MS || '2000', 10), // 2 seconds initial
  maxRestartsPerWindow: parseInt(process.env.MAX_RESTARTS_PER_WINDOW || '4', 10),
  restartWindowMinutes: parseInt(process.env.RESTART_WINDOW_MINUTES || '10', 10),
  
  // Soft/Hard restart timeouts
  softRestartTimeoutMs: parseInt(process.env.SOFT_RESTART_TIMEOUT_MS || '180000', 10), // 3 minutes
  hardRestartTimeoutMs: parseInt(process.env.HARD_RESTART_TIMEOUT_MS || '180000', 10), // 3 minutes
  
  // Rate limiting (per instance)
  maxSendsPerMinute: parseInt(process.env.MAX_SENDS_PER_MINUTE_PER_INSTANCE || '6', 10),
  maxSendsPerHour: parseInt(process.env.MAX_SENDS_PER_HOUR_PER_INSTANCE || '60', 10),
  
  // Retry backoff
  retryBaseBackoffMs: parseInt(process.env.RETRY_BASE_BACKOFF_MS || '5000', 10),
  retryMaxBackoffMs: parseInt(process.env.RETRY_MAX_BACKOFF_MS || '120000', 10),
  
  // Idempotency
  idempotencyDataPath: process.env.IDEMPOTENCY_DATA_PATH || './.wwebjs_idempotency.json',
  
  // Typing indicator configuration
  typingIndicatorEnabledDefault: process.env.TYPING_INDICATOR_ENABLED_DEFAULT !== 'false', // Default: true (enabled)
  typingIndicatorMinMs: parseInt(process.env.TYPING_INDICATOR_MIN_MS || '600', 10),
  typingIndicatorMaxMs: parseInt(process.env.TYPING_INDICATOR_MAX_MS || '1800', 10),
  typingIndicatorMaxTotalMs: parseInt(process.env.TYPING_INDICATOR_MAX_TOTAL_MS || '2500', 10),
  
  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
};

// No default webhook URL - each instance must specify its own webhook URL

if (!config.webhookSecret) {
  console.warn('WARNING: WEBHOOK_SECRET not set. Webhook requests will not include shared secret header.');
}

module.exports = config;

