# Advanced Setup Guide

## GitHub Integration

Ask: Do you want the agent to push branches and create pull requests?

If yes: user needs a GitHub **classic** token with `repo` scope from https://github.com/settings/tokens

Once they provide it, use the **Write tool** to append to `.env` (never echo tokens via shell — it leaks into shell history):
```dotenv
GITHUB_TOKEN=<token>
```

Optionally: `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` (defaults: `OmniClaw Agent` / `omniclaw@users.noreply.github.com`)

## Discord Agent

Ask: Do you want to add a Discord agent?

### Bot token

User needs a Discord bot token:
1. https://discord.com/developers/applications → New application → Bot → Reset Token
2. Under Bot → Privileged Gateway Intents, enable **Presence Intent** AND **Message Content Intent**
3. Invite via OAuth2 → URL Generator (scopes: `bot`, permissions: `Send Messages`, `Read Message History`)

Use the **Write tool** to append to `.env` (never echo tokens):
```dotenv
DISCORD_BOT_IDS=<BOT_ID>
DISCORD_BOT_<BOT_ID>_TOKEN=<token>
DISCORD_BOT_DEFAULT=<BOT_ID>
```

Optionally: `DISCORD_BOT_<BOT_ID>_RUNTIME=opencode`

**Never remove an existing `DISCORD_BOT_TOKEN` unless user explicitly asks.**

### Register Discord channel

JID format: `dc:<channel_id>`. Ask user to right-click the channel → Copy Channel ID (needs Developer Mode in Discord Settings → Advanced).

```bash
./.claude/skills/setup/scripts/06-register-channel.sh \
  --jid "dc:<CHANNEL_ID>" \
  --name "<AGENT_NAME>" \
  --trigger "@<TRIGGER>" \
  --folder "<FOLDER_NAME>" \
  --discord-bot-id "<BOT_ID>" \
  --agent-runtime "<claude-agent-sdk|opencode>" \
  --assistant-name "<AssistantName>"
```

Restart the service:
```bash
launchctl kickstart -k gui/$(id -u)/com.omniclaw
```

Verify by sending a message in the channel and checking `tail -f logs/omniclaw.log`.

### Internal bot key vs Discord snowflake ID

`DISCORD_BOT_IDS` uses **human-readable keys you define** (e.g. `PRIMARY`, `OCPEYTON`). These are completely different from the numeric IDs in the Discord Developer Portal.

The value in `channel_subscriptions.discord_bot_id` in SQLite **must** be the internal key, never the numeric snowflake ID.
