# wa-hub

Multi-tenant WhatsApp Web session manager service built with Node.js, Express, and whatsapp-web.js. This service provides a REST API for managing multiple WhatsApp Web sessions, sending messages, and forwarding webhook events.

## Features

- **Multi-tenant session management**: Each merchant/shop gets its own isolated WhatsApp Web session

## Canonical whatsapp-web.js lifecycle in wa-hub

wa-hub follows whatsapp-web.js best practices for session persistence and lifecycle:

1. **LocalAuth is the single source of truth** – Session data lives in `authBaseDir` (e.g. `./.wwebjs_auth/session-{clientId}/`). We do not mutate or delete it while a client is running. On `DELETE /instances/:id`, we destroy the client first, then purge the LocalAuth session directory.

2. **Event handlers before `initialize()`** – Listeners for `qr`, `authenticated`, `ready`, `auth_failure`, `disconnected`, `change_state` are attached before `client.initialize()`.

3. **State transitions are immediate** – In each lifecycle handler, we update `InstanceState` first. Webhook forwarding is fire-and-forget and never blocks state transitions.

4. **No custom `userDataDir`** – We do not set `puppeteer.userDataDir`; it would conflict with LocalAuth's session storage.

5. **Queue isolation** – The message queue and `ensureReady()` are independent of lifecycle events. Lifecycle handlers never await the queue or webhooks.

- **Persistent authentication**: Uses LocalAuth strategy with session-specific client IDs
- **RESTful API**: Full API implementation matching WAAPI endpoints
- **Webhook forwarding**: Automatically forwards WhatsApp events to your main application
- **Production-ready**: Includes error handling, logging, and PM2 deployment configuration

## Prerequisites

- Node.js 16+ 
- npm or yarn
- PM2 (for production deployment)
- Sufficient system resources for running multiple WhatsApp Web instances (Chrome/Puppeteer)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd wa-hub
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory:
```bash
cp .env.example .env
```

4. Configure environment variables in `.env`:
```env
PORT=3000
API_KEY=f0bdaeb85348f62f9d415e8bd749d251f5634e292ec61d7a133cd32ad71f1662
WEBHOOK_SECRET=your-shared-secret-here
CHROME_PATH=/usr/bin/chromium-browser
SESSION_DATA_PATH=./.wwebjs_auth
LOG_LEVEL=info
```

**Notes:** 
- A random API key has been generated for you. Use the one above or generate a new one:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- `CHROME_PATH` should point to your system's Chromium/Chrome. Common paths:
  - `/usr/bin/chromium-browser` (Ubuntu/Debian)
  - `/usr/bin/chromium` (some distributions)
  - `/usr/bin/google-chrome` (if using Chrome)
- Each instance must provide its own `webhook.url` when creating (no default webhook URL)

## Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PORT` | Server port | `3000` | No |
| `API_KEY` | API key for authentication (required for all endpoints except `/health`) | - | Yes |
| `WEBHOOK_SECRET` | Shared secret for webhook signature | - | Recommended |
| `WEBHOOK_PROTECTION_BYPASS` | Vercel deployment protection bypass secret (for webhook 401 fix) | - | No |
| `WEBHOOK_AUTH_TOKEN` | Bearer token sent with webhooks (if receiver requires Authorization header) | - | No |
| `READY_WATCHDOG_MS` | Timeout for ready event before soft-restart (ms) | `600000` (10 min) | No |
| `DELETE_DESTROY_TIMEOUT_MS` | Timeout for client.destroy() on delete before purge (ms) | `15000` (15s) | No |
| `CHROME_PATH` | Path to Chromium/Chrome executable for Puppeteer | `/usr/bin/chromium-browser` | No |
| `CHROME_DISABLE_SANDBOX` | Set to `1` to add `--no-sandbox` and `--disable-setuid-sandbox`. Default **1 on Linux**, 0 elsewhere (avoids "Zygote cannot be disabled if sandbox is enabled") | `1` on Linux | No |
| `CHROME_USE_NO_ZYGOTE` | Set to `1` to add `--no-zygote` (only applied when sandbox is disabled; never add `--no-zygote` without `--no-sandbox`) | `1` on Linux | No |
| `CHROME_ARGS_EXTRA` | Extra Chromium flags (space-separated) | - | No |
| `WAHUB_LOG_CHROME_ARGS` | Set to `1` to log full Chromium launch context (memory, versions) on each instance start | `0` | No |
| `PUPPETEER_DUMPIO` | Set to `1` to pipe Chromium stderr to process (see PM2 logs on launch failure) | `0` | No |
| `PUPPETEER_DEBUG_LAUNCH` | Set to `1` to log executable, memory, shm, /tmp on each launch | `0` | No |
| `CHROME_LAUNCH_TIMEOUT_MS` | Puppeteer launch timeout (ms) | `60000` | No |
| `RESTORE_CONCURRENCY` | Max concurrent restores on startup (use `1` on small VMs) | `1` | No |
| `RESTORE_COOLDOWN_MS` | Delay (ms) between each restore attempt | `30000` | No |
| `RESTORE_MIN_FREE_MEM_MB` | Do not start next restore if free memory below this (MB) | `800` | No |
| `RESTORE_MAX_ATTEMPTS` | Max restore attempts per instance before marking ERROR | `5` | No |
| `SESSION_DATA_PATH` | Path for storing WhatsApp session data | `./.wwebjs_auth` | No |
| `LOG_LEVEL` | Logging level | `info` | No |
| `TYPING_INDICATOR_ENABLED_DEFAULT` | Enable typing indicator by default for new instances | `true` | No |
| `TYPING_INDICATOR_MIN_MS` | Minimum typing duration (milliseconds) | `600` | No |
| `TYPING_INDICATOR_MAX_MS` | Maximum typing duration (milliseconds) | `1800` | No |
| `TYPING_INDICATOR_MAX_TOTAL_MS` | Maximum total time for typing + send (safety limit) | `2500` | No |
| `SENTRY_DSN` | Sentry DSN for error tracking (leave empty to disable) | - | No |
| `SENTRY_ENVIRONMENT` | Environment name (e.g. `production`, `staging`, `dev`) | `NODE_ENV` or `production` | No |
| `SENTRY_TRACES_SAMPLE_RATE` | Fraction of transactions to send for performance (0–1) | `0.05` | No |
| `SENTRY_PROFILES_SAMPLE_RATE` | Fraction of profiles to send (0 = off) | `0` | No |
| `SENTRY_RELEASE` | Release identifier (e.g. git SHA); optional | - | No |
| `WA_HUB_INSTANCE_ID` | Stable instance identifier for Sentry (overrides GCP metadata when set) | GCP instance id or `unknown` | No |
| `WA_HUB_INSTANCE_NAME` | Human-readable instance name for Sentry | - | No |

### Sentry (error tracking)

When `SENTRY_DSN` is set, wa-hub reports errors and breadcrumbs to Sentry. Every event is tagged with a **stable instance identifier** so you can filter by VM/instance (like shop domain in WASP).

- **DSN**: Set `SENTRY_DSN` in `.env` to your project DSN (Sentry → Project Settings → Client Keys (DSN)). Example format: `https://KEY@o4510933991030784.ingest.us.sentry.io/PROJECT_ID`.
- **Logs & tracing**: The SDK is initialized with `enableLogs: true` and `consoleLoggingIntegration({ levels: ['log', 'warn', 'error'] })` so `console.log`/`warn`/`error` are sent as structured logs. Custom spans are created for `POST /instances/:id/client/action/send-message` and for each WhatsApp send (`whatsapp.send`).
- **Instance ID**: Set `WA_HUB_INSTANCE_ID` to a fixed value (e.g. hostname or GCP instance name). If unset, the app tries the GCP metadata server (`metadata.google.internal`) and caches the instance id/name; outside GCP it uses `unknown` unless you set the env var.
- **PII / scrubbing**: Phone numbers, message bodies, tokens, cookies, QR data, and sensitive headers are **not** sent. Breadcrumbs and extras are scrubbed (phone-like patterns replaced, sensitive keys removed).
- **Breadcrumbs**: Process boot, WhatsApp client init, `qr_generated`, `authenticated`, `ready`, `auth_failure`, `disconnected`, browser restart, and send attempt/success/fail (with hashed chat id only).
- **How to verify**: In Sentry, open an issue or event and check the **Tags** panel for `gcp_instance_id` (and optionally `gcp_instance_name`). Use these to filter by instance in the Discover/Issues views.
- **Dev test**: With `SENTRY_DSN` set and `NODE_ENV` not `production`, run `npm run test-sentry` (with the server already running) or `curl -H "Authorization: Bearer YOUR_API_KEY" http://localhost:3000/internal/test-sentry` to trigger a test ReferenceError in Sentry. The route returns 404 in production.

