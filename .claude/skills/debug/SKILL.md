---
name: debug
description: Debug container agent issues. Use when things aren't working, container fails, authentication problems, or to understand how the container system works. Covers logs, environment variables, mounts, and common issues.
---

# OmniClaw Container Debugging

This guide covers debugging the containerized agent execution system.

## Architecture Overview

```
Host (macOS / Linux)                  Container (Linux VM / Docker)
─────────────────────────────────────────────────────────────────
src/backends/local-backend.ts          container/agent-runner/
    │                                      │
    │ spawns container via backend         │ runs Claude Agent SDK
    │ with volume mounts                   │ with MCP servers
    │                                      │
    ├── data/env/env ──────────────> /workspace/env-dir/env
    ├── groups/{folder} ───────────> /workspace/group
    ├── data/ipc/{folder} ────────> /workspace/ipc
    ├── data/sessions/{folder}/.claude/ ──> /home/node/.claude/ (isolated per-group)
    └── (main only) project root ──> /workspace/project
```

**Important:** The container runs as user `node` with `HOME=/home/node`. Session files must be mounted to `/home/node/.claude/` (not `/root/.claude/`) for session resumption to work.

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| **Main app logs** | `logs/omniclaw.log` | Host-side messaging, routing, container spawning |
| **Main app errors** | `logs/omniclaw.error.log` | Host-side errors |
| **Container run logs** | `groups/{folder}/logs/container-*.log` | Per-run: input, mounts, stderr, stdout |
| **Claude sessions** | `~/.claude/projects/` | Claude Code session history |

## Enabling Debug Logging

Set `LOG_LEVEL=debug` for verbose output:

```bash
# For development
LOG_LEVEL=debug bun run dev

# For systemd service (Linux), add to unit override:
systemctl --user edit omniclaw
# Add: Environment=LOG_LEVEL=debug

# For launchd service (macOS), add to plist EnvironmentVariables:
# <key>LOG_LEVEL</key>
# <string>debug</string>
```

Debug level shows:
- Full mount configurations
- Container command arguments
- Real-time container stderr

## Common Issues

### 1. "Claude Code process exited with code 1"

**Check the container log file** in `groups/{folder}/logs/container-*.log`

Common causes:

#### Missing Authentication
```
Invalid API key · Please run /login
```
**Fix:** Ensure `.env` file exists with either OAuth token or API key:
```bash
# Should show one of:
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...  (subscription)
# ANTHROPIC_API_KEY=sk-ant-api03-...        (pay-per-use)
```

#### Root User Restriction
```
--dangerously-skip-permissions cannot be used with root/sudo privileges
```
**Fix:** Container must run as non-root user. Check Dockerfile has `USER node`.

### 2. Environment Variables Not Passing

The system extracts only authentication variables (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) from `.env` and mounts them for sourcing inside the container.

To verify env vars are reaching the container:
```bash
# Docker
docker run --rm \
  -v $(pwd)/data/env:/workspace/env-dir:ro \
  --entrypoint /bin/bash omniclaw-agent:latest \
  -c 'export $(cat /workspace/env-dir/env | xargs); echo "OAuth: ${#CLAUDE_CODE_OAUTH_TOKEN} chars, API: ${#ANTHROPIC_API_KEY} chars"'

# Apple Container
echo '{}' | container run -i \
  --mount type=bind,source=$(pwd)/data/env,target=/workspace/env-dir,readonly \
  --entrypoint /bin/bash omniclaw-agent:latest \
  -c 'export $(cat /workspace/env-dir/env | xargs); echo "OAuth: ${#CLAUDE_CODE_OAUTH_TOKEN} chars, API: ${#ANTHROPIC_API_KEY} chars"'
```

### 3. Mount Issues

To check what's mounted inside a container:
```bash
# Docker
docker run --rm --entrypoint /bin/bash omniclaw-agent:latest -c 'ls -la /workspace/'

# Apple Container (quirks: only mounts directories, -v doesn't support :ro)
container run --rm --entrypoint /bin/bash omniclaw-agent:latest -c 'ls -la /workspace/'
```

