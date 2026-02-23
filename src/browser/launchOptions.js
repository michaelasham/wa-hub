/**
 * Centralized Chromium/Puppeteer launch options for wa-hub.
 * Reduces memory pressure and /dev/shm issues during login/sync.
 * All instance launches use these args; configurable via env.
 */

const config = require('../config');

/** Base Chromium args: memory/shm hardening, no GPU, no zygote, background throttling disabled */
const BASE_ARGS = [
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=site-per-process',
  '--disable-features=TranslateUI',
  '--disable-ipc-flooding-protection',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-breakpad',
  '--disable-component-extensions-with-background-pages',
  '--disable-default-apps',
  '--disable-notifications',
  '--disable-prompt-on-repost',
  '--disable-sync',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
  '--metrics-recording-only',
  '--disable-blink-features=AutomationControlled',
  '--disable-x11-autolaunch',
  '--disable-application-cache',
  '--ignore-certificate-errors',
  '--no-pings',
  '--window-size=1920,1080',
  '--log-level=3',
  '--disk-cache-size=104857600',
  '--media-cache-size=104857600',
];

/**
 * Returns the array of Chromium launch args to use for all instance launches.
 * Does NOT include --no-sandbox unless CHROME_DISABLE_SANDBOX=1.
 * @returns {string[]}
 */
function getChromiumLaunchArgs() {
  const args = [...BASE_ARGS];

  if (config.chromeDisableSandbox) {
    args.unshift('--no-sandbox', '--disable-setuid-sandbox');
  }

  if (config.chromeArgsExtra && config.chromeArgsExtra.trim()) {
    const extra = config.chromeArgsExtra.trim().split(/\s+/).filter(Boolean);
    args.push(...extra);
  }

  return args;
}

/**
 * Log Chromium launch context. Always logs a short line; full context (memory, versions) when WAHUB_LOG_CHROME_ARGS=1.
 * @param {string} instanceId - Instance id for log prefix
 * @param {{ executablePath?: string; headless: boolean; argsCount: number }} opts
 */
function logLaunchContext(instanceId, opts = {}) {
  const executablePath = opts.executablePath || 'bundled';
  const argsCount = opts.argsCount ?? 0;
  console.log(`[${instanceId}] [Chromium] launch executable=${executablePath} headless=${opts.headless !== false} args=${argsCount}`);

  if (!config.wahubLogChromeArgs) return;

  let puppeteerVersion = 'unknown';
  try {
    const pptr = require('puppeteer-core');
    puppeteerVersion = pptr.__version || puppeteerVersion;
  } catch (_) {
    // puppeteer-core may be transitive via whatsapp-web.js
  }
  const mem = process.memoryUsage();
  const line = {
    instanceId,
    nodeVersion: process.version,
    puppeteerVersion,
    executablePath,
    headless: opts.headless !== false,
    argsCount,
    memory: {
      rss: Math.round(mem.rss / 1048576) + 'MB',
      heapUsed: Math.round(mem.heapUsed / 1048576) + 'MB',
      external: Math.round((mem.external || 0) / 1048576) + 'MB',
    },
  };
  console.log(`[${instanceId}] [Chromium] launch context: ${JSON.stringify(line)}`);
}

module.exports = {
  getChromiumLaunchArgs,
  logLaunchContext,
};
