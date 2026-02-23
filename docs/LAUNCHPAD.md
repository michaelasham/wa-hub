# Launchpad VM

The launchpad is a GCP Compute Engine VM (Spot or on-demand) used to offload QR code generation and initial WhatsApp sync from the main wa-hub VM. The main VM remains the sole external interface (e.g. for Shopify/WASP); the launchpad is started on-demand, runs a single onboarding, uploads session + instances to GCS, then is stopped.

---

## Architecture overview

1. **Main VM** (wa-hub, `USE_LAUNCHPAD_FOR_ONBOARDING=false` or unset): When a new instance is created via `POST /instances`:
   - Starts the launchpad VM (creates if not exists, or starts if stopped).
   - POSTs to the launchpad at `/onboard` with `{ instanceId, name, webhookConfig }` (header `X-Launchpad-Secret`).
   - Waits for the launchpad to complete onboarding (QR scan + sync) and upload session + instances to GCS.
   - Downloads the session zip and instances JSON from GCS, extracts the session dir into `AUTH_BASE_DIR`, merges the instance into `INSTANCES_DATA_PATH`.
   - Stops the launchpad VM.
   - Resumes the instance locally via `createInstance()` (session already on disk).

2. **Launchpad VM** (wa-hub with `IS_LAUNCHPAD=true`): Exposes internal endpoints only:
   - **POST /onboard**: Creates the instance locally, waits for `ready` (polls `getInstance().state`), zips the session dir and instances file, uploads to GCS, returns `{ ready: true, gcsSessionPath, gcsInstancesPath }`.
   - **GET /status/:id**: Returns `{ instanceId, state, qrCode? }` for polling (auth: `X-Launchpad-Secret`).

Only one onboarding at a time on the launchpad.

---

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GCP_PROJECT_ID` | GCP project ID (required when launchpad is used) | — |
| `GCS_BUCKET_NAME` | GCS bucket for session/instances transfer | `wa-hub-launchpad-sessions` |
| `LAUNCHPAD_VM_NAME` | Name of the launchpad VM | `wa-hub-launchpad` |
| `LAUNCHPAD_ZONE` | GCP zone for the VM | `us-central1-c` |
| `LAUNCHPAD_INTERNAL_URL` | Base URL of launchpad (e.g. `http://10.x.x.x:3000`). Optional when main VM starts launchpad and uses the returned URL. | `null` |
| `LAUNCHPAD_START_TIMEOUT_MS` | Max wait for VM RUNNING (ms) | `180000` (3 min) |
| `LAUNCHPAD_SYNC_TIMEOUT_MS` | Max wait for onboard sync (ms) | `3600000` (1 hour) |
| `LAUNCHPAD_USE_ON_DEMAND` | Use standard (on-demand) VM instead of Spot | `false` |
| `LAUNCHPAD_INTERNAL_SECRET` | Shared secret for `/onboard` and `/status/:id` (required when launchpad is used) | — |
| `LAUNCHPAD_REPO_URL` | Git repo URL for launchpad startup script clone | `https://github.com/michaelasham/wa-hub.git` |
| `USE_LAUNCHPAD_FOR_ONBOARDING` | Route new instance creation through launchpad (main VM only) | `false` |
| `IS_LAUNCHPAD` | Set `true` only on the launchpad VM; enables internal routes | `false` |

When `USE_LAUNCHPAD_FOR_ONBOARDING=true` or `IS_LAUNCHPAD=true`, `GCP_PROJECT_ID` and `LAUNCHPAD_INTERNAL_SECRET` must be set or the process will throw at startup.

---

## GCP setup

### 1. Create the GCS bucket

- In Cloud Console: **Cloud Storage → Buckets → Create**.
- Choose a name (e.g. `wa-hub-launchpad-sessions`) and region (same as your main VM or launchpad zone).
- Set `GCS_BUCKET_NAME` in `.env` on the main VM (and ensure the launchpad receives it via metadata/startup script).

### 2. Service account and roles (main VM)

The **main VM** needs a service account with:

| Role | Purpose |
|------|---------|
| **Compute Instance Admin (v1)** | Create, start, stop, get the launchpad VM (`compute.instances.insert`, `.start`, `.stop`, `.get`). |
| **Storage Object Admin** (on the bucket) | Read/write objects in the launchpad GCS bucket (download session zip and instances JSON, and the launchpad uploads to the same bucket). |

Optional: use a custom role or narrower permissions (e.g. only the specific bucket) for Storage.

- Attach the service account to the main VM (GCE → VM → Edit → Service account).
- Use **Application Default Credentials**; do not put keys in code.

### 3. Launchpad VM (created by main VM)

The main VM creates the launchpad with:

- **Machine type**: e2-medium (Spot by default; set `LAUNCHPAD_USE_ON_DEMAND=true` for standard).
- **Image**: Ubuntu 22.04 LTS.
- **Startup script** (via instance metadata): installs git/node/npm, clones `LAUNCHPAD_REPO_URL` into `/app`, `npm install`, writes `.env` from metadata (`GCS_BUCKET_NAME`, `LAUNCHPAD_INTERNAL_SECRET`, `GCP_PROJECT_ID`, `IS_LAUNCHPAD=true`), then starts the app (e.g. `node src/index.js` or PM2).

The launchpad VM’s service account (default or the one attached to the new instance) needs **Storage Object Admin** (or equivalent) on the same GCS bucket so it can upload the session zip and instances JSON. If the launchpad is created with the **same project default** service account as the main VM and that account already has Storage Object Admin on the bucket, no extra IAM is needed. Otherwise, grant the launchpad’s service account the same bucket access.

### 4. Network and firewall