Expected structure:
```
/workspace/
├── env-dir/env           # Environment file (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)
├── group/                # Current group folder (cwd)
├── project/              # Project root (main channel only)
├── global/               # Global CLAUDE.md (non-main only)
├── ipc/                  # Inter-process communication
│   ├── messages/         # Outgoing messages
│   ├── tasks/            # Scheduled task commands
│   ├── current_tasks.json    # Read-only: scheduled tasks visible to this group
│   └── available_groups.json # Read-only: groups for activation (main only)
└── extra/                # Additional custom mounts
```

### 4. Permission Issues

The container runs as user `node` (uid 1000). All of `/workspace/` and `/app/` should be owned by `node`.

### 5. Session Not Resuming / "Claude Code process exited with code 1"

**Root cause:** The SDK looks for sessions at `$HOME/.claude/projects/`. Inside the container, `HOME=/home/node`, so it looks at `/home/node/.claude/projects/`.

**Fix:** Ensure `local-backend.ts` mounts to `/home/node/.claude/`:
```typescript
mounts.push({
  hostPath: claudeDir,
  containerPath: '/home/node/.claude',  // NOT /root/.claude
  readonly: false
});
```

### 6. Service Stops After SSH Disconnect (Linux)

Systemd user services are killed when the last login session ends unless lingering is enabled.

**Diagnose:**
```bash
loginctl show-user $(whoami) | grep Linger
# Linger=no means services die on logout
```

**Fix:**
```bash
loginctl enable-linger $(whoami)
```

This persists across reboots. The setup script (step 10) enables this automatically. If it fails with a permissions error, sudo or a polkit rule may be needed.

### 7. MCP Server Failures

If an MCP server fails to start, the agent may exit. Check the container logs for MCP initialization errors.

## Service Management

```bash
# Check status
launchctl list | grep omniclaw                    # macOS
systemctl --user status omniclaw                  # Linux

# Restart
launchctl kickstart -k gui/$(id -u)/com.omniclaw  # macOS
systemctl --user restart omniclaw                  # Linux

# Stop
launchctl bootout gui/$(id -u)/com.omniclaw                  # macOS
systemctl --user stop omniclaw                                # Linux

# View live logs
tail -f logs/omniclaw.log

# Check running agent containers
docker ps --filter name=omniclaw                  # Docker
launchctl list | grep 'container-runtime-linux.omniclaw'  # Apple Container

# Rebuild after code changes
bun run build
# Then restart service (see above)
```

## Manual Container Testing

### Test the full agent flow:
```bash
# Set up env file
mkdir -p data/env groups/test

# Run test query (Docker)
echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | \
  docker run -i --rm \
  -v $(pwd)/data/env:/workspace/env-dir:ro \
  -v $(pwd)/groups/test:/workspace/group \
  -v $(pwd)/data/ipc:/workspace/ipc \
  omniclaw-agent:latest
```

### Interactive shell in container:
```bash
docker run --rm -it --entrypoint /bin/bash omniclaw-agent:latest   # Docker
container run --rm -it --entrypoint /bin/bash omniclaw-agent:latest  # Apple Container
```

## SDK Options Reference

The agent-runner uses these Claude Agent SDK options:

```typescript
query({
  prompt: input.prompt,
  options: {
    cwd: '/workspace/group',
    allowedTools: ['Bash', 'Read', 'Write', ...],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,  // Required with bypassPermissions
    settingSources: ['project'],
    mcpServers: { ... }
  }
})
```

**Important:** `allowDangerouslySkipPermissions: true` is required when using `permissionMode: 'bypassPermissions'`. Without it, Claude Code exits with code 1.

## Rebuilding After Changes

```bash
# Rebuild main app
bun run build

# Rebuild container
./container/build.sh

# Force clean rebuild (Docker)
docker builder prune -f && ./container/build.sh

# Force clean rebuild (Apple Container — flush builder cache)
container builder stop && container builder rm && container builder start
./container/build.sh
```

## Session Persistence

Claude sessions are stored per-group in `data/sessions/{group}/.claude/` for security isolation.

**Critical:** The mount path must match the container user's HOME directory:
- Container user: `node`
- Container HOME: `/home/node`
- Mount target: `/home/node/.claude/` (NOT `/root/.claude/`)

