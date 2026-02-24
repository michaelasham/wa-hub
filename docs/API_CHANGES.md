# Important API Changes - For App Developers

This document outlines important changes and new features in the wa-hub API that app developers should be aware of when building applications on top of this service.

## 📋 Summary of Changes

The service has been enhanced with automatic reconnection, message queueing, and improved error handling. These changes improve reliability but introduce some new response fields and behaviors.

---

## 🆕 New Response Fields

### `send-message` and `create-poll` Endpoints

These endpoints now return additional information about the instance state and queue:

**Success Response (200 - Message Sent Immediately):**
```json
{
  "messageId": "true_201223998599@c.us_3EB085CB259DFB9774AA80",
  "status": "success",
  "instanceState": "ready",
  "queueDepth": 0
}
```

**Queued Response (202 - Message/Poll Queued):**
```json
{
  "status": "queued",
  "instanceState": "disconnected",
  "queueDepth": 5,
  "queueId": "queue-item-id",
  "message": "Message queued. Will be sent when instance becomes ready."
}
```

### New Fields Explained

- **`instanceState`**: Current state of the WhatsApp instance
  - `ready` - Instance is connected and ready to send messages
  - `connecting` - Instance is in the process of connecting
  - `disconnected` - Instance is disconnected (will auto-reconnect)
  - `needs_qr` - Instance requires QR code scan (terminal state - needs manual intervention)
  - `error` - Instance is in an error state

- **`queueDepth`**: Number of messages/polls currently queued for this instance
  - `0` means no items in queue
  - If > 0, messages are waiting to be sent when instance becomes ready

---

## 🔄 Automatic Message Queueing

**What Changed:**
- Messages and polls are now **automatically queued** if the instance is not ready
- Queued items are **automatically sent** when the instance becomes ready
- No manual intervention required - this is fully transparent

**When Messages Are Queued:**
- Instance state is `disconnected`, `connecting`, or `error`
- Queue will automatically flush when instance transitions to `ready`

**Queue Limits:**
- Default maximum queue size: **200 items**
- If queue is full, new requests return `429 Too Many Requests`
- Queue size is configurable via `MAX_QUEUE_SIZE` environment variable

**What This Means for Your App:**
- You can send messages even when an instance is temporarily disconnected
- Messages will be delivered automatically when the instance reconnects
- Monitor `queueDepth` if you want to track queued messages
- Handle `202` status code as "queued successfully" (not an error)
- Handle `429` status code as "queue full - retry later"

---

## 🔁 Automatic Reconnection

**What Changed:**
- Instances now **automatically reconnect** when disconnected
- Reconnection happens in the background - no API calls needed
- Reconnection uses a "reconnection ladder": soft restart → hard restart

**What This Means for Your App:**
- You don't need to manually reconnect instances
- Messages sent during disconnection will be queued and sent after reconnection
- You can still check instance status via `/instances/:id/client/status` if needed
- Monitor webhook events (`ready`, `disconnected`) to track connection state

**Terminal States:**
- `needs_qr` - Instance requires QR code scan (automatic reconnection stops)
- `error` - Instance is in error state (may or may not auto-reconnect depending on error)

---

## 📊 HTTP Status Codes

### Success Status Codes

- **200 OK**: Message/poll sent immediately
  ```json
  { "status": "success", "instanceState": "ready", "queueDepth": 0 }
  ```

- **202 Accepted**: Message/poll queued successfully
  ```json
  { "status": "queued", "instanceState": "disconnecting", "queueDepth": 3 }
  ```

### Error Status Codes

- **400 Bad Request**: Invalid request or instance in terminal state (e.g., `needs_qr`)
  ```json
  { "error": "Instance needs QR code scan...", "status": 400 }
  ```

- **404 Not Found**: Instance not found

- **429 Too Many Requests**: Queue is full (max queue size reached)
  ```json
  { "error": "Queue full. Maximum queue size (200) reached.", "status": 429 }
  ```

- **500 Internal Server Error**: Unexpected server error

---

## 🔍 Recommended App Behavior

### 1. Handle Multiple Status Codes

```javascript
// Example: Handling different response scenarios
async function sendMessage(instanceId, chatId, message) {
  const response = await fetch(`/instances/${instanceId}/client/action/send-message`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ chatId, message })
  });

  const data = await response.json();

  if (response.status === 200) {
    // Message sent immediately
    console.log(`Message sent: ${data.messageId}`);
    return { success: true, messageId: data.messageId };
  } else if (response.status === 202) {
    // Message queued
    console.log(`Message queued (${data.queueDepth} in queue)`);
    return { success: true, queued: true, queueDepth: data.queueDepth };
  } else if (response.status === 429) {
    // Queue full - retry later
    console.warn('Queue full, retry later');
    return { success: false, error: 'Queue full', retry: true };
  } else if (response.status === 400 && data.error?.includes('QR')) {
    // Terminal state - needs manual intervention
    console.error('Instance needs QR scan');
    return { success: false, error: 'Needs QR scan', needsManualAction: true };
  } else {
    // Other error
    return { success: false, error: data.error };
  }
}
```

### 2. Monitor Instance State (Optional)

If you want to track instance health, you can periodically check the status:

```javascript
// Get instance status
const response = await fetch(`/instances/${instanceId}/client/status`, {
  headers: { 'Authorization': `Bearer ${API_KEY}` }
});

const data = await response.json();
const state = data.clientStatus?.instanceStatus; // "ready", "disconnected", etc.
```

### 3. Listen to Webhook Events

The webhook events provide real-time updates about instance state:

- **`ready`** - Instance is ready to send messages
- **`disconnected`** - Instance disconnected (will auto-reconnect)
- **`change_state`** - Instance state changed
- **`needs_qr`** - Instance needs QR code scan (manual intervention required)

### 4. Enhanced `vote_update` Webhook Payload

The `vote_update` webhook now includes `pollMessageId` for linking votes to the original poll:

**Example `vote_update` payload:**
```json
{
  "event": "vote_update",
  "instanceId": "WASP-blesscurls_myshopify_com",
  "data": {
    "vote": {
      "voter": "201223998599",
      "selectedOptions": ["Confirm"],
      "timestamp": 1234567890,
      "pollMessageId": "true_201223998599@c.us_3EB085CB259DFB9774AA80"
    }
  }
}
```

**What This Means:**
- Use `pollMessageId` + `instanceId` + `voter` as an idempotent key to track poll votes
- Link votes back to the original poll message/order
- `pollMessageId` may be `null` if the parent poll message ID cannot be determined

---

## ⚠️ Breaking Changes

**None!** These are additive changes. Existing code will continue to work, but you can optionally use the new fields for better visibility.

---

## 🎯 Key Takeaways

1. ✅ **Messages are automatically queued** when instances are disconnected
2. ✅ **Instances automatically reconnect** - no manual intervention needed
3. ✅ **Monitor `instanceState` and `queueDepth`** for better visibility
4. ✅ **Handle `202` status code** as successful queuing (not an error)
5. ✅ **Handle `429` status code** when queue is full (retry later)
6. ✅ **Watch for `needs_qr` state** - this requires manual QR code scan
7. ✅ **Use `pollMessageId` in `vote_update` webhooks** to link votes to original polls/orders

---

## 📚 Additional Resources

- See [API.md](./API.md) for complete API documentation
- See [WEBHOOK_SETUP.md](./WEBHOOK_SETUP.md) for webhook configuration details
- See [README.md](./README.md) for deployment and configuration

---

**Last Updated:** 2025-01-27
