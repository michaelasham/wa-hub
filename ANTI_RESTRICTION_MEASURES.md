# Anti-Restriction Measures - Human-Like Behavior

This document outlines all measures implemented in wa-hub to prevent WhatsApp account restrictions by avoiding bot-like patterns and bugs that could trigger WhatsApp's detection systems.

## 🎯 Core Principle

**We are NOT trying to "evade detection" or "fool WhatsApp"** - we are implementing **stability best practices** to ensure reliable, predictable, human-like messaging patterns that won't trigger false positives.

---

## 1. ✍️ Typing Indicator (Human-Like UX)

**Purpose:** Simulate natural human typing behavior before sending messages

**Implementation:**
- Random typing duration: 600-1800ms (configurable, default)
- Hard timeout limit: 2500ms maximum (prevents stuck typing)
- Only applies to customer-facing messages (not merchant notifications)
- Automatically clears typing state in `finally` block (never leaves typing "on")
- Skips groups automatically (typing in groups looks unnatural)
- Enabled by default for new instances

**Why It Helps:**
- Real users type before sending messages
- Prevents "instant reply" patterns that look automated
- Random timing prevents predictable patterns

**Configuration:**
```env
TYPING_INDICATOR_ENABLED_DEFAULT=true  # Enabled by default
TYPING_INDICATOR_MIN_MS=600
TYPING_INDICATOR_MAX_MS=1800
TYPING_INDICATOR_MAX_TOTAL_MS=2500
```

---

## 2. ⏱️ Rate Limiting (No Burst Patterns)

**Purpose:** Prevent rapid-fire message bursts that look like spam

**Implementation:**
- **Per-minute limit:** 6 messages/minute per instance (default, configurable)
- **Per-hour limit:** 60 messages/hour per instance (default, configurable)
- Automatic deferral: If limit reached, messages wait until window clears
- Independent tracking per instance (multi-tenant safe)

**Why It Helps:**
- Humans don't send 100 messages in 1 minute
- Prevents accidental bursts from:
  - Cron jobs sending multiple orders at once
  - Retry loops creating cascading sends
  - Queue flushes sending all items simultaneously
- Conservative limits reduce risk

**Configuration:**
```env
MAX_SENDS_PER_MINUTE_PER_INSTANCE=6   # Conservative: 1 every 10 seconds
MAX_SENDS_PER_HOUR_PER_INSTANCE=60    # Conservative: 1 per minute average
```

**Behavior:**
- Queue items automatically deferred when rate limit hit
- No rejection - messages wait gracefully
- Rate limit windows are rolling (not fixed)

---

## 3. 🔄 Steady Queue Drain (No Bursts)

**Purpose:** Replace bursty queue flushes with steady, gradual sending

**Problem (Before):**
- Cron scans orders → sends all immediately → 10 messages in 1 second ❌
- Queue flush on reconnect → all items sent at once → burst ❌
- Retry cascades → duplicate sends → more bursts ❌

**Solution (Now):**
- **Continuous send loop:** Processes queue gradually, one item at a time
- **500ms delay** between sends (configurable)
- **Respects rate limits:** Automatically defers when limits hit
- **Sequential processing:** Never sends multiple items simultaneously

**Why It Helps:**
- Humans send messages one at a time, not in bursts
- Even if queue has 20 items, sends at steady pace (20 seconds minimum)
- Prevents accidental spikes from cron jobs or reconnection

**Example:**
```
Before:  [Queue: 10 items] → Reconnect → Send all 10 in 1 second ❌
After:   [Queue: 10 items] → Reconnect → Send 1 per 500ms = 5 seconds ✅
```

---

## 4. 🛡️ Idempotency (No Duplicate Sends)

**Purpose:** Prevent duplicate messages from retries, bugs, or race conditions

**Problem:**
- Cron runs twice → same order confirmed twice ❌
- Retry on timeout → message already sent, retry sends again ❌
- Race condition → two processes send same message ❌

**Solution:**
- **Idempotency keys:** Each message/poll has unique key
  - Format: `order:<shop>:<orderId>:confirmPoll:v1`
- **Persistent storage:** File-based log tracks sent messages
- **Check before send:** If already sent, skip silently (return success)
- **Check before queue:** If already queued, reject duplicate

**Why It Helps:**
- Prevents duplicate messages that look like bot errors
- No more "Why did I get 3 confirmations for the same order?"
- Makes system robust to retries, cron duplicates, race conditions