### Authentication

All API endpoints (except `/health`) require authentication using an API key. Include the API key in requests using one of these methods:

1. **Authorization header (recommended):**
   ```bash
   Authorization: Bearer {API_KEY}
   ```

2. **X-API-Key header:**
   ```bash
   X-API-Key: {API_KEY}
   ```

The API key is configured via the `API_KEY` environment variable. If not set, authentication is disabled (development mode only).

### Chromium stability for multi-session WhatsApp

Login/sync can spike memory and trigger OOM or Chromium crashes on small VMs. Use these to keep instances stable:

- **Chromium flags**: wa-hub applies hardened launch args by default. On Linux, `CHROME_DISABLE_SANDBOX` and `CHROME_USE_NO_ZYGOTE` default to `1` so `--no-sandbox` and `--no-zygote` are set together (Chromium requires both if you use either). Set `CHROME_DISABLE_SANDBOX=0` only if you need sandbox enabled; never use `--no-zygote` without `--no-sandbox`.
- **Shared memory (/dev/shm)**: We always pass `--disable-dev-shm-usage` as a fallback. If you run in **Docker**, increase shared memory: `docker run --shm-size=1g ...` or in compose add `shm_size: "1gb"`. Otherwise Chromium may crash during QR/auth.
- **Swap on GCP VM (e2-medium 4GB)**: Add swap so the system doesn’t OOM during spikes:
  ```bash
  sudo ./scripts/ops/add-swap.sh 4G
  ```
- **Verify after a crash**: Run `./scripts/ops/check-oom.sh` to see OOM/killed process messages and current memory/swap; run `./scripts/ops/check-shm.sh` to see `/dev/shm` size and recommendations.

**How to diagnose "Failed to launch the browser process":**

1. **Get actionable errors**: On launch failure, wa-hub attaches a Chromium log tail to `instance.lastError` (visible in the dashboard tooltip and in `GET /instances` or `GET /__debug/system`). Enable extra diagnostics:
   - `PUPPETEER_DUMPIO=1` – Chromium stderr is piped to the process (so it appears in PM2 logs).
   - `PUPPETEER_DEBUG_LAUNCH=1` – Log executable path, headless, args count, uid/gid, total/free memory, `/dev/shm` size, disk free for `/tmp` on each launch.
2. **Reproduce**: Restart the instance (or the service), then check `lastError` on the failed instance (dashboard or API). The tail includes the last ~3.5k characters of the Chromium log when `CHROME_LOG_DIR` is writable (default `/tmp`).
3. **Small VMs**: Use sequential restore (`RESTORE_CONCURRENCY=1`, default), add swap (`scripts/ops/add-swap.sh 2G`), and set `RESTORE_MIN_FREE_MEM_MB=800` so the scheduler waits for free memory before launching the next instance.

See [scripts/ops/README.md](scripts/ops/README.md) for full ops script usage.

## Running Locally

### Development Mode

```bash
npm start
```

The service will start on `http://localhost:3000` (or the port specified in `PORT`).

### Testing Locally

To test the service with webhooks, use the included test webhook server:

**Terminal 1 - Start webhook receiver:**
```bash
npm run test-webhook
```

**Terminal 2 - Start wa-hub:**
```bash
npm start
```

Or use the test script to start both:
```bash
./start-test.sh
```

See [TESTING.md](./TESTING.md) for detailed testing instructions.

### Health Check

```bash
curl http://localhost:3000/health
```

## API Endpoints

All endpoints follow the WAAPI specification. Base URL: `http://localhost:3000`

### 1. List All Instances
```bash
GET /instances
```

### 2. Create Instance
```bash
POST /instances
Content-Type: application/json

{
  "name": "WASP-shop-domain.myshopify.com",
  "webhook": {
    "url": "https://your-app.com/webhooks/waapi",
    "events": ["vote_update", "qr", "ready", "authenticated", "disconnected", "change_state", "auth_failure"]
  }
}
```

### 3. Update Instance (Webhook Configuration)
```bash
PUT /instances/:id
Content-Type: application/json

{
  "webhook": {
    "url": "https://your-app.com/webhooks/waapi",
    "events": ["vote_update", "qr", "ready"]
  }
}
```

### 4. Get QR Code
```bash
GET /instances/:id/client/qr
```

