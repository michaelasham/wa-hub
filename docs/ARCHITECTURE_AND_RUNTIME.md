# wa-hub: Architecture & Runtime (Q&A)

Answers to common questions about app structure, session management, API, deployment, GCP, storage, and config.

---

## 1. Overall app structure

- **Main app:** Node.js with **Express** (v5). Single repo; **not** a monorepo in the Nx/Lerna sense, but the repo contains two runnable apps:
  - **wa-hub** (backend): `src/index.js` → Express server on port 3000.
  - **wa-hub-dashboard**: Next.js 16 app in `wa-hub-dashboard/` on port 3001.
- **Integration:** wa-hub is **not** consumed as a library. External apps (e.g. WASP/Shopify) call wa-hub’s **REST API** (HTTP + API key). The dashboard is a separate Next.js app that also calls the same REST API. No custom wrappers or CLI around wa-hub beyond the PM2 ecosystem file and optional scripts (e.g. `scripts/test-sentry.js`, `scripts/ops/`).

---

## 2. WhatsApp session management

- **Library:** whatsapp-web.js with **LocalAuth**.
- **Initialization:** One instance = one whatsapp-web.js `Client`. The client is created in **instance-manager** (`createClient()`), with:
  - `authStrategy: new LocalAuth({ clientId: sanitizedInstanceId, dataPath: config.authBaseDir })`
  - Puppeteer/Chromium options from `src/browser/launchOptions.js` (args, executable path).
- **QR / syncing:** Event listeners are attached before `client.initialize()`: `qr`, `authenticated`, `ready`, `auth_failure`, `disconnected`, `change_state`. QR is converted to base64 and returned via `GET /instances/:id/client/qr` and/or sent to the instance’s webhook. On `authenticated`, the app waits for `ready` (with optional ready-poll fallback). No multi-device flag; single WhatsApp Web session per instance.
- **Session resumption:** After restart, `loadInstancesFromDisk()` reads the instance list from disk and calls `createInstance()` for each entry; each client uses LocalAuth so session data is restored from the same `dataPath` (no re-QR if the session dir is intact).
- **Auth/session files:**
  - **Path:** `config.authBaseDir` (env: `AUTH_BASE_DIR` or `SESSION_DATA_PATH`), default `./.wwebjs_auth`.
  - **Layout:** LocalAuth creates subdirs per instance, e.g. `session-{clientId}/` (or `{clientId}/`, `Default-{clientId}/`). Contents are whatever whatsapp-web.js/LocalAuth write (browser profile, tokens, etc.) — not hand-edited JSON.
  - **Instance list:** Stored in a **JSON file** at `config.instancesDataPath` (env: `INSTANCES_DATA_PATH`), default `./.wwebjs_instances.json`. Format: array of objects with `id`, `name`, `webhook`, etc. Written by `saveInstancesToDisk()`, read by `loadInstancesFromDisk()`.

---

## 3. Multi-instance handling

- **Model:** Single Node process; **in-process manager** (no separate processes or worker threads per instance). All instances live in a **Map** (`instances`) in `instance-manager.js`, keyed by instance id. Each entry is an **InstanceContext** (state machine, queue, client reference, timers, etc.).
- **Trigger for new instance:** A new instance is created when the API receives **POST /instances** with `name`, `webhook.url`, and optional `webhook.events`. That calls `instanceManager.createInstance(id, name, webhookConfig)`, which creates the context, persists the instance list, and starts the client (createClient + setupEventListeners + initialize). There is no automatic discovery; onboarding is entirely via this API (typically called by the main app or dashboard when a new shop/tenant is added).

---

## 4. API / endpoints

- **Web framework:** **Express**; routes are mounted in `src/router.js` (and a few on `app` in `src/index.js`).
- **Exposure:** Backend listens on `config.port` (default **3000**). No built-in HTTPS; in production, HTTPS is typically provided by a reverse proxy or load balancer. External callers (Shopify app, dashboard) use the VM’s URL (e.g. `http(s)://<host>:3000`) and send **API_KEY** via `Authorization: Bearer <key>` or `X-API-Key`.
- **Endpoints related to WhatsApp / instances:**

