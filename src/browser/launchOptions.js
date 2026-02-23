/**
 * Centralized Chromium/Puppeteer launch options for wa-hub.
 * Reduces memory pressure and /dev/shm issues during login/sync.
 * Env: PUPPETEER_EXECUTABLE_PATH, PUPPETEER_DUMPIO, PUPPETEER_DEBUG_LAUNCH,
 * CHROME_LAUNCH_TIMEOUT_MS, CHROME_DISABLE_SANDBOX, CHROME_ARGS_EXTRA.
 * Executable order: PUPPETEER_EXECUTABLE_PATH (if set) -> google-chrome-stable -> chromium -> bundled (avoids Snap when possible).
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const shm = require('../system/shm');

/** Candidates after env (prefer non-Snap: google-chrome-stable, then chromium; no chromium-browser/snap in default order) */
const FALLBACK_CANDIDATES = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
];

/**
 * Resolve executable path in order: (a) PUPPETEER_EXECUTABLE_PATH if set, (b) google-chrome-stable, (c) chromium, (d) bundled.
 * @returns {{ path: string|null, exists: boolean }}
 */
function getChosenExecutablePath() {
  const fromEnv = (config.puppeteerExecutablePath || '').trim();
  if (fromEnv) {
    const exists = fs.existsSync(fromEnv);
    return { path: fromEnv, exists };
  }
  for (const p of FALLBACK_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return { path: p, exists: true };
    } catch (_) {}
  }
  return { path: null, exists: false };
}