### 5. Get Instance Status
```bash
GET /instances/:id/client/status
```

### 6. Get Client Details
```bash
GET /instances/:id/client/me
```

### 7. Send Poll Message
```bash
POST /instances/:id/client/action/create-poll
Content-Type: application/json

{
  "chatId": "201224885551@c.us",
  "caption": "Confirm your order?",
  "options": ["Confirm", "Cancel"],
  "multipleAnswers": false
}
```

### 8. Send Text Message
```bash
POST /instances/:id/client/action/send-message
Content-Type: application/json

{
  "chatId": "201224885551@c.us",
  "message": "Hello, this is a test message"
}
```

### 9. Delete Instance
```bash
DELETE /instances/:id
```
**Hard delete:** Destroys the client, removes from runtime and persisted list, and **purges LocalAuth session storage**. Recreating an instance with the same id will require a new QR and can connect a different number. Idempotent: if the instance is not in memory, still purges session dirs if they exist. See [docs/HARD_DELETE.md](./docs/HARD_DELETE.md).

### 10. Logout Instance
```bash
POST /instances/:id/client/action/logout
```

## Testing the QR Flow

1. **Create an instance:**
```bash
curl -X POST http://localhost:3000/instances \
  -H "Content-Type: application/json" \
  -d '{"name": "WASP-test.myshopify.com"}'
```

Response:
```json
{
  "instance": {
    "id": "WASP-test.myshopify.com",
    "name": "WASP-test.myshopify.com",
    "status": "initializing"
  },
  "status": "success"
}
```

2. **Wait 10-15 seconds for QR code to be ready, then fetch it:**
```bash
curl http://localhost:3000/instances/WASP-test.myshopify.com/client/qr
```

Response:
```json
{
  "qrCode": {
    "data": {
      "qr_code": "base64_encoded_qr_image"
    }
  },
  "status": "success"
}
```

3. **Check instance status:**
```bash
curl http://localhost:3000/instances/WASP-test.myshopify.com/client/status
```

4. **After scanning QR, check status again** (should show `ready` or `authenticated`):
```bash
curl http://localhost:3000/instances/WASP-test.myshopify.com/client/status
```

5. **Get client details:**
```bash
curl http://localhost:3000/instances/WASP-test.myshopify.com/client/me
```

## Deployment to VPS

### Using PM2

1. **Install PM2 globally:**
```bash
npm install -g pm2
```

2. **Create logs directory:**
```bash
mkdir -p logs
```

3. **Start the service with PM2:**
```bash
pm2 start ecosystem.config.js
```

4. **Save PM2 process list:**
```bash
pm2 save
```

5. **Set up PM2 to start on system boot:**
```bash
pm2 startup
```

### PM2 Commands

```bash
# View logs
pm2 logs wa-hub

# View status
pm2 status

# Restart service
pm2 restart wa-hub

# Stop service
pm2 stop wa-hub

# View detailed info
pm2 info wa-hub

# Monitor resources
pm2 monit
```

### Automated Deployment with GitHub Actions (Recommended)

For automated push-to-deploy on GCP Compute Engine VMs, see **[DEPLOY_SETUP.md](./DEPLOY_SETUP.md)** for complete setup instructions.

This setup includes:
- **Systemd service** management
- **GitHub Actions** workflow for automatic deployment on push to `main`
- **Secure SSH-based** deployment with dedicated deploy user
- **Zero-downtime** deployments with automatic service restart

Quick setup:
1. Follow the VM setup steps in `DEPLOY_SETUP.md`
2. Configure GitHub Secrets (`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`)
3. Push to `main` branch to trigger automatic deployment

The deployment workflow will:
- Pull latest code from `main`
- Install dependencies (`npm ci`)
- Build if needed (`npm run build`)
- Restart the `wa-hub` systemd service
- Verify service status

### Using systemd (Alternative)

Create a systemd service file at `/etc/systemd/system/wa-hub.service`:

```ini
[Unit]
Description=wa-hub WhatsApp Session Manager
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/wa-hub
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable wa-hub
sudo systemctl start wa-hub
```

## Webhook Events

The service automatically forwards the following events to your configured webhook URL:

- `qr` - QR code updates
- `ready` - Instance ready/connected
- `authenticated` - Authentication successful
- `disconnected` - Instance disconnected
- `change_state` - Instance state changes
- `auth_failure` - Authentication failures
- `message` - Incoming messages
- `vote_update` - Poll vote responses

