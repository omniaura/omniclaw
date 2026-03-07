# OmniClaw Debug Checklist

## Known Issues (2026-02-08)

### 1. [FIXED] Resume branches from stale tree position
When agent teams spawns subagent CLI processes, they write to the same session JSONL. On subsequent `query()` resumes, the CLI reads the JSONL but may pick a stale branch tip (from before the subagent activity), causing the agent's response to land on a branch the host never receives a `result` for. **Fix**: pass `resumeSessionAt` with the last assistant message UUID to explicitly anchor each resume.

### 2. IDLE_TIMEOUT == CONTAINER_TIMEOUT (both 30 min)
Both timers fire at the same time, so containers always exit via hard SIGKILL (code 137) instead of graceful `_close` sentinel shutdown. The idle timeout should be shorter (e.g., 5 min) so containers wind down between messages, while container timeout stays at 30 min as a safety net for stuck agents.

### 3. Cursor advanced before agent succeeds
`processGroupMessages` advances `lastAgentTimestamp` before the agent runs. If the container times out, retries find no messages (cursor already past them). Messages are permanently lost on timeout.

## Quick Status Check

```bash
# 1. Is the service running?
launchctl list | grep omniclaw                    # macOS
systemctl --user status omniclaw                  # Linux

# 1b. Will the service survive logout? (Linux only)
loginctl show-user $(whoami) | grep Linger
# Linger=no → service dies on SSH disconnect. Fix: loginctl enable-linger $(whoami)

# 2. Any running agent containers?
docker ps --filter name=omniclaw 2>/dev/null                              # Docker
launchctl list 2>/dev/null | grep 'container-runtime-linux.omniclaw'      # Apple Container

# 3. Recent errors in service log?
grep -E '"level":"error"' logs/omniclaw.log | tail -20

# 4. Is the channel connected? (look for last connection event)
grep -E 'Connected|Connection closed|connection.*close' logs/omniclaw.log | tail -5

# 5. Are groups loaded?
grep 'groupCount' logs/omniclaw.log | tail -3
```

## Session Transcript Branching

```bash
# Check for concurrent CLI processes in session debug logs
ls -la data/sessions/<group>/.claude/debug/

# Count unique SDK processes that handled messages
# Each .txt file = one CLI subprocess. Multiple = concurrent queries.
```

## Container Timeout Investigation

```bash
# Check for recent timeouts
grep -E 'Container timeout|timed out' logs/omniclaw.log | tail -10

# Check container log files for the timed-out container
ls -lt groups/*/logs/container-*.log | head -10

# Check if retries were scheduled and what happened
grep -E 'Scheduling retry|retry|Max retries' logs/omniclaw.log | tail -10
```

## Agent Not Responding

```bash
# Check if messages are being received
grep 'New messages' logs/omniclaw.log | tail -10

# Check if messages are being processed (container spawned)
grep -E 'Processing messages|Spawning container' logs/omniclaw.log | tail -10

# Check if messages are being piped to active container
grep -E 'Piped messages|sendMessage' logs/omniclaw.log | tail -10

# Check the queue state — any active containers?
grep -E 'Starting container|Container active|concurrency limit' logs/omniclaw.log | tail -10
```

## Container Mount Issues

```bash
# Check mount validation logs (shows on container spawn)
grep -E 'Mount validated|Mount.*REJECTED|mount' logs/omniclaw.log | tail -10

# Verify the mount allowlist is readable
cat ~/.config/omniclaw/mount-allowlist.json
```

## Auth Issues

```bash
# Check if auth expired
grep -E 'QR\|authentication required\|qr\|login' logs/omniclaw.log | tail -5

# Check auth files exist
ls -la store/auth/

# Re-authenticate if needed
bun run auth
```

## Service Management

```bash
# Restart
launchctl kickstart -k gui/$(id -u)/com.omniclaw   # macOS
systemctl --user restart omniclaw                    # Linux

# Stop
launchctl unload ~/Library/LaunchAgents/com.omniclaw.plist   # macOS
systemctl --user stop omniclaw                                # Linux

# View live logs
tail -f logs/omniclaw.log

# Rebuild after code changes
bun run build
# Then restart (see above)
```
