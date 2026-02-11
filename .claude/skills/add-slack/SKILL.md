---
name: add-slack
description: Add Slack as a channel. Uses Socket Mode (WebSocket, no public URL). Workspace-level shared context across channels, image support, share_request tool.
---

# Add Slack Channel

This skill adds Slack support to NanoClaw using Socket Mode (WebSocket-based, no public URL needed).

## Prerequisites

### 1. Create a Slack App

Tell the user:

> I need you to create a Slack App:
>
> 1. Go to https://api.slack.com/apps and click **Create New App** > **From scratch**
> 2. Give it a name (e.g., "Omni") and select your workspace
> 3. Enable **Socket Mode** under Settings > Socket Mode — create an App-Level Token with `connections:write` scope (name it e.g., "socket"). Copy the `xapp-...` token.
> 4. Under **OAuth & Permissions**, add these Bot Token Scopes:
>    - `channels:history` — read channel messages
>    - `channels:read` — list channels
>    - `chat:write` — send messages
>    - `groups:history` — read private channel messages
>    - `groups:read` — list private channels
>    - `im:history` — read DM messages
>    - `im:read` — list DMs
>    - `users:read` — resolve user display names
>    - `team:read` — resolve workspace name
> 5. Under **Event Subscriptions**, enable events and subscribe to these bot events:
>    - `message.channels` — messages in public channels
>    - `message.groups` — messages in private channels
>    - `message.im` — direct messages
> 6. Install the app to your workspace (OAuth & Permissions > Install to Workspace)
> 7. Copy the **Bot User OAuth Token** (`xoxb-...`)

Wait for user to provide both tokens.

### 2. Add Tokens to Environment

Add to `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-level-token
```

### 3. Build and Restart

```bash
bun run build
# If using launchctl:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Look for `Slack bot connected via Socket Mode` in the logs.

### 4. Invite Bot to Channels

Tell the user:

> Invite the bot to any Slack channel you want it to monitor:
> - In the channel, type `/invite @YourBotName`
> - Or right-click the channel > Integrations > Add an app

### 5. Register Channels

After the bot is connected and in channels, register them via the main agent. The JID format is:
- `slack:{channelId}` for channels (e.g., `slack:C06ABC123`)
- `slack:dm:{dmChannelId}` for DMs

The main agent can find Slack channels in the `available_groups.json` snapshot and register them with `register_group`, providing the `slack_workspace_id` parameter for server-level context.

## Architecture

The Slack channel (`src/channels/slack.ts`) follows the same pattern as Discord:
- `SlackChannel implements Channel` — Socket Mode via `@slack/bolt`
- JID format: `slack:{channelId}` or `slack:dm:{dmChannelId}`
- Workspace-level shared context: channels in the same Slack workspace share a `servers/{workspace-slug}/` directory
- Image attachments downloaded with `Authorization: Bearer` header
- Bot mentions (`<@botUserId>`) translated to trigger pattern
- DMs auto-trigger (prepend trigger if not present)
- User display names resolved via `users.info` (cached)

## Troubleshooting

### Bot not responding to messages

1. **Socket Mode not enabled**: Settings > Socket Mode must be ON
2. **Missing event subscriptions**: Event Subscriptions > Subscribe to bot events must include `message.channels`, `message.groups`, `message.im`
3. **Bot not in channel**: Use `/invite @BotName` in the channel
4. **Missing scopes**: OAuth & Permissions > Bot Token Scopes — check all required scopes listed above
5. **Channel not registered**: Check `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'slack:%'"`

### Bot can't read messages in private channels

Add the `groups:history` and `groups:read` scopes, reinstall the app, and invite the bot to the private channel.

### Image attachments not working

Slack requires the bot token for downloading files. Ensure `channels:history` (or `groups:history`) scope is set — file access requires message read permissions.

### Getting channel IDs

- Right-click a channel > View channel details > scroll to the bottom — the Channel ID is shown
- Or use the Slack API: `https://api.slack.com/methods/conversations.list/test`
