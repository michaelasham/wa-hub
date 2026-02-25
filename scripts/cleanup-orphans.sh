#!/usr/bin/env bash
#
# cleanup-orphans.sh - Safe one-time manual cleanup of orphan LocalAuth session folders
#
# wa-hub never automatically purges auth files. When you delete an instance from
# the dashboard or via API, the instance is removed from the map and
# .wwebjs_instances.json, but .wwebjs_auth/session-<id>/ is left on disk. These
# orphan folders can cause problems when creating a new instance with the same
# name: LocalAuth loads stale data → post_logout=1 → NEEDS_QR loop.
#
# This script can run in two modes:
#   - Default: list/delete only ORPHAN session folders (not in .wwebjs_instances.json).
#   - --all: list/delete ALL session-* folders in .wwebjs_auth.
#
# Usage:
#   chmod +x scripts/cleanup-orphans.sh
#   ./scripts/cleanup-orphans.sh              # dry-run: list orphans only
#   ./scripts/cleanup-orphans.sh --delete      # delete orphans only
#   ./scripts/cleanup-orphans.sh --all         # dry-run: list ALL session folders
#   ./scripts/cleanup-orphans.sh --all --delete # delete ALL session folders
#

set -euo pipefail

# --- Config (match wa-hub defaults) ---
AUTH_BASE_DIR="${AUTH_BASE_DIR:-./.wwebjs_auth}"
INSTANCES_DATA_PATH="${INSTANCES_DATA_PATH:-./.wwebjs_instances.json}"

# --- Helpers ---
die() { echo "ERROR: $*" >&2; exit 1; }
usage() {
  cat <<'EOF'
Usage: ./scripts/cleanup-orphans.sh [OPTIONS]
  (no args)       Dry-run: list orphan session folders only (no deletion).
  --all           Target ALL session-* folders (not just orphans). Use with --delete to wipe all.
  --delete        Actually delete the listed folders (orphans, or all if --all).
  --help          Show this help.

Examples:
  ./scripts/cleanup-orphans.sh                    # dry-run orphans
  ./scripts/cleanup-orphans.sh --delete           # delete orphans only
  ./scripts/cleanup-orphans.sh --all               # dry-run: list ALL session folders
  ./scripts/cleanup-orphans.sh --all --delete      # delete ALL session folders (full wipe)

Before first real delete:
  1) Backup: tar -czvf wwebjs_auth_backup_$(date +%Y%m%d_%H%M%S).tar.gz -C . .wwebjs_auth
  2) Ensure wa-hub is stopped or no instance is using those sessions.
  3) Run with --delete (and --all if you want to delete everything).
EOF
  exit 0
}

# --- Parse args ---
DO_DELETE=false
DO_ALL=false
for arg in "$@"; do
  case "$arg" in
    --delete) DO_DELETE=true ;;
    --all) DO_ALL=true ;;
    --help|-h) usage ;;
    *) die "Unknown option: $arg" ;;
  esac
done

# --- Checks ---
if [[ "$DO_ALL" != true ]] && ! command -v jq &>/dev/null; then
  die "jq is required for orphan mode. Install with: apt-get install jq  # or use --all to target all sessions"
fi

if [[ ! -d "$AUTH_BASE_DIR" ]]; then
  echo "Auth base dir not found: $AUTH_BASE_DIR (nothing to clean)."
  exit 0
fi

if [[ "$DO_ALL" != true ]] && [[ ! -f "$INSTANCES_DATA_PATH" ]]; then
  die "Instances file not found: $INSTANCES_DATA_PATH (use --all to target all session folders without it)"
fi

# Sanitize instance ID like wa-hub: [^a-zA-Z0-9_-] -> _
sanitize_id() {
  echo "$1" | sed 's/[^a-zA-Z0-9_-]/_/g'
}

# --- All session-* folders (only names starting with "session-") ---
SESSION_DIRS_LIST=$(mktemp)
trap 'rm -f "$SESSION_DIRS_LIST"' EXIT

