# Instance Manager & Lifecycle Reference

This document answers detailed questions about the current implementation of instance creation, state machine, event handlers, reconnect logic, delete/purge, Puppeteer launch options, restore on startup, and launchpad. All paths are relative to the repo root.

---

## 1. createClient(), setupEventListeners(), and client.initialize() flow

**File:** `src/instance-manager.js`

### createClient(instanceId, instanceName)

Creates a WhatsApp Web client with LocalAuth and Puppeteer. Uses `launchOptions.getPuppeteerLaunchOptions(instanceId)` and optional `executablePath` from `getChosenExecutablePath()`.

```javascript
// src/instance-manager.js (lines ~1121–1158)
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

  logLaunchContext(instanceId, { ... });

  return new Client({
    authStrategy: new LocalAuth({
      clientId: sanitizedClientId,
      dataPath: config.authBaseDir,
    }),
    puppeteer: puppeteerConfig,
  });
}
```

### setupEventListeners(instanceId, client)

Attaches all lifecycle and message listeners. Handlers are side-effect safe: state transitions first, webhooks fire-and-forget so the event loop is not blocked.

**Events attached:** `qr`, `authenticated`, `ready`, `auth_failure`, `disconnected`, `change_state`, `message`, `message_create`, `vote_update`.

### client.initialize() flow (createInstance)

In `createInstance()` the flow is:

1. `client = await createClient(instanceId, name)`
2. `setupEventListeners(instanceId, client)`
3. `startPopupDismisser(client, ...)`
4. `instance.transitionTo(InstanceState.STARTING_BROWSER, ...)`
5. `await client.initialize()`
6. `instance.transitionTo(InstanceState.CONNECTING, ...)`
7. `enableSyncLiteInterception(client, instanceId)`
8. `await Promise.race([ waitForReadyEvent(instanceId), timeout(initTimeoutMs) ])` — waits for either `ready` or QR (or timeout)

```javascript
// src/instance-manager.js (lines ~2135–2173, simplified)
client = await createClient(instanceId, name);
instance.client = client;
setupEventListeners(instanceId, client);
startPopupDismisser(client, `[${instanceId}]`);
instance.transitionTo(InstanceState.STARTING_BROWSER, `launching browser (attempt ${attempt}/${maxAttempts})`);
await client.initialize();
instance.transitionTo(InstanceState.CONNECTING, `initializing (attempt ${attempt}/${maxAttempts})`);
const { enableSyncLiteInterception } = require('./utils/syncLiteInterception');
enableSyncLiteInterception(client, instanceId);
await Promise.race([
  waitForReadyEvent(instanceId).catch(() => {}),
  new Promise((_, reject) => setTimeout(() => reject(new Error('Initialization timeout - no QR or ready event')), readyTimeout)),
]).catch((timeoutError) => {
  if (instance.qrCode) { /* QR received, OK */ return; }
  throw timeoutError;
});
```

---

## 2. State machine (InstanceState and transitions)

**File:** `src/instance-manager.js`

### InstanceState enum

```javascript
// src/instance-manager.js (lines 39–49)
const InstanceState = {
  READY: 'ready',
  STARTING_BROWSER: 'starting_browser',  // Launching Chromium (before CONNECTING)
  CONNECTING: 'connecting',
  DISCONNECTED: 'disconnected',
  NEEDS_QR: 'needs_qr',
  ERROR: 'error',
  RESTRICTED: 'restricted',   // Detected restriction – long cooldown, no reconnect
  PAUSED: 'paused',           // Cooldown or rate limit – pause sends, no reconnect until window expires
  FAILED_QR_TIMEOUT: 'failed_qr_timeout',  // Stuck in NEEDS_QR past TTL / max recovery attempts
};
```

**Note:** There is no `SYNCING` in InstanceState. “Syncing” is a **system mode** (normal vs syncing) in `src/systemMode.js`: when any instance is in CONNECTING, NEEDS_QR, or STARTING_BROWSER, system mode is `syncing`; when all are READY or terminal, it is `normal`.

### How transitions happen

- **transitionTo(newState, reason)** (InstanceContext method, ~208–296): sets `this.state = newState`, updates `lastStateChangeAt`, calls `systemMode.enterSyncing(this.id)` when entering STARTING_BROWSER/CONNECTING/NEEDS_QR, then `systemMode.recomputeFromInstances()`. State-specific side effects:
  - **READY:** clear watchdogs/cooldowns, start health check, resolve ready promise, start send loop if queue non-empty.
  - **DISCONNECTED:** clear health check, stop send loop, reject ready promise.
  - **NEEDS_QR / ERROR / RESTRICTED / PAUSED / FAILED_QR_TIMEOUT:** stop send loop, clear connecting watchdog (except PAUSED), reject ready promise.

