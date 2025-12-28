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

## Project Structure

```
wa-hub/
├── src/
│   ├── index.js          # Main Express application
│   ├── router.js         # API routes
│   ├── sessions.js       # Session manager
│   ├── config.js         # Configuration
│   └── utils.js          # Utility functions
├── ecosystem.config.js   # PM2 configuration
├── .env                  # Environment variables (create this)
├── .wwebjs_auth/         # WhatsApp session data (auto-created)
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