**Status Tracking:**
- `QUEUED` - Message is in queue, waiting to send
- `SENT` - Message successfully sent (won't send again)
- `FAILED` - Failed after retries (won't retry forever)
- `SKIPPED` - Duplicate detected (already sent)

---

## 5. 🔁 Intelligent Reconnection (No Tight Loops)

**Purpose:** Prevent infinite reconnection loops that look suspicious

**Implementation:**
- **Reconnection ladder:** Soft restart → Hard restart → Stop
- **Rate limiting:** Max 4 restarts per 10-minute window
- **Terminal state detection:** `NEEDS_QR` or `auth_failure` → Stop trying
- **Exponential backoff:** 2s, 4s, 8s... up to max (prevents tight loops)
- **Single-flight:** Only one reconnection attempt at a time (mutex)

**Why It Helps:**
- Bots create/destroy sessions rapidly when they fail
- Humans don't reconnect 100 times per minute
- Terminal states (NEEDS_QR) mean manual intervention needed - stop auto-retrying

**Configuration:**
```env
MAX_RESTARTS_PER_WINDOW=4              # Max 4 restarts per window
RESTART_WINDOW_MINUTES=10              # 10-minute window
RESTART_BACKOFF_MS=2000                # Initial backoff: 2 seconds
```

**Behavior:**
- Normal disconnect → Auto-reconnect (once)
- Repeated disconnects → Backoff + rate limit
- NEEDS_QR → **Stop immediately** (manual intervention required)
- Rate limit exceeded → Mark as ERROR, stop retrying

---

## 6. 🚫 sendSeen Workaround (Prevents Crashes)

**Purpose:** Avoid a known WhatsApp Web bug that crashes sends

**Problem:**
- `whatsapp-web.js` internally calls `sendSeen()` after sending
- WhatsApp Web has a bug: `sendSeen` can fail with "markedUnread" error
- This crashes the entire send operation (message not sent, instance disconnects)

**Solution:**
- **Explicit `sendSeen: false`:** Disable automatic "seen" marking
- Applied to all `client.sendMessage()` calls
- Prevents the internal bug from crashing sends

**Why It Helps:**
- Prevents crashes that cause reconnection loops
- Prevents failed sends that trigger retries
- More stable → fewer suspicious disconnections

**Implementation:**
```javascript
await client.sendMessage(chatId, message, { sendSeen: false });
await client.sendMessage(chatId, poll, { sendSeen: false });
```

---

## 7. 📊 Queue System (No Lost Messages)

**Purpose:** Ensure messages aren't lost during disconnects

**Implementation:**
- **Per-instance queues:** Each instance has its own queue
- **Persistent idempotency:** Queue state tracked in idempotency store
- **Automatic flush on reconnect:** Queue processes when instance becomes READY
- **Retry with backoff:** Failed sends retry with exponential backoff

**Why It Helps:**
- Prevents "ghost sends" (API says sent, but message never sent)
- No message loss during network hiccups
- Predictable retry behavior (not aggressive)

---

## 8. 🔐 Per-Instance Isolation (No Cross-Contamination)

**Purpose:** Isolate session data per instance to prevent auth issues

**Implementation:**
- **LocalAuth per instance:** Each instance has its own `clientId`
- **Session data isolation:** `./wwebjs_auth/session-{instanceId}/`
- **Backward compatible:** Migrates old shared sessions automatically

**Why It Helps:**
- Prevents session conflicts between instances
- More reliable auto-login (each instance's auth is separate)
- Reduces "auth_failure" errors from session corruption

---

## 9. 🎛️ Terminal State Handling (Hard Stop)

**Purpose:** Stop all activity when WhatsApp requires manual intervention

**Implementation:**
- **NEEDS_QR state:** Instance needs QR scan → Stop all sending, stop auto-reconnect
- **auth_failure state:** Auth failed → Stop all activity
- **Queue preserved:** Items stay in queue, but no retries until manual intervention

**Why It Helps:**
- Prevents endless retry loops when account needs manual action
- WhatsApp might flag accounts that keep trying after being blocked
- Clear signal that human intervention needed

**Behavior:**
```
Instance state: NEEDS_QR
→ Send loop: STOPPED
→ Auto-reconnect: STOPPED  
→ Queue: PRESERVED (but not sending)
→ Status endpoint: Shows "needs_qr" clearly
```

---

## 10. ⚡ Event-Driven Readiness (No Polling)

**Purpose:** Avoid aggressive polling that looks like automation

**Problem (Polling):**
```javascript
// ❌ BAD: Checking status every 100ms
while (instance.status !== 'ready') {
  await sleep(100);
  status = await checkStatus();
}
```

**Solution (Event-Driven):**
```javascript
// ✅ GOOD: Wait for 'ready' event
await waitForReadyEvent(instanceId);  // Event-driven, not polling
```

**Why It Helps:**
- No CPU-wasting polling loops
- No constant status checks that look like automation
- More efficient, more natural

---

## 11. 📈 Observability & Monitoring

**Purpose:** Catch problems early before they become restriction triggers

**Implementation:**
- **Per-instance counters:** `sent24h`, `sent1h`, `failures1h`, `disconnects1h`
- **Structured logging:** All typing attempts, rate limits, failures logged
- **Status endpoint:** `GET /instances/:id/status` shows full health
- **Rate limit visibility:** Can see current sends/minute, sends/hour

**Why It Helps:**
- Monitor for unusual patterns (e.g., 1000 sends in 1 hour = problem)
- Catch bugs early (e.g., duplicate sends visible in logs)
- Debug restriction triggers (e.g., "Why did my instance disconnect?")

---

## 12. 🛡️ Error Classification & Handling

**Purpose:** Distinguish recoverable errors from terminal errors

**Implementation:**
- **Disconnect errors:** Classified → Trigger reconnection
- **Auth errors:** Classified → Stop (terminal)
- **Rate limit errors:** Classified → Defer (not an error)
- **Other errors:** Retry with exponential backoff

**Why It Helps:**
- Prevents retrying terminal errors (auth failures) forever
- Handles transient errors gracefully (network hiccups)
- No aggressive retries that look like attacks

---

## 📊 Summary Table

| Measure | Purpose | Default Behavior | Prevents |
|---------|---------|------------------|----------|
| **Typing Indicator** | Human-like typing | Enabled, 600-1800ms random | Instant-reply patterns |
| **Rate Limiting** | No bursts | 6/min, 60/hour | Message spam bursts |
| **Steady Drain** | Gradual sending | 500ms between sends | Queue flush bursts |
| **Idempotency** | No duplicates | Persistent tracking | Duplicate sends |
| **Reconnection Limits** | No tight loops | Max 4/10min, backoff | Infinite reconnect loops |
| **sendSeen: false** | Avoid crashes | Always disabled | Send failures |
| **Terminal States** | Hard stop | NEEDS_QR → stop all | Continued retry after block |
| **Event-Driven** | No polling | Wait for events | Aggressive status checks |
| **Per-Instance Auth** | Isolation | Separate sessions | Session conflicts |
| **Queue Persistence** | No message loss | Survives restarts | Lost messages |

---

## 🎯 Expected Behavior

With all these measures in place:

**Normal Operation:**
- ✅ Typing indicator appears 0.6-1.8 seconds before message
- ✅ Messages send at steady pace (max 6/minute)
- ✅ No duplicate sends (idempotency checked)
- ✅ Queue drains gradually (1 per 500ms)
- ✅ Disconnects handled gracefully (reconnect with backoff)
- ✅ Terminal states stop all activity (NEEDS_QR)

**During Problems:**
- ✅ Rate limit hit → Messages deferred (not rejected)
- ✅ Disconnect during send → Message re-queued, reconnect triggered
- ✅ Duplicate detected → Skipped silently (no error)
- ✅ NEEDS_QR state → All activity stops, manual intervention required

**Monitoring:**
- ✅ Status endpoint shows: rate limits, queue depth, counters, state
- ✅ Logs show: typing attempts, rate limit hits, failures
- ✅ Idempotency store shows: sent/queued/failed messages

---

## ⚙️ Configuration Checklist

For production deployment, ensure these are configured:

```env
# Typing Indicator (enabled by default)
TYPING_INDICATOR_ENABLED_DEFAULT=true
TYPING_INDICATOR_MIN_MS=600
TYPING_INDICATOR_MAX_MS=1800

# Rate Limiting (conservative defaults)
MAX_SENDS_PER_MINUTE_PER_INSTANCE=6
MAX_SENDS_PER_HOUR_PER_INSTANCE=60

# Reconnection Limits (prevent loops)
MAX_RESTARTS_PER_WINDOW=4
RESTART_WINDOW_MINUTES=10

# Queue Limits
MAX_QUEUE_SIZE=200

# Timeouts (safety limits)
TYPING_INDICATOR_MAX_TOTAL_MS=2500
READY_TIMEOUT_MS=180000
```

---

## 🚨 What We DON'T Do (Anti-Patterns Avoided)

- ❌ **No random delays to "hide" automation** - We use delays for steady flow, not deception
- ❌ **No message content obfuscation** - We send honest messages as-is
- ❌ **No proxy rotation or IP masking** - We rely on legitimate infrastructure
- ❌ **No aggressive retries** - We respect backoff and rate limits
- ❌ **No fake user-agent strings** - We use whatsapp-web.js as-is
- ❌ **No timing randomization for "stealth"** - Our randomization is for natural UX (typing)

**Our approach:** Stability, reliability, and predictable human-like patterns - not deception.

---

## 📚 Related Documentation

- [REFACTOR_SUMMARY.md](./REFACTOR_SUMMARY.md) - Technical implementation details
- [API_CHANGES.md](./API_CHANGES.md) - API changes for app developers
- [README.md](./README.md) - Setup and usage guide

---

**Last Updated:** 2025-01-27