To clear sessions:

```bash
# Clear all sessions for all groups
rm -rf data/sessions/

# Clear sessions for a specific group
rm -rf data/sessions/{groupFolder}/.claude/

# Also clear the session ID from OmniClaw's tracking (stored in SQLite)
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = '{groupFolder}'"
```

## Discord Multi-Bot Routing

### Internal bot key vs Discord snowflake ID

OmniClaw uses **two completely different identifiers** for Discord bots — they must not be confused:

| Identifier | Where it lives | Example | Used for |
|---|---|---|---|
| **Internal bot key** | `DISCORD_BOT_IDS` in `.env` | `PRIMARY`, `OCPEYTON` | OmniClaw routing |
| **Discord snowflake ID** | Discord Developer Portal → App → General | `1476396931709276191` | Discord's own API |

The internal bot key must match exactly across:
- `DISCORD_BOT_IDS=PRIMARY,OCPEYTON`
- `DISCORD_BOT_<KEY>_TOKEN=<token>` (e.g., `DISCORD_BOT_OCPEYTON_TOKEN`)
- `channel_subscriptions.discord_bot_id` in SQLite

**Common mistake:** Using the numeric Discord snowflake ID in `channel_subscriptions.discord_bot_id` instead of the human-readable key. This breaks routing silently.

### Diagnosing wrong-bot-sending issues

```bash
# Check what keys are configured in env
grep DISCORD_BOT_IDS .env

# Check what's stored in the DB (should match keys above, NOT numeric IDs)
sqlite3 store/messages.db "SELECT DISTINCT discord_bot_id FROM channel_subscriptions WHERE discord_bot_id IS NOT NULL"

# Fix if DB contains numeric IDs instead of keys
sqlite3 store/messages.db "UPDATE channel_subscriptions SET discord_bot_id = 'OCPEYTON' WHERE discord_bot_id = '1476396931709276191'"
```

## IPC Debugging

```bash
# Check pending messages
ls -la data/ipc/messages/

# Check pending task operations
ls -la data/ipc/tasks/

# Check available groups (main channel only)
cat data/ipc/main/available_groups.json

# Check current tasks snapshot
cat data/ipc/{groupFolder}/current_tasks.json
```

## Quick Diagnostic Script

```bash
echo "=== OmniClaw Diagnostic ==="

echo -e "\n1. Service running?"
if command -v systemctl &>/dev/null; then
  systemctl --user is-active omniclaw 2>/dev/null && echo "OK (systemd)" || echo "NOT RUNNING"
  echo -n "   Linger: "; loginctl show-user $(whoami) 2>/dev/null | grep Linger || echo "unknown"
elif command -v launchctl &>/dev/null; then
  launchctl list 2>/dev/null | grep -q com.omniclaw && echo "OK (launchd)" || echo "NOT RUNNING"
fi

echo -e "\n2. Authentication configured?"
[ -f .env ] && (grep -q "CLAUDE_CODE_OAUTH_TOKEN=sk-" .env || grep -q "ANTHROPIC_API_KEY=sk-" .env) && echo "OK" || echo "MISSING"

echo -e "\n3. Container runtime?"
if command -v docker &>/dev/null; then
  docker info &>/dev/null && echo "OK (Docker)" || echo "Docker installed but not running"
elif command -v container &>/dev/null; then
  container system status &>/dev/null && echo "OK (Apple Container)" || echo "Apple Container not running"
else
  echo "No container runtime found"
fi

echo -e "\n4. Container image?"
docker images omniclaw-agent:latest --format "OK ({{.Size}})" 2>/dev/null || \
  (echo '{}' | container run -i --entrypoint /bin/echo omniclaw-agent:latest "OK" 2>/dev/null) || \
  echo "MISSING — run ./container/build.sh"

echo -e "\n5. Recent errors?"
grep -E '"level":"error"' logs/omniclaw.log 2>/dev/null | tail -3 || echo "No error log"

echo -e "\n6. Groups loaded?"
grep 'groupCount' logs/omniclaw.log 2>/dev/null | tail -1 || echo "No log data"
```
