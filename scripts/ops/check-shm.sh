#!/usr/bin/env bash
# Print /dev/shm size and recommend 1g+ for Chromium (wa-hub).

echo "=== /dev/shm ==="
df -h /dev/shm 2>/dev/null || echo "df /dev/shm not available"
echo ""
echo "Recommendation: Use at least 1GB for multi-session Chromium (wa-hub)."
echo "  - On bare metal: /dev/shm is often 50% of RAM; if low, add swap (see add-swap.sh)."
echo "  - In Docker: run with --shm-size=1g or more."
