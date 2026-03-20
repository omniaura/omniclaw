# Advanced Setup Guide

## GitHub Integration

Ask: Do you want the agent to push branches and create pull requests?

If yes: user needs a GitHub **classic** token with `repo` scope from https://github.com/settings/tokens

Once they provide it, use the **Write tool** to append to `.env` (never echo tokens via shell — it leaks into shell history):

```dotenv
GITHUB_TOKEN=<token>
```

Optionally: `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` (defaults: `OmniClaw Agent` / `omniclaw@users.noreply.github.com`)

## GitHub Context Injection

Agents can see open PRs, issues, and review comments injected into their system prompt. Requires `GITHUB_TOKEN` in `.env`.

Create `data/github-watches.json`:

```json
{
  "cacheTtlMs": 300000,
  "watches": [
    {
      "agentId": "<agent-folder-name>",
      "repos": [
        {
          "owner": "<org>",
          "repo": "<repo>",
          "openPrs": { "limit": 10, "includeReviewComments": true },
          "recentIssues": { "limit": 10 }
        }
      ]
    }
  ]
}
```

- `agentId` matches the agent's folder name (the `folder` column in the `agents` table)
- Multiple agents can watch different sets of repos
- Cache TTL defaults to 5 minutes; override per-config with `cacheTtlMs`
- The `# GitHub Context` block appears in the agent's system prompt automatically

## GitHub Webhooks (Optional)

For real-time GitHub event notifications (instead of waiting for cache expiry), set up a webhook:

1. Add webhook secret to `.env`:

   ```dotenv
   GITHUB_WEBHOOK_SECRET=<your-secret>
   ```

2. In your GitHub repo settings → Webhooks → Add webhook:
   - Payload URL: `https://<your-host>/webhooks/github`
   - Content type: `application/json`
   - Secret: same value as `GITHUB_WEBHOOK_SECRET`
   - Events: select `Pull requests`, `Pull request reviews`, `Pull request review comments`, `Issues`, `Issue comments`, `Check suites`

3. Restart the service. The webhook server starts automatically when `GITHUB_WEBHOOK_SECRET` is configured.

Events trigger immediate cache invalidation and synthetic messages to watching agents. Polling via `data/github-watches.json` is kept as fallback.

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

After registering, set the context layer folders (the register script doesn't set these automatically yet):

```bash
# Set agent identity folder
sqlite3 store/messages.db \
  "UPDATE agents SET agent_context_folder = 'agents/<name>' WHERE folder = '<FOLDER_NAME>'"

# Set channel and category context folders
sqlite3 store/messages.db \
  "UPDATE channel_subscriptions
   SET channel_folder = 'servers/<server>/<category>/<channel>',
       category_folder = 'servers/<server>/<category>'
   WHERE agent_id = '<agent-id>' AND channel_jid = 'dc:<CHANNEL_ID>'"
```

Create the corresponding directories under `groups/`:

```bash
mkdir -p groups/agents/<name>
mkdir -p groups/servers/<server>/<category>/<channel>
mkdir -p groups/servers/<server>/<category>
```

Restart the service and verify by sending a message in the channel and checking `tail -f logs/omniclaw.log`.

### Internal bot key vs Discord snowflake ID

`DISCORD_BOT_IDS` uses **human-readable keys you define** (e.g. `PRIMARY`, `OCPEYTON`). These are completely different from the numeric IDs in the Discord Developer Portal.

The value in `channel_subscriptions.discord_bot_id` in SQLite **must** be the internal key, never the numeric snowflake ID.
