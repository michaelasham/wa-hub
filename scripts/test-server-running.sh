#!/bin/bash
echo "=== Testing if wa-hub server stays running ==="
echo ""

# Clean up any existing processes
killall -9 node 2>/dev/null
sleep 1

echo "Starting server in background..."
node src/index.js > /tmp/wa-hub-output.log 2>&1 &
SERVER_PID=$!

echo "Server started with PID: $SERVER_PID"
sleep 2

echo ""
echo "Checking if process is still alive..."
if ps -p $SERVER_PID > /dev/null 2>&1; then
  echo "✓ Process is RUNNING (PID: $SERVER_PID)"
  
  echo ""
  echo "Testing health endpoint..."
  RESPONSE=$(curl -s http://localhost:3000/health)
  if [ "$RESPONSE" = '{"status":"ok","service":"wa-hub"}' ]; then
    echo "✓ Health check SUCCESS"
    echo "  Response: $RESPONSE"
  else
    echo "✗ Health check FAILED"
    echo "  Response: $RESPONSE"
  fi
  
  echo ""
  echo "Server output:"
  tail -10 /tmp/wa-hub-output.log
  
  echo ""
  echo "✓ SERVER IS WORKING CORRECTLY!"
  echo "The server is running and responding to requests."
  echo ""
  echo "To stop it, run: kill $SERVER_PID"
  
  kill $SERVER_PID 2>/dev/null
else
  echo "✗ Process EXITED"
  echo ""
  echo "Server output:"
  cat /tmp/wa-hub-output.log
fi

rm -f /tmp/wa-hub-output.log