### Webhook Payload Format

All webhook payloads include:
- `event` - Event type
- `instanceId` - Session ID
- `data` - Event-specific data

Example:
```json
{
  "event": "vote_update",
  "instanceId": "WASP-test.myshopify.com",
  "data": {
    "vote": {
      "voter": "201224885551",
      "selectedOptions": ["Confirm"],
      "timestamp": 1234567890
    }
  }
}
```

### Webhook Signature

If `WEBHOOK_SECRET` is configured, the service includes an `x-wa-hub-signature` header with an HMAC-SHA256 signature of the payload. Verify it in your webhook handler:

```javascript
const crypto = require('crypto');

function verifyWebhookSignature(payload, signature, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  const expectedSignature = hmac.update(JSON.stringify(payload)).digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}
```

## Typing Indicator Feature

The typing indicator feature simulates human typing before sending messages to make conversations feel more natural. This helps prevent detection patterns that could trigger WhatsApp restrictions.

### Configuration

**Environment Variables:**
- `TYPING_INDICATOR_ENABLED_DEFAULT` - Enable by default for new instances (default: `false`)
- `TYPING_INDICATOR_MIN_MS` - Minimum typing duration in milliseconds (default: `600`)
- `TYPING_INDICATOR_MAX_MS` - Maximum typing duration in milliseconds (default: `1800`)
- `TYPING_INDICATOR_MAX_TOTAL_MS` - Maximum total time for typing + send, safety limit (default: `2500`)

**Per-Instance Configuration:**

Enable typing indicator when creating an instance:
```json
{
  "name": "WASP-shop.myshopify.com",
  "webhook": {
    "url": "https://your-webhook.com/webhooks/waapi",
    "events": ["vote_update", "message"]
  },
  "typingIndicatorEnabled": true,
  "applyTypingTo": ["customer"]
}
```

Or update an existing instance:
```bash
curl -X PUT http://localhost:3000/instances/WASP-shop_myshopify_com \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "typingIndicatorEnabled": true,
    "applyTypingTo": ["customer"]
  }'
```

### Behavior

- **Enabled by default:** `true` (can be disabled via config or per-instance)
- **Applies to:** Customer-facing messages/polls only (not merchant notifications by default)
- **Duration:** Random between `MIN_MS` and `MAX_MS` (default: 600-1800ms)
- **Safety:** Hard limit of `MAX_TOTAL_MS` (2500ms) prevents indefinite typing
- **Requirements:** 
  - Instance must be in `READY` state
  - Only applies to direct customer chats (skips groups)
  - Never blocks indefinitely (timeout protection)

### Safety Constraints

- Typing indicator never runs if instance is not `READY`
- Always clears typing state in `finally` block (even if send fails)
- If typing fails, message still sends (fail-safe)
- Maximum duration enforced to prevent long "typing" periods
- Does not apply to merchant notifications unless explicitly enabled via `applyTypingTo`

### Logging

All typing indicator activity is logged with structured format:
```
[instanceName] [Typing] Applied: true, typingMs: 1200, chatId: ***4599
[instanceName] [Typing] Skipped: chat_not_found (chatId: ***4599)
```

## Session Drift (Instances vs LocalAuth)

Drift between the instances list (`.wwebjs_instances.json`) and LocalAuth session directories (`.wwebjs_auth/session-{clientId}/`) can occur. **`DELETE /instances/:id` performs a hard delete and purges LocalAuth session storage** — recreating with the same id requires a new QR. Orphans can still exist from legacy deletes or crashes. Use `scripts/sessions-gc.js` to report drift and optionally remove orphaned session dirs. **Never manually delete session data while wa-hub is running.**

```bash
# Dry-run report
node scripts/sessions-gc.js

# Delete orphans (stop wa-hub first)
pm2 stop wa-hub && node scripts/sessions-gc.js --delete-orphans --confirm --no-dry-run && pm2 start wa-hub
```

See [docs/SESSION_DRIFT.md](./docs/SESSION_DRIFT.md) for details and recommended ops workflow.

## Ready-Poll Fallback

whatsapp-web.js sometimes never emits the `ready` event even when the client is connected. wa-hub includes a fallback that polls `client.info` and `client.getState()` every `READY_POLL_INTERVAL_MS` (default 15s) after `authenticated`. Both signals must pass before we treat the client as ready. See [docs/READY_POLL.md](./docs/READY_POLL.md) for safety checks and diagnostics.

