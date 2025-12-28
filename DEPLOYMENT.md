# Deployment Guide

## On Your Server (GCP VM)

### 1. Pull Latest Code

```bash
cd /home/michaelnasser321/wa-hub
git pull origin main
```

### 2. Install/Update Dependencies

```bash
npm install
```

### 3. Update .env File

Make sure your `.env` file has all required variables:

```env
PORT=3000
API_KEY=f0bdaeb85348f62f9d415e8bd749d251f5634e292ec61d7a133cd32ad71f1662
WEBHOOK_SECRET=michaelasham
CHROME_PATH=/usr/bin/chromium-browser
SESSION_DATA_PATH=./.wwebjs_auth
LOG_LEVEL=info
```

**Important:** 
- Set `CHROME_PATH` to your system Chromium path
- Common paths: `/usr/bin/chromium-browser` or `/usr/bin/chromium`
- Verify with: `which chromium-browser` or `which chromium`

### 4. Verify System Chromium Installation

```bash
# Check if Chromium is installed
which chromium-browser || which chromium

# If not installed, install it:
sudo apt update
sudo apt install -y chromium-browser

# Or on some systems:
sudo apt install -y chromium
```

### 5. Restart Service

```bash
pm2 restart wa-hub
# Or if using ecosystem.config.js:
pm2 restart ecosystem.config.js
```

### 6. Check Logs

```bash
pm2 logs wa-hub
```

You should see:
- No errors about bundled Chromium
- Service starting successfully
- No warnings about missing libraries

## Troubleshooting

### If you still see bundled Chromium errors:

1. **Verify the code is updated:**
   ```bash
   grep -A 5 "executablePath" src/sessions.js
   ```
   Should show: `executablePath: config.chromePath,`

2. **Check CHROME_PATH is set:**
   ```bash
   grep CHROME_PATH .env
   ```

3. **Verify Chromium exists:**
   ```bash
   ls -la /usr/bin/chromium-browser
   # or
   ls -la /usr/bin/chromium
   ```

4. **If Chromium is in a different location, find it:**
   ```bash
   find /usr -name "chromium*" 2>/dev/null
   find /usr -name "chrome" 2>/dev/null
   ```

5. **Then update .env with the correct path:**
   ```bash
   # Edit .env and set CHROME_PATH to the found path
   nano .env
   ```

6. **Restart again:**
   ```bash
   pm2 restart wa-hub
   ```
