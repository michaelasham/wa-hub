# PM2 logs – common issues

## 1. wa-hub: "Failed to launch the browser process!"

**Symptom:** Instances stay in `connecting` then transition to `error` with:
```
Failed to launch the browser process!
TROUBLESHOOTING: https://github.com/puppeteer/puppeteer/blob/main/docs/troubleshooting.md
```

**Cause:** On headless Linux (e.g. GCP VM), Chromium often cannot start without `--no-sandbox`.

**Fix:**

1. **Enable sandbox disable** in wa-hub `.env` on the server:
   ```bash
   CHROME_DISABLE_SANDBOX=1
   ```
   (Or `CHROME_DISABLE_SANDBOX=true`.) Then restart: `pm2 restart wa-hub`.

2. **Install Chromium and dependencies** (Debian/Ubuntu):
   ```bash
   sudo apt-get update
   sudo apt-get install -y chromium-browser
   # or for minimal deps:
   sudo apt-get install -y libgbm1 libasound2 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2
   ```
   Ensure `CHROME_PATH` in `.env` matches your install (e.g. `/usr/bin/chromium-browser` or `/usr/bin/chromium`).

3. **Check executable:**
   ```bash
   ls -la /usr/bin/chromium-browser
   # or
   which chromium-browser
   ```

---

## 2. wa-hub-dashboard: EADDRINUSE port 3000

**Symptom:** Dashboard error log shows:
```
code: 'EADDRINUSE',
port: 3000
```

**Cause:** Something (often wa-hub backend) is already bound to port 3000. The dashboard is intended to run on **3001** (`next start -p 3001` in `wa-hub-dashboard/package.json`).

**Fix:**

- Ensure **wa-hub** (backend) uses port **3000** and starts first.
- Ensure **wa-hub-dashboard** uses port **3001** and does not override with `PORT=3000` in its env.
- If using PM2, start order: `pm2 start ecosystem.config.js` (wa-hub on 3000), then start the dashboard (e.g. from `wa-hub-dashboard` with script that uses 3001). Do not set `PORT=3000` for the dashboard app.

---

## 3. wa-hub-dashboard: "middleware" file convention is deprecated

**Symptom:** Next.js warns:
```
The "middleware" file convention is deprecated. Please use "proxy" instead.
```

**Cause:** Next.js 16+ deprecation; your middleware file still uses the old convention.

**Fix:** Follow the [Next.js proxy docs](https://nextjs.org/docs/messages/middleware-to-proxy) and migrate when you can. The app still runs; this is a warning, not a runtime error.

---

## 4. Dashboard not working (blank page, "unreachable", 401)

**Checks on the VM:**

1. **PM2 has the dashboard process**
   ```bash
   pm2 status
   ```
   You should see both `wa-hub` and `wa-hub-dashboard`. If the dashboard is missing, start both:
   ```bash
   cd ~/wa-hub && pm2 start ecosystem.config.js
   ```

2. **Dashboard env (wa-hub backend URL and token)**  
   The dashboard needs a `.env` file inside `wa-hub-dashboard/` (or env vars passed by ecosystem from the dashboard `.env`). Ecosystem loads `wa-hub-dashboard/.env`. Create or edit it:
   ```bash
   cd ~/wa-hub/wa-hub-dashboard
   # Create .env with at least:
   # WA_HUB_BASE_URL=http://localhost:3000
   # WA_HUB_TOKEN=your-wa-hub-API-key
   ```
   If wa-hub runs on the same machine, use `http://localhost:3000`. If the browser is on another machine, use the VM’s URL (e.g. `http://YOUR_VM_IP:3000`).  
   If wa-hub has no `API_KEY` set, you can leave `WA_HUB_TOKEN` empty (dashboard will still call the API).

3. **Dashboard logs**
   ```bash
   pm2 logs wa-hub-dashboard --lines 50
   ```
   Look for build errors (`next build` in prestart), port in use (use 3001, not 3000), or missing deps. Install deps if needed:
   ```bash
   cd ~/wa-hub/wa-hub-dashboard && npm install
   pm2 restart wa-hub-dashboard
   ```

4. **Port**  
   Dashboard must use **3001**. Do not set `PORT=3000` for the dashboard (that’s the backend). Ecosystem sets `PORT: 3001` for the dashboard app.

5. **First start**  
   The first time the dashboard runs, `prestart` runs `next build`, which can take 1–2 minutes. Check logs until you see “Ready” or “compiled successfully”.
