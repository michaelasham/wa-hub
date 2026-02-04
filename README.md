# wa-hub

Multi-tenant WhatsApp Web session manager service built with Node.js, Express, and whatsapp-web.js. This service provides a REST API for managing multiple WhatsApp Web sessions, sending messages, and forwarding webhook events.

## Features

- **Multi-tenant session management**: Each merchant/shop gets its own isolated WhatsApp Web session
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
| `CHROME_PATH` | Path to Chromium/Chrome executable for Puppeteer | `/usr/bin/chromium-browser` | No |
| `SESSION_DATA_PATH` | Path for storing WhatsApp session data | `./.wwebjs_auth` | No |
| `LOG_LEVEL` | Logging level | `info` | No |
| `TYPING_INDICATOR_ENABLED_DEFAULT` | Enable typing indicator by default for new instances | `true` | No |
| `TYPING_INDICATOR_MIN_MS` | Minimum typing duration (milliseconds) | `600` | No |
| `TYPING_INDICATOR_MAX_MS` | Maximum typing duration (milliseconds) | `1800` | No |
| `TYPING_INDICATOR_MAX_TOTAL_MS` | Maximum total time for typing + send (safety limit) | `2500` | No |

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

**What Gets Deleted:**
- `Default/Cache`
- `Default/Code Cache`
- `Default/GPUCache`
- `Default/Service Worker/CacheStorage`
- `Default/Service Worker/ScriptCache`
- `Default/Media Cache`
- `Default/ShaderCache`
- Similar directories in `Profile 1`, `Profile 2`, etc.

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

