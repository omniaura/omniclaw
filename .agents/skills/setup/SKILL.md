---
name: setup
description: Run initial OmniClaw setup. Use when user wants to install dependencies, authenticate WhatsApp, register their main channel, or start the background services. Triggers on "setup", "install", "configure omniclaw", or first-time setup requests.
---

# OmniClaw Setup

**Read the user's request first. Most requests are lightweight — handle them directly without loading any guide.**

## Route by intent

| User says                                                                                                                     | Action                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| restart, reboot, kick, kickstart                                                                                              | → [Reboot](#reboot-service) below                                                                                                                                    |
| verify, status, health check                                                                                                  | → run `09-verify.sh` directly                                                                                                                                        |
| update, upgrade, pulled latest, auto-update                                                                                   | → read [guides/upgrade.md](guides/upgrade.md)                                                                                                                        |
| install, fresh setup, first time, configure                                                                                   | → read [guides/fresh-install.md](guides/fresh-install.md)                                                                                                            |
| github, discord bot/agent, webhooks, github watches                                                                           | → read [guides/advanced-setup.md](guides/advanced-setup.md)                                                                                                          |
| add agent to channel, subscribe agent, register agent in chat, new channel for agent                                          | → read [guides/agents-and-context.md](guides/agents-and-context.md) (see "Adding an existing agent to a new channel" or "Adding a new agent to an existing channel") |
| agent identity, context, workspace mounts, agent-to-agent routing, triggers, wrong identity, sender identity, channel context | → read [guides/agents-and-context.md](guides/agents-and-context.md)                                                                                                  |
| linger, ssh disconnect, service dies, agents go offline                                                                       | → [Linger fix](#linger-fix) below                                                                                                                                    |
| mac mini, mac server mode, force-shutdown, pmset, sleep, autorestart, auto-login, mac wakes up                                | → [Mac server-mode fix](#mac-server-mode-fix) below                                                                                                                  |
| broken, not working, error, troubleshoot                                                                                      | → read [guides/troubleshooting.md](guides/troubleshooting.md)                                                                                                        |

---

## Reboot service

**Check status first, then act.**

```bash
# 1. Which agents are registered?
sqlite3 store/messages.db "SELECT folder, name FROM registered_groups"

# 2. Is the service running? (pick one)
launchctl list | grep omniclaw          # macOS
systemctl --user status omniclaw        # Linux

# 3. Check for running agent containers
launchctl list | grep 'container-runtime-linux.omniclaw'   # macOS
# Each line = an active agent container processing a task or message

# 4. Recent activity per agent
for folder in $(sqlite3 store/messages.db "SELECT folder FROM registered_groups"); do
  LATEST=$(ls -t "groups/$folder/logs/" 2>/dev/null | head -1)
  [ -n "$LATEST" ] && echo "$folder: $(echo "$LATEST" | sed 's/container-//;s/\.log//')" || echo "$folder: no activity"
done

# 5. Recent errors
tail -20 logs/omniclaw.log
```

Present agent status to user and ask which to reboot (all vs specific). Use **AskUserQuestion**.

### Drain active containers before restarting

**IMPORTANT:** If any agent containers are running (step 3 above), you MUST wait for them to finish before restarting. Killing the orchestrator while containers are active destroys in-progress agent work.

**Wait for containers to drain:**

```bash
# Poll until no omniclaw containers remain (check every 10s, timeout after 10min)
echo "Waiting for active containers to finish..."
for i in $(seq 1 60); do
  ACTIVE=$(launchctl list 2>/dev/null | grep -c 'container-runtime-linux.omniclaw' || true)
  [ "$ACTIVE" -eq 0 ] && echo "All containers finished." && break
  echo "  $ACTIVE container(s) still running... (${i}0s elapsed)"
  sleep 10
done
```

If the user explicitly says to restart immediately (e.g. "force restart", "restart now"), skip the drain wait. Otherwise always drain first.

**Reboot all — macOS:**

```bash
launchctl kickstart -k gui/$(id -u)/com.omniclaw
sleep 3 && launchctl list | grep omniclaw
tail -5 logs/omniclaw.log
```

**Reboot all — Linux:**

```bash
systemctl --user restart omniclaw
sleep 3 && systemctl --user is-active omniclaw
tail -5 logs/omniclaw.log
```

Report whether the service came back up successfully.

---

## Linger fix

**Linux only.** If user reports agents going offline after SSH disconnect:

```bash
# Check
loginctl show-user $(whoami) | grep Linger

# Fix
loginctl enable-linger $(whoami)

# Verify
loginctl show-user $(whoami) | grep Linger
# Should show Linger=yes
```

Without linger, systemd tears down all user services when the last session ends. This is also handled automatically by step 10 (`08-setup-service.sh`) during fresh install.

---

## Mac server-mode fix

**macOS only.** If user reports the Mac (especially a Mac mini) requiring force-shutdowns, going to sleep, or not coming back after a power blip:

```bash
./.claude/skills/setup/scripts/00-check-mac-server-mode.sh
```

Parse the status block. If `NEEDS_FIXUP=true`, AskUserQuestion whether to apply the fixup. If yes, tell the user to open a new terminal tab and run:

```bash
sudo bash .agents/skills/setup/scripts/mac-server-mode.sh
```

The fixup is sudo-only and interactive (it prompts to enable SSH), so it cannot run from this shell. The script sets `pmset sleep=0`, `autorestart=1`, `tcpkeepalive=1`, `womp=1`, and `disksleep=0`, and prompts the user to enable Remote Login. It does not script auto-login (macOS stores the password obfuscated-not-encrypted) — the user must enable it via System Settings > Users & Groups > Automatic Login.

After the user reports done, re-run `00-check-mac-server-mode.sh` to confirm.

**Note:** sleep prevention lives at the OS layer (`pmset`), not in app code. Earlier versions wrapped the launchd `ProgramArguments` with `caffeinate -dimsu`; that was removed in favor of this OS-level config, which also avoids forcing the display awake on headless servers.

### FileVault and auto-login (known trade-off)

If the user tries to enable Automatic Login and macOS replies *"Automatic login can't be turned on because FileVault is enabled,"* that's working as designed — FileVault derives the disk-decryption key from the login password, so auto-login would defeat full-disk encryption. The status block reports `FILEVAULT_ON` and sets `AUTOLOGIN_NOTE=filevault_blocks_autologin` when it sees this combo. Surface the three options below; **do not script any change to FileVault state** — that's a security decision for the user.

- **Option 1 — Disable FileVault.** Gets true zero-touch headless reboot: after a panic plus `pmset autorestart=1` the Mac comes back to a logged-in session and omniclaw is online again with no human in the loop. Trade-off: full-disk encryption is gone, so anyone with physical access to the machine has access to the data. Only acceptable if the Mac mini lives somewhere physically secure (locked office, home server closet). Not the default recommendation.
- **Option 2 — Keep FileVault, accept manual login on reboot (recommended).** `pmset autorestart=1` still gets the Mac back to the FileVault password prompt automatically; the user logs in once via Screen Sharing or in person and omniclaw resumes. Best balance of security and recovery for most setups, and panics should be rare now that we're off Apple's `container` framework.
- **Option 3 — `sudo fdesetup authrestart` for planned reboots.** Stashes the FileVault key in EFI for the *next* boot only, so a user-initiated reboot (e.g. macOS update) comes back fully unattended. Does not help with surprise panics — Apple deliberately closes that path for security reasons.

---

## Verify

```bash
./.claude/skills/setup/scripts/09-verify.sh
```

Fix any failures per [guides/troubleshooting.md](guides/troubleshooting.md).

---

## OpenCode auth reset

Use this when a local OpenCode agent creates fresh sessions but still returns empty assistant outputs, especially after auth/provider drift.

Common symptom:

```text
[opencode-runtime] Created new session: ...
[opencode-runtime] Injected system context
[opencode-runtime] extractResponseText: 0 parts, types:
```

Known cause:

- base OpenCode auth store for the agent contains mixed providers or stale auth state
- fresh dispatch sessions inherit that bad base state

Safe reset sequence for a local agent such as `ocpeyton-discord`:

```bash
# Stop service first
launchctl bootout gui/$(id -u)/com.omniclaw          # macOS
systemctl --user stop omniclaw                       # Linux

# Clear persisted dispatch sessions
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder LIKE 'ocpeyton-discord__dispatch__%';"

# Clear dispatch runtime stores
find data/opencode-data -maxdepth 1 -type d -name 'ocpeyton-discord__dispatch__*' -exec rm -rf {} +

# Clear base auth/database so agent rebuilds from fresh login
rm -f data/opencode-data/ocpeyton-discord/auth.json \
      data/opencode-data/ocpeyton-discord/mcp-auth.json \
      data/opencode-data/ocpeyton-discord/opencode.db \
      data/opencode-data/ocpeyton-discord/opencode.db-shm \
      data/opencode-data/ocpeyton-discord/opencode.db-wal

# Start service again
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.omniclaw.plist   # macOS
systemctl --user start omniclaw                                              # Linux
```

After restart:

- re-auth if needed
- send a simple test message to the agent
- confirm the next run no longer logs `extractResponseText: 0 parts`
