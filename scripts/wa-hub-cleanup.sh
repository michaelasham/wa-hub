#!/bin/bash
#
# WA-Hub Cache Cleanup Script
#
# Safely removes Chromium cache directories from tenant profiles while preserving
# authentication data. Designed to run as a scheduled job (systemd timer or cron).
#
# CRITICAL: LocalAuth is the single source of truth for session persistence.
# NEVER delete: .wwebjs_auth/**, LocalAuth dataPath/**, any active instance profile.
# Cleanup runs ONLY when wa-hub service is stopped (no active clients).
#
# Safety: ALLOWLIST only - we delete ONLY known safe cache folders:
#   Cache, Code Cache, GPUCache (under Default/ or Profile N/)
#
# Usage:
#   DRY_RUN=1 ./scripts/wa-hub-cleanup.sh          # Preview only
#   MAX_DELETE_GB=50 ./scripts/wa-hub-cleanup.sh   # Limit deletions to 50GB
#   ./scripts/wa-hub-cleanup.sh                    # Run cleanup
#

set -euo pipefail

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Configuration
DRY_RUN="${DRY_RUN:-0}"
MAX_DELETE_GB="${MAX_DELETE_GB:-100}"
LOG_FILE="${LOG_FILE:-/var/log/wa-hub-cleanup.log}"
TENANTS_DIR="${WA_HUB_TENANTS_DIR:-}"

# Service detection (PM2 or systemd)
SERVICE_NAME="wa-hub"
SERVICE_TYPE="unknown"

# ALLOWLIST: Only these cache subdirs (under Default/, Profile 1/, etc.) are safe to delete.
# NEVER add: Local Storage, IndexedDB, Cookies, Session Storage, Preferences, .wwebjs_auth, etc.

# Logging function
log() {
  local level="$1"
  shift
  local message="$*"
  local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
  
  echo "[$timestamp] [$level] $message" | tee -a "$LOG_FILE" >&2
}

# Detect service type (PM2 or systemd)
detect_service() {
  if command -v pm2 >/dev/null 2>&1 && pm2 list | grep -q "$SERVICE_NAME"; then
    SERVICE_TYPE="pm2"
    log "INFO" "Detected PM2 service: $SERVICE_NAME"
  elif systemctl is-active --quiet "$SERVICE_NAME.service" 2>/dev/null; then
    SERVICE_TYPE="systemd"
    log "INFO" "Detected systemd service: $SERVICE_NAME.service"
  else
    SERVICE_TYPE="none"
    log "WARN" "No active service detected. Proceeding without stopping service."
  fi
}

# Stop service
stop_service() {
  if [ "$SERVICE_TYPE" = "pm2" ]; then
    log "INFO" "Stopping PM2 service: $SERVICE_NAME"
    if [ "$DRY_RUN" = "0" ]; then
      pm2 stop "$SERVICE_NAME" || log "WARN" "Failed to stop PM2 service (may not be running)"
      sleep 2  # Give it time to stop
    else
      log "INFO" "[DRY RUN] Would stop PM2 service: $SERVICE_NAME"
    fi
  elif [ "$SERVICE_TYPE" = "systemd" ]; then
    log "INFO" "Stopping systemd service: $SERVICE_NAME.service"
    if [ "$DRY_RUN" = "0" ]; then
      systemctl stop "$SERVICE_NAME.service" || log "WARN" "Failed to stop systemd service"
      sleep 2
    else
      log "INFO" "[DRY RUN] Would stop systemd service: $SERVICE_NAME.service"
    fi
  fi
}

# Start service
start_service() {
  if [ "$SERVICE_TYPE" = "pm2" ]; then
    log "INFO" "Starting PM2 service: $SERVICE_NAME"
    if [ "$DRY_RUN" = "0" ]; then
      pm2 start "$SERVICE_NAME" || log "ERROR" "Failed to start PM2 service"
    else
      log "INFO" "[DRY RUN] Would start PM2 service: $SERVICE_NAME"
    fi
  elif [ "$SERVICE_TYPE" = "systemd" ]; then
    log "INFO" "Starting systemd service: $SERVICE_NAME.service"
    if [ "$DRY_RUN" = "0" ]; then
      systemctl start "$SERVICE_NAME.service" || log "ERROR" "Failed to start systemd service"
    else
      log "INFO" "[DRY RUN] Would start systemd service: $SERVICE_NAME.service"
    fi
  fi
}

# Get directory size in bytes
get_dir_size() {
  local dir="$1"
  if [ -d "$dir" ]; then
    du -sb "$dir" 2>/dev/null | cut -f1 || echo "0"
  else
    echo "0"
  fi
}

