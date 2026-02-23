#!/usr/bin/env bash
# Add swap on the VM (Ubuntu/Debian GCP). Usage: sudo ./add-swap.sh 4G
# Idempotent: if swap already exists, prints and exits.

set -e
SIZE="${1:-2G}"
SWAPFILE="${SWAPFILE:-/swapfile}"
FSTAB_LINE="${SWAPFILE} none swap sw 0 0"
SYSCTL_FILE="/etc/sysctl.d/99-wa-hub-swap.conf"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0 $*"
  exit 1
fi

if [ -n "$(swapon --show=name --noheadings 2>/dev/null)" ]; then
  echo "Swap already enabled:"
  swapon --show
  free -h
  exit 0
fi

if [ -f "$SWAPFILE" ]; then
  echo "Swap file $SWAPFILE already exists. Enabling..."
  chmod 600 "$SWAPFILE"
  swapon "$SWAPFILE"
  grep -qF "$FSTAB_LINE" /etc/fstab || echo "$FSTAB_LINE" >> /etc/fstab
  echo "Done."
  free -h
  swapon --show
  exit 0
fi

echo "Creating swap file $SWAPFILE of size $SIZE..."
# Parse size: 4G -> 4096 MB, 2G -> 2048 MB
case "$SIZE" in
  *G) COUNT=$((${SIZE%G} * 1024));;
  *M) COUNT=${SIZE%M};;
  *)  COUNT=2048;;
esac
if command -v fallocate >/dev/null 2>&1; then
  fallocate -l "$SIZE" "$SWAPFILE" 2>/dev/null || dd if=/dev/zero of="$SWAPFILE" bs=1M count="$COUNT"
else
  dd if=/dev/zero of="$SWAPFILE" bs=1M count="$COUNT"
fi
chmod 600 "$SWAPFILE"
mkswap "$SWAPFILE"
swapon "$SWAPFILE"
grep -qF "$FSTAB_LINE" /etc/fstab || echo "$FSTAB_LINE" >> /etc/fstab

# Optional: reduce swappiness so swap is used less aggressively
if [ ! -f "$SYSCTL_FILE" ]; then
  echo "vm.swappiness=20" > "$SYSCTL_FILE"
  sysctl -p "$SYSCTL_FILE" 2>/dev/null || true
fi

echo "Swap enabled and persisted."
free -h
swapon --show
