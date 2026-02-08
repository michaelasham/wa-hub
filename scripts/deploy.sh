#!/bin/bash
# Deploy script for wa-hub service
# This script is executed on the VM via GitHub Actions

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

DEPLOY_DIR="/opt/wa-hub"
SERVICE_NAME="wa-hub"

echo -e "${GREEN}Starting deployment to ${DEPLOY_DIR}...${NC}"

# Change to deploy directory
cd "${DEPLOY_DIR}" || {
    echo -e "${RED}Error: Cannot change to ${DEPLOY_DIR}${NC}"
    exit 1
}

# Fetch latest changes
echo -e "${YELLOW}Fetching latest changes from origin...${NC}"
git fetch --all

# Reset to origin/main (hard reset to ensure clean state)
echo -e "${YELLOW}Resetting to origin/main...${NC}"
git reset --hard origin/main

# Clean up any untracked files that might interfere
echo -e "${YELLOW}Cleaning untracked files...${NC}"
git clean -fd || true

# Install dependencies
echo -e "${YELLOW}Installing dependencies with npm ci...${NC}"
npm ci --production

# Check if build script exists and run it if needed
if grep -q '"build"' package.json; then
    echo -e "${YELLOW}Running build script...${NC}"
    npm run build
fi

# Restart the service
echo -e "${YELLOW}Restarting ${SERVICE_NAME} service...${NC}"
sudo systemctl restart "${SERVICE_NAME}"

# Wait a moment for service to start
sleep 2

# Check service status
echo -e "${YELLOW}Checking service status...${NC}"
if sudo systemctl is-active --quiet "${SERVICE_NAME}"; then
    echo -e "${GREEN}✓ Service ${SERVICE_NAME} is running${NC}"
    sudo systemctl status "${SERVICE_NAME}" --no-pager -l
    exit 0
else
    echo -e "${RED}✗ Service ${SERVICE_NAME} failed to start${NC}"
    sudo systemctl status "${SERVICE_NAME}" --no-pager -l
    exit 1
fi
