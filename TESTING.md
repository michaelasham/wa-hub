# Testing wa-hub Locally

This guide explains how to test the wa-hub service locally with the fake webhook server.

## Quick Start

### Option 1: Manual Start (Two Terminals)

**Terminal 1 - Start webhook server:**
```bash
npm run test-webhook
# or
node test-webhook-server.js
```

**Terminal 2 - Start wa-hub service:**
```bash
npm start
# or
node src/index.js
```

### Option 2: Using the Test Script (One Terminal)

```bash
./start-test.sh
```

Press `Ctrl+C` to stop both services.

## Testing the Full Flow

### 1. Start Both Services

Make sure both services are running:
- wa-hub: http://localhost:3000
- Webhook server: http://localhost:3001

### 2. Create a WhatsApp Instance

```bash
curl -X POST http://localhost:3000/instances \
  -H "Content-Type: application/json" \
  -d '{
    "name": "WASP-test.myshopify.com",
    "webhook": {
      "url": "http://localhost:3001/webhooks/waapi",
      "events": ["vote_update", "qr", "ready", "authenticated", "disconnected", "change_state", "auth_failure", "message"]
    }
  }'
```

Expected response:
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

### 3. Get QR Code

Wait 10-15 seconds, then:

```bash
curl http://localhost:3000/instances/WASP-test.myshopify.com/client/qr
```

Expected response:
```json
{
  "qrCode": {
    "data": {
      "qr_code": "base64_encoded_qr_image..."
    }
  },
  "status": "success"
}
```

**Check the webhook server terminal** - you should see a `qr` event logged!

### 4. Check Instance Status

```bash
curl http://localhost:3000/instances/WASP-test.myshopify.com/client/status
```

### 5. Scan QR Code

1. Open WhatsApp on your phone
2. Go to Settings > Linked Devices
3. Tap "Link a Device"
4. Scan the QR code from the API response

**After scanning**, you should see:
- `authenticated` event in webhook server
- `ready` event in webhook server
- Status changes to `ready` when checking status

### 6. Get Client Info (After Connected)

```bash
curl http://localhost:3000/instances/WASP-test.myshopify.com/client/me
```

### 7. Send a Test Message

Replace `YOUR_PHONE_NUMBER` with a phone number (format: country code + number, e.g., "201224885551"):

```bash
curl -X POST http://localhost:3000/instances/WASP-test.myshopify.com/client/action/send-message \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "YOUR_PHONE_NUMBER",
    "message": "Hello from wa-hub test!"
  }'
```

### 8. Send a Poll Message

```bash
curl -X POST http://localhost:3000/instances/WASP-test.myshopify.com/client/action/create-poll \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "YOUR_PHONE_NUMBER",
    "caption": "Test poll: Do you like testing?",
    "options": ["Yes", "No"],
    "multipleAnswers": false
  }'
```

**If someone votes on the poll**, you should see a `vote_update` event in the webhook server!

### 9. List All Instances

```bash
curl http://localhost:3000/instances
```

### 10. Clean Up - Delete Instance

```bash
curl -X DELETE http://localhost:3000/instances/WASP-test.myshopify.com
```

## Expected Webhook Events

When testing, you should see these events in the webhook server:

1. **`qr`** - QR code generated
2. **`authenticated`** - QR code scanned, authentication successful
3. **`ready`** - Client ready to send/receive messages
4. **`message`** - Incoming message received
5. **`vote_update`** - Poll vote received
6. **`change_state`** - Connection state changed
7. **`disconnected`** - Connection lost

## Troubleshooting

### Webhook Server Not Receiving Events

1. Check that `MAIN_APP_WEBHOOK_BASE` in `.env` points to `http://localhost:3001/webhooks/waapi`
2. Verify webhook server is running on port 3001
3. Check wa-hub logs for webhook forwarding errors

### QR Code Not Available

- Wait 10-15 seconds after creating instance
- Check wa-hub logs for initialization errors
- Verify the instance was created successfully

### Instance Not Connecting

- Ensure QR code is scanned within validity period
- Check for `auth_failure` events in webhook server
- Review wa-hub logs for authentication errors

### Signature Verification Errors

- Ensure `WEBHOOK_SECRET` matches in both `.env` files
- The test webhook server uses the same secret from environment or defaults to `test-shared-secret-123`
- Check that `x-wa-hub-signature` header is present

## Environment Variables for Testing

Make sure your `.env` file has:

```env
PORT=3000
MAIN_APP_WEBHOOK_BASE=http://localhost:3001/webhooks/waapi
WEBHOOK_SECRET=test-shared-secret-123
SESSION_DATA_PATH=./.wwebjs_auth
LOG_LEVEL=info
```

For the webhook server, you can set:

```bash
export WEBHOOK_PORT=3001
export WEBHOOK_SECRET=test-shared-secret-123
```

Or it will use defaults.

## Next Steps

Once local testing is successful:
1. Update `.env` with your production webhook URL
2. Deploy wa-hub using PM2 (see README.md)
3. Update webhook URL in production instance configuration

