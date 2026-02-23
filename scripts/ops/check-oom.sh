#!/usr/bin/env bash
# Verify memory/swap and detect OOM kills from kernel logs.
# Run on the VM (e.g. after a crash) to confirm OOM as root cause.

echo "=== Memory & swap (current) ==="
free -h
echo ""
echo "=== Swap devices ==="
swapon --show 2>/dev/null || true
echo ""
echo "=== OOM / killed processes (current boot, kernel log) ==="
journalctl -k -b 0 --no-pager 2>/dev/null | grep -i -E "out of memory|oom|killed process" || echo "(none or journalctl not available)"
echo ""
echo "=== OOM (previous boot, if available) ==="
journalctl -k -b -1 --no-pager 2>/dev/null | grep -i -E "out of memory|oom|killed process" || echo "(none or journalctl not available)"
echo ""
echo "=== dmesg tail (last 30 lines, errors/warn) ==="
dmesg 2>/dev/null | tail -30 | grep -i -E "oom|kill|memory|error|warn" || dmesg 2>/dev/null | tail -15
