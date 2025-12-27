#!/bin/bash
# Test script for wa-hub API endpoints
# Make sure the server is running: npm start

BASE_URL="http://localhost:3000"

echo "🧪 Testing wa-hub API Endpoints"
echo "================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Health Check
echo -e "${BLUE}1. Health Check${NC}"
echo "curl $BASE_URL/health"
curl -s "$BASE_URL/health" | jq '.' || curl -s "$BASE_URL/health"
echo ""
echo ""

# Test 2: List Instances (should be empty initially)
echo -e "${BLUE}2. List All Instances${NC}"
echo "curl $BASE_URL/instances"
INSTANCES=$(curl -s "$BASE_URL/instances")
echo "$INSTANCES" | jq '.' || echo "$INSTANCES"
echo ""
echo ""

# Test 3: Create Instance
echo -e "${BLUE}3. Create Instance${NC}"
echo "curl -X POST $BASE_URL/instances -H 'Content-Type: application/json' -d '{...}'"
INSTANCE_ID=$(curl -s -X POST "$BASE_URL/instances" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "WASP-test.myshopify.com",
    "webhook": {
      "url": "http://localhost:3001/webhooks/waapi",
      "events": ["vote_update", "qr", "ready", "authenticated", "disconnected", "change_state", "auth_failure", "message"]
    }
  }' | jq -r '.instance.id // empty' 2>/dev/null)

if [ -z "$INSTANCE_ID" ]; then
  INSTANCE_RESPONSE=$(curl -s -X POST "$BASE_URL/instances" \
    -H "Content-Type: application/json" \
    -d '{
      "name": "WASP-test.myshopify.com",
      "webhook": {
        "url": "http://localhost:3001/webhooks/waapi",
        "events": ["vote_update", "qr", "ready", "authenticated", "disconnected", "change_state", "auth_failure", "message"]
      }
    }')
  echo "$INSTANCE_RESPONSE" | jq '.' || echo "$INSTANCE_RESPONSE"
  INSTANCE_ID="WASP-test.myshopify.com"
else
  echo "Instance created: $INSTANCE_ID"
  curl -s -X POST "$BASE_URL/instances" \
    -H "Content-Type: application/json" \
    -d '{
      "name": "WASP-test.myshopify.com",
      "webhook": {
        "url": "http://localhost:3001/webhooks/waapi",
        "events": ["vote_update", "qr", "ready", "authenticated", "disconnected", "change_state", "auth_failure", "message"]
      }
    }' | jq '.'
fi
echo ""
echo -e "${YELLOW}⏳ Wait 10-15 seconds for QR code to be ready...${NC}"
echo ""
sleep 5
echo ""

# Test 4: Get QR Code
echo -e "${BLUE}4. Get QR Code${NC}"
echo "curl $BASE_URL/instances/$INSTANCE_ID/client/qr"
QR_RESPONSE=$(curl -s "$BASE_URL/instances/$INSTANCE_ID/client/qr")
echo "$QR_RESPONSE" | jq '.qrCode.data.qr_code // .error // .' || echo "$QR_RESPONSE"
echo ""
echo ""

# Test 5: Get Instance Status
echo -e "${BLUE}5. Get Instance Status${NC}"
echo "curl $BASE_URL/instances/$INSTANCE_ID/client/status"
curl -s "$BASE_URL/instances/$INSTANCE_ID/client/status" | jq '.' || curl -s "$BASE_URL/instances/$INSTANCE_ID/client/status"
echo ""
echo ""

# Test 6: List Instances Again (should show the created instance)
echo -e "${BLUE}6. List Instances (should show created instance)${NC}"
echo "curl $BASE_URL/instances"
curl -s "$BASE_URL/instances" | jq '.' || curl -s "$BASE_URL/instances"
echo ""
echo ""

# Test 7: Update Instance
echo -e "${BLUE}7. Update Instance (webhook config)${NC}"
echo "curl -X PUT $BASE_URL/instances/$INSTANCE_ID -H 'Content-Type: application/json' -d '{...}'"
curl -s -X PUT "$BASE_URL/instances/$INSTANCE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "WASP-test-updated.myshopify.com",
    "webhook": {
      "url": "http://localhost:3001/webhooks/waapi",
      "events": ["qr", "ready"]
    }
  }' | jq '.' || curl -s -X PUT "$BASE_URL/instances/$INSTANCE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "WASP-test-updated.myshopify.com",
    "webhook": {
      "url": "http://localhost:3001/webhooks/waapi",
      "events": ["qr", "ready"]
    }
  }'