**Incoming messages:** whatsapp-web.js v1.34.4 has reports of `message` events failing to fire. wa-hub listens to both `message` and `message_create`, filters `fromMe` for incoming-only webhooks, dedupes by message ID, and runs a fallback poller for unread chats when the instance is READY. See [docs/INCOMING_MESSAGE_FALLBACK.md](./docs/INCOMING_MESSAGE_FALLBACK.md).

## Dashboard ↔ wa-hub Communication

For clients integrating with wa-hub: how the dashboard fetches status, receives webhooks, uses SSE, and treats webhooks as the source of truth. See [docs/DASHBOARD_WAHUB_COMMUNICATION.md](./docs/DASHBOARD_WAHUB_COMMUNICATION.md).

## Disk Cleanup & Storage Management

WA-Hub uses Chromium/Puppeteer for each WhatsApp instance, which can accumulate significant cache data over time. To prevent disk storage from growing indefinitely, automated cleanup tools are provided.

### Quick Start

**1. Check current disk usage:**
```bash
node scripts/report-disk-usage.js
```

**2. Preview cleanup (dry run):**
```bash
DRY_RUN=1 ./scripts/wa-hub-cleanup.sh
```

**3. Run cleanup manually:**
```bash
./scripts/wa-hub-cleanup.sh
```

### Disk Usage Report

The `report-disk-usage.js` script provides detailed disk usage analysis:

```bash
# Human-readable report
node scripts/report-disk-usage.js

# JSON output (for automation)
node scripts/report-disk-usage.js --json
```

**Output includes:**
- Per-tenant directory sizes (sorted by size)
- Chromium profile directories (Default, Profile 1, etc.)
- Cache directory breakdown (Cache, Code Cache, GPUCache, etc.)
- Total storage usage

**Example output:**
```
Tenant: WASP-shop_myshopify_com
  Total Size: 2.5 GB
  Profiles:
    Default: 2.3 GB (cache: 1.8 GB)
      - Cache: 800 MB
      - Code Cache: 600 MB
      - GPUCache: 400 MB
```

### Automated Cleanup Script

The `wa-hub-cleanup.sh` script safely removes Chromium cache directories while preserving authentication data.

**Safety Features:**
- ✅ Stops service before cleanup (prevents corruption)
- ✅ Only deletes cache directories (never auth/session data)
- ✅ DRY_RUN mode for preview
- ✅ MAX_DELETE_GB guard (prevents accidental huge deletions)
- ✅ Detailed logging

**What Gets Deleted (allowlist only):**
- `Default/Cache`, `Default/Code Cache`, `Default/GPUCache`
- Same under `Profile 1`, `Profile 2`, etc.

**What Never Gets Deleted:**
- `.wwebjs_auth/` (authentication data)
- `.wwebjs_cache/` (session cache - may contain important data)
- `Local Storage`, `IndexedDB`, `Session Storage` (browser data)

**Usage:**
```bash
# Preview what would be deleted
DRY_RUN=1 ./scripts/wa-hub-cleanup.sh

# Run cleanup (default: max 100GB per run)
./scripts/wa-hub-cleanup.sh

# Custom max deletion limit
MAX_DELETE_GB=50 ./scripts/wa-hub-cleanup.sh

# Custom tenants directory
WA_HUB_TENANTS_DIR=/custom/path/.wwebjs_auth ./scripts/wa-hub-cleanup.sh
```

### Scheduled Cleanup (systemd Timer)

**1. Install systemd service and timer:**

```bash
# Update paths in scripts/wa-hub-cleanup.service first!
# Edit: User, WorkingDirectory, ExecStart paths

# Copy service file
sudo cp scripts/wa-hub-cleanup.service /etc/systemd/system/

# Copy timer file
sudo cp scripts/wa-hub-cleanup.timer /etc/systemd/system/

# Reload systemd
sudo systemctl daemon-reload

# Enable and start timer
sudo systemctl enable wa-hub-cleanup.timer
sudo systemctl start wa-hub-cleanup.timer

# Check timer status
sudo systemctl status wa-hub-cleanup.timer

# View next run time
sudo systemctl list-timers wa-hub-cleanup.timer
```

**2. Configure logrotate:**

```bash
# Copy logrotate config
sudo cp scripts/wa-hub-cleanup.logrotate /etc/logrotate.d/wa-hub-cleanup

# Test logrotate config
sudo logrotate -d /etc/logrotate.d/wa-hub-cleanup
```

