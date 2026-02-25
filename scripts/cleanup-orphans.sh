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
# This script identifies orphans (session-* folders whose ID is NOT in
# .wwebjs_instances.json), does a dry-run by default, and can optionally
# delete after you backup and uncomment the rm step.
#
# Requirements: jq installed. Run from repo root (or set paths below).
#
# Usage:
#   chmod +x scripts/cleanup-orphans.sh
#   ./scripts/cleanup-orphans.sh              # dry-run: list orphans only
#   ./scripts/cleanup-orphans.sh --delete     # (after backup & uncomment rm) actually delete
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
  (no args)     Dry-run: list orphan session folders only (no deletion).
  --delete      Actually delete orphans (only if you have uncommented the rm step below).
  --help        Show this help.

Before first real delete:
  1) Backup: tar -czvf wwebjs_auth_backup_$(date +%Y%m%d_%H%M%S).tar.gz -C . .wwebjs_auth
  2) Ensure wa-hub is stopped or no instance is using those sessions.
  3) Uncomment the "rm -rf" block in this script (search for "UNCOMMENT TO ENABLE DELETE").
  4) Run with --delete and confirm when prompted.
EOF
  exit 0
}

# --- Parse args ---
DO_DELETE=false
for arg in "$@"; do
  case "$arg" in
    --delete) DO_DELETE=true ;;
    --help|-h) usage ;;
    *) die "Unknown option: $arg" ;;
  esac
done

# --- Checks ---
if ! command -v jq &>/dev/null; then
  die "jq is required. Install with: apt-get install jq  # or brew install jq"
fi

if [[ ! -d "$AUTH_BASE_DIR" ]]; then
  echo "Auth base dir not found: $AUTH_BASE_DIR (nothing to clean)."
  exit 0
fi

if [[ ! -f "$INSTANCES_DATA_PATH" ]]; then
  die "Instances file not found: $INSTANCES_DATA_PATH"
fi

# Sanitize instance ID like wa-hub: [^a-zA-Z0-9_-] -> _
sanitize_id() {
  echo "$1" | sed 's/[^a-zA-Z0-9_-]/_/g'
}

# --- Active instance IDs from .wwebjs_instances.json ---
# JSON is array of objects with "id" field. Produce one identifier per line:
# raw id and sanitized id, so we match both session-<id> and session-<sanitized>.
ACTIVE_LIST=$(mktemp)
trap 'rm -f "$ACTIVE_LIST"' EXIT

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

# --- All session-* folders (only names starting with "session-") ---
SESSION_DIRS_LIST=$(mktemp)
trap 'rm -f "$ACTIVE_LIST" "$SESSION_DIRS_LIST"' EXIT

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

# --- Orphans: session folder name (session-<suffix>) where <suffix> is not in active set ---
# We have active as the list of identifiers (id and sanitized id). Session folder is "session-X".
# X is orphan if X is not in ACTIVE_LIST.
ORPHAN_SUFFIXES=$(mktemp)
trap 'rm -f "$ACTIVE_LIST" "$SESSION_DIRS_LIST" "$ORPHAN_SUFFIXES"' EXIT

# Strip "session-" prefix to get suffix, then find suffixes not in active list.
sed 's/^session-//' "$SESSION_DIRS_LIST" | sort -u | comm -23 - "$ACTIVE_LIST" > "$ORPHAN_SUFFIXES" || true

echo "=== Orphan session folders (would be deleted) ==="
if [[ ! -s "$ORPHAN_SUFFIXES" ]]; then
  echo "  (none)"
  echo ""
  echo "No orphans. Exiting."
  exit 0
fi

ORPHAN_NAMES=$(mktemp)
trap 'rm -f "$ACTIVE_LIST" "$SESSION_DIRS_LIST" "$ORPHAN_SUFFIXES" "$ORPHAN_NAMES"' EXIT
sed 's/^/session-/' "$ORPHAN_SUFFIXES" > "$ORPHAN_NAMES"

while IFS= read -r name; do
  echo "  $AUTH_BASE_DIR/$name"
done < "$ORPHAN_NAMES"
echo ""

# --- Dry-run: done unless --delete ---
if ! "$DO_DELETE"; then
  echo "--- Dry-run only (no deletion). ---"
  echo "To backup and then delete:"
  echo "  1) Backup: tar -czvf wwebjs_auth_backup_\$(date +%Y%m%d_%H%M%S).tar.gz -C . .wwebjs_auth"
  echo "  2) Uncomment the 'rm -rf' block in this script (search for 'UNCOMMENT TO ENABLE DELETE')."
  echo "  3) Run: $0 --delete"
  exit 0
fi

# --- Confirm before delete ---
echo "You ran with --delete. About to delete the orphan folders listed above."
echo "Only proceed if you have made a backup and uncommented the rm block in this script."
read -r -p "Type 'yes' to delete: " confirm
if [[ "$confirm" != "yes" ]]; then
  echo "Aborted."
  exit 1
fi

# --- Delete: COMMENTED OUT BY DEFAULT. Uncomment to enable. ---
# UNCOMMENT TO ENABLE DELETE:
# while IFS= read -r name; do
#   path="$AUTH_BASE_DIR/$name"
#   if [[ -d "$path" ]]; then
#     echo "Removing: $path"
#     rm -rf "$path"
#   fi
# done < "$ORPHAN_NAMES"
# echo "Done. Orphan session folders removed."

# If rm block is still commented, do nothing and remind.
echo "No deletion performed: the 'rm -rf' block in this script is still commented out."
echo "Edit the script, uncomment the block marked 'UNCOMMENT TO ENABLE DELETE', then run again with --delete."
