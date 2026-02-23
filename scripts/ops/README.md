# Ops scripts (VM / Chromium stability)

Run these on the wa-hub host (e.g. GCP VM) to improve stability during login/sync.

## add-swap.sh

Add swap so the system is less likely to OOM during Chromium spikes.

```bash
sudo ./scripts/ops/add-swap.sh 4G
```

- Creates `/swapfile`, enables swap, and persists in `/etc/fstab`.
- Optional: sets `vm.swappiness=20` in `/etc/sysctl.d/99-wa-hub-swap.conf`.
- Idempotent: if swap already exists, prints status and exits.

## check-oom.sh

Print memory/swap and kernel OOM/kill messages (current and previous boot).

```bash
./scripts/ops/check-oom.sh
```

Use after a crash to confirm OOM as root cause.

## check-shm.sh

Print `/dev/shm` size and recommend 1GB+ for Chromium.

```bash
./scripts/ops/check-shm.sh
```

On Docker, use `--shm-size=1g` (or more). On bare metal, ensure enough RAM or add swap.