/** Base Chromium args: memory/shm hardening, no GPU. Sandbox/zygote added separately (--no-zygote only with --no-sandbox). */
const BASE_ARGS = [
  '--disable-dev-shm-usage',
  '--disable-gpu',
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

const CHROME_LOG_DIR = process.env.CHROME_LOG_DIR || '/tmp';
const STDERR_TAIL_MAX = 3500;

/**
 * Ensure --no-zygote is never used without --no-sandbox (Chromium error: "Zygote cannot be disabled if sandbox is enabled").
 * Mutates args: if --no-zygote present but --no-sandbox missing, logs and injects sandbox flags at front.
 * @param {string[]} args
 */
function validateAndFixSandboxZygote(args) {
  const hasNoZygote = args.includes('--no-zygote');
  const hasNoSandbox = args.includes('--no-sandbox');
  if (hasNoZygote && !hasNoSandbox) {
    console.error('[Chromium] FATAL CONFIG: --no-zygote requires --no-sandbox. Auto-injecting --no-sandbox and --disable-setuid-sandbox.');
    args.unshift('--no-sandbox', '--disable-setuid-sandbox');
  }
}

/**
 * Returns the array of Chromium launch args. Sandbox/zygote: add --no-sandbox (and optionally --no-zygote) only when enabled; --no-zygote only if sandbox disabled.
 * @param {string} [instanceId] - If set, add log file so buildLaunchFailureMessage can read stderr tail
 * @returns {string[]}
 */
function getChromiumLaunchArgs(instanceId) {
  const args = [];

  if (config.chromeDisableSandbox) {
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }
  if (config.chromeUseNoZygote && config.chromeDisableSandbox) {
    args.push('--no-zygote');
  }

  args.push(...BASE_ARGS);

  if (config.chromeArgsExtra && config.chromeArgsExtra.trim()) {
    const extra = config.chromeArgsExtra.trim().split(/\s+/).filter(Boolean);
    args.push(...extra);
  }

  if (instanceId && typeof instanceId === 'string') {
    const safeId = instanceId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const logFile = path.join(CHROME_LOG_DIR, `wa-hub-chrome-${safeId}.log`);
    args.push('--enable-logging', '--v=1', `--log-file=${logFile}`);
  }

  validateAndFixSandboxZygote(args);
  return args;
}

/**
 * Returns Puppeteer launch options (dumpio, timeout, args). Used when constructing Client({ puppeteer }).
 * @param {string} [instanceId] - Passed to getChromiumLaunchArgs for optional log file
 * @returns {{ headless: boolean, args: string[], dumpio?: boolean, timeout?: number, executablePath?: string }}
 */
function getPuppeteerLaunchOptions(instanceId) {
  const args = getChromiumLaunchArgs(instanceId);
  const opts = {
    headless: true,
    args,
    timeout: config.chromeLaunchTimeoutMs || 60000,
  };
  if (config.puppeteerDumpio) {
    opts.dumpio = true;
  }
  return opts;
}

/**
 * Log Chromium launch context. Always logs chosen executablePath and whether it exists.
 * When PUPPETEER_DEBUG_LAUNCH=1, also logs uid/gid, totalmem, freemem, shm, disk free /tmp.
 */
function logLaunchContext(instanceId, opts = {}) {
  const executablePath = opts.executablePath || 'bundled';
  const exists = opts.executablePathExists;
  const argsCount = opts.argsCount ?? 0;
  console.log(`[${instanceId}] [Chromium] launch executable=${executablePath} exists=${exists !== undefined ? !!exists : 'n/a'} headless=${opts.headless !== false} args=${argsCount}`);

  if (config.puppeteerDebugLaunch) {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const shmBytes = shm.getShmSizeBytes ? shm.getShmSizeBytes() : null;
    let diskFreeTmp = null;
    try {
      const df = require('child_process').execSync('df -k /tmp 2>/dev/null | tail -1', { encoding: 'utf8', timeout: 2000 });
      const parts = df.trim().split(/\s+/);
      const availK = parseInt(parts[3], 10);
      if (!Number.isNaN(availK)) diskFreeTmp = `${availK}KB`;
    } catch (_) {}
    const allArgs = opts.args || [];
    const debugLine = {
      instanceId,
      executablePath: opts.executablePath || 'bundled',
      headless: opts.headless !== false,
      argsCount,
      noSandbox: allArgs.includes('--no-sandbox'),
      noZygote: allArgs.includes('--no-zygote'),
      argsSample: allArgs.slice(0, 12),
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      gid: typeof process.getgid === 'function' ? process.getgid() : null,
      totalMemMB: Math.round(totalMem / 1048576),
      freeMemMB: Math.round(freeMem / 1048576),
      shmSizeMB: shmBytes != null ? Math.round(shmBytes / 1048576) : null,
      diskFreeTmp,
    };
    console.log(`[${instanceId}] [Chromium] DEBUG_LAUNCH: ${JSON.stringify(debugLine)}`);
  }

  if (config.wahubLogChromeArgs && !config.puppeteerDebugLaunch) {
    let puppeteerVersion = 'unknown';
    try {
      const pptr = require('puppeteer-core');
      puppeteerVersion = pptr.__version || puppeteerVersion;
    } catch (_) {}
    const mem = process.memoryUsage();
    const line = {
      instanceId,
      nodeVersion: process.version,
      puppeteerVersion,
      executablePath: opts.executablePath || 'bundled',
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
}

/**
 * Build actionable lastError string from launch failure: message + Chromium log file tail if present.
 * @param {Error} err - The thrown error from initialize()/launch
 * @param {string} instanceId - Instance id (used to locate log file)
 * @param {number} [stderrMaxChars=3000] - Max chars of log tail to append
 * @returns {string}
 */
function buildLaunchFailureMessage(err, instanceId, stderrMaxChars = STDERR_TAIL_MAX) {
  const msg = err && (err.message || String(err)) || 'Unknown launch error';
  let out = `LAUNCH_FAILED: ${msg}`;
  if (!instanceId || typeof instanceId !== 'string') return out;
  const safeId = instanceId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const logPath = path.join(CHROME_LOG_DIR, `wa-hub-chrome-${safeId}.log`);
  try {
    if (fs.existsSync(logPath)) {
      const buf = fs.readFileSync(logPath, 'utf8');
      const tail = buf.length > stderrMaxChars ? buf.slice(-stderrMaxChars) : buf;
      const trimmed = tail.trim();
      if (trimmed) out += `\n--- Chromium log tail ---\n${trimmed}`;
    }
  } catch (_) {}
  return out;
}

/**
 * Log launch failure clearly (full message + stderr tail). Call after setting instance.lastError.
 */
function logLaunchFailure(instanceId, err, lastErrorMsg) {
  const msg = err && (err.message || String(err)) || 'Unknown';
  console.error(`[${instanceId}] [Chromium] LAUNCH FAILED: ${msg}`);
  if (lastErrorMsg && lastErrorMsg !== msg) {
    console.error(`[${instanceId}] [Chromium] lastError (with stderr tail):\n${lastErrorMsg}`);
  }
}

module.exports = {
  getChosenExecutablePath,
  getChromiumLaunchArgs,
  getPuppeteerLaunchOptions,
  logLaunchContext,
  buildLaunchFailureMessage,
  logLaunchFailure,
};