Transitions are triggered from:

- **qr:** → `NEEDS_QR` (unless already READY, then ignored).
- **authenticated:** if current state is NEEDS_QR → `CONNECTING` (“authenticated, syncing”).
- **ready:** → `READY` via `markReady('event')`.
- **auth_failure:** → `NEEDS_QR`.
- **disconnected:** → `RESTRICTED` (if restriction-like reason), or `NEEDS_QR` (terminal: LOGOUT/UNPAIRED/CONFLICT/TIMEOUT), or `PAUSED` (cooldown); if `DISABLE_AUTO_RECONNECT` then `DISCONNECTED`.
- **createInstance:** STARTING_BROWSER → CONNECTING → (READY or NEEDS_QR or ERROR from timeout/failure).
- **ensureReady:** after soft/hard restart success → READY; on failure with QR during restart → NEEDS_QR, else → ERROR.
- **processQueueItem:** on “disconnect” errors → DISCONNECTED and ensureReady.
- **Connecting watchdog:** stuck in CONNECTING/NEEDS_QR too long → ERROR after max restarts.
- **NEEDS_QR watchdog:** stuck NEEDS_QR past TTL / max recovery → FAILED_QR_TIMEOUT.

---

## 3. Exact code: qr event and authenticated event

**File:** `src/instance-manager.js`

### qr event (lines ~1176–1209)

```javascript
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
```

### authenticated event (lines ~1352–1373)

```javascript
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
```

---

## 4. ready, disconnected, change_state, auth_failure handlers (summary)

**File:** `src/instance-manager.js`

- **ready:** calls `markReady('event')` (idempotent), which sets `readyInProgress`, clears ready watchdog/poll, sets client info, `transitionTo(InstanceState.READY)`, starts send loop and message fallback poller, forwards webhook.
- **auth_failure:** clears watchdogs/pollers, sets `lastAuthFailureAt` / `lastError`, `transitionTo(InstanceState.NEEDS_QR, \`Auth failure: ${msg}\`)`, forwards webhook.
- **disconnected:** restriction check → RESTRICTED; terminal reasons (LOGOUT/UNPAIRED/CONFLICT/TIMEOUT) → NEEDS_QR; else cooldown → PAUSED and timer to later transition to DISCONNECTED and call `ensureReady(instanceId)` (unless `DISABLE_AUTO_RECONNECT`).
- **change_state:** log and forward webhook only; no InstanceState change.

---

## 5. Reconnect / ensureReady / restart logic (and fallback poll, processQueueItem)

**File:** `src/instance-manager.js`

### ensureReady(instanceId) (lines ~1687–1787)

- Throws if NEEDS_QR, ERROR, FAILED_QR_TIMEOUT, or RESTRICTED (or PAUSED with cooldowns still active).
- If READY, returns.
- If restart rate limit hit → transition to PAUSED, schedule a single auto-wake timer that calls `ensureReady(instanceId)` again, then throws.
- Acquires reconnection lock, records restart attempt, applies backoff from `config.restartBackoffSequenceMs`.
- **Attempt 1:** soft restart (`softRestartAndWaitReady`): destroy client, then `client.initialize()`, then `waitForReadyEvent`.
- **Attempt 2:** hard restart (`hardRestartAndWaitReady`): destroy client, `createClient` + `setupEventListeners` + `client.initialize()`, then `waitForReadyEvent`.
- On hard failure: if `instance.qrReceivedDuringRestart` → NEEDS_QR, else → ERROR. Always releases lock.

### softRestartAndWaitReady / hardRestartAndWaitReady

- **Soft:** `instance.client.destroy()` then `instance.client.initialize()`, then `waitForReadyEvent`.
- **Hard:** destroy old client, `createClient` → `setupEventListeners` → `startPopupDismisser` → `client.initialize()` → `waitForReadyEvent`.

### runMessageFallbackPoll (lines ~1304–1342)

- Runs only when instance is READY and system allows background task.
- Fetches chats, unread chats, messages; calls `processIncomingMessage` for incoming messages.
- On error: if `ProtocolError` or message includes `Execution context was destroyed`, only `clearMessageFallbackPoller()` — **no** transition to DISCONNECTED and **no** ensureReady (to avoid reconnect loops).

### processQueueItem (lines ~1793–1982)

- Checks ready/rate limits/idempotency, then sends message or poll (with optional typing).
- On send error:
  - **“No LID for user”:** log once, `idempotencyStore.markFailed`, return true (remove from queue), no retry.
  - **Disconnect-like errors** (`Session closed`, `disconnected`, `null`, `evaluate`, `Execution context was destroyed`, `Protocol error`, `ProtocolError`, `Failed to launch`): transition to DISCONNECTED, set `nextAttemptAt` (backoff), and if not NEEDS_QR call `ensureReady(instanceId)`; return false (keep item).
  - **Other errors:** increment attemptCount, set `nextAttemptAt` (exponential backoff), log; after 5 attempts call `idempotencyStore.markFailed`; return false.

