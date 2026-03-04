#!/bin/bash
set -e

# When running as host uid (--user 501:20), there's no /etc/passwd entry.
# Many tools (claude, git, ssh-keygen) need to resolve the current user.
if ! id -un &>/dev/null 2>&1; then
  echo "omniclaw:x:$(id -u):$(id -g):OmniClaw Agent:${HOME:-/home/bun}:/bin/bash" >> /etc/passwd
fi

# Source environment variables from mounted env file
[ -f /workspace/env-dir/env ] && export $(cat /workspace/env-dir/env | xargs)

# Cap JS heap to prevent OOM
export NODE_OPTIONS="--max-old-space-size=2048"

# Cap Go heap for tsgo (TypeScript native compiler) — Go doesn't auto-detect
# container memory limits, so without this tsgo allocates unbounded memory and hangs.
# Set to 75% of available RAM, leaving headroom for OS + other processes.
# See: https://github.com/microsoft/typescript-go/issues/2125
TOTAL_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
export GOMEMLIMIT=$(( TOTAL_KB * 3 / 4 / 1024 ))MiB

# Configure git with GitHub token
if [ -n "$GITHUB_TOKEN" ]; then
  gh auth setup-git 2>/dev/null || true
  git config --global user.name "${GIT_AUTHOR_NAME:-OmniClaw Agent}"
  git config --global user.email "${GIT_AUTHOR_EMAIL:-omniclaw@users.noreply.github.com}"

  # Authenticate Graphite CLI if available and not already authenticated
  if command -v gt &> /dev/null; then
    if ! gt auth status &> /dev/null; then
      gt auth --token "$GITHUB_TOKEN" 2>/dev/null || true
    fi
  fi
fi

# SSH key setup: use workspace-persisted key or generate a new one
mkdir -p ~/.ssh
if [ -f /workspace/group/.ssh/id_ed25519 ]; then
  # Persistent key from previous container run
  cp /workspace/group/.ssh/id_ed25519 ~/.ssh/id_ed25519
  chmod 600 ~/.ssh/id_ed25519
else
  # Generate a new key for this agent
  ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -q
  # Persist to workspace so it survives container restarts
  mkdir -p /workspace/group/.ssh
  cp ~/.ssh/id_ed25519 /workspace/group/.ssh/id_ed25519
  cp ~/.ssh/id_ed25519.pub /workspace/group/.ssh/id_ed25519.pub
  chmod 600 /workspace/group/.ssh/id_ed25519
  # Notify host via IPC that a new key was generated
  PUBKEY=$(cat ~/.ssh/id_ed25519.pub)
  echo "{\"type\":\"ssh_pubkey\",\"pubkey\":\"$PUBKEY\"}" > /workspace/ipc/messages/ssh_pubkey_$(date +%s%N).json
fi
ssh-keyscan github.com gitlab.com >> ~/.ssh/known_hosts 2>/dev/null || true

# Buffer stdin then run agent.
# If /tmp/input.json already exists, skip the stdin buffering step.
# Apple Container requires EOF to flush stdin pipe.
if [ ! -s /tmp/input.json ]; then
  cat > /tmp/input.json
fi
bun /app/src/index.ts < /tmp/input.json