| Method + path | Purpose |
|----------------|--------|
| GET /health | Liveness (no auth); CPU, memory, instance count. |
| GET /instances | List instances (metadata only). |
| POST /instances | Create instance (name, webhook); starts client and QR flow. |
| PUT /instances/:id | Update instance (e.g. name, webhook). |
| DELETE /instances/:id | Hard delete: destroy client, remove from list, purge LocalAuth dir. |
| GET /instances/:id/client/qr | Get current QR as base64 (or 404 if not in needs_qr). |
| GET /instances/:id/client/status | Client state (ready/connecting/needs_qr/error/etc.). |
| GET /instances/:id/client/info-raw | Raw client info (for debugging). |
| GET /instances/:id/client/me | “Me” info (phone, name) when ready. |
| POST /instances/:id/client/action/send-message | Send text message (body: chatId, message). |
| POST /instances/:id/client/action/create-poll | Create/send poll. |
| POST /instances/:id/client/action/logout | Logout and transition to needs_qr. |
| GET /instances/:id/queue | Get send queue for instance. |
| DELETE /instances/:id/queue | Clear queue. |
| POST /instances/:id/queue/trigger | Trigger send loop. |
| GET /instances/:id/status | Instance status (legacy shape). |
| GET /instances/:id/diagnostics | Diagnostics (state, last events, errors). |
| POST /instances/:id/restart | Soft/hard restart client. |
| POST /instances/:id/retry | Retry after error (e.g. re-init). |
| POST /instances/:id/view-session | Start “view session” (remote debugging) and return token/URL. |
| POST /view-session/revoke | Revoke view session. |
| GET /view-session/screenshot | Screenshot (view session). |
| POST /view-session/click | Click (view session). |
| POST /view-session/scroll | Scroll (view session). |
| GET /system/status | System mode (normal/syncing), instance count; used by dashboard for “Low Power Mode”. |
| GET /__debug/system | Debug: system mode + instances (requires X-Admin-Debug-Secret). |
| GET /__debug/env | Debug: env keys only (requires admin secret). |
| POST /__debug/instances/:id/retry | Debug: retry instance (requires admin secret). |
| GET /internal/test-sentry | Dev only: trigger test error for Sentry (404 in production). |

- **Shopify / webhooks:** wa-hub does not implement Shopify OAuth or webhooks itself. Your main app (e.g. WASP) receives Shopify webhooks and, when it needs to send WhatsApp or manage a session, calls wa-hub’s API (create instance, get QR, send message, etc.). wa-hub can **send** webhooks to a URL you configure per instance (e.g. to your app) when WhatsApp events occur (qr, ready, message, etc.), using `WEBHOOK_SECRET` and optional `WEBHOOK_AUTH_TOKEN` for signing/auth.

---

## 5. VM / app runtime

- **Process manager:** **PM2**. One ecosystem file at repo root: `ecosystem.config.js`.
  - **wa-hub:** `script: './src/index.js'`, `instances: 1`, `exec_mode: 'fork'`, `PORT: 3000`, `NODE_ENV: production`, `max_memory_restart: '1G'`.
  - **wa-hub-dashboard:** `script: 'npm', args: 'run start'`, `cwd: wa-hub-dashboard`, `PORT: 3001`, `NODE_ENV: production`; env vars such as `WA_HUB_BASE_URL`, `WA_HUB_TOKEN`, `DASHBOARD_PASSWORD`, etc. are passed from the host env.
