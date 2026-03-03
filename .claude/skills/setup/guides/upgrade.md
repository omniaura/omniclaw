# OmniClaw Upgrade Guide

Use this when: pulled latest code, auto-update ran, something broke after a git pull, or want to manually upgrade.

## What auto-update does

`container/auto-update.sh` (set up in step 10b of fresh install, or run manually):

1. `git pull --ff-only origin main` — exits immediately if already up to date
2. `bun run build` — rebuilds host TypeScript
3. `bash container/build.sh` — rebuilds container image
4. Waits for agents to go idle (up to 10 min), then restarts

If any step fails, it exits without restarting — old service + image stay up safely.

**DB migrations run automatically on service start** — additive only, never drops data.

## Upgrade checklist

**Step 1 — Is the container up to date?**

```bash
container run -i --rm --entrypoint wc omniclaw-agent:latest -l /app/src/index.ts
```

Stale or errors → flush cache and rebuild:
```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

> `--no-cache` alone doesn't fix this with Apple Container's buildkit — the cache bust is required.

**Step 2 — Restart the service**

```bash
launchctl kickstart -k gui/$(id -u)/com.omniclaw
```

**Step 3 — Verify**

```bash
./.claude/skills/setup/scripts/09-verify.sh
```

## Rollback

```bash
git log --oneline -5        # find the previous commit
git reset --hard <HASH>
bun run build
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.omniclaw
```

Schema changes are additive — rolling back code is safe even after migrations ran.

## New opt-in capabilities

These require explicit action — existing agents are unaffected by default.

### OpenCode runtime

Run a specific agent on OpenCode instead of Claude Agent SDK:

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET container_config = json_set(COALESCE(container_config,'{}'), '$.agentRuntime', 'opencode') WHERE folder = '<FOLDER_NAME>'"
```

Add to `.env`: `OPENCODE_MODEL=anthropic/claude-sonnet-4-5`

### Multiple Discord bots

Add to `.env`:
```
DISCORD_BOT_IDS=CLAUDE,OPENCODE
DISCORD_BOT_CLAUDE_TOKEN=<existing>
DISCORD_BOT_OPENCODE_TOKEN=<new>
DISCORD_BOT_OPENCODE_RUNTIME=opencode
DISCORD_BOT_DEFAULT=CLAUDE
```

Then re-register channels with `--discord-bot-id OPENCODE`.

**Internal bot key vs Discord snowflake ID:** `DISCORD_BOT_IDS` uses human-readable keys you define (e.g. `PRIMARY`, `OCPEYTON`). Never use the numeric Discord Developer Portal IDs in `channel_subscriptions.discord_bot_id`.
