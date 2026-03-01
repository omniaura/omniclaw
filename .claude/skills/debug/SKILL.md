---
name: debug
description: Debug container agent issues. Use when things aren't working, container fails, authentication problems, or to understand how the container system works. Covers logs, environment variables, mounts, and common issues.
---

# OmniClaw Container Debugging

This guide covers debugging the containerized agent execution system.

## Architecture Overview

```
Host (macOS)                          Container (Linux VM)
─────────────────────────────────────────────────────────────
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
| **Main app logs** | `logs/omniclaw.log` | Host-side WhatsApp, routing, container spawning |
| **Main app errors** | `logs/omniclaw.error.log` | Host-side errors |
| **Container run logs** | `groups/{folder}/logs/container-*.log` | Per-run: input, mounts, stderr, stdout |
| **Claude sessions** | `~/.claude/projects/` | Claude Code session history |

## Enabling Debug Logging

Set `LOG_LEVEL=debug` for verbose output:

```bash
# For development
LOG_LEVEL=debug npm run dev

# For launchd service, add to plist EnvironmentVariables:
<key>LOG_LEVEL</key>
<string>debug</string>
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
cat .env  # Should show one of:
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...  (subscription)
# ANTHROPIC_API_KEY=sk-ant-api03-...        (pay-per-use)
```

#### Root User Restriction
```
--dangerously-skip-permissions cannot be used with root/sudo privileges
```
**Fix:** Container must run as non-root user. Check Dockerfile has `USER node`.

### 2. Environment Variables Not Passing

**Apple Container Bug:** Environment variables passed via `-e` are lost when using `-i` (interactive/piped stdin).

**Workaround:** The system extracts only authentication variables (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) from `.env` and mounts them for sourcing inside the container. Other env vars are not exposed.

To verify env vars are reaching the container:
```bash
echo '{}' | container run -i \
  --mount type=bind,source=$(pwd)/data/env,target=/workspace/env-dir,readonly \
  --entrypoint /bin/bash omniclaw-agent:latest \
  -c 'export $(cat /workspace/env-dir/env | xargs); echo "OAuth: ${#CLAUDE_CODE_OAUTH_TOKEN} chars, API: ${#ANTHROPIC_API_KEY} chars"'
```

### 3. Mount Issues

**Apple Container quirks:**
- Only mounts directories, not individual files
- `-v` syntax does NOT support `:ro` suffix - use `--mount` for readonly:
  ```bash
  # Readonly: use --mount
  --mount "type=bind,source=/path,target=/container/path,readonly"

  # Read-write: use -v
  -v /path:/container/path
  ```

To check what's mounted inside a container:
```bash
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
│   ├── messages/         # Outgoing WhatsApp messages
│   ├── tasks/            # Scheduled task commands
│   ├── current_tasks.json    # Read-only: scheduled tasks visible to this group
│   └── available_groups.json # Read-only: WhatsApp groups for activation (main only)
└── extra/                # Additional custom mounts
```

### 4. Permission Issues

The container runs as user `node` (uid 1000). Check ownership:
```bash
container run --rm --entrypoint /bin/bash omniclaw-agent:latest -c '
  whoami
  ls -la /workspace/
  ls -la /app/
'
```

All of `/workspace/` and `/app/` should be owned by `node`.

### 5. Session Not Resuming / "Claude Code process exited with code 1"

If sessions aren't being resumed (new session ID every time), or Claude Code exits with code 1 when resuming:

**Root cause:** The SDK looks for sessions at `$HOME/.claude/projects/`. Inside the container, `HOME=/home/node`, so it looks at `/home/node/.claude/projects/`.

**Check the mount path:**
```bash
# In local-backend.ts, verify mount is to /home/node/.claude/, NOT /root/.claude/
grep -A3 "Claude sessions" src/backends/local-backend.ts
```

**Verify sessions are accessible:**
```bash
container run --rm --entrypoint /bin/bash \
  -v ~/.claude:/home/node/.claude \
  omniclaw-agent:latest -c '