# Format bytes to human-readable
format_bytes() {
  local bytes="$1"
  if [ "$bytes" -eq 0 ]; then
    echo "0 B"
  else
    # Try numfmt first (GNU coreutils), fallback to manual calculation
    if command -v numfmt >/dev/null 2>&1; then
      numfmt --to=iec-i --suffix=B "$bytes" 2>/dev/null || {
        # Fallback calculation
        local kb=$((bytes / 1024))
        local mb=$((kb / 1024))
        local gb=$((mb / 1024))
        if [ "$gb" -gt 0 ]; then
          echo "${gb}.$((mb % 1024 / 100)) GB"
        elif [ "$mb" -gt 0 ]; then
          echo "${mb}.$((kb % 1024 / 100)) MB"
        elif [ "$kb" -gt 0 ]; then
          echo "${kb} KB"
        else
          echo "${bytes} B"
        fi
      }
    else
      # Manual calculation fallback
      local kb=$((bytes / 1024))
      local mb=$((kb / 1024))
      local gb=$((mb / 1024))
      if [ "$gb" -gt 0 ]; then
        echo "${gb}.$((mb % 1024 / 100)) GB"
      elif [ "$mb" -gt 0 ]; then
        echo "${mb}.$((kb % 1024 / 100)) MB"
      elif [ "$kb" -gt 0 ]; then
        echo "${kb} KB"
      else
        echo "${bytes} B"
      fi
    fi
  fi
}

# ALLOWLIST only: these are the ONLY cache subdirs we delete. Never touch session/auth.
SAFE_CACHE_NAMES=("Cache" "Code Cache" "GPUCache")

# Clean cache directories in a tenant
# WHY ACTIVE PROFILES MUST NOT BE CLEANED: Chromium may crash or hang if Cache/GPUCache/Code
# Cache are deleted while the browser is running. We only run when service is stopped and no
# process has tenant data open (verified via lsof/fuser).
# We delete ONLY Cache, Code Cache, GPUCache under each profile. Everything else is skipped.
clean_tenant_cache() {
  local tenant_dir="$1"
  local tenant_name=$(basename "$tenant_dir")
  local total_deleted=0
  local deleted_count=0
  local skipped_count=0
  
  log "INFO" "Scanning tenant: $tenant_name"
  
  # Find all profile directories (Default, Profile 1, Profile 2, etc.)
  local profiles=()
  if [ -d "$tenant_dir" ]; then
    while IFS= read -r -d '' profile; do
      local profile_name=$(basename "$profile")
      if [[ "$profile_name" == "Default" ]] || [[ "$profile_name" =~ ^Profile\ [0-9]+$ ]]; then
        profiles+=("$profile")
      fi
    done < <(find "$tenant_dir" -maxdepth 1 -type d -print0 2>/dev/null || true)
  fi
  
  for profile_dir in "${profiles[@]}"; do
    local profile_name=$(basename "$profile_dir")
    log "INFO" "  Processing profile: $profile_name"
    
    for cache_name in "${SAFE_CACHE_NAMES[@]}"; do
      local cache_dir="$profile_dir/$cache_name"
      local cache_rel="$profile_name/$cache_name"
      
      if [ -d "$cache_dir" ]; then
        local size=$(get_dir_size "$cache_dir")
        
        if [ "$size" -gt 0 ]; then
          local size_formatted=$(format_bytes "$size")
          
          local size_gb=$((size / 1024 / 1024 / 1024))
          if [ "$size_gb" -gt "$MAX_DELETE_GB" ]; then
            log "WARN" "    SKIP (exceeds MAX_DELETE_GB ${MAX_DELETE_GB}GB): $cache_rel ($size_formatted)"
            skipped_count=$((skipped_count + 1))
            continue
          fi
          
          if [ "$DRY_RUN" = "1" ]; then
            log "INFO" "    [DRY RUN] Would delete: $cache_dir ($size_formatted)"
          else
            log "INFO" "    Deleting (exact path): $cache_dir ($size_formatted)"
            rm -rf "$cache_dir"
            if [ $? -eq 0 ]; then
              total_deleted=$((total_deleted + size))
              deleted_count=$((deleted_count + 1))
              log "INFO" "    ✓ Deleted successfully"
            else
              log "ERROR" "    ✗ Failed to delete"
            fi
          fi
        fi
      fi
    done
  done
  
  if [ "$deleted_count" -gt 0 ]; then
    local total_formatted=$(format_bytes "$total_deleted")
    log "INFO" "  Tenant $tenant_name: Deleted $deleted_count cache dirs ($total_formatted)"
  fi
  if [ "$skipped_count" -gt 0 ]; then
    log "INFO" "  Tenant $tenant_name: Skipped $skipped_count paths (exceeded limit)"
  fi
  
  echo "$total_deleted"
}

