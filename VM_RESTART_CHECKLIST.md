# VM Restart Checklist

This document outlines what you need to do when restarting your GCP VM, especially if it gets a new IP address.

## 🔴 Critical: IP Address Changes

**GCP VMs with ephemeral IPs get a NEW IP on restart** (unless you've configured a static IP).

### 1. Check New IP Address

```bash
# After VM restart, SSH in and check:
curl ifconfig.me
# or
hostname -I
```

### 2. Update Apps That Call WA-Hub

**Apps need to update their WA_HUB_BASE_URL:**

```bash
# Example: If your app uses environment variable
export WA_HUB_BASE_URL=http://NEW_IP:3000

# Or update in your app's .env file:
WA_HUB_BASE_URL=http://NEW_IP:3000
WA_HUB_TOKEN=your-api-key-here
```

**Apps that might need updates:**
- Your main Shopify app (WASP)
- Any other services that call wa-hub API
- Monitoring/health check services

### 3. Update Firewall Rules (if needed)

If you have firewall rules restricting access to wa-hub:

```bash
# GCP Console: VPC Network > Firewall Rules
# Update source IP ranges or allow new IP

# Or via gcloud:
gcloud compute firewall-rules update wa-hub-allow \
  --source-ranges=NEW_IP/32
```

### 4. Update DNS (if using)

If you're using a domain name pointing to the VM IP:

```bash
# Update DNS A record to point to new IP
# Example: wa-hub.yourdomain.com -> NEW_IP
```

---

## ✅ Automatic (Should Work Automatically)

### 1. PM2 Auto-Start

PM2 should auto-start wa-hub on boot if you've saved the PM2 process list:

```bash
# Check if PM2 startup is configured:
pm2 startup

# If not configured, run:
pm2 startup
# Then follow the instructions it prints

# Save current PM2 process list:
pm2 save
```

**After restart, verify:**
```bash
pm2 status
pm2 logs wa-hub
```

### 2. WhatsApp Sessions

✅ **Sessions persist automatically** - LocalAuth stores session data in `.wwebjs_auth/`, so instances should auto-reconnect without QR codes.

**Verify after restart:**
```bash
curl http://localhost:3000/instances \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### 3. Systemd Services

If you've set up the cleanup timer, it should auto-start:

```bash
# Check systemd services:
sudo systemctl status wa-hub-cleanup.timer
```

---

## 📋 Post-Restart Verification Checklist

Run these commands after VM restart to verify everything is working:

```bash
# 1. Check wa-hub is running
pm2 status
pm2 logs wa-hub --lines 50

# 2. Check wa-hub health
curl http://localhost:3000/health

# 3. Check instances are loaded
curl http://localhost:3000/instances \
  -H "Authorization: Bearer YOUR_API_KEY" | jq

# 4. Check new IP address
curl ifconfig.me
echo ""

# 5. Test API from outside (if firewall allows)
curl http://$(curl -s ifconfig.me):3000/health

# 6. Verify instances are connecting
# Check logs for "ready" events
pm2 logs wa-hub | grep "ready"
```

---

## 🔧 Manual Steps (If Auto-Start Fails)

### 1. Start WA-Hub Manually

```bash
cd ~/wa-hub

# Pull latest code (if needed)
git pull

# Install dependencies (if needed)
npm install

# Start with PM2
pm2 start ecosystem.config.js
# or
pm2 restart wa-hub
```

### 2. Verify Environment Variables

Check `.env` file exists and has correct values:

```bash
cd ~/wa-hub
cat .env

# Should have:
# PORT=3000
# API_KEY=your-key
# SESSION_DATA_PATH=./.wwebjs_auth
# etc.
```

### 3. Check Disk Space

After restart, verify disk cleanup is working:

```bash
# Check disk usage
node scripts/report-disk-usage.js

# If needed, run cleanup
./scripts/wa-hub-cleanup.sh
```

---

## 🎯 Recommended: Use Static IP (Prevent IP Changes)

**Best solution:** Configure a static IP in GCP to avoid IP changes:

### Option 1: Reserve Static External IP

```bash
# Reserve static IP
gcloud compute addresses create wa-hub-static-ip \
  --region=YOUR_REGION

# Get the IP
gcloud compute addresses describe wa-hub-static-ip \
  --region=YOUR_REGION

# Assign to VM
gcloud compute instances add-access-config YOUR_VM_NAME \
  --access-config-name="External NAT" \
  --address=STATIC_IP_ADDRESS
```

### Option 2: Use Load Balancer

- Set up a GCP Load Balancer with a static IP
- Point your apps to the load balancer IP
- Load balancer forwards to VM (even if VM IP changes)

---

## 📱 Notify Dependent Services

After restart, you may need to:

1. **Update your main app's environment variables:**
   ```bash
   # In your WASP app or other dependent services
   WA_HUB_BASE_URL=http://NEW_IP:3000
   ```

2. **Restart dependent services** (if they cache the old IP)

3. **Check webhook delivery:**
   - WA-Hub sends webhooks TO your app
   - Your app's webhook URL should still work (it's configured per-instance)
   - But if your app calls wa-hub API, it needs the new IP

---

## 🚨 Emergency Rollback

If something goes wrong:

```bash
# Stop wa-hub
pm2 stop wa-hub

# Check logs
pm2 logs wa-hub --err

# Restart
pm2 restart wa-hub

# If PM2 is broken, start manually
cd ~/wa-hub
node src/index.js
```

---

## 📝 Quick Reference

**Before Restart:**
- [ ] Note current IP: `curl ifconfig.me`
- [ ] Save PM2 process list: `pm2 save`
- [ ] Document which apps depend on wa-hub

**After Restart:**
- [ ] Get new IP: `curl ifconfig.me`
- [ ] Verify PM2 started: `pm2 status`
- [ ] Check wa-hub health: `curl http://localhost:3000/health`
- [ ] Update dependent apps with new IP
- [ ] Update firewall rules (if needed)
- [ ] Update DNS (if using domain)
- [ ] Test API calls from dependent apps
- [ ] Verify instances are reconnecting

---

**Last Updated:** 2025-01-27
