# Dashboard ↔ wa-hub Communication (Detailed Reference)

This document explains how the wa-hub-dashboard communicates with wa-hub and, indirectly, whatsapp-web.js. Other clients building integrations with wa-hub can use this as a reference.

---

## Architecture Overview

```
┌─────────────────┐     REST (proxy)      ┌─────────────┐     REST / API Key     ┌─────────────┐
│   Dashboard     │ ──────────────────►  │   wa-hub    │ ◄────────────────────  │  whatsapp-  │
│   (Next.js)     │  GET/POST/PUT/DELETE  │   (Express) │      Puppeteer         │  web.js     │
└────────┬────────┘                       └──────┬──────┘                       └─────────────┘
         │                                       │
         │  Webhooks (wa-hub → dashboard)       │  Event listeners
         │  POST with HMAC                       │  qr, authenticated, ready,
         ◄───────────────────────────────────────┤  auth_failure, disconnected,
         │                                       │  message, etc.
         │  SSE (dashboard → browser)            │
         │  Server-Sent Events                   │
         ◄───────────────────────────────────────┤
         │  (broadcasts webhook events + API logs)│
         ▼
┌─────────────────┐
│  Browser (React)│
└─────────────────┘
```

The dashboard never talks to whatsapp-web.js directly. It talks only to wa-hub. wa-hub wraps whatsapp-web.js and exposes a REST API and forwards lifecycle events via webhooks.

---

## 1. How the Dashboard Reaches wa-hub (API Proxy)

The dashboard does not call wa-hub directly from the browser. All wa-hub API requests go through a Next.js API route that proxies to wa-hub. This keeps the API key server-side.

### Flow

1. **Client code** (e.g. `waHubRequest({ method: 'GET', path: '/instances/foo/client/status' })`) calls `fetch('/api/wahub/instances/foo/client/status')`.
2. **Next.js route** `app/api/wahub/[[...path]]/route.ts` receives the request, strips the `/api/wahub` prefix, and forwards to `WA_HUB_BASE_URL` + path (e.g. `http://localhost:3000/instances/foo/client/status`).
3. **Headers**: The proxy adds `Authorization: Bearer ${WA_HUB_TOKEN}`. `WA_HUB_TOKEN` must equal wa-hub’s `API_KEY`.
4. **Response**: The proxy returns wa-hub’s JSON response as-is. Status 502 is used if the request to wa-hub fails.

### Configuration

- `WA_HUB_BASE_URL`: wa-hub base URL (e.g. `http://localhost:3000` or `http://136.119.21.7:3000`).
- `WA_HUB_TOKEN`: Same value as wa-hub’s `API_KEY`.

---

## 2. Status Fetching (Pull Model)

The dashboard fetches instance status **on demand**, not on a timer.

### When status is fetched

- **Instance detail page**: Once on mount via `fetchStatus()`.
- **Manual refresh**: When the user clicks “Refresh”, `fetchStatus()` runs again.
- **Home page**: `GET /instances` once on load; “Refresh” re-fetches.

There is **no background polling** for status. The dashboard treats status as a snapshot.

### Endpoint

`GET /instances/:id/client/status` → proxied to wa-hub.

### Response shape (from wa-hub)

```json
{
  "success": true,
  "data": {
    "clientStatus": {
      "instanceStatus": "ready",
      "instanceId": "WASP-testy",
      "data": { "phoneNumber": "1234567890" },
      "state": "ready",
      "queueDepth": 0,
      "lastEvent": "ready",
      "lastDisconnectReason": null,
      "restartAttempts": 0,
      "readyWatchdogMs": 600000,
      "readyWatchdogStartAt": null,
      "authenticatedAt": "2026-02-08T09:46:29.498Z",
      "readySource": "poll",
      "readyAt": "2026-02-08T09:46:45.213Z",
      "authenticatedToReadyMs": 15695,
      "readyPollAttempts": 4,
      "lastReadyPollError": null
    }
  }
}
```

### Status / state mapping

wa-hub maps internal `InstanceState` to `instanceStatus`:

| InstanceState | instanceStatus |
|---------------|----------------|
| READY         | `ready`        |
| CONNECTING    | `initializing` |
| NEEDS_QR      | `qr`           |
| DISCONNECTED  | `disconnected` |
| ERROR         | `disconnected` |

`state` is the raw internal state (`ready`, `connecting`, `needs_qr`, etc.).

---

## 3. Webhooks (Push Model)

Webhooks are the main way the dashboard gets real-time updates. wa-hub pushes events to a URL the dashboard exposes.

