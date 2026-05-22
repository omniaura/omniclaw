#!/usr/bin/env bash
# Clean up stopped docker containers, dangling images, unused volumes,
# and (optionally) the buildkit builder cache.
#
# OmniClaw runs on Docker (OrbStack on macOS) only. Apple Container was removed.
set -euo pipefail

CMD="${CONTAINER_CMD:-docker}"
if [ "$CMD" != "docker" ]; then
  echo "Warning: CONTAINER_CMD=$CMD is no longer supported. Using 'docker'."
  CMD="docker"
fi

FLUSH_BUILDER=false

for arg in "$@"; do
  case "$arg" in
    --flush-builder) FLUSH_BUILDER=true ;;
    -h|--help)
      echo "Usage: $0 [--flush-builder]"
      echo "  --flush-builder  Also flush the buildkit cache (docker builder prune -af)"
      exit 0
      ;;
  esac
done

echo "=== Docker disk usage (before) ==="
$CMD system df
echo

# 1. Remove stopped containers
echo "--- Pruning stopped containers ---"
$CMD container prune -f
echo

# 2. Remove dangling images
echo "--- Pruning dangling images ---"
$CMD image prune -f
echo

# 3. Remove unused volumes
echo "--- Pruning unused volumes ---"
$CMD volume prune -f
echo

# 4. Optionally flush buildkit cache
if $FLUSH_BUILDER; then
  echo "--- Flushing buildkit builder cache ---"
  $CMD builder prune -af
  echo "Builder cache flushed."
  echo
fi

echo "=== Docker disk usage (after) ==="
$CMD system df
