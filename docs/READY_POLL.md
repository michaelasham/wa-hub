# Ready-Poll Fallback

## Why It Exists

whatsapp-web.js sometimes never emits the `ready` event even when the client is fully connected and authenticated. The phone shows "Active" but wa-hub stays stuck in `connecting` indefinitely.

The ready-poll fallback detects readiness by polling `client.info` and `client.getState()` instead of relying solely on the `ready` event.

## How It Works

After `authenticated` fires, wa-hub starts a poll every `READY_POLL_INTERVAL_MS` (default 15s). The poll treats the client as ready only when **both** signals pass:

1. **client.info** exists (contact info populated)
2. **client.getState()** succeeds and returns a non-empty string (e.g. `CONNECTED`)

If either check fails (throws or returns empty), we keep polling. This avoids false positives from partial or transient state.

## Safety Checks

- **Idempotent**: `markReady()` returns immediately if the instance is already `READY` or `readyInProgress`
- **Only after authenticated**: Poll-based ready is allowed only after we've seen the `authenticated` event
- **Dual signal**: Requires both `client.info` and `client.getState()` to pass
- **Terminal paths**: The poll timer is stopped on: ready (event or poll), auth_failure, disconnected, soft/hard restart, instance deletion, watchdog timeout

## Diagnostics

- `readySource`: `"event"` | `"poll"` | null — how ready was detected
- `authenticatedAt`, `readyAt`, `authenticatedToReadyMs` — timing
- `readyPollAttempts` — number of poll checks run
- `lastReadyPollError` — last error from `getState()` (if any)

Exposed via `GET /instances/:id/client/status` and `GET /instances/:id/diagnostics`.
