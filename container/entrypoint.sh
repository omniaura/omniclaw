#!/bin/bash
set -e

# When running as host uid (--user 501:20), there's no /etc/passwd entry.
# Many tools (claude, git, ssh-keygen) need to resolve the current user.
if ! id -un &>/dev/null 2>&1; then
  echo "omniclaw:x:$(id -u):$(id -g):OmniClaw Agent:${HOME:-/home/bun}:/bin/bash" >> /etc/passwd
fi

# Source environment variables from mounted env file
if [ -f /workspace/env-dir/env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    export "$line"
  done < /workspace/env-dir/env
fi

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

# SSH key setup: deterministic from SSH_KEY_SEED, workspace-persisted, or random
mkdir -p ~/.ssh
AGENT_FOLDER=$(basename /workspace/group)

generate_deterministic_key() {
  # Derive a deterministic ed25519 key from SSH_KEY_SEED + agent folder name.
  # HMAC-SHA256(seed, folder) → 32-byte seed → ed25519 keypair.
  # Same seed + folder always produces the same key across rebuilds.
  node -e "
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const seed = crypto.createHmac('sha256', process.env.SSH_KEY_SEED)
  .update('$AGENT_FOLDER')
  .digest();

// Create ed25519 key from deterministic seed
const key = crypto.createPrivateKey({
  key: Buffer.concat([
    // PKCS#8 DER prefix for ed25519 (16 bytes) + 34 bytes (04 20 + 32-byte seed)
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed
  ]),
  format: 'der',
  type: 'pkcs8',
});

const privPem = key.export({ type: 'pkcs8', format: 'pem' });
const pubKey = crypto.createPublicKey(key);
const pubSsh = pubKey.export({ type: 'spki', format: 'der' });

// Convert public key to OpenSSH format
const keyType = Buffer.from('ssh-ed25519');
const rawPub = pubSsh.subarray(-32); // last 32 bytes = raw ed25519 public key
const typeLen = Buffer.alloc(4); typeLen.writeUInt32BE(keyType.length);
const pubLen = Buffer.alloc(4); pubLen.writeUInt32BE(rawPub.length);
const sshPub = 'ssh-ed25519 ' + Buffer.concat([typeLen, keyType, pubLen, rawPub]).toString('base64') + ' omniclaw-$AGENT_FOLDER';

// Write OpenSSH private key format
const home = process.env.HOME || '/home/bun';

// Use ssh-keygen to convert PKCS#8 PEM to OpenSSH format
fs.writeFileSync(home + '/.ssh/id_ed25519.pem', privPem, { mode: 0o600 });
fs.writeFileSync(home + '/.ssh/id_ed25519.pub', sshPub + '\n', { mode: 0o644 });
" && ssh-keygen -p -N "" -m pem -f ~/.ssh/id_ed25519.pem -q 2>/dev/null && mv ~/.ssh/id_ed25519.pem ~/.ssh/id_ed25519 || {
    # Fallback: ssh-keygen conversion failed, try direct approach
    rm -f ~/.ssh/id_ed25519.pem
    return 1
  }
  chmod 600 ~/.ssh/id_ed25519
}

if [ -n "$SSH_KEY_SEED" ]; then
  if generate_deterministic_key; then
    # Persist to workspace
    mkdir -p /workspace/group/.ssh
    cp ~/.ssh/id_ed25519 /workspace/group/.ssh/id_ed25519
    cp ~/.ssh/id_ed25519.pub /workspace/group/.ssh/id_ed25519.pub
    chmod 600 /workspace/group/.ssh/id_ed25519
  elif [ -f /workspace/group/.ssh/id_ed25519 ]; then
    # Deterministic generation failed, fall back to persisted key
    cp /workspace/group/.ssh/id_ed25519 ~/.ssh/id_ed25519
    chmod 600 ~/.ssh/id_ed25519
  else
    # Last resort: random key
    ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -q
    mkdir -p /workspace/group/.ssh
    cp ~/.ssh/id_ed25519 /workspace/group/.ssh/id_ed25519
    cp ~/.ssh/id_ed25519.pub /workspace/group/.ssh/id_ed25519.pub
    chmod 600 /workspace/group/.ssh/id_ed25519
    PUBKEY=$(cat ~/.ssh/id_ed25519.pub)
    echo "{\"type\":\"ssh_pubkey\",\"pubkey\":\"$PUBKEY\"}" > /workspace/ipc/messages/ssh_pubkey_$(date +%s%N).json
  fi
elif [ -f /workspace/group/.ssh/id_ed25519 ]; then
  # Persistent key from previous container run
  cp /workspace/group/.ssh/id_ed25519 ~/.ssh/id_ed25519
  chmod 600 ~/.ssh/id_ed25519
else
  # Generate a new random key for this agent
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
