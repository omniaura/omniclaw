#!/bin/bash
set -euo pipefail

# 03-setup-container.sh — Build the agent container image with Docker (OrbStack on macOS)
#
# OmniClaw runs agents in Docker. On macOS we use OrbStack (Apple-Silicon native,
# lightweight, Docker-CLI-compatible). Apple Container was removed because it
# caused kernel panics on macOS 26 and was otherwise unreliable.
#
# Usage: 03-setup-container.sh [--runtime docker]
#   --runtime is optional and only accepts 'docker'. The flag is preserved for
#   backwards compatibility with older fresh-install runs that passed it.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [setup-container] $*" >> "$LOG_FILE"; }

# Parse args — accept --runtime for backwards compat, but enforce docker.
RUNTIME="docker"
while [[ $# -gt 0 ]]; do
  case $1 in
    --runtime)
      if [ -n "${2:-}" ] && [ "$2" != "docker" ]; then
        log "WARNING: --runtime=$2 ignored; OmniClaw is docker-only since OrbStack migration"
      fi
      shift 2
      ;;
    *) shift ;;
  esac
done

IMAGE="omniclaw-agent:latest"

# Verify docker is reachable. On macOS, this requires OrbStack.app to have been
# launched at least once — after that it runs as a background service forever.
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  log "Docker not available — is OrbStack installed and launched at least once?"
  cat <<EOF
=== OMNICLAW SETUP: SETUP_CONTAINER ===
RUNTIME: docker
IMAGE: $IMAGE
BUILD_OK: false
TEST_OK: false
STATUS: failed
ERROR: runtime_not_available
HINT: On macOS, install OrbStack (\`brew install --cask orbstack\`) and open OrbStack.app once. On Linux, \`sudo systemctl start docker\`.
LOG: logs/setup.log
=== END ===
EOF
  exit 2
fi

log "Building container with docker (OrbStack on macOS)"

# Build
BUILD_OK="false"
if (cd "$PROJECT_ROOT" && docker build -t "$IMAGE" -f container/Dockerfile .) >> "$LOG_FILE" 2>&1; then
  BUILD_OK="true"
  log "Container build succeeded"
else
  log "Container build failed"
  cat <<EOF
=== OMNICLAW SETUP: SETUP_CONTAINER ===
RUNTIME: docker
IMAGE: $IMAGE
BUILD_OK: false
TEST_OK: false
STATUS: failed
ERROR: build_failed
LOG: logs/setup.log
=== END ===
EOF
  exit 1
fi

# Test
TEST_OK="false"
log "Testing container with echo command"
TEST_OUTPUT=$(echo '{}' | docker run -i --rm --entrypoint /bin/echo "$IMAGE" "Container OK" 2>>"$LOG_FILE") || true
if echo "$TEST_OUTPUT" | grep -q "Container OK"; then
  TEST_OK="true"
  log "Container test passed"
else
  log "Container test failed: $TEST_OUTPUT"
fi

STATUS="success"
if [ "$BUILD_OK" = "false" ] || [ "$TEST_OK" = "false" ]; then
  STATUS="failed"
fi

cat <<EOF
=== OMNICLAW SETUP: SETUP_CONTAINER ===
RUNTIME: docker
IMAGE: $IMAGE
BUILD_OK: $BUILD_OK
TEST_OK: $TEST_OK
STATUS: $STATUS
LOG: logs/setup.log
=== END ===
EOF

if [ "$STATUS" = "failed" ]; then
  exit 1
fi
