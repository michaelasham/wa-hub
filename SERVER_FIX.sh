#!/bin/bash
# Quick fix script for server deployment
# Run this on your GCP VM server

echo "🔧 Fixing wa-hub deployment..."
echo ""

cd /home/michaelnasser321/wa-hub

echo "1. Pulling latest code..."
git pull origin main

echo ""
echo "2. Checking .env file..."
if ! grep -q "CHROME_PATH" .env; then
  echo "CHROME_PATH=/usr/bin/chromium-browser" >> .env
  echo "✅ Added CHROME_PATH to .env"
else
  echo "✅ CHROME_PATH already in .env"
fi

if ! grep -q "^API_KEY=" .env; then
  echo "API_KEY=f0bdaeb85348f62f9d415e8bd749d251f5634e292ec61d7a133cd32ad71f1662" >> .env
  echo "✅ Added API_KEY to .env"
fi

if ! grep -q "^WEBHOOK_SECRET=" .env; then
  echo "WEBHOOK_SECRET=michaelasham" >> .env
  echo "✅ Added WEBHOOK_SECRET to .env"
fi

echo ""
echo "3. Checking Chromium installation..."
if ! command -v chromium-browser &> /dev/null && ! command -v chromium &> /dev/null; then
  echo "⚠️  Chromium not found. Installing..."
  sudo apt update
  sudo apt install -y chromium-browser || sudo apt install -y chromium
else
  echo "✅ Chromium is installed"
  which chromium-browser || which chromium
fi

echo ""
echo "4. Installing/updating npm dependencies..."
npm install

echo ""
echo "5. Restarting service..."
pm2 restart wa-hub

echo ""
echo "✅ Done! Check logs with: pm2 logs wa-hub"
