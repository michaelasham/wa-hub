# Session Drift: Instances List vs LocalAuth Directories

wa-hub maintains two distinct persistence layers that can drift over time:

1. **Instances list** – `.wwebjs_instances.json` (or `INSTANCES_DATA_PATH`)
2. **LocalAuth session directories** – `.wwebjs_auth/session-{clientId}/` (or `AUTH_BASE_DIR`)

This document explains why drift happens, how to detect it, and how to safely clean up orphaned session data.

## Why Drift Happens

Drift between the instances list and LocalAuth directories can occur:

| Scenario | Result |
|----------|--------|
| **DELETE /instances/:id** (current behavior) | Hard delete: client destroyed, instance removed from list, **LocalAuth dir purged**. Recreating with same id requires new QR. |
| Legacy delete (pre-purge) or crash before purge | Instance removed from list, but LocalAuth dir may remain on disk |
| Instance never started | Instance exists in JSON, no `session-{clientId}` dir yet |
| Manual edits or migration | Instances JSON and auth dirs may have been modified separately |

**Current behavior:** `DELETE /instances/:id` performs a hard delete and purges LocalAuth session storage. Orphans can still exist from older deletions (before this change), crashes, or manual edits. Use `sessions-gc.js` to clean them up.

## Consequences of Drift

- **Orphaned LocalAuth dirs** – Session data for deleted instances accumulates on disk and can grow indefinitely
- **Missing session dirs** – Instances in the list without a corresponding dir are normal (e.g. never started, or awaiting QR)
- **No functional impact** – Drift does not affect running instances; it only affects disk usage

## Tool: sessions-gc.js

The `scripts/sessions-gc.js` CLI script reports drift and optionally deletes orphaned session directories.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--dry-run` | `true` | Report only, no deletions |
| `--no-dry-run` | - | Disable dry-run when deleting |
| `--delete-orphans` | `false` | Delete orphan directories |
| `--confirm` | `false` | Required for deletions |
| `--require-stopped` | `true` | Refuse delete if wa-hub is running |
| `--no-require-stopped` | - | Allow delete while wa-hub may be running (dangerous) |
| `--json` | `false` | Output report as JSON |
| `--instances-path P` | `INSTANCES_DATA_PATH` or `.wwebjs_instances.json` | Path to instances JSON |
| `--auth-base D` | `AUTH_BASE_DIR` or `.wwebjs_auth` | LocalAuth base directory |

### Environment Variables

- `INSTANCES_DATA_PATH` – Path to instances JSON (fallback for `--instances-path`)
- `AUTH_BASE_DIR` – LocalAuth base directory (fallback for `--auth-base`)

### Usage Examples

```bash
# Dry-run report (default)
node scripts/sessions-gc.js

# JSON output
node scripts/sessions-gc.js --json

# Custom paths
node scripts/sessions-gc.js --instances-path /data/wa-hub/.wwebjs_instances.json --auth-base /data/wa-hub/.wwebjs_auth

# Delete orphans (wa-hub must be stopped)
pm2 stop wa-hub
node scripts/sessions-gc.js --delete-orphans --confirm --no-dry-run
pm2 start wa-hub
```

### Report Output

The report includes:

- **Instance count** – Entries in `.wwebjs_instances.json`
- **LocalAuth dir count** – `session-*` directories under auth base
- **Orphans** – LocalAuth dirs whose client ID is not in the instances list (safe to delete)
- **Missing** – Instance IDs without a corresponding LocalAuth dir (informational)
- **Total orphan size** – Disk space used by orphan dirs (via `du -sk`)

### Safety Guarantees

1. **Never delete active sessions** – Orphans are computed as `localAuthIds - instanceIds`; directories for instances still in the list are never touched.
2. **Wa-hub must be stopped** – With `--require-stopped` (default), the script refuses to delete if a wa-hub process is detected (`pgrep -f wa-hub`).
3. **Explicit confirmation** – `--confirm` is required alongside `--delete-orphans`.
4. **Dry-run by default** – Deletions only occur with `--no-dry-run --delete-orphans --confirm`.

## Recommended Operations Workflow

1. **Weekly/monthly dry-run**
   - Run `node scripts/sessions-gc.js` (or `--json`) to inspect drift and orphan size.

2. **Delete orphans only when service is stopped**
   ```bash
   pm2 stop wa-hub   # or: systemctl stop wa-hub
   node scripts/sessions-gc.js --delete-orphans --confirm --no-dry-run
   pm2 start wa-hub  # or: systemctl start wa-hub
   ```

3. **Optional: scheduled dry-run**
   - Add a cron job to run the script in dry-run mode and log or alert on orphan count/size.

## Relation to Disk Cleanup

This script is separate from `wa-hub-cleanup.sh` / `report-disk-usage.js`:

- **sessions-gc.js** – Removes whole LocalAuth session directories for instances that no longer exist.
- **wa-hub-cleanup.sh** – Removes Chromium cache inside existing session dirs (Cache, Code Cache, etc.) to reclaim space without deleting auth data.

Both tools can be used together as part of a disk management strategy.

## See Also

- [README – Disk Cleanup & Storage Management](../README.md#disk-cleanup--storage-management)
- [DISK_CLEANUP.md](../DISK_CLEANUP.md) – Chromium cache cleanup implementation
