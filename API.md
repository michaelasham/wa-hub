# wa-hub API Documentation

## Base URL

```
http://35.225.63.31:3000
```

**Important:** HTTP requests only (not HTTPS).

---

## Authentication

All endpoints require an API key in the Authorization header (except `/health`).

**Header Format:**
```
Authorization: Bearer YOUR_API_KEY
```

**Your API Key:**
```
f0bdaeb85348f62f9d415e8bd749d251f5634e292ec61d7a133cd32ad71f1662
```

---

## Endpoints

### Health Check

```bash
GET /health
```

No authentication required.

**Response:**
```json
{"status":"ok","service":"wa-hub"}
```

---

### List All Instances

```bash
GET /instances
Headers: Authorization: Bearer YOUR_API_KEY
```

**Response:**
```json
[
  {
    "id": "instance_id",
    "name": "WASP-shop.myshopify.com",
    "status": "ready",
    "phoneNumber": "1234567890"
  }
]
```

---

### Create Instance

```bash
POST /instances
Headers: 
  Authorization: Bearer YOUR_API_KEY
  Content-Type: application/json

Body:
{
  "name": "WASP-shop.myshopify.com",
  "webhook": {
    "url": "https://your-webhook-url.com/webhooks/waapi",
    "events": ["vote_update", "qr", "ready", "authenticated", "disconnected", "change_state", "auth_failure", "message"]
  }
}
```

**Note:** `webhook.url` is required. Each instance must provide its own webhook URL.

**Response:**
```json
{
  "instance": {
    "id": "WASP-shop_myshopify_com",
    "name": "WASP-shop.myshopify.com",
    "status": "initializing"
  },
  "status": "success"
}
```

---

### Get QR Code

```bash
GET /instances/{instanceId}/client/qr
Headers: Authorization: Bearer YOUR_API_KEY
```

Wait 10-15 seconds after creating instance before requesting QR code.

**Response:**
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

---

### Get Instance Status

```bash
GET /instances/{instanceId}/client/status
Headers: Authorization: Bearer YOUR_API_KEY
```

**Response:**
```json
{
  "clientStatus": {
    "instanceStatus": "ready",
    "instanceId": "instance_id",
    "data": {
      "phoneNumber": "1234567890",
      "formattedNumber": "1234567890"
    }
  },
  "status": "success"
}
```

---

### Get Client Details

```bash
GET /instances/{instanceId}/client/me
Headers: Authorization: Bearer YOUR_API_KEY
```

Only works when instance status is `ready`.

**Response:**
```json
{
  "me": {
    "data": {
      "displayName": "Your Name",
      "contactId": "1234567890",
      "formattedNumber": "1234567890",
      "profilePicUrl": null
    }
  },
  "status": "success"
}
```

---

### Send Text Message

```bash
POST /instances/{instanceId}/client/action/send-message
Headers: 
  Authorization: Bearer YOUR_API_KEY
  Content-Type: application/json

Body:
{
  "chatId": "201224885551",
  "message": "Hello from wa-hub!"
}
```

**Note:** Phone number format: country code + number (no + sign, e.g., `201224885551`)

---

### Send Poll Message

```bash
POST /instances/{instanceId}/client/action/create-poll
Headers: 
  Authorization: Bearer YOUR_API_KEY
  Content-Type: application/json

Body:
{
  "chatId": "201224885551",
  "caption": "Test poll: Do you like testing?",
  "options": ["Yes", "No"],
  "multipleAnswers": false
}
```

**Important:** Poll votes are sent to the instance's webhook URL as `vote_update` events.

---

### Update Instance (Webhook Config)

```bash
PUT /instances/{instanceId}
Headers: 
  Authorization: Bearer YOUR_API_KEY
  Content-Type: application/json

Body:
{
  "webhook": {
    "url": "https://new-webhook-url.com/webhooks/waapi",
    "events": ["vote_update", "qr", "ready"]
  }
}
```

---

### Delete Instance

```bash
DELETE /instances/{instanceId}
Headers: Authorization: Bearer YOUR_API_KEY
```

Logs out and destroys the instance completely.

**Response:**
```json
{
  "message": "Instance {instanceId} deleted and destroyed successfully",
  "status": "success"
}
```

---

### Logout Instance

```bash
POST /instances/{instanceId}/client/action/logout
Headers: Authorization: Bearer YOUR_API_KEY
```

Same as DELETE - logs out and destroys the instance.

---

## Example cURL Commands

### Create Instance

```bash
curl -X POST http://35.225.63.31:3000/instances \
  -H "Authorization: Bearer f0bdaeb85348f62f9d415e8bd749d251f5634e292ec61d7a133cd32ad71f1662" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "WASP-test.myshopify.com",
    "webhook": {
      "url": "https://your-webhook-url.com/webhooks/waapi",
      "events": ["vote_update", "qr", "ready", "message"]
    }
  }'
```

### Get QR Code

```bash
curl http://35.225.63.31:3000/instances/WASP-test_myshopify_com/client/qr \
  -H "Authorization: Bearer f0bdaeb85348f62f9d415e8bd749d251f5634e292ec61d7a133cd32ad71f1662"
```

### Send Message

```bash
curl -X POST http://35.225.63.31:3000/instances/WASP-test_myshopify_com/client/action/send-message \
  -H "Authorization: Bearer f0bdaeb85348f62f9d415e8bd749d251f5634e292ec61d7a133cd32ad71f1662" \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "201224885551",
    "message": "Hello!"
  }'
```

---

## Webhook Events

When events occur, they are POSTed to the instance's webhook URL:

- `vote_update` - Poll vote received (CRITICAL for COD confirmations)
- `qr` - QR code generated
- `ready` - Instance connected and ready
- `authenticated` - Authentication successful
- `disconnected` - Instance disconnected
- `change_state` - Connection state changed
- `auth_failure` - Authentication failed
- `message` - Incoming message received

All webhook requests include `x-wa-hub-signature` header with HMAC-SHA256 signature.

---

## Important Notes

1. **Instance IDs:** Instance names with dots are sanitized (e.g., `WASP-test.myshopify.com` → `WASP-test_myshopify_com`)
2. **Phone Numbers:** Format as country code + number, no + sign (e.g., `201224885551`)
3. **Webhook URL:** Required when creating instances - each instance must have its own webhook URL
4. **QR Code:** Wait 10-15 seconds after instance creation before requesting QR code
5. **HTTP Only:** This API uses HTTP (not HTTPS) - use for internal/trusted networks only

