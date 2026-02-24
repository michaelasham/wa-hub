# Webhook Configuration

## Default Webhook URL

The default webhook URL is configured in `.env`:

```env
MAIN_APP_WEBHOOK_BASE=https://heard-parameter-maybe-strange.trycloudflare.com/webhooks/waapi
```

All new instances will use this URL by default when no webhook URL is specified during instance creation.

## Per-Instance Webhook URLs

You can also specify a different webhook URL for each instance when creating it:

```bash
curl -X POST http://localhost:3000/instances \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "WASP-shop1.myshopify.com",
    "webhook": {
      "url": "https://heard-parameter-maybe-strange.trycloudflare.com/webhooks/waapi",
      "events": ["vote_update", "qr", "ready", "authenticated", "disconnected", "change_state", "auth_failure", "message"]
    }
  }'
```

## Webhook Events

The following events are forwarded to your webhook URL:

- `vote_update` - Poll vote responses (CRITICAL for COD confirmations)
- `qr` - QR code updates (for connection flow)
- `ready` - Instance ready/connected
- `authenticated` - Authentication successful
- `disconnected` - Instance disconnected
- `change_state` - Instance state changes
- `auth_failure` - Authentication failures
- `message` - Incoming messages

## Webhook Payload Format

All webhook payloads are sent as POST requests with JSON body:

```json
{
  "event": "vote_update",
  "instanceId": "WASP-shop1_myshopify_com",
  "data": {
    "vote": {
      "voter": "201224885551",
      "selectedOptions": ["Confirm"],
      "timestamp": 1234567890
    }
  }
}
```

## Webhook Signature

The `WEBHOOK_SECRET` is configured in `.env` (currently: `michaelasham`). All webhook requests include an `x-wa-hub-signature` header with HMAC-SHA256 signature.

Verify the signature in your webhook handler:

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

## Testing

Make sure your webhook endpoint is accessible and returns `200 OK` to prevent retries.
