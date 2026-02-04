#!/bin/bash
#
# Setup script for WA-Hub disk cleanup automation
# 
# This script helps configure systemd timer and logrotate for automated cleanup.
# It will prompt for paths and create the necessary configuration files.
#
# Usage:
#   sudo ./scripts/setup-cleanup.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=========================================="
echo "WA-Hub Cleanup Setup"
echo "=========================================="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
  echo "Error: This script must be run as root (use sudo)"
  exit 1
fi

# Detect current user (for service User field)
CURRENT_USER="${SUDO_USER:-$USER}"
echo "Detected user: $CURRENT_USER"
echo ""

# Get project root (default to current directory)
read -p "WA-Hub project root [$PROJECT_ROOT]: " input_root
PROJECT_ROOT="${input_root:-$PROJECT_ROOT}"
PROJECT_ROOT=$(realpath "$PROJECT_ROOT")

if [ ! -d "$PROJECT_ROOT" ]; then
  echo "Error: Project root does not exist: $PROJECT_ROOT"
  exit 1
fi

echo "Using project root: $PROJECT_ROOT"
echo ""

# Get tenants directory
read -p "Tenants directory (leave empty to use default from config.js) []: " tenants_dir
if [ -z "$tenants_dir" ]; then
  TENANTS_DIR=""
else
  TENANTS_DIR=$(realpath "$tenants_dir")
  if [ ! -d "$TENANTS_DIR" ]; then
    echo "Warning: Tenants directory does not exist: $TENANTS_DIR"
    read -p "Continue anyway? [y/N]: " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
      exit 1
    fi
  fi
fi

# Get service user
read -p "Service user (user running wa-hub) [$CURRENT_USER]: " service_user
SERVICE_USER="${service_user:-$CURRENT_USER}"

# Get max delete limit
read -p "Max deletion limit (GB) [100]: " max_delete_gb
MAX_DELETE_GB="${max_delete_gb:-100}"

echo ""
echo "=========================================="
echo "Configuration Summary"
echo "=========================================="
echo "Project Root: $PROJECT_ROOT"
echo "Tenants Dir: ${TENANTS_DIR:-<use default from config>}"
echo "Service User: $SERVICE_USER"
echo "Max Delete GB: $MAX_DELETE_GB"
echo ""

read -p "Continue with installation? [y/N]: " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Installation cancelled."
  exit 0
fi

# Create systemd service file
echo ""
echo "Creating systemd service file..."
SERVICE_FILE="/etc/systemd/system/wa-hub-cleanup.service"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=WA-Hub Cache Cleanup Service
Documentation=https://github.com/your-org/wa-hub
After=network.target

[Service]
Type=oneshot
User=$SERVICE_USER
WorkingDirectory=$PROJECT_ROOT
Environment="WA_HUB_TENANTS_DIR=$TENANTS_DIR"
Environment="LOG_FILE=/var/log/wa-hub-cleanup.log"
ExecStart=/bin/bash $PROJECT_ROOT/scripts/wa-hub-cleanup.sh
StandardOutput=journal
StandardError=journal

# Safety: prevent accidental huge deletions
Environment="MAX_DELETE_GB=$MAX_DELETE_GB"

[Install]
WantedBy=multi-user.target
EOF

echo "✓ Created: $SERVICE_FILE"

# Create systemd timer file
echo "Creating systemd timer file..."
TIMER_FILE="/etc/systemd/system/wa-hub-cleanup.timer"

cat > "$TIMER_FILE" <<EOF
[Unit]
Description=WA-Hub Cache Cleanup Timer (Daily at 04:30)
Documentation=https://github.com/your-org/wa-hub
Requires=wa-hub-cleanup.service

[Timer]
# Run daily at 04:30 local time
OnCalendar=*-*-* 04:30:00
# If the system was off during the scheduled time, run immediately on boot
Persistent=true
# Add some randomization to avoid thundering herd (0-30 minutes)
RandomizedDelaySec=1800

[Install]
WantedBy=timers.target
EOF

echo "✓ Created: $TIMER_FILE"

# Create logrotate config
echo "Creating logrotate config..."
LOGROTATE_FILE="/etc/logrotate.d/wa-hub-cleanup"

cat > "$LOGROTATE_FILE" <<EOF
/var/log/wa-hub-cleanup.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 0644 root root
    sharedscripts
    postrotate
        # Reload systemd journal if needed
        systemctl reload wa-hub-cleanup.service > /dev/null 2>&1 || true
    endscript
}
EOF

echo "✓ Created: $LOGROTATE_FILE"

# Ensure cleanup script is executable
chmod +x "$PROJECT_ROOT/scripts/wa-hub-cleanup.sh"
echo "✓ Made cleanup script executable"

# Reload systemd
echo ""
echo "Reloading systemd daemon..."
systemctl daemon-reload
echo "✓ Systemd daemon reloaded"

# Enable and start timer
echo ""
echo "Enabling and starting cleanup timer..."
systemctl enable wa-hub-cleanup.timer
systemctl start wa-hub-cleanup.timer
echo "✓ Timer enabled and started"

# Show status
echo ""
echo "=========================================="
echo "Installation Complete!"
echo "=========================================="
echo ""
echo "Timer Status:"
systemctl status wa-hub-cleanup.timer --no-pager -l || true
echo ""
echo "Next Run Time:"
systemctl list-timers wa-hub-cleanup.timer --no-pager || true
echo ""
echo "Useful Commands:"
echo "  Check timer status:    sudo systemctl status wa-hub-cleanup.timer"
echo "  View next run:        sudo systemctl list-timers wa-hub-cleanup.timer"
echo "  Manually run cleanup: sudo systemctl start wa-hub-cleanup.service"
echo "  View logs:            sudo journalctl -u wa-hub-cleanup.service -f"
echo "  View cleanup log:    sudo tail -f /var/log/wa-hub-cleanup.log"
echo ""
echo "To test cleanup (dry run):"
echo "  DRY_RUN=1 $PROJECT_ROOT/scripts/wa-hub-cleanup.sh"
echo ""
