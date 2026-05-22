#!/bin/bash
set -u

# 00-check-mac-server-mode.sh — Inspect macOS server-readiness settings.
#
# On macOS (especially Mac mini deployments), the OS must be configured to
# stay awake, auto-restart after power failure, allow SSH, and auto-login
# so that omniclaw can run as a 24/7 headless service.
#
# This script reports current state. Fixup is applied by mac-server-mode.sh
# (which requires sudo and is intentionally not invoked from here).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [check-mac-server-mode] $*" >> "$LOG_FILE"; }

# Detect platform
case "$(uname -s)" in
  Darwin*) PLATFORM="macos" ;;
  *)       PLATFORM="other" ;;
esac

if [ "$PLATFORM" != "macos" ]; then
  log "Not macOS, skipping"
  cat <<EOF
=== OMNICLAW SETUP: CHECK_MAC_SERVER_MODE ===
PLATFORM: $PLATFORM
APPLICABLE: false
STATUS: skipped
LOG: logs/setup.log
=== END ===
EOF
  exit 0
fi

# Detect Mac mini specifically.
# Older Intel Mac minis report hw.model like "Macmini9,1". Apple Silicon Macs
# report opaque codes like "Mac16,11" (M4 Pro Mac mini), so fall back to
# system_profiler for the human-readable model name.
HW_MODEL="$(sysctl -n hw.model 2>/dev/null || echo unknown)"
IS_MAC_MINI="false"
if echo "$HW_MODEL" | grep -qi macmini; then
  IS_MAC_MINI="true"
else
  MODEL_NAME="$(system_profiler SPHardwareDataType 2>/dev/null | awk -F': ' '/Model Name/{print $2; exit}' || true)"
  if echo "${MODEL_NAME:-}" | grep -qi "Mac mini"; then
    IS_MAC_MINI="true"
  fi
fi
log "hw.model=$HW_MODEL is_mac_mini=$IS_MAC_MINI"

# pmset sleep — want 0 (never)
SLEEP_VALUE="$(pmset -g 2>/dev/null | awk '/ sleep /{print $2; exit}' || echo unknown)"
SLEEP_OK="false"
if [ "$SLEEP_VALUE" = "0" ]; then SLEEP_OK="true"; fi

# pmset autorestart — want 1 (restart after power failure)
AUTORESTART_VALUE="$(pmset -g 2>/dev/null | awk '/autorestart/{print $2; exit}' || echo unknown)"
AUTORESTART_OK="false"
if [ "$AUTORESTART_VALUE" = "1" ]; then AUTORESTART_OK="true"; fi

# systemsetup -getremotelogin — want On
# (requires Full Disk Access on newer macOS; tolerate failure gracefully)
SSH_RAW="$(systemsetup -getremotelogin 2>&1 || true)"
SSH_OK="false"
case "$SSH_RAW" in
  *"Remote Login: On"*) SSH_OK="true" ;;
esac

# Auto-login — want set (we do not script this; just report)
AUTOLOGIN_USER="$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true)"
AUTOLOGIN_OK="false"
if [ -n "$AUTOLOGIN_USER" ]; then AUTOLOGIN_OK="true"; fi

# FileVault — informational only. macOS blocks auto-login while FileVault is on
# because the login password derives the disk-decryption key. We do NOT script
# any change to FileVault state; this is purely so the orchestrator can surface
# the trade-off to the user instead of nagging them to enable auto-login.
FILEVAULT_RAW="$(fdesetup status 2>/dev/null || true)"
case "$FILEVAULT_RAW" in
  *"FileVault is On."*)  FILEVAULT_ON="true" ;;
  *"FileVault is Off."*) FILEVAULT_ON="false" ;;
  *)                     FILEVAULT_ON="unknown" ;;
esac

# Soft note: FileVault on + auto-login off is expected, not a failure.
# Surface a hint so the orchestrator can explain the trade-off rather than
# repeating "no auto-login configured" at the user.
AUTOLOGIN_NOTE=""
if [ "$AUTOLOGIN_OK" != "true" ] && [ "$FILEVAULT_ON" = "true" ]; then
  AUTOLOGIN_NOTE="filevault_blocks_autologin"
fi

log "sleep=$SLEEP_VALUE ok=$SLEEP_OK autorestart=$AUTORESTART_VALUE ok=$AUTORESTART_OK ssh_ok=$SSH_OK autologin_ok=$AUTOLOGIN_OK filevault_on=$FILEVAULT_ON note=${AUTOLOGIN_NOTE:-none}"

# Overall status. FileVault-on + auto-login-off is a deliberate user choice
# (Apple won't allow auto-login with FileVault), so don't flag it as needing
# fixup on that ground alone — the other pmset/SSH settings still might.
NEEDS_FIXUP="false"
if [ "$SLEEP_OK" != "true" ] || [ "$AUTORESTART_OK" != "true" ] || [ "$SSH_OK" != "true" ]; then
  NEEDS_FIXUP="true"
fi
if [ "$AUTOLOGIN_OK" != "true" ] && [ "$FILEVAULT_ON" != "true" ]; then
  NEEDS_FIXUP="true"
fi

FIXUP_SCRIPT="$SCRIPT_DIR/mac-server-mode.sh"

cat <<EOF
=== OMNICLAW SETUP: CHECK_MAC_SERVER_MODE ===
PLATFORM: $PLATFORM
HW_MODEL: $HW_MODEL
IS_MAC_MINI: $IS_MAC_MINI
SLEEP: $SLEEP_VALUE
SLEEP_OK: $SLEEP_OK
AUTORESTART: $AUTORESTART_VALUE
AUTORESTART_OK: $AUTORESTART_OK
SSH_OK: $SSH_OK
AUTOLOGIN_USER: ${AUTOLOGIN_USER:-not_set}
AUTOLOGIN_OK: $AUTOLOGIN_OK
FILEVAULT_ON: $FILEVAULT_ON
AUTOLOGIN_NOTE: ${AUTOLOGIN_NOTE:-none}
NEEDS_FIXUP: $NEEDS_FIXUP
FIXUP_SCRIPT: $FIXUP_SCRIPT
STATUS: success
LOG: logs/setup.log
=== END ===
EOF
