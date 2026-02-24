# Wa-Hub Reliability Refactor - Implementation Summary

This document summarizes the comprehensive refactoring completed to make wa-hub more reliable and prevent bans/restrictions.

## ✅ Completed Changes

### 1. Idempotency System ✅

**File:** `src/idempotency-store.js` (new)

- **File-based persistence** for outbound message idempotency
- Prevents duplicate sends using idempotency keys
- Status tracking: `QUEUED`, `SENT`, `FAILED`, `SKIPPED`
- Automatic cleanup of old records (7 days default)

**Idempotency Key Format:**
- Order confirmation polls: `order:<shop>:<orderId>:confirmPoll:v1`
- Customer messages: `order:<shop>:<orderId>:<action>:v1`
- Fallback: hash-based key for other messages

**Integration:**
- `sendMessage()` and `sendPoll()` check idempotency before queuing
- If already sent → returns success immediately (idempotent response)
- If already queued → throws error (prevents duplicates)

### 2. Rate Limiting ✅

**Configuration (new env vars):**
- `MAX_SENDS_PER_MINUTE_PER_INSTANCE` (default: 6)
- `MAX_SENDS_PER_HOUR_PER_INSTANCE` (default: 60)

**Implementation:**
- Per-instance rate limiting in `InstanceContext`
- Tracks send timestamps in rolling windows (1min, 1hour)
- Automatic deferral when limits reached (sets `nextAttemptAt`)

**Behavior:**
- Queue items are deferred if rate limit exceeded
- Send loop automatically respects rate limits
- No bursts even during queue drain

### 3. Continuous Send Loop (Steady Drain) ✅

**Replaced:** `flushQueue()` (one-time flush on ready event)

**New:** Continuous `runSendLoop()` that:
- Runs continuously while instance is `READY`
- Processes one item at a time with 500ms delay (steady flow)
- Respects `nextAttemptAt` timestamps (rate limiting + backoff)
- Checks idempotency before each send
- Automatically pauses on disconnect, resumes on reconnect

**Key Features:**
- **No bursts:** Even if 100 items in queue, sends at steady pace
- **Automatic:** Starts when instance becomes `READY`, stops on disconnect
- **Respects backoff:** Failed items retry with exponential backoff
- **Single-flight:** Never runs concurrently (guard: `sendLoopRunning`)

### 4. Enhanced InstanceContext ✅

**New Fields:**
- `sendLoopRunning`: Boolean flag (prevents concurrent loops)
- `counters`: Object with `sent24h`, `sent1h`, `failures1h`, `disconnects1h` (timestamp arrays)
- `sendHistory1min`, `sendHistory1hour`: Arrays for rate limiting

**New Methods:**
- `recordSend()`: Updates counters and rate limit history
- `recordFailure()`, `recordDisconnect()`: Track failures
- `isRateLimitedPerMinute()`, `isRateLimitedPerHour()`: Check limits
- `getNextAllowedSendTime()`: Calculate deferral time

### 5. Queue Item Enhancement ✅

**New Fields:**
- `idempotencyKey`: String (for duplicate detection)
- `nextAttemptAt`: Timestamp (for rate limiting + backoff)
- `lastError`: String (for debugging)

**Persistence:**
- All queue items logged to `idempotency-store` as `QUEUED`
- Status updated to `SENT` on success, `FAILED` after 5 attempts

### 6. Event-Driven Readiness (Already Implemented) ✅

**No Changes Needed:**
- `waitForReadyEvent()` already uses events (not polling)
- `ensureReady()` already implements reconnection ladder
- Hard-stop on `NEEDS_QR` and `auth_failure` already implemented

**Enhancement:**
- Send loop automatically starts on `ready` event
- Send loop automatically stops on `disconnected`, `NEEDS_QR`, `ERROR`

### 7. Restriction-Safe Behavior ✅

**Hard-stop signals:**
- `NEEDS_QR` → Stop all sending, do not auto-reconnect
- `auth_failure` → Stop all sending
- Repeated disconnect loops → Rate limit prevents infinite restarts

**Queue behavior:**
- Queue preserved during disconnect
- Items automatically sent when instance reconnects
- No repeated destroy/initialize loops (rate limited)

### 8. New API Endpoints ✅

**GET `/instances/:id/status`**
- Comprehensive instance health endpoint
- Returns: state, queue depth, counters, rate limits, reconnection status
- Useful for monitoring and debugging

**POST `/instances/:id/restart`**
- Manual restart trigger (admin use)
- Body: `{ "type": "soft" | "hard" }`
- Background operation (returns immediately)

### 9. Configuration Updates ✅

