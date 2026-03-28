#!/usr/bin/env bash
# Clean up stopped Apple Containers, dangling images, unused volumes,
# and (optionally) the buildkit builder cache.
set -euo pipefail

CMD="${CONTAINER_CMD:-$(command -v container 2>/dev/null || echo docker)}"
FLUSH_BUILDER=false

for arg in "$@"; do
  case "$arg" in
    --flush-builder) FLUSH_BUILDER=true ;;
    -h|--help)
      echo "Usage: $0 [--flush-builder]"
      echo "  --flush-builder  Also flush the buildkit cache (stop/rm/start builder)"
      exit 0
      ;;
  esac
done

echo "=== Container disk usage (before) ==="
$CMD system df
echo

# 1. Remove stopped containers
echo "--- Pruning stopped containers ---"
$CMD prune
echo

# 2. Remove dangling images
echo "--- Pruning dangling images ---"
$CMD image prune
echo

# 3. Remove unused volumes
echo "--- Pruning unused volumes ---"
$CMD volume prune
echo

# 4. Optionally flush buildkit cache
if $FLUSH_BUILDER; then
  echo "--- Flushing buildkit builder cache ---"
  $CMD builder stop 2>/dev/null || true
  $CMD builder rm 2>/dev/null || true
  $CMD builder start
  echo "Builder cache flushed and restarted."
  echo
fi

echo "=== Container disk usage (after) ==="
$CMD system df
