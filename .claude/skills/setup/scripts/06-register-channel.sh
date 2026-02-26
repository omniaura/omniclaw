#!/bin/bash
set -euo pipefail

# 06-register-channel.sh — Write channel registration config, create group folders

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [register-channel] $*" >> "$LOG_FILE"; }

cd "$PROJECT_ROOT"

# Parse args
JID=""
NAME=""
TRIGGER=""
FOLDER=""
REQUIRES_TRIGGER="true"
ASSISTANT_NAME="Andy"
DISCORD_BOT_ID=""
AGENT_RUNTIME=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --jid)              JID="$2"; shift 2 ;;
    --name)             NAME="$2"; shift 2 ;;
    --trigger)          TRIGGER="$2"; shift 2 ;;
    --folder)           FOLDER="$2"; shift 2 ;;
    --discord-bot-id)   DISCORD_BOT_ID="$2"; shift 2 ;;
    --agent-runtime)    AGENT_RUNTIME="$2"; shift 2 ;;
    --no-trigger-required) REQUIRES_TRIGGER="false"; shift ;;
    --assistant-name)   ASSISTANT_NAME="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Validate required args
if [ -z "$JID" ] || [ -z "$NAME" ] || [ -z "$TRIGGER" ] || [ -z "$FOLDER" ]; then
  log "ERROR: Missing required args (--jid, --name, --trigger, --folder)"
  cat <<EOF
=== OMNICLAW SETUP: REGISTER_CHANNEL ===
STATUS: failed
ERROR: missing_required_args
LOG: logs/setup.log
=== END ===
EOF
  exit 4
fi

log "Registering channel: jid=$JID name=$NAME trigger=$TRIGGER folder=$FOLDER requiresTrigger=$REQUIRES_TRIGGER"

# Create data directory
mkdir -p "$PROJECT_ROOT/data"

# Write directly to SQLite (the DB and schema exist from the sync-groups step)
TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
DB_PATH="$PROJECT_ROOT/store/messages.db"
REQUIRES_TRIGGER_INT=$( [ "$REQUIRES_TRIGGER" = "true" ] && echo 1 || echo 0 )

HAS_RG_DISCORD_BOT_ID=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM pragma_table_info('registered_groups') WHERE name='discord_bot_id';" 2>/dev/null || echo "0")
if [ "$HAS_RG_DISCORD_BOT_ID" = "1" ]; then
  sqlite3 "$DB_PATH" "INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, discord_bot_id) VALUES ('$JID', '$NAME', '$FOLDER', '$TRIGGER', '$TIMESTAMP', NULL, $REQUIRES_TRIGGER_INT, NULLIF('$DISCORD_BOT_ID',''));"
else
  sqlite3 "$DB_PATH" "INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger) VALUES ('$JID', '$NAME', '$FOLDER', '$TRIGGER', '$TIMESTAMP', NULL, $REQUIRES_TRIGGER_INT);"
fi

log "Wrote registration to SQLite"

HAS_AGENTS_TABLE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='agents';" 2>/dev/null || echo "0")
HAS_ROUTES_TABLE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='channel_routes';" 2>/dev/null || echo "0")
HAS_SUBSCRIPTIONS_TABLE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='channel_subscriptions';" 2>/dev/null || echo "0")

