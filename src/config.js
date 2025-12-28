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
  
  // Chromium/Chrome executable path (for Puppeteer)
  chromePath: process.env.CHROME_PATH || '/usr/bin/chromium-browser', // Fallback: /usr/bin/chromium
  
  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
};

// No default webhook URL - each instance must specify its own webhook URL

if (!config.webhookSecret) {
  console.warn('WARNING: WEBHOOK_SECRET not set. Webhook requests will not include shared secret header.');
}

module.exports = config;