### Watchdogs

- **Ready watchdog:** started on qr/authenticated; on timeout calls `onReadyWatchdogTimeout` (can trigger ensureReady/pause logic).
- **Connecting watchdog:** started when entering CONNECTING (e.g. after soft/hard restart); if stuck in CONNECTING/NEEDS_QR for `connectingWatchdogMs` with no progress, restarts client; after `connectingWatchdogMaxRestarts` transitions to ERROR.
- **NEEDS_QR watchdog:** if instance stays in NEEDS_QR past TTL / max recovery attempts, transition to FAILED_QR_TIMEOUT.

---

## 6. Delete instance logic and purgeLocalAuthSession

**File:** `src/instance-manager.js`

### deleteInstance(instanceId) (lines ~2569–2657)

1. Clear all timers (ready watchdog, ready poll, message fallback poller, connecting watchdog, health check, disconnect cooldown, rate-limit wake).
2. Stop send loop.
3. `idempotencyStore.deleteByInstanceName(instanceName)`.
4. `revokeViewSessionTokensByInstanceId(instanceId)`.
5. `deleteChromiumLogForInstance(instanceId)`.
6. Remove from `instances` map, then `saveInstancesToDisk()`.
7. If client exists: `client.logout()` then `client.destroy()` with `deleteDestroyTimeoutMs` race.
8. If instance was not in map, try to remove it from persisted instances file only.
9. **Auth files are not deleted:** `result.purged = false`, `result.purgedPaths = []`. No call to `purgeLocalAuthSession`.

```javascript
// src/instance-manager.js (lines 2646–2649)
// Auth files are never deleted: instance is removed from app but session dir is left on disk.
result.purged = false;
result.purgedPaths = [];
```

### purgeLocalAuthSession(instanceId) (lines ~2526–2557)

Still **defined** in `src/instance-manager.js` but **not called** anywhere (per “never delete auth files”):

- Builds candidate dirs: `session-${sanitizedId}`, `sanitizedId`, `Default-${sanitizedId}` under `config.authBaseDir`.
- For each, if directory exists, `fs.rm(dirPath, { recursive: true, force: true })`.
- Returns `{ purged, purgedPaths, warnings }`.

No caller in createInstance (session-logged-out path), QR recovery nuclear path, or deleteInstance.

---

## 7. Puppeteer launch options and Chromium args

**File:** `src/browser/launchOptions.js`

### Base Chromium args (lines 39–72)

```javascript
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
```

### getChromiumLaunchArgs(instanceId) (lines 122–147)

- If `config.chromeDisableSandbox` → add `--no-sandbox`, `--disable-setuid-sandbox`.
- If `config.chromeUseNoZygote && config.chromeDisableSandbox` → add `--no-zygote`.
- Append `BASE_ARGS`.
- If `config.chromeArgsExtra` → append split tokens.
- If `instanceId` provided → add `--enable-logging`, `--v=1`, `--log-file=<CHROME_LOG_DIR>/wa-hub-chrome-<safeId>.log`.
- `validateAndFixSandboxZygote(args)` (ensures `--no-zygote` is never used without `--no-sandbox`).
- Return args.

### getPuppeteerLaunchOptions(instanceId) (lines 155–167)

- `args = getChromiumLaunchArgs(instanceId)`.
- Return `{ headless: true, args, timeout: config.chromeLaunchTimeoutMs || 60000 }`, and if `config.puppeteerDumpio` then `dumpio: true`.

### Executable path

- `getChosenExecutablePath()`: `PUPPETEER_EXECUTABLE_PATH` if set; else first existing of `/usr/bin/google-chrome-stable`, `/usr/bin/chromium`; else `null` (Puppeteer bundled).

Config (from `src/config.js`): `chromePath`, `chromeDisableSandbox`, `chromeUseNoZygote`, `chromeArgsExtra`, `chromeLaunchTimeoutMs`, `puppeteerDumpio`, `puppeteerExecutablePath`, `CHROME_LOG_DIR` (env, default `/tmp`).

---

## 8. loadInstancesFromDisk() and restore logic on startup

**File:** `src/instance-manager.js` (loadInstancesFromDisk ~2768–2841), **File:** `src/restoreScheduler.js`

### loadInstancesFromDisk() (lines ~2768–2841)