# Main cleanup function
main() {
  log "INFO" "=========================================="
  log "INFO" "WA-Hub Cache Cleanup Started"
  log "INFO" "=========================================="
  
  if [ "$DRY_RUN" = "1" ]; then
    log "INFO" "DRY RUN MODE - No files will be deleted"
  fi
  
  log "INFO" "MAX_DELETE_GB: $MAX_DELETE_GB"
  
  # Determine tenants directory
  if [ -z "$TENANTS_DIR" ]; then
    # Try to load from config or use default
    cd "$PROJECT_ROOT"
    if [ -f "src/config.js" ]; then
      # Try to extract from Node.js (fallback to default)
      TENANTS_DIR="${AUTH_BASE_DIR:-${SESSION_DATA_PATH:-./.wwebjs_auth}}"
    else
      TENANTS_DIR="./.wwebjs_auth"
    fi
  fi
  
  # Resolve absolute path
  TENANTS_DIR=$(cd "$PROJECT_ROOT" && cd "$TENANTS_DIR" && pwd)
  log "INFO" "Tenants Directory: $TENANTS_DIR"
  
  if [ ! -d "$TENANTS_DIR" ]; then
    log "ERROR" "Tenants directory does not exist: $TENANTS_DIR"
    log "ERROR" "Set WA_HUB_TENANTS_DIR environment variable to override."
    exit 1
  fi
  
  # Detect and stop service
  detect_service
  stop_service
  
  # Wait for wa-hub and Chromium to fully exit (Chromium may take a few seconds after node dies)
  sleep 5

  # GUARD: Only clean when NO process is using tenant data.
  # Chromium may crash or hang if Cache/GPUCache/Code Cache are deleted while running.
  # Active profiles (client exists, state != STOPPED) must never be cleaned.
  if command -v lsof >/dev/null 2>&1; then
    local open_count=0
    open_count=$(lsof +D "$TENANTS_DIR" 2>/dev/null | wc -l | tr -d ' \n') || true
    open_count=${open_count:-0}
    if [ "$open_count" -gt 0 ]; then
      log "ERROR" "SKIP CLEANUP: Processes still have tenant data open (lsof found $open_count references)"
      log "ERROR" "  Reason: wa-hub or Chromium not fully stopped. Ensure service is stopped and wait for Chromium to exit."
      start_service
      exit 1
    fi
  elif command -v fuser >/dev/null 2>&1; then
    local pids
    pids=$(fuser -m "$TENANTS_DIR" 2>/dev/null || true)
    if [ -n "$pids" ]; then
      log "ERROR" "SKIP CLEANUP: Processes using tenant data: $pids"
      log "ERROR" "  Reason: wa-hub or Chromium not fully stopped."
      start_service
      exit 1
    fi
  else
    log "WARN" "Cannot verify no active processes (lsof/fuser not found). Proceeding with caution."
  fi

  # Double-check: wa-hub server process should be gone (instance-manager is the main module)
  if pgrep -f "instance-manager" >/dev/null 2>&1; then
    log "ERROR" "SKIP CLEANUP: wa-hub process still running (pgrep found instance-manager)"
    log "ERROR" "  Reason: Service stop may have failed. Ensure wa-hub is fully stopped."
    start_service
    exit 1
  fi

  log "INFO" "Verified: no active processes using tenant data. Safe to clean."
  
  # Find all tenant directories
  local tenants=()
  while IFS= read -r -d '' tenant; do
    tenants+=("$tenant")
  done < <(find "$TENANTS_DIR" -maxdepth 1 -type d -not -path "$TENANTS_DIR" -print0 2>/dev/null || true)
  
  if [ ${#tenants[@]} -eq 0 ]; then
    log "WARN" "No tenant directories found in $TENANTS_DIR"
  else
    log "INFO" "Found ${#tenants[@]} tenant directory(ies)"
    
    local grand_total=0
    local grand_count=0
    
    # Clean each tenant
    for tenant_dir in "${tenants[@]}"; do
      local deleted=$(clean_tenant_cache "$tenant_dir")
      grand_total=$((grand_total + deleted))
      if [ "$deleted" -gt 0 ]; then
        grand_count=$((grand_count + 1))
      fi
    done
    
    # Summary
    log "INFO" "=========================================="
    if [ "$DRY_RUN" = "1" ]; then
      log "INFO" "DRY RUN SUMMARY:"
      log "INFO" "  Would delete: $(format_bytes $grand_total) from $grand_count tenant(s)"
    else
      log "INFO" "CLEANUP SUMMARY:"
      log "INFO" "  Deleted: $(format_bytes $grand_total) from $grand_count tenant(s)"
    fi
    log "INFO" "=========================================="
  fi
  
  # Start service
  start_service
  
  log "INFO" "Cleanup completed successfully"
}

# Run main function
main "$@"
