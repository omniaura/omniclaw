# Slack Integration Skill

OmniClaw has a built-in Slack channel (`src/channels/slack.ts`) that connects via Socket Mode. This skill handles setup and troubleshooting.

## Setup

### 1. Create the Slack App

Go to https://api.slack.com/apps -> **Create New App** -> **From a manifest** -> paste the contents of `slack-app-manifest.template.json` from this skill directory.

Edit the `display_information.name` and `features.bot_user.display_name` fields before pasting if you want a custom bot name.

The manifest configures Socket Mode, all required scopes, and event subscriptions automatically.

### 2. Generate Tokens

After creating the app:

1. **App-Level Token**: Go to **Basic Information** -> **App-Level Tokens** -> **Generate Token**. Give it a name (e.g. "socket"), add scope `connections:write`. Copy the `xapp-...` token.
2. **Install to Workspace**: Go to **Install App** -> **Install to Workspace**. Copy the **Bot User OAuth Token** (`xoxb-...`).

### 3. Set Environment Variables

Add to `.env`:

```
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_APP_TOKEN=xapp-your-token
```

OmniClaw auto-connects Slack when both tokens are present.

### 4. Subscribe an Agent to a Slack Channel

Invite the bot to a Slack channel, then find the channel ID (right-click channel name -> **View channel details** -> ID at the bottom).

```sql
INSERT INTO channel_subscriptions (channel_jid, agent_id, trigger_pattern, requires_trigger, priority, is_primary, created_at)
VALUES ('slack:CHANNEL_ID', 'YOUR_AGENT_ID', '@BotName', 0, 100, 1, datetime('now'));
```

Set `requires_trigger` to `1` if the agent should only respond when mentioned.

### 5. Restart and Verify

```bash
launchctl kickstart -k gui/$(id -u)/com.omniclaw  # macOS
# or
systemctl --user restart omniclaw                   # Linux
```

Check logs for `Slack bot connected`:

```bash
grep -i slack logs/omniclaw.log | tail -5
```

## Standalone CLI Tool

This skill also includes a standalone script for quick Slack operations outside the orchestrator:

```bash
cd .claude/skills/slack && bun install

# List channels
bun run slack.ts list

# Read messages
bun run slack.ts read --channel C123456 --limit 10

# Send a message
bun run slack.ts send --channel C123456 --text "Hello!"

# Reply to a thread
bun run slack.ts reply --channel C123456 --thread-ts 1234567890.123456 --text "Reply"

# Fetch thread
bun run slack.ts thread --channel C123456 --thread-ts 1234567890.123456
```

Requires `SLACK_BOT_TOKEN` env var.

## Troubleshooting

| Issue                                             | Fix                                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| "Failed to connect Slack bot"                     | Check both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set                        |
| Bot doesn't respond in channel                    | Verify the bot is invited to the channel and a `channel_subscriptions` row exists |
| "Message from unregistered Slack channel" in logs | Add a subscription for that channel JID                                           |
| Socket disconnects                                | Slack reconnects automatically; check network if persistent                       |

## Files

- `SKILL.md` - This documentation
- `slack.ts` - Standalone CLI script for Slack operations
- `package.json` - Dependencies (@slack/web-api)
- `slack-app-manifest.template.json` - Slack app manifest template
