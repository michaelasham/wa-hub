# wa-hub API Test Commands

Quick reference for testing wa-hub API endpoints with curl.

**Base URL:** `http://localhost:3000`

**Authentication:** All endpoints (except `/health`) require an API key. Include it in requests as:
- Authorization header: `Authorization: Bearer {API_KEY}`
- Or X-API-Key header: `X-API-Key: {API_KEY}`

**Your API Key:** `f0bdaeb85348f62f9d415e8bd749d251f5634e292ec61d7a133cd32ad71f1662`

(Add this to your `.env` file as `API_KEY=...`)

---

## 1. Health Check

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{"status":"ok","service":"wa-hub"}
```

---

## 2. List All Instances

```bash
curl http://localhost:3000/instances
```

Expected response:
```json
[]
```
(Empty array initially)

---

## 3. Create Instance

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

**Note:** Wait 10-15 seconds after creating before requesting QR code.

---

## 4. Get QR Code

Replace `INSTANCE_ID` with your instance ID (e.g., `WASP-test.myshopify.com`):

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

To view the QR code, decode the base64 string or use an online base64 to image converter.

---

## 5. Get Instance Status

```bash
curl http://localhost:3000/instances/WASP-test.myshopify.com/client/status
```

Expected responses:

**Before scanning QR:**
```json
{
  "clientStatus": {
    "instanceStatus": "qr",
    "instanceId": "WASP-test.myshopify.com",
    "data": {}
  },
  "status": "success"
}
```

**After scanning QR (ready):**
```json
{
  "clientStatus": {
    "instanceStatus": "ready",
    "instanceId": "WASP-test.myshopify.com",
    "data": {
      "phoneNumber": "1234567890",
      "formattedNumber": "1234567890"
    }
  },
  "status": "success"
}
```

---

## 6. Get Client Details (Me)

**Only works when instance is `ready`:**

```bash
curl http://localhost:3000/instances/WASP-test.myshopify.com/client/me
```

Expected response:
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

## 7. Update Instance (Webhook Configuration)

```bash
curl -X PUT http://localhost:3000/instances/WASP-test.myshopify.com \
  -H "Content-Type: application/json" \
  -d '{
    "name": "WASP-test-updated.myshopify.com",
    "webhook": {
      "url": "http://localhost:3001/webhooks/waapi",
      "events": ["qr", "ready", "message"]
    }
  }'
```

---

## 8. Send Text Message

**Requires instance to be `ready` (connected):**

Replace `PHONE_NUMBER` with recipient's phone number (format: country code + number, no + sign, e.g., `201224885551`):

```bash
curl -X POST http://localhost:3000/instances/WASP-test.myshopify.com/client/action/send-message \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "201224885551",
    "message": "Hello from wa-hub! 👋"
  }'
```

Expected response:
```json
{
  "messageId": "message_id_here",
  "status": "success"
}
```

---

## 9. Send Poll Message

**Requires instance to be `ready` (connected):**

```bash
curl -X POST http://localhost:3000/instances/WASP-test.myshopify.com/client/action/create-poll \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "201224885551",
    "caption": "Test poll: Do you like testing?",
    "options": ["Yes", "No"],
    "multipleAnswers": false
  }'
```

Expected response:
```json
{
  "messageId": "message_id_here",
  "status": "success"
}
```

---

## 10. Logout Instance

```bash
curl -X POST http://localhost:3000/instances/WASP-test.myshopify.com/client/action/logout
```

Expected response:
```json
{
  "message": "Instance WASP-test.myshopify.com logged out successfully",
  "status": "success"
}
```

---

## 11. Delete Instance

```bash
curl -X DELETE http://localhost:3000/instances/WASP-test.myshopify.com
```

Expected response:
```json
{
  "message": "Instance WASP-test.myshopify.com deleted successfully",
  "status": "success"
}
```

---

## Quick Test Flow

1. **Start webhook server** (in another terminal):
   ```bash
   npm run test-webhook
   ```

2. **Start wa-hub** (in another terminal):
   ```bash
   npm start
   ```

3. **Create instance:**
   ```bash
   curl -X POST http://localhost:3000/instances \
     -H "Content-Type: application/json" \
     -d '{"name": "WASP-test.myshopify.com"}'
   ```

4. **Wait 10-15 seconds, then get QR code:**
   ```bash
   curl http://localhost:3000/instances/WASP-test.myshopify.com/client/qr
   ```

5. **Check status:**
   ```bash
   curl http://localhost:3000/instances/WASP-test.myshopify.com/client/status
   ```

6. **Scan QR code with WhatsApp** (Settings > Linked Devices > Link a Device)

7. **Check status again** (should show `ready`):
   ```bash
   curl http://localhost:3000/instances/WASP-test.myshopify.com/client/status
   ```

8. **Get client info:**
   ```bash
   curl http://localhost:3000/instances/WASP-test.myshopify.com/client/me
   ```

9. **Send a test message** (replace with your phone number):
   ```bash
   curl -X POST http://localhost:3000/instances/WASP-test.myshopify.com/client/action/send-message \
     -H "Content-Type: application/json" \
     -d '{"chatId": "YOUR_PHONE_NUMBER", "message": "Hello!"}'
   ```

10. **Clean up:**
    ```bash
    curl -X DELETE http://localhost:3000/instances/WASP-test.myshopify.com
    ```

---

## Tips

- Use `jq` for pretty JSON output: `curl ... | jq '.'`
- Replace `WASP-test.myshopify.com` with your actual instance ID
- Replace `201224885551` with actual phone numbers (format: country code + number, no + sign)
- Phone numbers are automatically formatted to include `@c.us` suffix
- Check webhook server terminal to see incoming events
- Status values: `initializing`, `qr`, `ready`, `authenticated`, `disconnected`, `auth_failure`