shopt -s nullglob
for d in "$AUTH_BASE_DIR"/session-*; do
  [[ -d "$d" ]] && basename "$d"
done | sort -u > "$SESSION_DIRS_LIST"

echo "=== All session folders (in $AUTH_BASE_DIR) ==="
if [[ -s "$SESSION_DIRS_LIST" ]]; then
  cat "$SESSION_DIRS_LIST" | sed 's/^/  /'
else
  echo "  (none)"
fi
echo ""

# --- Build delete list: either all session dirs (--all) or orphans only ---
TO_DELETE=$(mktemp)
trap 'rm -f "$SESSION_DIRS_LIST" "$TO_DELETE"' EXIT

if "$DO_ALL"; then
  cp "$SESSION_DIRS_LIST" "$TO_DELETE"
  SECTION_LABEL="ALL session folders (would be deleted)"
else
  ACTIVE_LIST=$(mktemp)
  trap 'rm -f "$SESSION_DIRS_LIST" "$TO_DELETE" "$ACTIVE_LIST"' EXIT
  jq -r '.[].id // empty' "$INSTANCES_DATA_PATH" | while IFS= read -r id; do
    [[ -z "$id" ]] && continue
    echo "$id"
    sanitize_id "$id"
  done | sort -u > "$ACTIVE_LIST"

  echo "=== Active instance IDs (from $INSTANCES_DATA_PATH) ==="
  if [[ -s "$ACTIVE_LIST" ]]; then
    cat "$ACTIVE_LIST" | sed 's/^/  /'
  else
    echo "  (none)"
  fi
  echo ""

  ORPHAN_SUFFIXES=$(mktemp)
  trap 'rm -f "$SESSION_DIRS_LIST" "$TO_DELETE" "$ACTIVE_LIST" "$ORPHAN_SUFFIXES"' EXIT
  sed 's/^session-//' "$SESSION_DIRS_LIST" | sort -u | comm -23 - "$ACTIVE_LIST" > "$ORPHAN_SUFFIXES" || true
  sed 's/^/session-/' "$ORPHAN_SUFFIXES" > "$TO_DELETE"
  SECTION_LABEL="Orphan session folders (would be deleted)"
fi

echo "=== $SECTION_LABEL ==="
if [[ ! -s "$TO_DELETE" ]]; then
  echo "  (none)"
  echo ""
  if "$DO_ALL"; then
    echo "No session folders to delete. Exiting."
  else
    echo "No orphans. Exiting."
  fi
  exit 0
fi

while IFS= read -r name; do
  echo "  $AUTH_BASE_DIR/$name"
done < "$TO_DELETE"
echo ""

# --- Dry-run: done unless --delete ---
if ! "$DO_DELETE"; then
  echo "--- Dry-run only (no deletion). ---"
  echo "To backup and then delete:"
  echo "  1) Backup: tar -czvf wwebjs_auth_backup_\$(date +%Y%m%d_%H%M%S).tar.gz -C . .wwebjs_auth"
  if "$DO_ALL"; then
    echo "  2) Run: $0 --all --delete"
  else
    echo "  2) Run: $0 --delete"
  fi
  exit 0
fi

# --- Confirm before delete ---
if "$DO_ALL"; then
  echo "You ran with --all --delete. About to delete ALL session folders listed above."
else
  echo "You ran with --delete. About to delete the orphan folders listed above."
fi
echo "Only proceed if you have made a backup."
read -r -p "Type 'yes' to delete: " confirm
if [[ "$confirm" != "yes" ]]; then
  echo "Aborted."
  exit 1
fi

# --- Delete ---
while IFS= read -r name; do
  path="$AUTH_BASE_DIR/$name"
  if [[ -d "$path" ]]; then
    echo "Removing: $path"
    rm -rf "$path"
  fi
done < "$TO_DELETE"
if "$DO_ALL"; then
  echo "Done. All session folders removed."
else
  echo "Done. Orphan session folders removed."
fi
