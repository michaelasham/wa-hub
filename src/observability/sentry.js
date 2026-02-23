/**
 * Sentry integration for wa-hub: error tracking, breadcrumbs, and performance.
 * Every event is tagged with a stable instance identifier (WA_HUB_INSTANCE_ID or GCP metadata).
 * Sensitive data (phone numbers, message bodies, tokens, QR) is scrubbed before send.
 */

const Sentry = require('@sentry/node');
const { getGcpInstanceId, getGcpInstanceName, getGcpZone } = require('../infra/gcpMetadata');

let enabled = false;
let resolvedInstanceId = 'unknown';
let resolvedInstanceName;
let resolvedZone;

/** Phone-like pattern: 8–15 digits, optional leading + */
const PHONE_PATTERN = /(\+?\d{8,15})\b/g;
const SENSITIVE_KEYS = new Set([
  'authorization', 'cookie', 'token', 'qr', 'message', 'body', 'password',
  'phone', 'phonenumber', 'chatid', 'wid', 'session', 'secret',
]);

/**
 * Scrub string: replace phone-like substrings with [REDACTED].
 * @param {string} str
 * @returns {string}
 */
function scrubPhones(str) {
  if (typeof str !== 'string') return str;
  return str.replace(PHONE_PATTERN, '[REDACTED]');
}

/**
 * Recursively scrub event payload: remove sensitive headers, scrub phone numbers in strings.
 * @param {object} obj - Mutable object to scrub in place
 */
function scrubPayload(obj) {
  if (obj == null) return;
  if (typeof obj === 'string') return;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      if (typeof item === 'string') obj[i] = scrubPhones(item);
      else if (item && typeof item === 'object') scrubPayload(item);
    });
    return;
  }
  for (const key of Object.keys(obj)) {
    const keyLower = key.toLowerCase();
    if (SENSITIVE_KEYS.has(keyLower)) {
      delete obj[key];
      continue;
    }
    const v = obj[key];
    if (typeof v === 'string') obj[key] = scrubPhones(v);
    else if (v && typeof v === 'object') scrubPayload(v);
  }
}

/**
 * Initialize Sentry. Call once at startup before any other app code.
 * If SENTRY_DSN is not set, Sentry is disabled and no-op.
 * @returns {Promise<void>}
 */
async function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || dsn.trim() === '') {
    enabled = false;
    return;
  }

  // Resolve instance id: env override > GCP metadata > 'unknown'
  const envInstanceId = process.env.WA_HUB_INSTANCE_ID?.trim();
  const envInstanceName = process.env.WA_HUB_INSTANCE_NAME?.trim();
  if (envInstanceId) {
    resolvedInstanceId = envInstanceId;
    if (envInstanceName) resolvedInstanceName = envInstanceName;
  } else {
    try {
      const [id, name, zone] = await Promise.all([
        getGcpInstanceId(),
        getGcpInstanceName(),
        getGcpZone(),
      ]);
      if (id) resolvedInstanceId = String(id);
      if (name) resolvedInstanceName = String(name);
      if (zone) resolvedZone = String(zone);
    } catch (_) {
      resolvedInstanceId = 'unknown';
    }
  }

  const environment = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production';
  const release = process.env.SENTRY_RELEASE || undefined;
  const tracesSampleRate = Math.min(1, Math.max(0, parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE, 10) || 0.05));
  const profilesSampleRate = Math.min(1, Math.max(0, parseFloat(process.env.SENTRY_PROFILES_SAMPLE_RATE, 10) || 0));

  Sentry.init({
    dsn,
    environment,
    release: release || undefined,
    tracesSampleRate,
    profilesSampleRate,
    sendDefaultPii: false,
    enableLogs: true,
    integrations: [
      Sentry.consoleLoggingIntegration({ levels: ['log', 'warn', 'error'] }),
    ],
    beforeSend(event) {
      if (!event) return event;
      // Attach instance tags to every event
      event.tags = event.tags || {};
      event.tags.gcp_instance_id = resolvedInstanceId;
      if (resolvedInstanceName) event.tags.gcp_instance_name = resolvedInstanceName;
      // Scrub request headers
      if (event.request && event.request.headers) {
        const headers = event.request.headers;
        if (headers.Authorization) delete headers.Authorization;
        if (headers.Cookie) delete headers.Cookie;
        if (headers['x-api-key']) delete headers['x-api-key'];
      }
      // Scrub extra/contexts
      if (event.extra) scrubPayload(event.extra);
      if (event.contexts) scrubPayload(event.contexts);
      if (event.message) event.message = scrubPhones(event.message);
      return event;
    },
  });

  Sentry.setTag('gcp_instance_id', resolvedInstanceId);
  if (resolvedInstanceName) Sentry.setTag('gcp_instance_name', resolvedInstanceName);
  Sentry.setContext('runtime', {
    nodeVersion: process.version,
    pid: process.pid,
    platform: process.platform,
  });
  Sentry.setContext('gcp', {
    instance_id: resolvedInstanceId,
    instance_name: resolvedInstanceName || undefined,
    zone: resolvedZone || undefined,
  });

  // Boot breadcrumb
  Sentry.addBreadcrumb({
    category: 'process',
    message: 'boot',
    level: 'info',
  });

  enabled = true;
}

