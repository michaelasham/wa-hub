# Regression Fix: Stuck NEEDS_QR / CONNECTING

## Summary

This fix addresses instances getting stuck in NEEDS_QR or CONNECTING after introducing disk cleanup and message queue. Changes focus on:

1. **Disk cleanup** – Safeguards against accidental deletion of session/auth data
2. **Event handlers** – Webhook forwarding never blocks state transitions
3. **Watchdog** – Restart when stuck in CONNECTING > 3 min (soft/hard restart)
4. **Diagnostics** – New endpoint for debugging stuck instances

## Changes

### 1. Disk Cleanup (`scripts/wa-hub-cleanup.sh`)

- **PROTECTED_DIRS**: Added Cookies, History, Preferences, Web Data, Login Data, Local Application Storage, puppeteer, userDataDir
- **Explicit path logging**: Logs exact path before each delete
- **Safety check**: `is_protected()` blocks session/auth-related paths

### 2. Event Handlers (`src/instance-manager.js`)

- **Fire-and-forget webhooks**: All lifecycle event handlers use `void forwardWebhook(...).catch(() => {})` so webhook failures never block state transitions
- **State before webhook**: `transitionTo()` is always called before any `forwardWebhook`
- **Webhook status tracking**: `lastWebhookEvent`, `lastWebhookStatus`, `lastWebhookAt`, `lastWebhookError` for diagnostics

### 3. High-Signal Logs

- Timestamp added to all event logs: `[${ts}] [${instanceId}] Event: qr`
- State transitions include timestamp: `[${ts}] [${instanceId}] State transition: ...`

### 4. CONNECTING Watchdog

- **Config**: `CONNECTING_WATCHDOG_MS` (default 180000 = 3 min)
- **Scope**: Starts only in `softRestartAndWaitReady` and `hardRestartAndWaitReady` (not during initial createInstance)
- **Behavior**: If instance stays in CONNECTING or NEEDS_QR for 3 min after a restart, runs `hardRestartAndWaitReady`
- **Logging**: `connecting_watchdog_timeout` event with elapsedMs and state

### 5. Diagnostic Endpoint

**GET** `/instances/:id/diagnostics`

Returns:
- `state`, `lastEvent`, `lastEventAt`
- `lastWebhookEvent`, `lastWebhookStatus`, `lastWebhookAt`, `lastWebhookError`
- `lastError`, `lastErrorAt`, `lastErrorStack`
- `readyWatchdogStartAt`, `connectingWatchdogStartAt`
- `qrReceivedDuringRestart`, `restartAttempts`, `queueDepth`, `sendLoopRunning`

### 6. Error Tracking

- `lastError`, `lastErrorAt`, `lastErrorStack` set on qr processing errors, auth_failure, and connecting watchdog timeout

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONNECTING_WATCHDOG_MS` | 180000 | Ms before restarting stuck CONNECTING/NEEDS_QR (3 min) |

## Usage

```bash
# Get diagnostics for stuck instance
curl -H "Authorization: Bearer $WA_HUB_TOKEN" \
  http://localhost:3000/instances/{instanceId}/diagnostics
```

## Testing

1. Run cleanup in dry-run: `DRY_RUN=1 ./scripts/wa-hub-cleanup.sh`
2. Verify protected paths are never deleted
3. Check logs for timestamped events and state transitions
4. Hit `/instances/:id/diagnostics` when instance is stuck
