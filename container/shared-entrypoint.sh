#!/bin/bash.real
set -e

# Shared Claude VM entrypoint — minimal setup, sleeps forever.
# Individual agent processes are started via `container exec` using agent-exec.sh.

# When running as host uid (--user 501:20), there's no /etc/passwd entry.
if ! id -un &>/dev/null 2>&1; then
  echo "omniclaw:x:$(id -u):$(id -g):OmniClaw Agent:${HOME:-/home/bun}:/bin/bash" >> /etc/passwd
fi

# Cap JS heap to prevent OOM (inherited by exec'd processes)
export NODE_OPTIONS="--max-old-space-size=2048"

# Cap Go heap for tsgo — Go doesn't auto-detect container memory limits.
TOTAL_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
export GOMEMLIMIT=$(( TOTAL_KB * 3 / 4 / 1024 ))MiB

echo "Shared Claude VM ready (PID $$)"
while true; do sleep 3600; done
