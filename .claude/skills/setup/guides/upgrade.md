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
# macOS
launchctl kickstart -k gui/$(id -u)/com.omniclaw
# Linux
systemctl --user restart omniclaw
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
# macOS
launchctl kickstart -k gui/$(id -u)/com.omniclaw
# Linux
systemctl --user restart omniclaw
```

Schema changes are additive — rolling back code is safe even after migrations ran.

## What's new (automatic)

These features activate automatically after upgrading — no action required.

### Sender identity pipeline

Messages now carry `sender_platform` (discord, whatsapp, telegram, slack, ipc, system) and sender IDs are canonicalized to `<platform>:<immutable-id>` format across all adapters. The `sender_id` attribute is exposed in the `<message>` XML agents receive. DB migrations add `sender_platform` and `sender_user_id` columns to `messages` automatically.

### Channel context injection

Agents now receive a `## Channel Context` block in their system prompt listing all channels they're subscribed to, with the current channel marked. Multi-channel agents see the full list; single-channel agents see just their channel name and JID.

### Live log streaming

The web dashboard now supports real-time log streaming via WebSocket. Access it from the dashboard log panel — logs show level badges and color coding.

### Rust toolchain in container

`cargo` and `rustc` are now included in the base container image.

## New opt-in capabilities

These require explicit action — existing agents are unaffected by default.

### GitHub context injection

Agents can see open PRs, issues, and review comments in their system prompt. See [advanced-setup.md](advanced-setup.md) for full config.

Quick setup:
1. Ensure `GITHUB_TOKEN` is in `.env`
2. Create `data/github-watches.json` with agent → repo mappings
3. Restart the service

### GitHub webhooks

For real-time GitHub event notifications, add `GITHUB_WEBHOOK_SECRET` to `.env` and configure a webhook in your GitHub repo. See [advanced-setup.md](advanced-setup.md).

### Persistent resume position store

Feature-flagged (off by default). When enabled, scheduled task resume positions survive service restarts. To enable, add to `.env`:

```dotenv
PERSISTENT_TASK_STATE=true
```

Currently in preview — fail-open on persistence errors (falls back to in-memory).

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
