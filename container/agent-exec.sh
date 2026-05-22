#!/bin/bash
set -e

# Per-agent exec wrapper for shared Claude VM.
# Invoked via: docker exec -i -e AGENT_WORKSPACE=... -e AGENT_IPC_DIR=... <vm> /app/agent-exec.sh
#
# Note: the shared VM mode is currently disabled because it was Apple-Container-
# only; this script is retained for future shared-VM-on-docker work.
#
# Expects these env vars (set by docker exec -e):
#   AGENT_WORKSPACE   - e.g. /workspace/groups/main
#   AGENT_IPC_DIR     - e.g. /data/ipc/main
#   AGENT_SESSION_DIR - e.g. /data/sessions/main/.claude
#   AGENT_ENV_DIR     - e.g. /data/env/main
#   AGENT_GLOBAL_DIR  - e.g. /workspace/groups/global
#   AGENT_CONTEXT_DIR - e.g. /workspace/groups/agent-context-folder (optional)
#   AGENT_CATEGORY_DIR - (optional)
#   AGENT_SERVER_DIR  - (optional)
#   AGENT_PROJECT_DIR - e.g. /workspace/project

# Shared-VM execs must always receive isolated per-agent paths.
: "${AGENT_WORKSPACE:?AGENT_WORKSPACE is required}"
: "${AGENT_IPC_DIR:?AGENT_IPC_DIR is required}"
: "${AGENT_SESSION_DIR:?AGENT_SESSION_DIR is required}"

# Source per-agent environment variables
if [ -n "$AGENT_ENV_DIR" ] && [ -f "$AGENT_ENV_DIR/env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    export "$line"
  done < "$AGENT_ENV_DIR/env"
fi

# Normalize GitHub auth env so both gh CLI aliases work
if [ -n "$GH_TOKEN" ] && [ -z "$GITHUB_TOKEN" ]; then
  export GITHUB_TOKEN="$GH_TOKEN"
elif [ -n "$GITHUB_TOKEN" ] && [ -z "$GH_TOKEN" ]; then
  export GH_TOKEN="$GITHUB_TOKEN"
fi

# Configure git with GitHub token
if [ -n "$GITHUB_TOKEN" ]; then
  gh auth setup-git 2>/dev/null || true
  git config --global user.name "${GIT_AUTHOR_NAME:-OmniClaw Agent}"
  git config --global user.email "${GIT_AUTHOR_EMAIL:-omniclaw@users.noreply.github.com}"

  if command -v gt &> /dev/null; then
    if ! gt auth status &> /dev/null; then
      gt auth --token "$GITHUB_TOKEN" 2>/dev/null || true
    fi
  fi
fi

# Set HOME to per-agent session dir's parent so .claude/ lands correctly
HOME="$(dirname "$AGENT_SESSION_DIR")"
export HOME

# SSH key setup: use workspace-persisted key or generate new
AGENT_FOLDER=$(basename "$AGENT_WORKSPACE")
mkdir -p ~/.ssh

generate_deterministic_key() {
  node -e "
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const seed = crypto.createHmac('sha256', process.env.SSH_KEY_SEED)
  .update('$AGENT_FOLDER')
  .digest();

const key = crypto.createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed
  ]),
  format: 'der',
  type: 'pkcs8',
});

const privPem = key.export({ type: 'pkcs8', format: 'pem' });
const pubKey = crypto.createPublicKey(key);
const pubSsh = pubKey.export({ type: 'spki', format: 'der' });

const keyType = Buffer.from('ssh-ed25519');
const rawPub = pubSsh.subarray(-32);
const typeLen = Buffer.alloc(4); typeLen.writeUInt32BE(keyType.length);
const pubLen = Buffer.alloc(4); pubLen.writeUInt32BE(rawPub.length);
const sshPub = 'ssh-ed25519 ' + Buffer.concat([typeLen, keyType, pubLen, rawPub]).toString('base64') + ' omniclaw-$AGENT_FOLDER';

const home = process.env.HOME || '/home/bun';

fs.writeFileSync(home + '/.ssh/id_ed25519.pem', privPem, { mode: 0o600 });
fs.writeFileSync(home + '/.ssh/id_ed25519.pub', sshPub + '\n', { mode: 0o644 });
" && ssh-keygen -p -N "" -m pem -f ~/.ssh/id_ed25519.pem -q 2>/dev/null && mv ~/.ssh/id_ed25519.pem ~/.ssh/id_ed25519 || {
    rm -f ~/.ssh/id_ed25519.pem
    return 1
  }
  chmod 600 ~/.ssh/id_ed25519
}

WORKSPACE="$AGENT_WORKSPACE"
IPC_DIR="$AGENT_IPC_DIR"
mkdir -p "$IPC_DIR/messages"

if [ -n "$SSH_KEY_SEED" ]; then
  if generate_deterministic_key; then
    mkdir -p "$WORKSPACE/.ssh"
    cp ~/.ssh/id_ed25519 "$WORKSPACE/.ssh/id_ed25519"
    cp ~/.ssh/id_ed25519.pub "$WORKSPACE/.ssh/id_ed25519.pub"
    chmod 600 "$WORKSPACE/.ssh/id_ed25519"
  elif [ -f "$WORKSPACE/.ssh/id_ed25519" ]; then
    cp "$WORKSPACE/.ssh/id_ed25519" ~/.ssh/id_ed25519
    chmod 600 ~/.ssh/id_ed25519
  else
    ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -q
    mkdir -p "$WORKSPACE/.ssh"
    cp ~/.ssh/id_ed25519 "$WORKSPACE/.ssh/id_ed25519"
    cp ~/.ssh/id_ed25519.pub "$WORKSPACE/.ssh/id_ed25519.pub"
    chmod 600 "$WORKSPACE/.ssh/id_ed25519"
    PUBKEY=$(cat ~/.ssh/id_ed25519.pub)
    echo "{\"type\":\"ssh_pubkey\",\"pubkey\":\"$PUBKEY\"}" > "$IPC_DIR/messages/ssh_pubkey_$(date +%s%N).json"
  fi
elif [ -f "$WORKSPACE/.ssh/id_ed25519" ]; then
  cp "$WORKSPACE/.ssh/id_ed25519" ~/.ssh/id_ed25519
  chmod 600 ~/.ssh/id_ed25519
else
  ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -q
  mkdir -p "$WORKSPACE/.ssh"
  cp ~/.ssh/id_ed25519 "$WORKSPACE/.ssh/id_ed25519"
  cp ~/.ssh/id_ed25519.pub "$WORKSPACE/.ssh/id_ed25519.pub"
  chmod 600 "$WORKSPACE/.ssh/id_ed25519"
  PUBKEY=$(cat ~/.ssh/id_ed25519.pub)
  echo "{\"type\":\"ssh_pubkey\",\"pubkey\":\"$PUBKEY\"}" > "$IPC_DIR/messages/ssh_pubkey_$(date +%s%N).json"
fi
ssh-keyscan github.com gitlab.com >> ~/.ssh/known_hosts 2>/dev/null || true

# Buffer stdin then run agent (per-agent temp file to avoid conflicts in shared VM)
INPUT_FILE="/tmp/input-$$.json"
trap 'rm -f "$INPUT_FILE"' EXIT
cat > "$INPUT_FILE"
cd "$AGENT_WORKSPACE"
bun /app/src/index.ts < "$INPUT_FILE"
