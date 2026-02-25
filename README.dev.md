# Local development guide — wa-hub

Step-by-step instructions for running the backend and Next.js dashboard locally, exposing them for QR scanning via Cloudflare Tunnel, and testing the full flow.

## Prerequisites

- Node.js 18+
- npm
- (Optional) [Cloudflare Tunnel (cloudflared)](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/) for public HTTPS QR scanning

## Quick start

```bash
# From repo root
cp .env.example .env
# Edit .env: set API_KEY, optional WEBHOOK_SECRET (see below)

npm install
npm run dev
```

- **Backend** (nodemon): restarts on any change under `src/`. Runs at **http://localhost:3000**
- **Dashboard** (Next.js): hot-reloads on edit. Runs at **http://localhost:3001**

Use **http://localhost:3001** for the dashboard; use the API at **http://localhost:3000** for health, instances, etc.

## Scripts (root package.json)

| Script | Description |
|--------|-------------|
| `npm run dev` | Backend (nodemon) + dashboard (Next.js dev) together |
| `npm run dev:backend` | Backend only; restarts on `src/**/*.js` changes |
| `npm run dev:dashboard` | Dashboard only; hot-reload on edit |
| `npm run dev:tunnel` | Prints a hint for exposing the app with Cloudflare Tunnel |

## Recommended .env for development

Create a **`.env`** in the repo root (or copy from `.env.example`). For local dev, at minimum:

```env
# Server
PORT=3000

# Required for API calls (generate one: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
API_KEY=your-32-byte-hex-api-key

# Optional: webhook signature (if you test webhooks)
WEBHOOK_SECRET=dev-webhook-secret

# Session storage (defaults are fine)
AUTH_BASE_DIR=./.wwebjs_auth
INSTANCES_DATA_PATH=./.wwebjs_instances.json

# Chromium (macOS: often /Applications/Google Chrome.app/Contents/MacOS/Google Chrome)
# Leave empty to use Puppeteer default, or set e.g. PUPPETEER_EXECUTABLE_PATH
# CHROME_PATH=

# Disable Sentry in dev (leave SENTRY_DSN empty)
SENTRY_DSN=
SENTRY_ENVIRONMENT=development

# Optional: required for GET /system/status (dashboard Low Power Mode pill)
ADMIN_DEBUG_SECRET=dev-admin-secret

# Local dev: do not use launchpad
USE_LAUNCHPAD_FOR_ONBOARDING=false
IS_LAUNCHPAD=false
```

Dashboard env: in **`wa-hub-dashboard/`**, copy `env.example` to **`.env.local`** (or `.env`):

```env
# wa-hub API (backend on 3000)
WA_HUB_BASE_URL=http://localhost:3000
WA_HUB_TOKEN=your-32-byte-hex-api-key

# Same value as backend API_KEY (dashboard uses this to call wa-hub)
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Dashboard auth (optional in dev)
DASHBOARD_PASSWORD=admin
DASHBOARD_SESSION_SECRET=any-random-string-for-dev

# HTTP in dev (no TLS)
DASHBOARD_SECURE_COOKIES=false

# Optional: for Low Power Mode status pill
ADMIN_DEBUG_SECRET=dev-admin-secret

# Webhook URL (see “Cloudflare Tunnel” below if you need public HTTPS for QR)
DASHBOARD_WEBHOOK_PUBLIC_URL=http://localhost:3001/api/wahub/webhook
```

Use the **same** `API_KEY` / `WA_HUB_TOKEN` in both backend and dashboard.

## Cloudflare Tunnel (public HTTPS for QR scanning)

WhatsApp often requires a **public HTTPS** URL to load the QR page. To expose your local backend or dashboard:

1. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/).

2. Start the backend (and optionally dashboard) locally:
   ```bash
   npm run dev
   ```

3. In another terminal, expose the **backend** (so wa-hub serves QR at a public URL):
   ```bash
   npx cloudflared tunnel --url http://localhost:3000
   ```
   Or expose the **dashboard** (so you open the dashboard and instance QR over HTTPS):
   ```bash
   npx cloudflared tunnel --url http://localhost:3001
   ```

4. Use the printed `*.trycloudflare.com` URL:
   - Backend tunnel: e.g. `https://abc123.trycloudflare.com` → health: `https://abc123.trycloudflare.com/health`
   - Dashboard tunnel: open the URL in the browser, create an instance, and scan QR from the dashboard.

5. If instances are created with a webhook URL, ensure the webhook target is reachable (e.g. same tunnel or another public URL). For local-only testing you can leave webhook URL as `http://localhost:3001/api/wahub/webhook` and only use the tunnel for loading the QR page.

Hint from the repo: run `npm run dev:tunnel` to print the cloudflared command.

## Testing locally

### 1. Health check

```bash
curl http://localhost:3000/health
```

### 2. Create an instance and get QR

```bash
export API_KEY=your-api-key-from-env

# Create instance
curl -X POST http://localhost:3000/instances \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"name":"dev-test","webhook":{"url":"http://localhost:3001/api/wahub/webhook","events":["message","qr","ready","disconnected"]}}'

# Get QR (replace INSTANCE_ID with id from create response)
curl -s http://localhost:3000/instances/INSTANCE_ID/qr -H "Authorization: Bearer $API_KEY" | jq -r '.qr' | base64 -d > qr.png && open qr.png
```

Or use the dashboard: open **http://localhost:3001**, create an instance, and scan the QR shown there (use a tunnel URL if needed).

### 3. Test reconnect

- With the instance in READY, restart the backend (`Ctrl+C` then `npm run dev:backend` or `npm run dev`). The instance should reconnect and return to READY (same session; no new QR if session is still valid).

### 4. Send a message

```bash
# Replace INSTANCE_ID and CHAT_ID (e.g. 1234567890@c.us)
curl -X POST http://localhost:3000/instances/INSTANCE_ID/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"chatId":"CHAT_ID","message":"Hello from local dev"}'
```

Use the dashboard to open an instance and send a message if you prefer.

## Behaviour summary

- **Backend**: Nodemon watches `src/` and restarts on `.js` changes (500 ms delay to avoid double restarts).
- **Dashboard**: Next.js dev server with hot reload; runs on port 3001 so it does not conflict with the backend on 3000.
- **Launchpad**: Not used in local dev; leave `USE_LAUNCHPAD_FOR_ONBOARDING=false` and `IS_LAUNCHPAD=false`. No production or launchpad code is changed by this setup.

## Troubleshooting

- **Dashboard cannot reach backend**: Ensure `WA_HUB_BASE_URL=http://localhost:3000` and `WA_HUB_TOKEN` equals backend `API_KEY`.
- **QR not loading**: Use Cloudflare Tunnel and open the tunnel URL (HTTPS) for the page that serves the QR.
- **Port in use**: Stop any other process on 3000 or 3001, or change `PORT` (backend) and dashboard port in `wa-hub-dashboard/package.json` dev script.
