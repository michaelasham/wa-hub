#!/usr/bin/env bash
# Clear the message/poll queue for an instance via wa-hub API.
# Usage: ./scripts/clear-instance-queue.sh [INSTANCE_ID]
#   If INSTANCE_ID is omitted, clears queue for the first instance returned by GET /instances.
# Requires: .env in repo root with API_KEY; backend running (default http://localhost:3000).

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

BASE_URL="${WA_HUB_BASE_URL:-http://34.69.38.248:3000}"
INSTANCE_ID="$1"

if [ -z "$API_KEY" ]; then
  echo "Error: API_KEY not set. Set it in .env or environment." >&2
  exit 1
fi

if [ -z "$INSTANCE_ID" ]; then
  echo "Fetching instances..."
  RAW=$(curl -s -H "Authorization: Bearer $API_KEY" "$BASE_URL/instances")
  INSTANCE_ID=$(echo "$RAW" | node -e "
    let d = '';
    process.stdin.on('data', c => d += c);
    process.stdin.on('end', () => {
      try {
        const j = JSON.parse(d);
        const list = Array.isArray(j) ? j : (j.data && Array.isArray(j.data) ? j.data : []);
        const id = list[0] && list[0].id;
        console.log(id || '');
      } catch (e) {
        console.log('');
      }
    });
  ")
  if [ -z "$INSTANCE_ID" ]; then
    echo "No instances found or invalid response. Pass INSTANCE_ID as first argument." >&2
    echo "Example: $0 WASP-my-instance" >&2
    exit 1
  fi
  echo "Using first instance: $INSTANCE_ID"
fi

echo "Clearing queue for instance: $INSTANCE_ID"
RESP=$(curl -s -w "\n%{http_code}" -X DELETE -H "Authorization: Bearer $API_KEY" "$BASE_URL/instances/$INSTANCE_ID/queue")
HTTP_CODE=$(echo "$RESP" | tail -n1)
BODY=$(echo "$RESP" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "$BODY" | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{ try { console.log(JSON.stringify(JSON.parse(d),null,2)); } catch(e){ console.log(d); } });"
  echo "Done."
else
  echo "HTTP $HTTP_CODE" >&2
  echo "$BODY" >&2
  exit 1
fi
