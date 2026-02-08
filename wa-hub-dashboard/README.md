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
| DASHBOARD_WEBHOOK_PUBLIC_URL | URL wa-hub will POST webhooks to (public) | http://localhost:3000/api/wahub/webhook |
| DASHBOARD_WEBHOOK_INTERNAL_URL | Same-server fix: use localhost to avoid 401 (e.g. http://localhost:3001/api/wahub/webhook) | (empty) |
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

## Troubleshooting: Webhook 401

If wa-hub logs "Webhook forwarding failed: Request failed with status code 401":

1. **Deployment protection**: If the dashboard is on Vercel with Deployment Protection, set `WEBHOOK_PROTECTION_BYPASS` in wa-hub's `.env` to your Vercel bypass secret. wa-hub will send `x-vercel-protection-bypass` with webhook requests.
2. **Bearer auth**: If the webhook receiver requires `Authorization: Bearer <token>`, set `WEBHOOK_AUTH_TOKEN` in wa-hub's `.env` to that token.
3. **Signature mismatch**: Ensure `WEBHOOK_SECRET` in wa-hub matches `WA_HUB_WEBHOOK_SIGNATURE_SECRET` in the receiver. If the receiver validates signatures and they don't match, it may return 401.
4. **Reverse proxy auth**: Exclude `/api/wahub/webhook` from nginx/Cloudflare auth so server-to-server POSTs (no cookies) can reach it.
5. **Same host**: When wa-hub and dashboard run on the same machine, use `http://localhost:PORT` or `http://127.0.0.1:PORT` as the webhook URL to avoid external auth layers.

## Troubleshooting: QR Not Appearing

1. **Webhook URL**: Ensure each instance has a webhook URL pointing to this dashboard (e.g. `DASHBOARD_WEBHOOK_PUBLIC_URL` + `/api/wahub/webhook`). Status and QR come from webhooks, not polling.
2. **Refresh**: Use the "Refresh" button in Connection Status to fetch current client status once.
3. **Check wa-hub logs**: `pm2 logs wa-hub` for `Event: qr`, `Event: authenticated`, `Event: ready`.
4. **Chromium issues**: If QR never appears, wa-hub may be stuck. Check wa-hub uses system Chromium (`CHROME_PATH`). See wa-hub DEBUGGING.md.