**Timer Schedule:**
- Runs daily at 04:30 local time
- Randomized delay: 0-30 minutes (prevents thundering herd)
- Persistent: runs immediately on boot if missed

### Scheduled Cleanup (Cron - Alternative)

If systemd is not available, use cron:

```bash
# Edit root crontab
sudo crontab -e

# Add this line (runs daily at 04:30):
30 4 * * * /bin/bash /path/to/wa-hub/scripts/wa-hub-cleanup.sh >> /var/log/wa-hub-cleanup.log 2>&1
```

### Preventive Measures

**Chromium Cache Size Limits:**

Cache size limits are automatically applied via Puppeteer launch arguments:
- `--disk-cache-size=104857600` (100MB disk cache)
- `--media-cache-size=104857600` (100MB media cache)

These limits are set in `src/instance-manager.js` and help prevent cache growth.

### Verification Checklist

After setup, verify everything works:

```bash
# 1. Check disk usage report
node scripts/report-disk-usage.js

# 2. Test dry run
DRY_RUN=1 ./scripts/wa-hub-cleanup.sh

# 3. Check systemd timer (if using systemd)
sudo systemctl status wa-hub-cleanup.timer
sudo systemctl list-timers wa-hub-cleanup.timer

# 4. Check logs
sudo tail -f /var/log/wa-hub-cleanup.log

# 5. Manually trigger cleanup (if needed)
sudo systemctl start wa-hub-cleanup.service
```

### Troubleshooting

**Cleanup script fails to stop service:**
- Check if service name matches (`wa-hub` for PM2, `wa-hub.service` for systemd)
- Verify service is running: `pm2 list` or `systemctl status wa-hub.service`

**"Tenants directory does not exist" error:**
- Set `WA_HUB_TENANTS_DIR` environment variable to your `.wwebjs_auth` path
- Or update the path in `scripts/wa-hub-cleanup.service`

**Service doesn't restart after cleanup:**
- Check logs: `sudo journalctl -u wa-hub-cleanup.service`
- Verify service name in cleanup script matches your deployment

**Disk usage still growing:**
- Verify cache size limits are applied (check Puppeteer args in logs)
- Run cleanup more frequently (adjust timer schedule)
- Check for other sources of disk usage (logs, temp files, etc.)

### Rollback

If cleanup causes issues:

1. **Stop automated cleanup:**
   ```bash
   sudo systemctl stop wa-hub-cleanup.timer
   sudo systemctl disable wa-hub-cleanup.timer
   ```

2. **Restore from backup** (if you have one):
   ```bash
   # Restore .wwebjs_auth directory from backup
   ```

3. **Re-authenticate instances** (if auth data was corrupted - should not happen):
   - Instances will require QR code scan again
   - Use `GET /instances/:id/qr` to get new QR codes

**Note:** Cleanup should never delete auth data. If instances require re-authentication after cleanup, it's likely a different issue (check logs).

## Project Structure

```
wa-hub/
├── src/
│   ├── index.js              # Main Express application
│   ├── router.js             # API routes
│   ├── instance-manager.js   # Instance lifecycle management
│   ├── sessions.js           # Session manager (legacy)
│   ├── config.js             # Configuration
│   ├── utils.js              # Utility functions
│   ├── utils/
│   │   └── typingIndicator.js # Typing indicator utility
│   └── idempotency-store.js  # Idempotency persistence
├── ecosystem.config.js       # PM2 configuration
├── .env                      # Environment variables (create this)
├── .wwebjs_auth/             # WhatsApp session data (auto-created)
└── README.md
```

## Troubleshooting

### QR Code Not Available
- Wait 10-15 seconds after creating an instance
- Check that the WhatsApp client is initializing properly
- Review logs for errors

### Instance Not Connecting
- Ensure QR code is scanned within the validity period
- Check network connectivity
- Review authentication logs

### Webhook Not Received
- Verify that each instance has a webhook URL configured (no default URL)
- Check that your webhook endpoint is accessible
- Review service logs for webhook forwarding errors
- Ensure webhook events are configured in instance settings

### Memory Issues
- Reduce number of concurrent instances
- Increase PM2 memory limit in `ecosystem.config.js`
- Monitor system resources with `pm2 monit`

## License

ISC

## Support

For issues and questions, please check the expectations.md file for API specifications and behavior details.

