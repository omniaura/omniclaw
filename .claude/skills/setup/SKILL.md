---
name: setup
description: Run initial OmniClaw setup. Use when user wants to install dependencies, authenticate WhatsApp, register their main channel, or start the background services. Triggers on "setup", "install", "configure omniclaw", or first-time setup requests.
---

# OmniClaw Setup

**Read the user's request first. Most requests are lightweight — handle them directly without loading any guide.**

## Route by intent

| User says | Action |
|-----------|--------|
| restart, reboot, kick, kickstart | → [Reboot](#reboot-service) below |
| verify, status, health check | → run `09-verify.sh` directly |
| update, upgrade, pulled latest, auto-update | → read [guides/upgrade.md](guides/upgrade.md) |
| install, fresh setup, first time, configure | → read [guides/fresh-install.md](guides/fresh-install.md) |
| github, discord bot/agent | → read [guides/advanced-setup.md](guides/advanced-setup.md) |
| agent identity, context, workspace mounts, agent-to-agent routing, triggers, wrong identity | → read [guides/agents-and-context.md](guides/agents-and-context.md) |
| broken, not working, error, troubleshoot | → read [guides/troubleshooting.md](guides/troubleshooting.md) |

---

## Reboot service

**Check status first, then act.**

```bash
# 1. Which agents are registered?
sqlite3 store/messages.db "SELECT folder, name FROM registered_groups"

# 2. Is the service running? (pick one)
launchctl list | grep omniclaw          # macOS
systemctl --user status omniclaw        # Linux

# 3. Recent activity per agent
for folder in $(sqlite3 store/messages.db "SELECT folder FROM registered_groups"); do
  LATEST=$(ls -t "groups/$folder/logs/" 2>/dev/null | head -1)
  [ -n "$LATEST" ] && echo "$folder: $(echo "$LATEST" | sed 's/container-//;s/\.log//')" || echo "$folder: no activity"
done

# 4. Recent errors
tail -20 logs/omniclaw.log
```

Present agent status to user and ask which to reboot (all vs specific). Use **AskUserQuestion**.

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

## Verify

```bash
./.claude/skills/setup/scripts/09-verify.sh
```

Fix any failures per [guides/troubleshooting.md](guides/troubleshooting.md).