1. Read `config.instancesDataPath` (e.g. `./.wwebjs_instances.json`). If not array or empty, return.
2. For each entry `d`, call `restoreScheduler.enqueue({ id, name, webhookUrl, webhookEvents, typingIndicatorEnabled, applyTypingTo })`.
3. Define `createFn(item)`:
   - If `item.type === 'retry'`: call `retryInstance(item.instanceId)`; return.
   - If `instances.has(item.id)`: call `teardownInstanceForRestoreRetry(item.id)` (clear timers, close browser, remove from map; no purge).
   - Then `createInstance(item.id, item.name, { url, events, typingIndicatorEnabled, applyTypingTo })`.
4. Define `markFailedFn(item, message)`: call `createInstanceStub(item.id, item.name, webhookConfig, message)` (stub in ERROR state).
5. Call `restoreScheduler.startSchedulerLoop(createFn, markFailedFn)`.

### teardownInstanceForRestoreRetry(instanceId) (lines ~2734–2758)

- Clears all instance timers and stop send loop.
- If client exists: remove page listeners, `client.pupBrowser.close()`, set `instance.client = null`.
- `instances.delete(instanceId)` and `systemMode.recomputeFromInstances(getAllInstances)`.
- Does **not** purge auth; allows a fresh `createInstance` for the same id on retry.

### restoreScheduler.js

- **Queue:** array of items `{ id, name, webhookUrl, webhookEvents, typingIndicatorEnabled, applyTypingTo, type?, attempts?, nextAttemptAfter? }` or `{ type: 'retry', instanceId }`.
- **processNext(createFn, markFailedFn):** if not processing and queue non-empty, enforces cooldown (`restoreCooldownMs`) and free memory gate (`restoreMinFreeMemMb`). Pops one item (respecting `nextAttemptAfter`), calls `createFn(item)`. On reject: if retry type, log and return; else increment attempts; if `attempts >= restoreMaxAttempts` call `markFailedFn(item, message)`; else re-enqueue with `nextAttemptAfter = now + backoff`.
- **startSchedulerLoop(createFn, markFailedFn):** setInterval every 10s calling `processNext(createFn, markFailedFn)`.

Config: `restoreConcurrency` (1), `restoreCooldownMs` (30s), `restoreMinFreeMemMb` (800), `restoreMaxAttempts` (5), `restoreBackoffBaseMs` (15s).

---

## 9. Launchpad-related code (leave untouched when parking)

### Config (`src/config.js`, lines 163–175, 184–191)

- `gcpProjectId`, `gcsBucketName`, `launchpadVmName`, `launchpadZone`, `launchpadInternalUrl`, `launchpadStartTimeoutMs`, `launchpadSyncTimeoutMs`, `launchpadUseOnDemand`, `launchpadInternalSecret`, `useLaunchpadForOnboarding`, `isLaunchpad`, `launchpadRepoUrl`.
- If `useLaunchpadForOnboarding` or `isLaunchpad`: require `GCP_PROJECT_ID` and `LAUNCHPAD_INTERNAL_SECRET`.

### Router (`src/router.js`)

- **POST /instances:** when `config.useLaunchpadForOnboarding`, create via `instanceManager.createInstanceViaLaunchpad(sessionId, name, webhookConfig)`; else `instanceManager.createInstance(...)`.
- **Launchpad internal (when `config.isLaunchpad`):** `launchpadSecretAuth` middleware; **POST /onboard** (create on launchpad, wait for ready, zip session + instances, upload to GCS); **GET /status/:id**.
- **POST /admin/launchpad/warm** and **POST /admin/launchpad/stop** (require admin debug when configured).

### Instance manager (`src/instance-manager.js`, lines 2229–2296)

- `createInstanceViaLaunchpad(instanceId, name, webhookConfig)`: loop up to `LAUNCHPAD_MAX_ATTEMPTS`; `gcpManager.startLaunchpad()` for `baseUrl`; POST `${baseUrl}/onboard` with `instanceId`, `name`, `webhookConfig`; on success download session zip from GCS and extract to `config.authBaseDir`, merge instances JSON, stop launchpad VM, then call `createInstance(instanceId, name, webhookConfig)` locally.
- Exported as `createInstanceViaLaunchpad` for the router.

### GCP manager (`src/gcp-manager.js`)

- `waitForLaunchpadHealth(baseUrl)` polls `/health` until OK or timeout.
- `startLaunchpad()`: ensure GCP VM running (create if needed), wait for app health, return `{ baseUrl }`.
- `stopLaunchpad()`: stop VM.
- Also GCS helpers used by launchpad flow: `uploadZipToGCS`, `downloadZipFromGCS`, `downloadFileFromGCS`.

When parking launchpad: leave the above files and branches as-is; disable by setting `USE_LAUNCHPAD_FOR_ONBOARDING=false` and `IS_LAUNCHPAD=false` so creation uses `createInstance` only and launchpad routes are not used.