echo "HOME=$HOME"
ls -la $HOME/.claude/projects/ 2>&1 | head -5
'
```

**Fix:** Ensure `local-backend.ts` mounts to `/home/node/.claude/`:
```typescript
mounts.push({
  hostPath: claudeDir,
  containerPath: '/home/node/.claude',  // NOT /root/.claude
  readonly: false
});
```

### 6. MCP Server Failures

If an MCP server fails to start, the agent may exit. Check the container logs for MCP initialization errors.

## Manual Container Testing

### Test the full agent flow:
```bash
# Set up env file
mkdir -p data/env groups/test
cp .env data/env/env

# Run test query
echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | \
  container run -i \
  --mount "type=bind,source=$(pwd)/data/env,target=/workspace/env-dir,readonly" \
  -v $(pwd)/groups/test:/workspace/group \
  -v $(pwd)/data/ipc:/workspace/ipc \
  omniclaw-agent:latest
```

### Test Claude Code directly:
```bash
container run --rm --entrypoint /bin/bash \
  --mount "type=bind,source=$(pwd)/data/env,target=/workspace/env-dir,readonly" \
  omniclaw-agent:latest -c '
  export $(cat /workspace/env-dir/env | xargs)
  claude -p "Say hello" --dangerously-skip-permissions --allowedTools ""
'
```

### Interactive shell in container:
```bash
container run --rm -it --entrypoint /bin/bash omniclaw-agent:latest
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
npm run build

# Rebuild container (use --no-cache for clean rebuild)
./container/build.sh

# Or force full rebuild
container builder prune -af
./container/build.sh
```

## Checking Container Image

```bash
# List images
container images

# Check what's in the image
container run --rm --entrypoint /bin/bash omniclaw-agent:latest -c '
  echo "=== Node version ==="
  node --version

  echo "=== Claude Code version ==="
  claude --version

  echo "=== Installed packages ==="
  ls /app/node_modules/
'
```

## Session Persistence

Claude sessions are stored per-group in `data/sessions/{group}/.claude/` for security isolation. Each group has its own session directory, preventing cross-group access to conversation history.

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

To verify session resumption is working, check the logs for the same session ID across messages:
```bash
grep "Session initialized" logs/omniclaw.log | tail -5
# Should show the SAME session ID for consecutive messages in the same group
```

## Discord Multi-Bot Routing

### Internal bot key vs Discord snowflake ID

OmniClaw uses **two completely different identifiers** for Discord bots — they must not be confused:

| Identifier | Where it lives | Example | Used for |
|---|---|---|---|
| **Internal bot key** | `DISCORD_BOT_IDS` in `.env` | `PRIMARY`, `OCPEYTON` | OmniClaw routing |
| **Discord snowflake ID** | Discord Developer Portal → App → General | `1476396931709276191` | Discord's own API |

The internal bot key is set by **you** when you configure `.env`. It must match exactly across:
- `DISCORD_BOT_IDS=PRIMARY,OCPEYTON`
- `DISCORD_BOT_<KEY>_TOKEN=<token>` (e.g., `DISCORD_BOT_OCPEYTON_TOKEN`)
- `channel_subscriptions.discord_bot_id` in SQLite

The Discord snowflake ID is **never stored in OmniClaw's DB** and is never used for routing. It only appears in Discord API responses.

**Common mistake:** Looking up the bot's numeric ID in the Discord Developer Portal and writing it into `channel_subscriptions.discord_bot_id`. This breaks routing silently — `findChannelForJid` won't match any bot and falls back to the default, so the wrong bot sends all messages.

### Diagnosing wrong-bot-sending issues

```bash
# Check what keys are configured in env
grep DISCORD_BOT_IDS .env

