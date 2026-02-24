#!/bin/bash
echo "Starting wa-hub server..."
node src/index.js &
SERVER_PID=$!
sleep 2

echo ""
echo "Checking if server is running..."
if ps -p $SERVER_PID > /dev/null 2>&1; then
  echo "✓ Server is running (PID: $SERVER_PID)"
  echo ""
  echo "Testing health endpoint..."
  curl -s http://localhost:3000/health
  echo ""
  echo ""
  echo "Server is running correctly!"
  echo "To stop it, run: kill $SERVER_PID"
else
  echo "✗ Server exited"
  echo "Check for errors above"
fi
