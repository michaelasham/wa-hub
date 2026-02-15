#!/bin/bash
# Build and restart wa-hub-dashboard (run from wa-hub root or scripts/)
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/wa-hub-dashboard"
echo "Building dashboard..."
npm install
npm run build
echo "Build complete. Restarting PM2..."
cd "$ROOT"
pm2 restart wa-hub-dashboard --update-env || pm2 start wa-hub-dashboard/ecosystem.config.js
echo "Done."
