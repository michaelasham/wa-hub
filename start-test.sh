#!/bin/bash
# Start both wa-hub service and test webhook server

echo "Starting test environment..."
echo ""

# Start webhook server in background
echo "🚀 Starting webhook server on port 3001..."
node test-webhook-server.js &
WEBHOOK_PID=$!

# Wait a moment for webhook server to start
sleep 2

# Start wa-hub service
echo "🚀 Starting wa-hub service on port 3000..."
echo ""
node src/index.js &
WAHUB_PID=$!

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Shutting down services..."
    kill $WEBHOOK_PID 2>/dev/null
    kill $WAHUB_PID 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for processes
wait