- Main VM and launchpad must be able to reach each other (e.g. same VPC).
- Main VM calls the launchpad at its **internal IP** on port **3000** (returned by `startLaunchpad()` or set via `LAUNCHPAD_INTERNAL_URL`).
- Ensure a firewall rule allows **ingress to the launchpad on tcp:3000** from the main VM (e.g. by network tag or source IP).

---

## How to warm and stop

- **Warm (start launchpad VM)**  
  `POST /admin/launchpad/warm`  
  - Requires API key (and optionally `X-Admin-Debug-Secret` if `ADMIN_DEBUG_SECRET` is set).  
  - Starts the launchpad VM; does **not** stop it.  
  - Response: `{ status: 'starting', estimatedReadyInSeconds: 120 }`.

- **Stop (stop launchpad VM)**  
  `POST /admin/launchpad/stop`  
  - Same auth as above.  
  - Stops the launchpad VM.  
  - Response: `{ status: 'stopped' }`.

Example (replace `YOUR_API_KEY` and optional `YOUR_ADMIN_SECRET`):

```bash
curl -X POST -H "Authorization: Bearer YOUR_API_KEY" -H "X-Admin-Debug-Secret: YOUR_ADMIN_SECRET" http://localhost:3000/admin/launchpad/warm
curl -X POST -H "Authorization: Bearer YOUR_API_KEY" -H "X-Admin-Debug-Secret: YOUR_ADMIN_SECRET" http://localhost:3000/admin/launchpad/stop
```

---

## Troubleshooting

### Spot preemption

- **Symptom**: Launchpad VM disappears or stops unexpectedly during onboarding.
- **Cause**: Spot VMs can be preempted; the app may not finish zip/upload before preemption.
- **Options**:
  - Set `LAUNCHPAD_USE_ON_DEMAND=true` to use a non-Spot (standard) VM.
  - Retry: the main VM uses up to 2 attempts; a new Spot VM is created on retry.
  - Pre-warm with `POST /admin/launchpad/warm` and create the instance soon after the VM is RUNNING to reduce time in Spot.

### GCS permissions

- **Symptom**: Upload or download fails with 403 / permission denied.
- **Checks**:
  - Main VM service account has **Storage Object Admin** (or equivalent) on the bucket used for `GCS_BUCKET_NAME`.
  - Launchpad VM’s service account can **write** to the same bucket (session zip and instances JSON).
  - Bucket name and `GCS_BUCKET_NAME` match (including default `wa-hub-launchpad-sessions`).
- **Quick test**: From the main VM, `gsutil ls gs://YOUR_BUCKET_NAME/` and `gsutil cp <local> gs://YOUR_BUCKET_NAME/test` (then delete the object).

### Startup script fails on launchpad

- **Symptom**: Launchpad VM reaches RUNNING but the app never responds on port 3000, or logs show failed clone/install.
- **Checks**:
  - **Repo**: `LAUNCHPAD_REPO_URL` is correct and the repo is **public** (or the VM has SSH/key access for a private repo).
  - **Node**: Startup script installs Node (e.g. `apt-get install nodejs npm`); on some images you may need `nodejs` from NodeSource.
  - **Metadata**: Instance metadata must include `GCS_BUCKET_NAME`, `LAUNCHPAD_INTERNAL_SECRET`, `GCP_PROJECT_ID` so the script can write `.env`; ensure no typos and values are set when creating the VM.
  - **Disk**: Sufficient disk space for clone + `npm install` (e.g. 20 GB boot disk).
- **Debug**: SSH into the launchpad VM and inspect `/var/log/syslog` or the script’s own logs; run `cd /app && node src/index.js` manually to see runtime errors.

### Main VM cannot reach launchpad

- **Symptom**: POST to `http://<launchpad-internal-ip>:3000/onboard` times out or connection refused.
- **Checks**:
  - Launchpad is in RUNNING state and the app is listening on port 3000 (see startup script / process).
  - Main VM uses the **internal IP** (not external) and the same VPC or routable network.
  - Firewall allows **ingress to the launchpad on tcp:3000** from the main VM (e.g. by source IP or network tag).

### Sync timeout (504 or “Sync timeout - instance not ready”)

- **Symptom**: Launchpad returns 504 or the main VM reports sync timeout.
- **Cause**: Instance on the launchpad did not reach `ready` within `LAUNCHPAD_SYNC_TIMEOUT_MS` (default 1 hour).
- **Checks**:
  - User actually scanned the QR on the launchpad within the timeout.
  - Launchpad has enough memory/CPU (e2-medium is usually sufficient).
  - No Chromium/browser launch failures on the launchpad (check launchpad logs; similar to main VM Chromium troubleshooting in the main README).

---

## Enabling launchpad on the main VM

1. In the main VM `.env`:
   - Set `GCP_PROJECT_ID`, `LAUNCHPAD_INTERNAL_SECRET`, and `GCS_BUCKET_NAME` (or rely on default bucket).
   - Set `USE_LAUNCHPAD_FOR_ONBOARDING=true`.
   - Optionally set `LAUNCHPAD_ZONE`, `LAUNCHPAD_VM_NAME`, `LAUNCHPAD_REPO_URL`, `LAUNCHPAD_USE_ON_DEMAND`.
2. Ensure the GCS bucket exists and both main and launchpad service accounts have the required roles (see above).
3. When running the **launchpad** VM (e.g. via PM2 after the startup script has cloned and started the app), set `IS_LAUNCHPAD=true` in its environment (e.g. in `.env` on the launchpad or via `process.env` in `ecosystem.config.js`). The startup script should write `IS_LAUNCHPAD=true` into `/app/.env` so the app enables internal routes.

See [README.md](../README.md#launchpad-vm-offload-qrsync) for a short summary and link back to this doc.
