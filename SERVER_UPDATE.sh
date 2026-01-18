#!/bin/bash
# Server update commands for wa-hub refactor

echo "🚀 Updating wa-hub on server..."

cd ~/wa-hub

echo "📥 Pulling latest changes..."
git pull origin main

echo "📦 Installing dependencies (if any new)..."
npm install

echo "🔄 Restarting wa-hub service..."
pm2 restart wa-hub

echo "📊 Checking status..."
pm2 status wa-hub

echo "📝 Viewing recent logs..."
pm2 logs wa-hub --lines 30 --nostream

echo "✅ Update complete!"
echo ""
echo "💡 To monitor logs in real-time:"
echo "   pm2 logs wa-hub"
echo ""
echo "💡 To check service status:"
echo "   pm2 status wa-hub"