- **OS:** Typically **Ubuntu/Debian** (e.g. on GCP). Not tied to a specific distro; needs Node, Chromium (or Chrome), and enough memory for multiple Chromium instances.
- **Startup:** `pm2 start ecosystem.config.js` (from repo root). No separate systemd unit or startup script is required if PM2 is managed by the user or a startup script that runs `pm2 start` and optionally `pm2 save` / `pm2 startup`.
- **Env vars:** All wa-hub config is via **environment variables** (see `.env.example` and `src/config.js`). Backend loads `.env` in the repo root via `dotenv` in `config.js`. For GCP/wa-hub specifically: `WA_HUB_INSTANCE_ID`, `WA_HUB_INSTANCE_NAME` (optional, for Sentry tagging), and Chromium-related vars (`CHROME_PATH`, `CHROME_DISABLE_SANDBOX`, etc.) are the main ones for VM runs.

---

## 6. GCP interactions

- **In code:** No **@google-cloud/compute** (or other GCP SDK) and no **gcloud** CLI calls via child_process. The only GCP interaction is **read-only** use of the **GCP metadata server** for Sentry tagging:
  - **Module:** `src/infra/gcpMetadata.js`.
  - **Usage:** HTTP GET to `http://metadata.google.internal/computeMetadata/v1/instance/id`, `.../instance/name`, `.../instance/zone` with header `Metadata-Flavor: Google`. Results are cached in memory. Used only to set Sentry tags (`gcp_instance_id`, `gcp_instance_name`) and context; no VM control, no auth beyond the metadata server (which is available by default on GCP VMs).
- **Auth:** No service account keys or Application Default Credentials are required for this; the metadata server is available to the process when running on a GCP Compute Engine VM. If not on GCP or metadata is unreachable, the code falls back to `WA_HUB_INSTANCE_ID` / `WA_HUB_INSTANCE_NAME` from env or `'unknown'`.

---

## 7. Data storage / transfer

- **Between VMs:** There is **no** built-in file transfer between VMs (no GCP Cloud Storage, SCP, or shared disk in the codebase). Instance list and LocalAuth/session data are **local to the VM**. To move sessions to another VM you would need to implement your own approach (e.g. copy `.wwebjs_auth` and `.wwebjs_instances.json` via Cloud Storage, SCP, or a shared filesystem) and ensure the new process uses the same paths (e.g. same `AUTH_BASE_DIR` / `INSTANCES_DATA_PATH`).
- **File storage in app:** All persistence is **local filesystem**:
  - Instance list: JSON file at `INSTANCES_DATA_PATH`.
  - Session data: LocalAuth dirs under `AUTH_BASE_DIR`.
  - Idempotency: JSON file at `IDEMPOTENCY_DATA_PATH` (see `src/idempotency-store.js`).
  No upload/download API for these files; they are read/written by the Node process only.

---

## 8. Error handling / logging

- **Session init/sync errors:** Handled inside **instance-manager**: try/catch around client init, retries (e.g. 2 attempts), state transitions to `error` or `needs_qr`, and optional `ensureReady()` / restart/retry flows. Errors are logged with `console.error` and/or `debugLog()` (JSON to stdout). **Sentry** is used when `SENTRY_DSN` is set: `sentry.captureException()` in the Express error middleware, in uncaughtException/unhandledRejection handlers, and in key flows (e.g. send failures, restore failures); breadcrumbs and custom spans are added for lifecycle and send operations.
- **Event-style reporting:** wa-hub does not expose a generic event emitter for external subscribers; external integration is via **webhooks** (HTTP POST to instance webhook URL) and **REST API** responses. Internally, system mode (normal/syncing) is driven by instance state and exposed via `GET /system/status`.
- **Logging:** No Winston/Pino; **console** (stdout/stderr) plus **Sentry** (when enabled). Request logging middleware logs each request to stdout. Optional `consoleLoggingIntegration` in Sentry sends console log/warn/error to Sentry. Log level is not strictly enforced in code (e.g. by a LOG_LEVEL value); it’s more a convention for operators.

---

## 9. Dependencies / versions