# Check what's stored in the DB (should match keys above, NOT numeric IDs)
sqlite3 store/messages.db "SELECT DISTINCT discord_bot_id FROM channel_subscriptions WHERE discord_bot_id IS NOT NULL"

# Check which bot actually sent a message (look for the jid in logs)
grep "Discord message sent" logs/omniclaw.log | tail -10
```

If the DB contains numeric snowflake IDs instead of human-readable keys, fix them:
```bash
# Example: replace numeric ID with the correct key
sqlite3 store/messages.db "UPDATE channel_subscriptions SET discord_bot_id = 'OCPEYTON' WHERE discord_bot_id = '1476396931709276191'"
```

### Scheduled task routing

Scheduled tasks route their result message through `group.discordBotId`, which comes from the task's assigned agent's `channel_subscriptions.discord_bot_id`. If the task was assigned to `ocpeyton-discord` but the reply came from the wrong bot, check:

```bash
sqlite3 store/messages.db "
SELECT st.id, st.group_folder, cs.discord_bot_id, cs.is_primary
FROM scheduled_tasks st
JOIN channel_subscriptions cs ON cs.channel_jid = st.chat_jid AND cs.agent_id = st.group_folder
WHERE st.status = 'active' LIMIT 10;
"
```

The `discord_bot_id` shown must match a key in `DISCORD_BOT_IDS`.

## IPC Debugging

The container communicates back to the host via files in `/workspace/ipc/`:

```bash
# Check pending messages
ls -la data/ipc/messages/

# Check pending task operations
ls -la data/ipc/tasks/

# Read a specific IPC file
cat data/ipc/messages/*.json

# Check available groups (main channel only)
cat data/ipc/main/available_groups.json

# Check current tasks snapshot
cat data/ipc/{groupFolder}/current_tasks.json
```

**IPC file types:**
- `messages/*.json` - Agent writes: outgoing WhatsApp messages
- `tasks/*.json` - Agent writes: task operations (schedule, pause, resume, cancel, refresh_groups)
- `current_tasks.json` - Host writes: read-only snapshot of scheduled tasks
- `available_groups.json` - Host writes: read-only list of WhatsApp groups (main only)

## Quick Diagnostic Script

Run this to check common issues:

```bash
echo "=== Checking OmniClaw Container Setup ==="

echo -e "\n1. Authentication configured?"
[ -f .env ] && (grep -q "CLAUDE_CODE_OAUTH_TOKEN=sk-" .env || grep -q "ANTHROPIC_API_KEY=sk-" .env) && echo "OK" || echo "MISSING - add CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY to .env"

echo -e "\n2. Env file copied for container?"
[ -f data/env/env ] && echo "OK" || echo "MISSING - will be created on first run"

echo -e "\n3. Apple Container system running?"
container system status &>/dev/null && echo "OK" || echo "NOT RUNNING - OmniClaw should auto-start it; check logs"

echo -e "\n4. Container image exists?"
echo '{}' | container run -i --entrypoint /bin/echo omniclaw-agent:latest "OK" 2>/dev/null || echo "MISSING - run ./container/build.sh"

echo -e "\n5. Session mount path correct?"
grep -q "/home/node/.claude" src/backends/local-backend.ts 2>/dev/null && echo "OK" || echo "WRONG - should mount to /home/node/.claude/, not /root/.claude/"

echo -e "\n6. Groups directory?"
ls -la groups/ 2>/dev/null || echo "MISSING - run setup"

echo -e "\n7. Recent container logs?"
ls -t groups/*/logs/container-*.log 2>/dev/null | head -3 || echo "No container logs yet"

echo -e "\n8. Session continuity working?"
SESSIONS=$(grep "Session initialized" logs/omniclaw.log 2>/dev/null | tail -5 | awk '{print $NF}' | sort -u | wc -l)
[ "$SESSIONS" -le 2 ] && echo "OK (recent sessions reusing IDs)" || echo "CHECK - multiple different session IDs, may indicate resumption issues"
```
