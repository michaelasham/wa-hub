# wa-hub Test Dashboard

A standalone local/dev web dashboard to debug and test wa-hub instances, messages, and webhooks without the WASP Shopify app.

## Features

- **Instance management**: Create, list, view, delete instances
- **WhatsApp lifecycle**: Status and QR from webhooks (no polling)
- **Test actions**: Send messages, create polls, logout
- **Live webhooks**: Receive wa-hub webhooks in real-time (qr, ready, authenticated, etc.)
- **API logs**: See all outbound requests to wa-hub with status, latency, request/response
- **QR 404 handling**: Distinguishes WAITING_FOR_QR vs INSTANCE_NOT_FOUND

## Setup

```bash
npm install
cp env.example .env
# Edit .env with your wa-hub URL and token
npm run dev
```

Open http://localhost:3000

## Password Protection

Set `DASHBOARD_PASSWORD` and `DASHBOARD_SESSION_SECRET` in `.env` to enable password protection:

```env
DASHBOARD_PASSWORD=your-secure-password
DASHBOARD_SESSION_SECRET=random-32-char-string-for-signing
```

- If both are set, the dashboard requires a password to access
- The webhook endpoint (`/api/wahub/webhook`) stays public so wa-hub can POST to it
- Session cookies are HttpOnly and expire after 24 hours

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| DASHBOARD_PASSWORD | Dashboard password (optional) | your-secure-password |
| DASHBOARD_SESSION_SECRET | Secret for signing session cookies (required if password set) | random-32-char-string |
| WA_HUB_BASE_URL | wa-hub API base URL | http://localhost:3000 |
| WA_HUB_TOKEN | API key (Bearer token) | your-api-key |
| DASHBOARD_WEBHOOK_PUBLIC_URL | URL wa-hub will POST webhooks to | http://localhost:3000/api/wahub/webhook |
| WA_HUB_WEBHOOK_SIGNATURE_SECRET | Must match wa-hub WEBHOOK_SECRET for signature verification | |
| POLL_INTERVAL_MS | (Legacy) Status poll interval | 3000 |
| QR_POLL_INTERVAL_MS | (Legacy) QR poll interval | 4000 |
| QR_POLL_MAX_ATTEMPTS | (Legacy) Max QR poll attempts | 30 |

Status and QR are webhook-driven. Set each instance’s webhook URL to `DASHBOARD_WEBHOOK_PUBLIC_URL` so wa-hub sends lifecycle events here.

## Exposing Webhook Publicly

For wa-hub (running elsewhere) to send webhooks to your local dashboard:

1. **ngrok**: `ngrok http 3000` → use the HTTPS URL + `/api/wahub/webhook` as DASHBOARD_WEBHOOK_PUBLIC_URL when creating instances
2. **cloudflared**: `cloudflared tunnel --url http://localhost:3000` → use the tunnel URL

Or run both wa-hub and dashboard on the same host and use the host's URL.

## Troubleshooting: QR Not Appearing

1. **Webhook URL**: Ensure each instance has a webhook URL pointing to this dashboard (e.g. `DASHBOARD_WEBHOOK_PUBLIC_URL` + `/api/wahub/webhook`). Status and QR come from webhooks, not polling.
2. **Refresh**: Use the "Refresh" button in Connection Status to fetch current client status once.
3. **Check wa-hub logs**: `pm2 logs wa-hub` for `Event: qr`, `Event: authenticated`, `Event: ready`.
4. **Chromium issues**: If QR never appears, wa-hub may be stuck. Check wa-hub uses system Chromium (`CHROME_PATH`). See wa-hub DEBUGGING.md.
