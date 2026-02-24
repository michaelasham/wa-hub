# Disk Cleanup Implementation Summary

This document summarizes the disk cleanup solution implemented for WA-Hub to prevent storage bloat from Chromium/Puppeteer cache accumulation.

## Problem

WA-Hub runs multiple WhatsApp Web instances using Chromium/Puppeteer. Each instance creates browser profiles with cache directories that can grow indefinitely:
- `Cache/` - HTTP cache
- `Code Cache/` - JavaScript code cache
- `GPUCache/` - GPU shader cache
- `Service Worker/CacheStorage/` - Service worker cache
- `Media Cache/` - Media files cache
- `ShaderCache/` - Additional shader cache

Over time, these caches can consume significant disk space, especially with multiple tenants.

## Solution Overview

The solution consists of:

1. **Disk Usage Diagnostic Tool** - Reports current disk usage per tenant
2. **Safe Cleanup Script** - Removes cache directories while preserving auth data
3. **Automated Scheduling** - systemd timer or cron for daily cleanup
4. **Preventive Measures** - Chromium cache size limits in Puppeteer args
5. **Log Rotation** - Automatic log file management

## Files Created

### Scripts

1. **`scripts/report-disk-usage.js`**
   - Node.js script for disk usage analysis
   - Outputs human-readable and JSON formats
   - Identifies cache-heavy directories per tenant

2. **`scripts/wa-hub-cleanup.sh`**
   - Bash script for safe cache cleanup
   - Stops service before cleanup (prevents corruption)
   - Only deletes cache directories (never auth data)
   - Supports DRY_RUN mode and MAX_DELETE_GB guard

3. **`scripts/setup-cleanup.sh`**
   - Interactive setup script for systemd configuration
   - Prompts for paths and creates systemd files
   - Enables and starts the timer

### Systemd Files

4. **`scripts/wa-hub-cleanup.service`**
   - systemd service unit for cleanup execution
   - Configurable via environment variables

5. **`scripts/wa-hub-cleanup.timer`**
   - systemd timer unit for daily scheduling
   - Runs at 04:30 local time with randomization

6. **`scripts/wa-hub-cleanup.logrotate`**
   - Logrotate configuration
   - Daily rotation, 30 days retention, compression

### Code Changes

7. **`src/instance-manager.js`**
   - Added Chromium cache size limits to Puppeteer args:
     - `--disk-cache-size=104857600` (100MB)
     - `--media-cache-size=104857600` (100MB)

## Safety Features

### What Gets Deleted ✅
- `Default/Cache`
- `Default/Code Cache`
- `Default/GPUCache`
- `Default/Service Worker/CacheStorage`
- `Default/Service Worker/ScriptCache`
- `Default/Media Cache`
- `Default/ShaderCache`
- Similar directories in `Profile 1`, `Profile 2`, etc.

### What Never Gets Deleted ❌
- `.wwebjs_auth/` - Authentication data (CRITICAL)
- `.wwebjs_cache/` - Session cache (may contain important data)
- `Local Storage/` - Browser local storage
- `IndexedDB/` - Browser database
- `Session Storage/` - Browser session storage
- `Application Cache/` - Application cache (different from HTTP cache)

### Additional Safety
- **Service Stop/Start**: Stops wa-hub service before cleanup, starts after
- **DRY_RUN Mode**: Preview deletions without actually deleting
- **MAX_DELETE_GB Guard**: Prevents accidental huge deletions (default: 100GB)
- **Detailed Logging**: All actions logged to `/var/log/wa-hub-cleanup.log`
- **Error Handling**: Continues even if individual deletions fail

## Usage

### Manual Cleanup

```bash
# Check disk usage
node scripts/report-disk-usage.js

# Preview cleanup (dry run)
DRY_RUN=1 ./scripts/wa-hub-cleanup.sh

# Run cleanup
./scripts/wa-hub-cleanup.sh

# Custom max deletion limit
MAX_DELETE_GB=50 ./scripts/wa-hub-cleanup.sh
```

### Automated Cleanup (systemd)