### Direction

wa-hub → dashboard (server-to-server POST).

### Webhook URL configuration

Each instance has a `webhook.url` and `webhook.events`. When creating an instance, the dashboard uses:

- `GET /api/config` → `webhookUrl` (from `DASHBOARD_WEBHOOK_INTERNAL_URL` or `DASHBOARD_WEBHOOK_PUBLIC_URL`).
- That URL is sent in `POST /instances` as `webhook.url`.

Typical values:

- **Same server**: `DASHBOARD_WEBHOOK_INTERNAL_URL=http://localhost:3001/api/wahub/webhook` (avoids auth issues).
- **Public**: `DASHBOARD_WEBHOOK_PUBLIC_URL=https://your-domain.com/api/wahub/webhook`.

### Webhook payload format

```json
{
  "event": "ready",
  "instanceId": "WASP-testy",
  "data": { "status": "ready" }
}
```

`event` is the lifecycle or event type. `data` varies by event.

### Events wa-hub sends

| Event           | When emitted by whatsapp-web.js or wa-hub |
|-----------------|--------------------------------------------|
| `qr`            | QR code available (scan required)         |
| `authenticated` | Session authenticated, syncing             |
| `ready`         | Client ready (or ready-poll fallback)      |
| `ready_timeout` | Ready not received within watchdog window  |
| `auth_failure`  | Auth failed                                 |
| `disconnected`  | Disconnected                                |
| `change_state`  | Internal state change                       |
| `message`       | Incoming message                            |
| `vote_update`   | Poll vote update                            |

`authenticated`, `ready`, and `ready_timeout` are always sent if the instance has a webhook URL. Other events are sent only if listed in `webhook.events` or if that list is empty.

### Webhook delivery

- **Fire-and-forget**: wa-hub does not block on webhook delivery. Failures are logged.
- **Headers**: `Content-Type: application/json`, optional `x-wa-hub-signature` (HMAC-SHA256 of JSON body), optional `Authorization: Bearer` if `WEBHOOK_AUTH_TOKEN` is set.
- **Idempotency**: The dashboard does not deduplicate. Re-sends are possible.

### Dashboard webhook handler

`POST /api/wahub/webhook`:

1. Verifies `x-wa-hub-signature` with `WA_HUB_WEBHOOK_SIGNATURE_SECRET` (must match wa-hub’s `WEBHOOK_SECRET`).
2. Parses JSON, stores the event in the in-memory store.
3. Updates `instanceMeta` (e.g. `waStatus`, `lifecycleRank`, `lastQrBase64` for `qr`).
4. Broadcasts to all SSE subscribers.

---

## 4. Server-Sent Events (SSE)

The dashboard uses SSE to push updates to the browser without polling.

### Endpoint

`GET /api/stream?instanceId=WASP-testy&scope=instance`

- `instanceId`: optional; filters events for that instance when `scope !== 'global'`.
- `scope=global`: all events; `scope=instance` (default): only events for `instanceId`.

### Connection lifecycle

1. Client opens `EventSource` on `/api/stream?...`.
2. Server sends `connected` and `initial` events.
3. When wa-hub POSTs a webhook, the handler calls `broadcastSse({ type: 'webhook', data: {...} })`, and all connected clients receive it.
4. API requests via the proxy also trigger `broadcastSse({ type: 'apiLog', data: {...} })`.

### Event types

| Type       | When sent                                |
|------------|-------------------------------------------|
| `connected`| Right after SSE connection                |
| `initial`  | Snapshot of recent webhook events + meta  |
| `webhook`  | After each webhook POST                   |
| `apiLog`   | After each proxied API request            |
| `qr`       | When `qr` webhook has `data.qr`           |

### Event payload shape

```json
{
  "type": "webhook",
  "data": {
    "id": "1739001234567-abc123",
    "timestamp": "2026-02-08T09:46:45.251Z",
    "instanceId": "WASP-testy",
    "event": "ready",
    "payload": { "event": "ready", "instanceId": "WASP-testy", "data": { "status": "ready" } },
    "signatureValid": true,
    "summary": "ready @ WASP-testy"
  }
}
```

### Client handling

`useSSE(instanceId, scope)`:

- Opens `EventSource`.
- Appends each received event to state (newest first, capped at 500).
- Provides `events`, `connected`, `clear`.

---

## 5. Status and Lifecycle Display Logic

The dashboard treats **webhooks as the primary source** for status and lifecycle. API status is a fallback.

### Connection status

`displayStatus` = primary status shown to the user:

