# wa-hub Debugging Guide

How to debug and test wa-hub when it's not working as expected.

## 1. Quick Health & Status Check (Remote VM)

```bash
# Health (no auth)
curl -s http://136.119.21.7:3000/health | jq .

# List instances (needs API key)
curl -s -H "X-API-Key: YOUR_API_KEY" http://136.119.21.7:3000/instances | jq .

# Instance status (replace INSTANCE_ID with yours)
curl -s -H "X-API-Key: YOUR_API_KEY" http://136.119.21.7:3000/instances/INSTANCE_ID/client/status | jq .
```

## 2. SSH to VM – Logs & Process Check

```bash
ssh michaelnasser321@136.119.21.7

# Tail logs (watch events in real time)
pm2 logs wa-hub

# Last 200 lines, grep for key events
pm2 logs wa-hub --lines 200 --nostream | grep -E '"event"|State transition|Error|ready|authenticated|disconnected'

# Is Chromium using system or bundled?
ps aux | grep chrome | grep -v grep

# Memory
free -h

# Kill stuck Chromium and restart
pkill -f "chrome.*wa-hub" || true
pm2 restart wa-hub
```

## 3. Local Testing (On Your Mac)

Run wa-hub locally to isolate VM vs code issues.

```bash
cd ~/wa-hub

# Start in foreground (see all output)
npm start

# In another terminal, run the test script
# (Edit BASE_URL and add API key header if needed)
./scripts/test-api.sh
```

Or manually:

```bash
# Terminal 1
npm start

# Terminal 2
curl http://localhost:3000/health
curl -H "X-API-Key: YOUR_KEY" http://localhost:3000/instances
# Create instance, get QR, etc.
```

## 4. Full Flow Test (Create → QR → Scan → Ready → Send)

```bash
# Set these
export BASE_URL="http://136.119.21.7:3000"
export API_KEY="f0bdaeb85348f62f9d415e8bd749d251f5634e292ec61d7a133cd32ad71f1662"

# 1. Health
curl -s $BASE_URL/health | jq .

# 2. Create instance (use a unique name for testing)
curl -s -X POST $BASE_URL/instances \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "WASP-debug-test",
    "webhook": {
      "url": "https://webhook.site/your-unique-id",
      "events": ["qr", "ready", "authenticated", "disconnected", "message"]
    }
  }' | jq .

# 3. Wait 15 sec, then get QR
sleep 15
curl -s -H "X-API-Key: $API_KEY" $BASE_URL/instances/WASP-debug-test/client/qr | jq '.qrCode.data.qr_code' -r | head -c 100
# (Full QR is base64 - use a QR decoder or the API response in a browser)

# 4. Check status (repeat until ready)
curl -s -H "X-API-Key: $API_KEY" $BASE_URL/instances/WASP-debug-test/client/status | jq .

# 5. After scanning, watch for ready. Then send a test message:
curl -s -X POST $BASE_URL/instances/WASP-debug-test/client/action/send-message \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"chatId": "YOUR_NUMBER@c.us", "message": "Test from wa-hub"}'
```

## 5. Structured Log Events to Grep For

| Event | Meaning |
|-------|---------|
| `"event":"qr"` | QR code received |
| `"event":"authenticated"` | Phone scanned QR, pairing done |
| `"event":"ready"` | WhatsApp Web fully loaded |
| `"event":"disconnected"` | Connection lost (check `reason`) |
| `"event":"ready_timeout"` | Ready didn't fire within 180s |
| `"event":"state_transition"` | State changed (from → to) |
| `"event":"process_start"` | Process (re)started |

## 6. Common Issues

| Symptom | Check |
|---------|-------|
| 99% CPU on renderer | Use system Chromium: `CHROME_PATH=/usr/bin/chromium-browser` or `/snap/bin/chromium` in `.env` |
| ready never fires | Logs show `authenticated` but not `ready` – Chromium/WhatsApp Web stuck. Try system Chromium. |
| Connection refused | wa-hub not running. `pm2 status`, `pm2 start wa-hub`. |
| 401 on /instances | Add `X-API-Key: YOUR_KEY` header. |
| Instance stuck in qr | Scan QR on phone. If already scanned, delete instance and recreate. |

## 7. Reset an Instance (Fresh Start)

```bash
# Via API (replace INSTANCE_ID and API_KEY)
curl -X DELETE -H "X-API-Key: YOUR_KEY" http://136.119.21.7:3000/instances/INSTANCE_ID

# Or on VM, remove session data and restart
rm -rf ~/wa-hub/.wwebjs_auth/session-WASP-YOUR_INSTANCE
pm2 restart wa-hub
# Then create instance again via your app
```