```bash
# Run setup script (interactive)
sudo ./scripts/setup-cleanup.sh

# Or manually:
sudo cp scripts/wa-hub-cleanup.service /etc/systemd/system/
sudo cp scripts/wa-hub-cleanup.timer /etc/systemd/system/
sudo cp scripts/wa-hub-cleanup.logrotate /etc/logrotate.d/wa-hub-cleanup
sudo systemctl daemon-reload
sudo systemctl enable wa-hub-cleanup.timer
sudo systemctl start wa-hub-cleanup.timer
```

### Automated Cleanup (Cron - Alternative)

```bash
# Add to root crontab
sudo crontab -e

# Add line:
30 4 * * * /bin/bash /path/to/wa-hub/scripts/wa-hub-cleanup.sh >> /var/log/wa-hub-cleanup.log 2>&1
```

## Verification

After setup, verify:

```bash
# 1. Check timer status
sudo systemctl status wa-hub-cleanup.timer

# 2. Check next run time
sudo systemctl list-timers wa-hub-cleanup.timer

# 3. Test dry run
DRY_RUN=1 ./scripts/wa-hub-cleanup.sh

# 4. Check logs
sudo tail -f /var/log/wa-hub-cleanup.log

# 5. Manually trigger (if needed)
sudo systemctl start wa-hub-cleanup.service
```

## Configuration

### Environment Variables

- `WA_HUB_TENANTS_DIR` - Override tenants directory (default: from config.js)
- `DRY_RUN` - Set to `1` for preview mode
- `MAX_DELETE_GB` - Maximum deletion per run (default: 100GB)
- `LOG_FILE` - Log file path (default: `/var/log/wa-hub-cleanup.log`)
- `SERVICE_NAME` - Service name for stop/start (default: `wa-hub`)

### Service Detection

The cleanup script automatically detects:
- **PM2**: If `pm2 list` shows `wa-hub` process
- **systemd**: If `wa-hub.service` is active
- **None**: Proceeds without stopping service (not recommended)

## Troubleshooting

### Service Won't Stop
- Check service name matches (`wa-hub` for PM2, `wa-hub.service` for systemd)
- Verify service is running: `pm2 list` or `systemctl status wa-hub.service`

### "Tenants Directory Does Not Exist"
- Set `WA_HUB_TENANTS_DIR` environment variable
- Or update path in systemd service file

### Service Doesn't Restart
- Check logs: `sudo journalctl -u wa-hub-cleanup.service`
- Verify service name in cleanup script

### Disk Usage Still Growing
- Verify cache size limits are applied (check Puppeteer args in logs)
- Run cleanup more frequently
- Check for other sources (logs, temp files)

## Rollback

If cleanup causes issues:

1. **Stop automated cleanup:**
   ```bash
   sudo systemctl stop wa-hub-cleanup.timer
   sudo systemctl disable wa-hub-cleanup.timer
   ```

2. **Restore from backup** (if available)

3. **Re-authenticate instances** (should not be necessary - cleanup never deletes auth data)

## Performance Impact

- **Cleanup Duration**: Typically 1-5 minutes depending on cache size
- **Service Downtime**: ~5-10 seconds (stop + start)
- **Scheduled Time**: 04:30 AM (low-traffic period)
- **Randomization**: 0-30 minutes (prevents thundering herd)

## Monitoring

Monitor cleanup effectiveness:

```bash
# Before cleanup
node scripts/report-disk-usage.js > before.json

# After cleanup
node scripts/report-disk-usage.js > after.json

# Compare
diff before.json after.json
```

## Future Enhancements

Potential improvements:
- Per-tenant cleanup scheduling
- Cleanup metrics/alerting
- Integration with monitoring systems
- More granular cache control
- Support for remote storage cleanup

## Support

For issues or questions:
1. Check logs: `/var/log/wa-hub-cleanup.log`
2. Review systemd journal: `sudo journalctl -u wa-hub-cleanup.service`
3. Test with DRY_RUN mode first
4. Verify service detection works correctly

---

**Last Updated**: 2025-01-27
**Version**: 1.0.0