/**
 * @param {Error|unknown} err
 * @param {Record<string, any>} [extra]
 */
function captureException(err, extra = undefined) {
  if (!enabled) return;
  if (extra && typeof extra === 'object') scrubPayload(extra);
  Sentry.withScope((scope) => {
    if (extra) scope.setExtras(extra);
    Sentry.captureException(err);
  });
}

/**
 * @param {string} message
 * @param {'info'|'warning'|'error'} [level]
 * @param {Record<string, any>} [extra]
 */
function captureMessage(message, level = 'info', extra = undefined) {
  if (!enabled) return;
  const msg = scrubPhones(message);
  if (extra && typeof extra === 'object') scrubPayload(extra);
  Sentry.withScope((scope) => {
    if (extra) scope.setExtras(extra);
    Sentry.captureMessage(msg, level);
  });
}

/**
 * @param {import('@sentry/node').Breadcrumb} breadcrumb
 */
function addBreadcrumb(breadcrumb) {
  if (!enabled) return;
  if (breadcrumb.message) breadcrumb.message = scrubPhones(breadcrumb.message);
  if (breadcrumb.data && typeof breadcrumb.data === 'object') scrubPayload(breadcrumb.data);
  Sentry.addBreadcrumb(breadcrumb);
}

/**
 * Run callback with a new scope (e.g. to set context or fingerprint).
 * @param {(scope: import('@sentry/node').Scope) => void} fn
 */
function withScope(fn) {
  if (!enabled) {
    if (typeof fn === 'function') fn({ setTag: () => {}, setContext: () => {}, setExtra: () => {}, setFingerprint: () => {} });
    return;
  }
  Sentry.withScope(fn);
}

/**
 * Flush and optionally close. Use before process.exit to ensure events are sent.
 * @param {number} [timeoutMs] - Default 2000
 * @returns {Promise<boolean>}
 */
function close(timeoutMs = 2000) {
  if (!enabled) return Promise.resolve(true);
  return Sentry.close(timeoutMs);
}

/** Whether Sentry is active (DSN was set and init succeeded). */
function isEnabled() {
  return enabled;
}

/** Resolved instance id for logging (never sent as PII in extra, only as tag). */
function getInstanceId() {
  return resolvedInstanceId;
}

/**
 * Create a span for meaningful operations (tracing). No-op when Sentry disabled.
 * Supports sync or async callbacks; when callback returns a Promise, that Promise is returned.
 * @param { { op: string; name?: string; attributes?: Record<string, string | number | boolean> } } options
 * @param {(span: import('@sentry/node').Span) => T} callback - sync or async
 * @returns {T}
 */
function startSpan(options, callback) {
  if (!enabled) {
    const fakeSpan = { setAttribute: () => {}, setAttributes: () => {} };
    return callback(fakeSpan);
  }
  return Sentry.startSpan(options, callback);
}

/** Sentry logger (use when Sentry enabled for structured logs). Prefer captureMessage for one-off. */
function getLogger() {
  return enabled ? Sentry.logger : null;
}

module.exports = {
  initSentry,
  captureException,
  captureMessage,
  addBreadcrumb,
  withScope,
  close,
  isEnabled,
  getInstanceId,
  scrubPhones,
  startSpan,
  getLogger,
};