if [ "$HAS_AGENTS_TABLE" = "1" ] && [ "$HAS_ROUTES_TABLE" = "1" ]; then
  BACKEND=$(sqlite3 "$DB_PATH" "SELECT backend FROM registered_groups WHERE backend IS NOT NULL LIMIT 1;" 2>/dev/null || true)
  [ -z "$BACKEND" ] && BACKEND="apple-container"

  case "$AGENT_RUNTIME" in
    claude-agent-sdk|opencode) ;;
    "") AGENT_RUNTIME="claude-agent-sdk" ;;
    *) AGENT_RUNTIME="claude-agent-sdk" ;;
  esac

  IS_ADMIN=0
  [ "$FOLDER" = "main" ] && IS_ADMIN=1

  HAS_AGENT_RUNTIME_COL=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM pragma_table_info('agents') WHERE name='agent_runtime';" 2>/dev/null || echo "0")
  if [ "$HAS_AGENT_RUNTIME_COL" = "1" ]; then
    sqlite3 "$DB_PATH" "INSERT OR IGNORE INTO agents (id, name, folder, backend, agent_runtime, is_admin, created_at) VALUES ('$FOLDER', '$NAME', '$FOLDER', '$BACKEND', '$AGENT_RUNTIME', $IS_ADMIN, '$TIMESTAMP');"
  else
    sqlite3 "$DB_PATH" "INSERT OR IGNORE INTO agents (id, name, folder, backend, is_admin, created_at) VALUES ('$FOLDER', '$NAME', '$FOLDER', '$BACKEND', $IS_ADMIN, '$TIMESTAMP');"
  fi

  HAS_CR_DISCORD_BOT_ID=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM pragma_table_info('channel_routes') WHERE name='discord_bot_id';" 2>/dev/null || echo "0")
  if [ "$HAS_CR_DISCORD_BOT_ID" = "1" ]; then
    sqlite3 "$DB_PATH" "INSERT OR REPLACE INTO channel_routes (channel_jid, agent_id, trigger_pattern, requires_trigger, discord_bot_id, created_at) VALUES ('$JID', '$FOLDER', '$TRIGGER', $REQUIRES_TRIGGER_INT, NULLIF('$DISCORD_BOT_ID',''), '$TIMESTAMP');"
  else
    sqlite3 "$DB_PATH" "INSERT OR REPLACE INTO channel_routes (channel_jid, agent_id, trigger_pattern, requires_trigger, created_at) VALUES ('$JID', '$FOLDER', '$TRIGGER', $REQUIRES_TRIGGER_INT, '$TIMESTAMP');"
  fi

  if [ "$HAS_SUBSCRIPTIONS_TABLE" = "1" ]; then
    HAS_CS_DISCORD_BOT_ID=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM pragma_table_info('channel_subscriptions') WHERE name='discord_bot_id';" 2>/dev/null || echo "0")
    if [ "$HAS_CS_DISCORD_BOT_ID" = "1" ]; then
      sqlite3 "$DB_PATH" "INSERT OR REPLACE INTO channel_subscriptions (channel_jid, agent_id, trigger_pattern, requires_trigger, priority, is_primary, discord_bot_id, created_at) VALUES ('$JID', '$FOLDER', '$TRIGGER', $REQUIRES_TRIGGER_INT, 100, 1, NULLIF('$DISCORD_BOT_ID',''), '$TIMESTAMP');"
    else
      sqlite3 "$DB_PATH" "INSERT OR REPLACE INTO channel_subscriptions (channel_jid, agent_id, trigger_pattern, requires_trigger, priority, is_primary, created_at) VALUES ('$JID', '$FOLDER', '$TRIGGER', $REQUIRES_TRIGGER_INT, 100, 1, '$TIMESTAMP');"
    fi
  fi

  log "Upserted agents/channel_routes entries"
fi

# Create group folders
mkdir -p "$PROJECT_ROOT/groups/$FOLDER/logs"
log "Created groups/$FOLDER/logs/"

# Update assistant name in CLAUDE.md files if different from default
NAME_UPDATED="false"
if [ "$ASSISTANT_NAME" != "Andy" ]; then
  log "Updating assistant name from Andy to $ASSISTANT_NAME"

  for md_file in groups/global/CLAUDE.md groups/main/CLAUDE.md; do
    if [ -f "$PROJECT_ROOT/$md_file" ]; then
      sed -i '' "s/^# Andy$/# $ASSISTANT_NAME/" "$PROJECT_ROOT/$md_file"
      sed -i '' "s/You are Andy/You are $ASSISTANT_NAME/g" "$PROJECT_ROOT/$md_file"
      log "Updated $md_file"
    else
      log "WARNING: $md_file not found, skipping name update"
    fi
  done

  # Add ASSISTANT_NAME to .env so config.ts picks it up
  ENV_FILE="$PROJECT_ROOT/.env"
  if [ -f "$ENV_FILE" ] && grep -q '^ASSISTANT_NAME=' "$ENV_FILE"; then
    sed "s|^ASSISTANT_NAME=.*|ASSISTANT_NAME=\"$ASSISTANT_NAME\"|" "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    echo "ASSISTANT_NAME=\"$ASSISTANT_NAME\"" >> "$ENV_FILE"
  fi
  log "Set ASSISTANT_NAME=$ASSISTANT_NAME in .env"

  NAME_UPDATED="true"
fi

cat <<EOF
=== OMNICLAW SETUP: REGISTER_CHANNEL ===
JID: $JID
NAME: $NAME
FOLDER: $FOLDER
TRIGGER: $TRIGGER
REQUIRES_TRIGGER: $REQUIRES_TRIGGER
ASSISTANT_NAME: $ASSISTANT_NAME
DISCORD_BOT_ID: $DISCORD_BOT_ID
AGENT_RUNTIME: $AGENT_RUNTIME
NAME_UPDATED: $NAME_UPDATED
STATUS: success
LOG: logs/setup.log
=== END ===
EOF
