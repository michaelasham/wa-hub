# WAAPI Complete Reference Documentation

This document contains all WAAPI (WhatsApp API) interactions, endpoints, webhooks, and data formats needed to recreate the functionality using `whatsapp-web.js` or any other WhatsApp library.

## Table of Contents
1. [Authentication](#authentication)
2. [API Endpoints](#api-endpoints)
3. [Webhook Configuration](#webhook-configuration)
4. [Webhook Payloads](#webhook-payloads)
5. [Message Formats](#message-formats)
6. [Phone Number Formatting](#phone-number-formatting)
7. [Error Handling](#error-handling)
8. [Testing](#testing)
9. [Migration to whatsapp-web.js](#migration-to-whatsapp-webjs)

---

## Authentication

### Environment Variables
```bash
WAAPI_BASE_URL=https://waapi.app/api/v1
WAAPI_TOKEN=your_bearer_token_here
WAAPI_WEBHOOK_SECRET=your_webhook_secret_here  # Optional, for signature verification
```

### Authentication Header
All API requests require Bearer token authentication:
```
Authorization: Bearer {WAAPI_TOKEN}
```

---

## API Endpoints

### 1. List All Instances
**GET** `/instances`

**Headers:**
```
Authorization: Bearer {WAAPI_TOKEN}
```

**Response Structure:**
```json
[
  {
    "id": "string",
    "name": "string",
    "status": "string",
    "phoneNumber": "string"  // Optional
  }
]
```

**Alternative Response Formats (WAAPI may return):**
- `{ instances: [...] }`
- `{ data: [...] }`

**cURL Example:**
```bash
curl -X GET "https://waapi.app/api/v1/instances" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

### 2. Create Instance
**POST** `/instances`

**Headers:**
```
Authorization: Bearer {WAAPI_TOKEN}
Content-Type: application/json
```

**Request Body:**
```json
{
  "name": "WASP-{shop.domain}"
}
```

**Response Structure:**
```json
{
  "instance": {
    "id": "string",
    "name": "string",
    "status": "string"
  },
  "status": "success"
}
```

**Alternative Response Formats:**
- `{ id: "...", name: "...", ... }` (direct instance object)
- `{ instanceId: "...", ... }` (with instanceId field)
- `{ data: { id: "...", ... } }` (nested in data)

**Important Notes:**
- Instance name format: `WASP-{shop.domain}` (e.g., `WASP-blesscurls.myshopify.com`)
- Check if instance with same name exists before creating (to avoid duplicates)
- QR code takes 10-15 seconds to be ready after instance creation

**cURL Example:**
```bash
curl -X POST "https://waapi.app/api/v1/instances" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "WASP-blesscurls.myshopify.com"
  }'
```

---

### 3. Update Instance (Webhook Configuration)
**PUT** `/instances/{instanceId}`

**Headers:**
```
Authorization: Bearer {WAAPI_TOKEN}
Content-Type: application/json
```

**Request Body:**
```json
{
  "name": "WASP-{shop.domain}",  // Optional
  "webhook": {
    "url": "https://your-app.com/webhooks/waapi",
    "events": [
      "vote_update",       // Poll votes (for COD confirmations)
      "qr",                // QR code updates (for connection)
      "ready",             // Instance ready/connected
      "authenticated",      // Authentication successful
      "disconnected",      // Instance disconnected
      "change_state",      // Instance state changes
      "auth_failure"       // Authentication failures
    ]
  }
}
```

**cURL Example:**
```bash
curl -X PUT "https://waapi.app/api/v1/instances/INSTANCE_ID" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "WASP-blesscurls.myshopify.com",
    "webhook": {
      "url": "https://whatsapphook-nhq0.onrender.com/webhooks/waapi",
      "events": ["vote_update", "qr", "ready", "authenticated", "disconnected", "change_state", "auth_failure"]
    }
  }'
```

---

### 4. Get QR Code
**GET** `/instances/{instanceId}/client/qr`

**Headers:**
```
Authorization: Bearer {WAAPI_TOKEN}
```

**Response Structure:**
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

**Alternative Response Format:**
```json
{
  "qr": "base64_encoded_qr_image",
  "status": "success"
}
```

**Important Notes:**
- QR code may not be immediately available after instance creation (wait 10-15 seconds)
- Implement retry logic: retry every 3 seconds for up to 30 seconds (10 attempts)

**cURL Example:**
```bash
curl -X GET "https://waapi.app/api/v1/instances/INSTANCE_ID/client/qr" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

### 5. Get Instance Status
**GET** `/instances/{instanceId}/client/status`

**Headers:**
```
Authorization: Bearer {WAAPI_TOKEN}
```

**Response Structure:**
```json
{
  "clientStatus": {
    "instanceStatus": "qr" | "ready" | "authenticated" | "disconnected" | "loading_screen" | "auth_failure",
    "instanceId": "string",
    "data": {
      "phoneNumber": "string",  // Optional
      "formattedNumber": "string"  // Optional
    }
  },
  "status": "success"
}
```

**Status Mapping:**
- `"qr"` → `"PENDING"` (waiting for QR scan)
- `"ready"` or `"authenticated"` → `"CONNECTED"` (connected and ready)
- `"disconnected"` → `"DISCONNECTED"` (disconnected)

**cURL Example:**
```bash
curl -X GET "https://waapi.app/api/v1/instances/INSTANCE_ID/client/status" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

### 6. Get Client Details (Connected User Info)
**GET** `/instances/{instanceId}/client/me`

**Headers:**
```
Authorization: Bearer {WAAPI_TOKEN}
```

**Response Structure:**
```json
{
  "me": {
    "data": {
      "displayName": "string",
      "contactId": "string",
      "formattedNumber": "string",
      "profilePicUrl": "string"
    }
  },
  "status": "success"
}
```

**Alternative Response Formats:**
- `{ me: { displayName, contactId, ... } }`
- `{ qrCode: { data: { displayName, ... } } }`
- `{ data: { displayName, ... } }`

**Important Notes:**
- Only works when instance is `CONNECTED` (status = "ready" or "authenticated")

**cURL Example:**
```bash
curl -X GET "https://waapi.app/api/v1/instances/INSTANCE_ID/client/me" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

### 7. Send Poll Message
**POST** `/instances/{instanceId}/client/action/create-poll`

**Headers:**
```
Authorization: Bearer {WAAPI_TOKEN}
Content-Type: application/json
```

**Request Body:**
```json
{
  "chatId": "201224885551@c.us",  // Phone number without +, with @c.us suffix
  "caption": "Message text here",
  "options": ["Confirm", "Cancel"],
  "multipleAnswers": false
}
```

**Phone Number Format:**
- Remove all non-digits: `+201224885551` → `201224885551`
- Add `@c.us` suffix: `201224885551@c.us`

**cURL Example:**
```bash
curl -X POST "https://waapi.app/api/v1/instances/INSTANCE_ID/client/action/create-poll" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "201224885551@c.us",
    "caption": "Confirming your order from Joex Eyewear\n\nHello! 👋\nThank you for shopping with Joex Eyewear.\n\nWe just want to confirm that you'\''ll be available to receive your order #11302 totaling 1305.00 EGP at the address you provided.\n\nPlease tap Confirm if you'\''d like us to ship your order now,\nor Cancel if you placed it by mistake.\nWe'\''ll hold your order until you confirm.",
    "options": ["Confirm", "Cancel"],
    "multipleAnswers": false
  }'
```

---

### 8. Send Text Message (Fallback)
**POST** `/instances/{instanceId}/client/action/send-message`

**Headers:**
```
Authorization: Bearer {WAAPI_TOKEN}
Content-Type: application/json
```

**Request Body:**
```json
{
  "chatId": "201224885551@c.us",
  "message": "Your message text here"
}
```

**cURL Example:**
```bash
curl -X POST "https://waapi.app/api/v1/instances/INSTANCE_ID/client/action/send-message" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "201224885551@c.us",
    "message": "Hello, this is a test message"
  }'
```

---

### 9. Delete Instance
**DELETE** `/instances/{instanceId}`

**Headers:**
```
Authorization: Bearer {WAAPI_TOKEN}
```

**cURL Example:**
```bash
curl -X DELETE "https://waapi.app/api/v1/instances/INSTANCE_ID" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

### 10. Logout Instance (Disconnect WhatsApp)
**POST** `/instances/{instanceId}/client/action/logout`

**Headers:**
```
Authorization: Bearer {WAAPI_TOKEN}
```

**cURL Example:**
```bash
curl -X POST "https://waapi.app/api/v1/instances/INSTANCE_ID/client/action/logout" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Webhook Configuration

### Webhook URL
```
https://your-app.com/webhooks/waapi
```

### Webhook Events
Configure these events in the webhook:
- `vote_update` - Poll vote responses (CRITICAL for COD confirmations)
- `qr` - QR code updates (for connection flow)
- `ready` - Instance ready/connected
- `authenticated` - Authentication successful
- `disconnected` - Instance disconnected
- `change_state` - Instance state changes
- `auth_failure` - Authentication failures

### Webhook Signature Verification (Optional)
If `WAAPI_WEBHOOK_SECRET` is configured, verify signature from header:
```
x-waapi-signature: {hmac_sha256_signature}
```

**Verification Logic:**
```javascript
const crypto = require('crypto');

function verifyWaapiSignature(payload, signature) {
  const hmac = crypto.createHmac("sha256", WAAPI_WEBHOOK_SECRET);
  const expectedSignature = hmac.update(JSON.stringify(payload)).digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}
```

### Webhook Response
- **Always return:** `200 OK` (even on errors)
- **Why:** Prevent WAAPI from retrying failed webhooks
- **Log errors:** But don't fail the webhook

---

## Webhook Payloads

### 1. Poll Vote Event (`vote_update` / `poll_vote` / `message.poll_vote`)

**Event Type Detection:**
```javascript
const eventType = payload.event || payload.type;
// Can be: "vote_update", "poll_vote", or "message.poll_vote"
```

**Payload Structure:**
```json
{
  "event": "vote_update",
  "instanceId": "string",
  "data": {
    "vote": {
      "voter": "201224885551",  // Phone number (without @c.us)
      "selectedOptions": ["Confirm"],  // Array of selected options
      "selected_options": ["Confirm"],  // Alternative field name
      "options": ["Confirm"],  // Another alternative
      "timestamp": "number"
    }
  }
}
```

**Alternative Payload Structures:**
```json
{
  "event": "vote_update",
  "instanceId": "string",
  "vote": {
    "from": "201224885551",
    "selectedOptions": ["Confirm"]
  }
}
```

```json
{
  "type": "poll_vote",
  "instanceId": "string",
  "data": {
    "voter": "201224885551",
    "selectedOptions": ["Cancel"]
  }
}
```

**Data Extraction:**
- Phone number: `vote.voter` OR `vote.from` OR `payload.from` OR `vote.chatId` OR `vote.senderId`
- Selected options: `vote.selectedOptions` OR `vote.selected_options` OR `vote.options`
- Instance ID: `payload.instanceId` OR `payload.instance_id` OR `vote.instanceId`

**Option Detection:**
- If option contains `"Confirm"` or `"✅"` → User selected Confirm
- If option contains `"Cancel"` or `"❌"` → User selected Cancel

---

### 2. QR Code Event (`qr`)

**Payload Structure:**
```json
{
  "event": "qr",
  "instanceId": "string",
  "data": {
    "qr": "base64_encoded_qr_image"
  }
}
```

**Alternative Structures:**
```json
{
  "event": "qr",
  "instanceId": "string",
  "qr": "base64_encoded_qr_image"
}
```

```json
{
  "type": "qr",
  "instanceId": "string",
  "qrCode": "base64_encoded_qr_image"
}
```

**Data Extraction:**
- QR code: `payload.data.qr` OR `payload.qr` OR `payload.data.qrCode` OR `payload.qrCode`
- Instance ID: `payload.instanceId` OR `payload.instance_id`

**Note:** If QR code not in payload, fetch from API: `GET /instances/{instanceId}/client/qr`

---

### 3. Status Update Event (`ready` / `authenticated` / `change_state`)

**Payload Structure:**
```json
{
  "event": "ready",
  "instanceId": "string",
  "status": "ready" | "authenticated" | "connected"
}
```

**Alternative:**
```json
{
  "event": "instance.status",
  "instanceId": "string",
  "data": {
    "status": "ready"
  }
}
```

**Status Mapping:**
- `"open"` or `"connected"` or `"ready"` or `"authenticated"` → `"CONNECTED"`
- `"close"` or `"disconnected"` → `"DISCONNECTED"`
- `"qr"` → `"PENDING"`

**Data Extraction:**
- Status: `payload.status` OR `payload.data.status`
- Instance ID: `payload.instanceId` OR `payload.instance_id`

---

### 4. Disconnected Event (`disconnected`)

**Payload Structure:**
```json
{
  "event": "disconnected",
  "instanceId": "string",
  "data": {
    "reason": "string"  // Optional
  }
}
```

**Data Extraction:**
- Instance ID: `payload.instanceId` OR `payload.instance_id`
- Reason: `payload.data.reason` OR `payload.reason`

---

### 5. Regular Message Event (`message` / `messages` / `message_create`)

**Payload Structure:**
```json
{
  "event": "message",
  "instanceId": "string",
  "data": {
    "message": {
      "from": "201224885551",
      "body": "CONFIRM",
      "text": "CONFIRM",
      "type": "text",
      "timestamp": "number",
      "id": "message_id_string"
    }
  }
}
```

**Alternative Structures:**
```json
{
  "event": "message",
  "instanceId": "string",
  "message": {
    "from": "201224885551",
    "body": "CONFIRM"
  }
}
```

**Data Extraction:**
- Phone number: `message.from` OR `message.chatId` OR `payload.from`
- Message text: `message.body` OR `message.text` OR `message.message`
- Message ID: `message.id` (if available)
- Instance ID: `payload.instanceId` OR `payload.instance_id`

**Text Message Keywords (for fallback processing):**
- Contains `"CONFIRM"` or equals `"YES"` or equals `"1"` → User confirmed
- Contains `"CANCEL"` or equals `"NO"` or equals `"2"` → User cancelled

---

## Message Formats

### Poll Message Format (for COD Confirmations)
```
Confirming your order from {merchantName}

Hello! 👋
Thank you for shopping with {merchantName}.

We just want to confirm that you'll be available to receive your order {orderName} totaling {orderTotal} at the address you provided.

Please tap Confirm if you'd like us to ship your order now,
or Cancel if you placed it by mistake.
We'll hold your order until you confirm.
```

**Variables:**
- `{merchantName}` - Shop name (e.g., "Joex Eyewear")
- `{orderName}` - Order name with # (e.g., "#11302")
- `{orderTotal}` - Formatted total (e.g., "1305.00 EGP")

**Poll Options:**
- `["Confirm", "Cancel"]` (exactly these strings, case-sensitive)
- `multipleAnswers: false`

---

## Phone Number Formatting

### WAAPI Format
- **Input:** `+201224885551` or `201224885551` or `201224885551@c.us`
- **Processing:** Remove all non-digits: `201224885551`
- **WAAPI Format:** Add `@c.us` suffix: `201224885551@c.us`

### Example
```javascript
function formatPhoneForWAAPI(phone) {
  // Remove all non-digits
  const digits = phone.replace(/\D/g, "");
  // Add @c.us suffix
  return digits + "@c.us";
}

// Usage:
formatPhoneForWAAPI("+201224885551");  // "201224885551@c.us"
formatPhoneForWAAPI("201224885551");   // "201224885551@c.us"
formatPhoneForWAAPI("201224885551@c.us"); // "201224885551@c.us"
```

---

## Error Handling

### Common Errors

**1. Instance Already Exists**
```json
{
  "error": "Instance with name \"WASP-{domain}\" already exists (ID: {id}). Use the existing instance instead of creating a duplicate."
}
```
**Solution:** Use existing instance instead of creating new one.

---

**2. Invalid Token (401/403)**
```json
{
  "status": 401,
  "error": "Unauthorized"
}
```
**Solution:** Verify `WAAPI_TOKEN` is valid and not expired.

---

**3. QR Code Not Ready**
```json
{
  "error": "Failed to get QR code: 404 - Not found"
}
```
**Solution:** Implement retry logic (wait 10-15 seconds after instance creation).

---

**4. Instance Not Connected**
```json
{
  "error": "WAAPI instance found but not connected. Status: PENDING"
}
```
**Solution:** Wait for instance to connect (status = "ready" or "authenticated") before sending messages.

---

**5. Invalid Phone Number Format**
**Error:** Message sending fails
**Solution:** Format phone as: remove all non-digits, add `@c.us` suffix
- `+201224885551` → `201224885551@c.us`

---

## Testing

### Test Instance Creation
```bash
curl -X POST "https://waapi.app/api/v1/instances" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "WASP-test.myshopify.com"}'
```

### Test QR Code
```bash
curl -X GET "https://waapi.app/api/v1/instances/INSTANCE_ID/client/qr" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Test Status
```bash
curl -X GET "https://waapi.app/api/v1/instances/INSTANCE_ID/client/status" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Test Send Poll
```bash
curl -X POST "https://waapi.app/api/v1/instances/INSTANCE_ID/client/action/create-poll" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "201224885551@c.us",
    "caption": "Test poll message",
    "options": ["Confirm", "Cancel"],
    "multipleAnswers": false
  }'
```

### Test Webhook (Local)
```bash
curl -X POST "http://localhost:3000/webhooks/waapi" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "vote_update",
    "instanceId": "test-instance",
    "data": {
      "vote": {
        "voter": "201224885551",
        "selectedOptions": ["Confirm"]
      }
    }
  }'
```

---

## Migration to whatsapp-web.js

### Key Differences
1. **Library:** `whatsapp-web.js` uses local WhatsApp Web connection (no external API)
2. **Authentication:** QR code scanning handled by library (no API endpoint)
3. **Webhooks:** Need to implement your own webhook server (library emits events)
4. **Poll Messages:** Library supports polls via `client.sendPoll()`
5. **Instance Management:** No external instance management (one client per process)

### Equivalent Functions

**WAAPI → whatsapp-web.js:**

| WAAPI | whatsapp-web.js |
|-------|----------------|
| `POST /instances` | `new Client({ ... })` + `client.initialize()` |
| `GET /instances/{id}/client/qr` | `client.on('qr', (qr) => ...)` event |
| `GET /instances/{id}/client/status` | `client.getState()` or `client.info` |
| `GET /instances/{id}/client/me` | `client.info` (contains user details) |
| `POST /instances/{id}/client/action/create-poll` | `client.sendPoll(chatId, pollOptions)` |
| `POST /instances/{id}/client/action/send-message` | `client.sendMessage(chatId, message)` |
| `PUT /instances/{id}` (webhook) | Implement event listeners + HTTP webhook server |
| `GET /instances` | Not needed (one client per process) |
| `DELETE /instances/{id}` | `client.logout()` or `client.destroy()` |
| `POST /instances/{id}/client/action/logout` | `client.logout()` |

### Webhook Events Mapping

| WAAPI Event | whatsapp-web.js Event |
|-------------|----------------------|
| `vote_update` | `client.on('poll_vote', (vote) => ...)` |
| `qr` | `client.on('qr', (qr) => ...)` |
| `ready` | `client.on('ready', () => ...)` |
| `authenticated` | `client.on('authenticated', () => ...)` |
| `disconnected` | `client.on('disconnect', (reason) => ...)` |
| `change_state` | `client.on('change_state', (state) => ...)` |
| `auth_failure` | `client.on('auth_failure', (msg) => ...)` |
| `message` | `client.on('message', (message) => ...)` |

### Example: whatsapp-web.js Implementation

```javascript
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

// Create client (equivalent to WAAPI createInstance)
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'WASP-shop-domain'  // Instance name equivalent
  })
});

// QR code (equivalent to GET /instances/{id}/client/qr)
client.on('qr', async (qr) => {
  const qrImage = await qrcode.toDataURL(qr);
  // Send QR to frontend or webhook
});

// Ready (equivalent to ready/authenticated events)
client.on('ready', () => {
  console.log('Client is ready!');
  const info = client.info;
  // info.pushname = displayName
  // info.wid.user = phone number
});

// Status (equivalent to GET /instances/{id}/client/status)
const state = await client.getState();
// state = 'CONNECTED' | 'OPENING' | 'PAIRING' | 'UNPAIRED'

// Send poll (equivalent to POST /instances/{id}/client/action/create-poll)
const chatId = '201224885551@c.us';
const pollOptions = {
  name: 'Confirming your order...',
  options: ['Confirm', 'Cancel'],
  selectableCount: 1  // multipleAnswers: false
};
await client.sendPoll(chatId, pollOptions);

// Poll vote (equivalent to vote_update webhook)
client.on('poll_vote', async (vote) => {
  const chatId = vote.pollData.chatId;
  const voter = vote.voter;
  const selectedOptions = vote.selectedOptions;
  // Send to your webhook endpoint
});

// Initialize (equivalent to instance creation + connection)
await client.initialize();
```

### Webhook Server Implementation

Since `whatsapp-web.js` doesn't have built-in webhooks, you need to create your own:

```javascript
const express = require('express');
const app = express();

app.use(express.json());

// Listen to whatsapp-web.js events and forward as webhooks
client.on('poll_vote', async (vote) => {
  // Forward to your webhook endpoint
  await fetch('https://your-app.com/webhooks/waapi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'vote_update',
      instanceId: 'local-instance',  // Or use shop domain
      data: {
        vote: {
          voter: vote.voter,
          selectedOptions: vote.selectedOptions
        }
      }
    })
  });
});

// Similar for other events: qr, ready, disconnected, etc.
```

---

## Summary

This document covers all WAAPI interactions needed to replace it with `whatsapp-web.js`:
- **10 API endpoints** with full request/response formats
- **5 webhook event types** with payload structures
- **Message formats** and phone number formatting rules
- **Error handling** and testing examples
- **Migration guide** for `whatsapp-web.js`

Use this as a complete reference when implementing the same functionality with `whatsapp-web.js` or any other WhatsApp library.