1. `lastWebhook.event` (most recent webhook for this instance).
2. `instanceMeta.waStatus`.
3. `status.instanceStatus` (from API).
4. `status.state` (from API).
5. `"unknown"`.

### Lifecycle rank

| Rank | Label       | When                                         |
|------|-------------|----------------------------------------------|
| 0    | disconnected| `disconnected` or `auth_failure`             |
| 1    | needs_qr    | `qr` or default                              |
| 2    | syncing     | `authenticated`                              |
| 3    | active      | `ready`                                      |

Rank is derived from:

1. **If ready**: `displayStatus === 'ready'` or `lastWebhook.event === 'ready'` or `status.state === 'ready'` or `status.instanceStatus === 'ready'` → rank 3.
2. Otherwise: `lastWebhook.event` → rank 0–3.
3. Default: rank 1 (needs_qr).

If status indicates ready, the lifecycle badge is always “active”, never “needs_qr”.

### QR panel visibility

The QR panel is hidden when:

- `lastWebhook.event === 'ready'` or `lastWebhook.event === 'authenticated'`, or
- `status.state === 'ready'` or `status.instanceStatus === 'ready'`, or
- `status.state === 'connecting'` or `status.instanceStatus === 'initializing'`.

So when status is ready or authenticating, the QR section is not shown.

---

## 6. QR Code Flow

### Primary: webhooks

When wa-hub sends a `qr` webhook with `data.qr` (base64), the dashboard:

1. Stores it in `instanceMeta.lastQrBase64`.
2. Broadcasts `{ type: 'qr', data: { instanceId, qr, classification: 'READY' } }`.

### Fallback: API

If the instance is in `needs_qr` and the dashboard has no QR from webhooks (e.g. 401 on webhook), `QrPanel` fetches:

`GET /instances/:id/client/qr` every 5 seconds until it gets a QR or leaves `needs_qr`.

---

## 7. Pings and Polling Summary

| Mechanism      | Direction     | Frequency                     | Purpose                        |
|----------------|---------------|------------------------------|--------------------------------|
| Webhooks       | wa-hub → dash | Event-driven                 | Real-time lifecycle and events |
| Status fetch   | dash → wa-hub | On load + manual refresh     | Snapshot of instance state     |
| QR fetch       | dash → wa-hub | Every 5s when needs_qr       | Fallback if webhooks fail      |
| Health check   | dash → wa-hub | On home page load            | `GET /health`                  |
| SSE            | dash → browser| Long-lived connection        | Stream webhook + API log events|

There is **no periodic status polling**. The dashboard relies on webhooks for real-time updates.

---

## 8. Expectations for Other Clients

### Webhook URL

- Each instance must have a `webhook.url` that can receive POSTs from wa-hub.
- Same-server deployments: use an internal URL (e.g. `http://localhost:PORT/api/wahub/webhook`) to avoid auth issues.
- For public URLs, ensure the endpoint accepts server-to-server POSTs (no cookie/session required).

### Webhook auth

- Verify `x-wa-hub-signature` with the shared secret (`WEBHOOK_SECRET` / `WA_HUB_WEBHOOK_SIGNATURE_SECRET`).
- Optionally use `WEBHOOK_AUTH_TOKEN` for Bearer auth if the receiver requires it.

### Status vs webhooks

- **Webhooks** are the source of truth for lifecycle.
- **API status** can be stale until the next fetch.
- Prefer webhook events for UI state; use API status as a fallback and for extra fields (e.g. `readySource`, `authenticatedToReadyMs`).

### No polling required

- A client can rely on webhooks for real-time updates.
- Polling status is only needed if webhooks are unreliable or for occasional snapshots.

### Events to handle

- `qr`: Show QR and wait for scan.
- `authenticated`: Show “syncing” / “authenticating”.
- `ready`: Show “active” / “ready”, hide QR.
- `ready_timeout`: Ready did not arrive in time; instance may soft-restart.
- `auth_failure`, `disconnected`: Handle errors and reconnection.

---

## 9. wa-hub ↔ whatsapp-web.js

wa-hub attaches listeners to the whatsapp-web.js `Client`:

- `qr`, `authenticated`, `ready`, `auth_failure`, `disconnected`, `change_state`, `message`, `vote_update`.

On each event, wa-hub:

1. Updates internal state.
2. Optionally calls `forwardWebhook()` to POST to the instance’s webhook URL.

wa-hub also adds a **ready-poll fallback**: if `ready` never fires, it polls `client.info` and `client.getState()` and treats the client as ready when both are present. This is reflected in `readySource: "poll"` in the status response.
