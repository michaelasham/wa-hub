#!/bin/bash
# Test API key authentication

API_KEY="f0bdaeb85348f62f9d415e8bd749d251f5634e292ec61d7a133cd32ad71f1662"
BASE_URL="http://localhost:3000"

echo "Testing API Key Authentication"
echo "=============================="
echo ""

# Test 1: Health check (should work without API key)
echo "1. Health check (no auth required):"
curl -s "$BASE_URL/health" | jq '.' || curl -s "$BASE_URL/health"
echo ""
echo ""

# Test 2: Request without API key (should fail)
echo "2. Request without API key (should fail):"
curl -s "$BASE_URL/instances" | jq '.' || curl -s "$BASE_URL/instances"
echo ""
echo ""

# Test 3: Request with API key in Authorization header (should work)
echo "3. Request with API key in Authorization header:"
curl -s -H "Authorization: Bearer $API_KEY" "$BASE_URL/instances" | jq '.' || curl -s -H "Authorization: Bearer $API_KEY" "$BASE_URL/instances"
echo ""
echo ""

# Test 4: Request with API key in X-API-Key header (should work)
echo "4. Request with API key in X-API-Key header:"
curl -s -H "X-API-Key: $API_KEY" "$BASE_URL/instances" | jq '.' || curl -s -H "X-API-Key: $API_KEY" "$BASE_URL/instances"
echo ""
echo ""

# Test 5: Request with wrong API key (should fail)
echo "5. Request with wrong API key (should fail):"
curl -s -H "Authorization: Bearer wrong-key-123" "$BASE_URL/instances" | jq '.' || curl -s -H "Authorization: Bearer wrong-key-123" "$BASE_URL/instances"
echo ""