echo ""
echo ""

# Test 8: Get Client Details (only works when connected)
echo -e "${BLUE}8. Get Client Details (requires instance to be ready)${NC}"
echo "curl $BASE_URL/instances/$INSTANCE_ID/client/me"
curl -s "$BASE_URL/instances/$INSTANCE_ID/client/me" | jq '.' || curl -s "$BASE_URL/instances/$INSTANCE_ID/client/me"
echo ""
echo ""

echo -e "${YELLOW}═══════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}⚠️  The following tests require the instance to be ready${NC}"
echo -e "${YELLOW}⚠️  (QR code scanned and connected)${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════${NC}"
echo ""
echo "To test message sending, you need to:"
echo "1. Scan the QR code from step 4"
echo "2. Wait for the instance status to be 'ready'"
echo "3. Then run the message tests"
echo ""
echo "Continue with message tests? (y/n)"
read -r answer
if [ "$answer" != "y" ]; then
  echo "Skipping message tests."
  exit 0
fi

# Test 9: Send Text Message (requires phone number)
echo -e "${BLUE}9. Send Text Message${NC}"
echo -e "${YELLOW}Enter phone number (format: country code + number, e.g., 201224885551):${NC}"
read -r PHONE_NUMBER
echo "curl -X POST $BASE_URL/instances/$INSTANCE_ID/client/action/send-message ..."
curl -s -X POST "$BASE_URL/instances/$INSTANCE_ID/client/action/send-message" \
  -H "Content-Type: application/json" \
  -d "{
    \"chatId\": \"$PHONE_NUMBER\",
    \"message\": \"Hello from wa-hub test! 👋\"
  }" | jq '.' || curl -s -X POST "$BASE_URL/instances/$INSTANCE_ID/client/action/send-message" \
  -H "Content-Type: application/json" \
  -d "{
    \"chatId\": \"$PHONE_NUMBER\",
    \"message\": \"Hello from wa-hub test! 👋\"
  }"
echo ""
echo ""

# Test 10: Send Poll Message
echo -e "${BLUE}10. Send Poll Message${NC}"
echo "curl -X POST $BASE_URL/instances/$INSTANCE_ID/client/action/create-poll ..."
curl -s -X POST "$BASE_URL/instances/$INSTANCE_ID/client/action/create-poll" \
  -H "Content-Type: application/json" \
  -d "{
    \"chatId\": \"$PHONE_NUMBER\",
    \"caption\": \"Test poll: Do you like testing? 😊\",
    \"options\": [\"Yes\", \"No\"],
    \"multipleAnswers\": false
  }" | jq '.' || curl -s -X POST "$BASE_URL/instances/$INSTANCE_ID/client/action/create-poll" \
  -H "Content-Type: application/json" \
  -d "{
    \"chatId\": \"$PHONE_NUMBER\",
    \"caption\": \"Test poll: Do you like testing? 😊\",
    \"options\": [\"Yes\", \"No\"],
    \"multipleAnswers\": false
  }"
echo ""
echo ""

# Test 11: Logout Instance
echo -e "${BLUE}11. Logout Instance${NC}"
echo "curl -X POST $BASE_URL/instances/$INSTANCE_ID/client/action/logout"
curl -s -X POST "$BASE_URL/instances/$INSTANCE_ID/client/action/logout" | jq '.' || curl -s -X POST "$BASE_URL/instances/$INSTANCE_ID/client/action/logout"
echo ""
echo ""

# Test 12: Delete Instance
echo -e "${BLUE}12. Delete Instance${NC}"
echo "curl -X DELETE $BASE_URL/instances/$INSTANCE_ID"
curl -s -X DELETE "$BASE_URL/instances/$INSTANCE_ID" | jq '.' || curl -s -X DELETE "$BASE_URL/instances/$INSTANCE_ID"
echo ""
echo ""

echo -e "${GREEN}✅ All tests completed!${NC}"