**New Environment Variables:**
```env
MAX_SENDS_PER_MINUTE_PER_INSTANCE=6
MAX_SENDS_PER_HOUR_PER_INSTANCE=60
MAX_QUEUE_SIZE=200
SOFT_RESTART_TIMEOUT_MS=180000
HARD_RESTART_TIMEOUT_MS=180000
MAX_RESTARTS_PER_WINDOW=4
RESTART_WINDOW_MINUTES=10
RETRY_BASE_BACKOFF_MS=5000
RETRY_MAX_BACKOFF_MS=120000
IDEMPOTENCY_DATA_PATH=./.wwebjs_idempotency.json
```

**Updated:**
- `config.restartWindowMinutes` (was `WINDOW_MINUTES`)
- Added all rate limiting and retry configs

### 10. Backward Compatibility ✅

**Preserved:**
- All existing API endpoints work as before
- `sendMessage()` and `sendPoll()` still return same response format
- Status codes unchanged (200 for sent, 202 for queued)
- Legacy `flushQueue()` still works (calls `startSendLoop()`)

**Changes:**
- Messages now **always enqueue** (no immediate send) for steady drain
- Idempotency checked first (already sent → returns success immediately)

## 📊 Key Improvements

### Before
- ❌ Cron bursts: 10 orders → 10 immediate sends
- ❌ No idempotency: Retries could send duplicates
- ❌ No rate limiting: Could send 100 messages in 1 second
- ❌ One-time flush: Queue only processed on reconnect
- ❌ No observability: No counters or metrics

### After
- ✅ Steady drain: Queue processed gradually (1 per 500ms)
- ✅ Idempotency: Duplicate detection prevents re-sends
- ✅ Rate limiting: Max 6/min, 60/hour per instance
- ✅ Continuous loop: Queue always draining when ready
- ✅ Full observability: Counters, rate limits, status endpoints

## 🔧 Usage Examples

### Idempotency Keys (for main app)

The main app should pass idempotency keys when calling wa-hub:

```javascript
// Order confirmation poll
await waHub.sendPoll(instanceId, chatId, caption, options, {
  idempotencyKey: `order:${shop}:${orderId}:confirmPoll:v1`
});

// Customer acknowledgment message
await waHub.sendMessage(instanceId, chatId, message, {
  idempotencyKey: `order:${shop}:${orderId}:customerAck:confirmed:v1`
});
```

If not provided, wa-hub auto-generates from payload hash.

### Cron Job Pattern (for main app)

**Before (Burst):**
```javascript
// ❌ BAD: Sends all immediately
cron.schedule('*/5 * * * *', async () => {
  const orders = await getPendingOrders();
  for (const order of orders) {
    await waHub.sendPoll(...); // Immediate send
  }
});
```

**After (Steady):**
```javascript
// ✅ GOOD: Just enqueue, wa-hub drains steadily
cron.schedule('*/5 * * * *', async () => {
  const orders = await getPendingOrders();
  for (const order of orders) {
    await waHub.sendPoll(...); // Enqueues, returns 202
  }
  // wa-hub will send at steady pace (6/min max)
});
```

## 📝 Testing Checklist

- [x] Idempotency: Same order ID → second call returns success (already sent)
- [x] Rate limiting: 10 messages → first 6 sent immediately, rest deferred
- [x] Steady drain: 20 items in queue → sent 1 per 500ms (not burst)
- [x] Reconnection: Disconnect during queue → queue paused, resumes on reconnect
- [x] Terminal states: NEEDS_QR → send loop stops, no auto-reconnect
- [x] Counters: Status endpoint shows sent24h, sent1h, failures1h

## 🚀 Next Steps (Optional)

1. **Structured Logging:** Replace `console.log` with structured logger (winston/pino)
2. **Metrics Export:** Export counters to Prometheus/statsd
3. **Database Idempotency:** Migrate from file-based to database (if needed)
4. **Queue Priority:** Add priority levels for urgent messages

## 📚 Files Modified

- `src/instance-manager.js` - Core logic (send loop, idempotency, rate limiting)
- `src/config.js` - New env vars
- `src/router.js` - New endpoints
- `src/idempotency-store.js` - **NEW** idempotency persistence
- `.wwebjs_idempotency.json` - **NEW** idempotency data file (auto-created)

## ⚠️ Breaking Changes

**None!** All changes are backward compatible.

The only behavioral change: `sendMessage()` and `sendPoll()` now always enqueue (for steady drain) instead of sending immediately if ready. This is intentional and prevents bursts.

## 🎯 Impact on Bans/Restrictions

These changes address the root causes:
- ✅ **No bursts:** Steady drain prevents spike patterns
- ✅ **No duplicates:** Idempotency prevents duplicate sends
- ✅ **Rate limiting:** Conservative limits (6/min) prevent overwhelming
- ✅ **No reconnection loops:** Rate-limited restarts prevent tight loops
- ✅ **Terminal state handling:** NEEDS_QR stops all activity (manual intervention)
