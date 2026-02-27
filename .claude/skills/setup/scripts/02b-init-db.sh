#!/bin/bash
set -euo pipefail

# 02b-init-db.sh — Ensure SQLite schema/migrations are applied

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"
DB_PATH="$PROJECT_ROOT/store/messages.db"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [init-db] $*" >> "$LOG_FILE"; }

cd "$PROJECT_ROOT"
log "Initializing database schema/migrations"

if bun -e "import { initDatabase } from './src/db.ts'; initDatabase();" >> "$LOG_FILE" 2>&1; then
  log "Database init completed"
else
  log "Database init failed"
  cat <<EOF
=== OMNICLAW SETUP: INIT_DB ===
DB_PATH: store/messages.db
SCHEMA_READY: false
SUBSCRIPTIONS_TABLE: unknown
STATUS: failed
ERROR: init_database_failed
LOG: logs/setup.log
=== END ===
EOF
  exit 1
fi

SCHEMA_READY="false"
SUBSCRIPTIONS_TABLE="false"

if [ -f "$DB_PATH" ]; then
  SCHEMA_READY="true"
  HAS_SUBSCRIPTIONS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='channel_subscriptions';" 2>/dev/null || echo "0")
  if [ "$HAS_SUBSCRIPTIONS" = "1" ]; then
    SUBSCRIPTIONS_TABLE="true"
  fi
fi

cat <<EOF
=== OMNICLAW SETUP: INIT_DB ===
DB_PATH: store/messages.db
SCHEMA_READY: $SCHEMA_READY
SUBSCRIPTIONS_TABLE: $SUBSCRIPTIONS_TABLE
STATUS: success
LOG: logs/setup.log
=== END ===
EOF
