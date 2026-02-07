# wa-hub Test Dashboard

A standalone local/dev web dashboard to debug and test wa-hub instances, messages, and webhooks without the WASP Shopify app.

## Features

- **Instance management**: Create, list, view, delete instances
- **WhatsApp lifecycle**: Status, QR, authenticated, ready, disconnected
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
| POLL_INTERVAL_MS | Status poll interval | 3000 |
| QR_POLL_INTERVAL_MS | QR poll interval | 4000 |
| QR_POLL_MAX_ATTEMPTS | Max QR poll attempts before stopping | 30 |

## Exposing Webhook Publicly

For wa-hub (running elsewhere) to send webhooks to your local dashboard:

1. **ngrok**: `ngrok http 3000` → use the HTTPS URL + `/api/wahub/webhook` as DASHBOARD_WEBHOOK_PUBLIC_URL when creating instances
2. **cloudflared**: `cloudflared tunnel --url http://localhost:3000` → use the tunnel URL

Or run both wa-hub and dashboard on the same host and use the host's URL.

## Troubleshooting: QR Not Appearing

1. **Check instance status**: Start status polling on the instance detail page. Status should be `qr` or `needs_qr` when QR is expected.
2. **Start QR polling**: Click "Start QR polling". The dashboard will hit `/client/qr` every 4s. If you see `WAITING_FOR_QR`, the instance exists but QR isn't ready yet (Chromium still loading).
3. **Check wa-hub logs**: `pm2 logs wa-hub` for `Event: qr`, `Event: authenticated`, `Event: ready`.
4. **QR 404**: If classification is `INSTANCE_NOT_FOUND`, the instance may have been deleted or the ID is wrong.
5. **Chromium issues**: If QR never appears, wa-hub may be stuck. Check wa-hub uses system Chromium (`CHROME_PATH`). See wa-hub DEBUGGING.md.