- **Node.js:** Not pinned in package.json; README suggests **Node 16+**. In practice, current code runs on Node 18+ (e.g. @sentry/node 10).
- **wa-hub:** This repo; version in package.json is **1.0.0**.
- **whatsapp-web.js:** **^1.34.2** (Puppeteer is a dependency of whatsapp-web.js; wa-hub does not list Puppeteer directly in its package.json).
- **Other notable deps:** **express** ^5.2.1, **@sentry/node** ^10.39.0, **axios** ^1.13.2, **dotenv** ^16.4.5, **nanoid** ^5.1.6, **qrcode** ^1.5.3, **qrcode-terminal** ^0.12.0, **pidusage** ^4.0.1. Dashboard: **Next.js** 16.1.6, **React** 18, **@shopify/polaris** (and related).

---

## 10. Custom config (env) for wa-hub

Relevant env vars (see `.env.example` and `src/config.js` for full list):

- **Server:** `PORT`, `API_KEY`, `NODE_ENV`.
- **Webhook:** `WEBHOOK_SECRET`, `WEBHOOK_PROTECTION_BYPASS`, `WEBHOOK_AUTH_TOKEN`.
- **Paths:** `SESSION_DATA_PATH`, `AUTH_BASE_DIR`, `INSTANCES_DATA_PATH`, `IDEMPOTENCY_DATA_PATH`.
- **Chromium:** `CHROME_PATH`, `CHROME_DISABLE_SANDBOX`, `CHROME_USE_NO_ZYGOTE`, `CHROME_ARGS_EXTRA`, `PUPPETEER_EXECUTABLE_PATH`, `PUPPETEER_DUMPIO`, `PUPPETEER_DEBUG_LAUNCH`, `CHROME_LAUNCH_TIMEOUT_MS`, `CHROME_LOG_DIR`, `WAHUB_LOG_CHROME_ARGS`.
- **Instance lifecycle / restarts:** `READY_WATCHDOG_MS`, `DISABLE_AUTO_RECONNECT`, `MAX_QUEUE_SIZE`, `READY_TIMEOUT_MS`, `RESTART_BACKOFF_MS`, `MAX_RESTARTS_PER_WINDOW`, `RESTART_WINDOW_MINUTES`, `SOFT_RESTART_TIMEOUT_MS`, `HARD_RESTART_TIMEOUT_MS`, `INIT_TIMEOUT_MS`, `DELETE_DESTROY_TIMEOUT_MS`, and related backoff/cooldown vars.
- **Rate limiting:** `MAX_SENDS_PER_MINUTE_PER_INSTANCE`, `MAX_SENDS_PER_HOUR_PER_INSTANCE`; retry: `RETRY_BASE_BACKOFF_MS`, `RETRY_MAX_BACKOFF_MS`.
- **Low-power / sync:** `MAX_OUTBOUND_QUEUE`, `OUTBOUND_QUEUE_TTL_MS`, `OUTBOUND_DRAIN_DELAY_MS`, `INBOUND_*`, `SYNC_LITE_BLOCK_*`, `QR_SYNC_GRACE_MS`, `QR_STALE_MS`, `QR_TTL_MS`, `QR_MAX_RECOVERY_ATTEMPTS`, etc.
- **Restore:** `RESTORE_CONCURRENCY`, `RESTORE_COOLDOWN_MS`, `RESTORE_MIN_FREE_MEM_MB`, `RESTORE_MAX_ATTEMPTS`, `RESTORE_BACKOFF_BASE_MS`.
- **Sentry:** `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_PROFILES_SAMPLE_RATE`, `SENTRY_RELEASE`, `WA_HUB_INSTANCE_ID`, `WA_HUB_INSTANCE_NAME`.
- **Admin/debug:** `ADMIN_DEBUG_SECRET` (for `GET /__debug/*` and `GET /system/status` when used with dashboard).
- **Other:** `LOG_LEVEL`, `VIEW_SESSION_JWT_SECRET`, typing/mark-seen related vars.

There is no “multi-device mode” flag; each instance is a single WhatsApp Web session. Sync limits and headless behavior are controlled by the lifecycle/restart and Chromium env vars above (and by the built-in queue and rate limits in instance-manager).
