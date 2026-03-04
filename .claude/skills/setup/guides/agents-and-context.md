# Agents & Context System Guide

This guide covers the multi-agent system and workspace context architecture — the parts most likely to be configured incorrectly.

---

## How agents are defined

Each agent has an entry in the `agents` table:

```sql
SELECT id, name, folder, agent_context_folder FROM agents;
```

> **Migration note:** `agent_context_folder` is added by `addColumnIfNotExists` in `src/db.ts` (it is not part of the initial `CREATE TABLE agents`). On very old databases before migrations run, use:
>
> ```sql
> SELECT id, name, folder FROM agents;
> ```

| Column                 | Purpose                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `id`                   | Unique key (e.g. `clayton-discord`)                               |
| `name`                 | Display name (e.g. `Clayton`)                                     |
| `folder`               | Legacy group folder — still used as fallback for workspace mounts |
| `agent_context_folder` | Path under `groups/` for identity files (e.g. `agents/clayton`)   |

If `agent_context_folder` is NULL, the agent has no `/workspace/agent` mount and no persistent identity file.

---

## How agents subscribe to channels

Each `channel_subscriptions` row binds an agent to a channel with routing info:

```sql
SELECT channel_jid, agent_id, trigger_pattern, discord_bot_id,
       channel_folder, category_folder
FROM channel_subscriptions
WHERE channel_jid = 'dc:<CHANNEL_ID>';
```

> **Migration note:** `channel_folder` and `category_folder` are added by `addColumnIfNotExists` in `src/db.ts` (they are not part of the initial `CREATE TABLE channel_subscriptions`). If migrations have not run yet, use this fallback query first:
>
> ```sql
> SELECT channel_jid, agent_id, trigger_pattern, discord_bot_id
> FROM channel_subscriptions
> WHERE channel_jid = 'dc:<CHANNEL_ID>';
> ```

| Column            | Purpose                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `trigger_pattern` | Text pattern that selects this agent (e.g. `@Clayton`)                                        |
| `discord_bot_id`  | Human-readable bot key from `.env` (e.g. `PRIMARY`, `OCPEYTON`) — NOT the Discord snowflake   |
| `channel_folder`  | Path under `groups/` for this channel's notebook (e.g. `servers/omni-aura/omniaura/omniclaw`) |
| `category_folder` | Path under `groups/` for the shared category workspace (e.g. `servers/omni-aura/omniaura`)    |

---

## Workspace mounts inside the container

When a container starts for a channel subscription, these directories are mounted:

| Mount                 | Host path                        | Access     | What lives there                         |
| --------------------- | -------------------------------- | ---------- | ---------------------------------------- |
| `/workspace/group`    | `groups/<channel_folder>/`       | read-write | Per-channel notebook, CLAUDE.md, memory/ |
| `/workspace/agent`    | `groups/<agent_context_folder>/` | read-write | Agent identity CLAUDE.md, agent memory   |
| `/workspace/category` | `groups/<category_folder>/`      | read-write | Shared team knowledge across channels    |
| `/workspace/server`   | `groups/<server_folder>/`        | read-write | Server-wide shared context               |
| `/workspace/global`   | `groups/global/`                 | read-only  | Global notes for all agents              |

**If any path doesn't exist on disk, that mount is silently skipped** — the agent just won't have that context.

---

## Agent identity file

The most common breakage point. Each agent needs a correct `CLAUDE.md` at `groups/<agent_context_folder>/CLAUDE.md`.

**Verify identity files are correct:**

```bash
for folder in $(sqlite3 store/messages.db "SELECT agent_context_folder FROM agents WHERE agent_context_folder IS NOT NULL"); do
  echo "=== $folder ==="
  head -3 "groups/$folder/CLAUDE.md" 2>/dev/null || echo "(MISSING)"
done
```

The first few lines should say `You are <AgentName>` — not someone else's name.

**If wrong or missing:** Edit `groups/<agent_context_folder>/CLAUDE.md` directly. Template:

```markdown
# <AgentName> Identity

You are **<AgentName>** (@<Trigger>), <role description>.

## Discord Context

- Your trigger is `@<Trigger>`
- Other agents in these channels: <list co-agents and their @triggers>

## Notes

- Channel-specific context lives in `/workspace/group/CLAUDE.md`
- Category-specific context lives in `/workspace/category/CLAUDE.md`
- Server-wide context lives in `/workspace/server/CLAUDE.md`
```

**Always include the co-agent list.** If Agent A doesn't know Agent B's trigger, it can't address them — breaking the conversation loop.

---

## Discord bot keys

`DISCORD_BOT_IDS` in `.env` uses **your own human-readable keys** (e.g. `PRIMARY`, `OCPEYTON`). These are NOT Discord's numeric snowflake IDs.

```dotenv
DISCORD_BOT_IDS=PRIMARY,OCPEYTON
DISCORD_BOT_PRIMARY_TOKEN=<token>
DISCORD_BOT_OCPEYTON_TOKEN=<token>
DISCORD_BOT_DEFAULT=PRIMARY
# Optional per-bot runtime override:
DISCORD_BOT_OCPEYTON_RUNTIME=opencode
```

The `discord_bot_id` column in `channel_subscriptions` must match one of these keys exactly. Mismatch = messages never reach the agent.

**Verify:**

```bash
# Keys in .env (don't print tokens):
grep "DISCORD_BOT_IDS" .env

# Keys in DB:
sqlite3 store/messages.db "SELECT DISTINCT discord_bot_id FROM channel_subscriptions WHERE discord_bot_id IS NOT NULL"
```

---

## Agent-to-agent routing

Messages route to an agent when the message content contains that agent's `trigger_pattern`.

**For agent A to trigger agent B, A must write `@<B's trigger>` in its message.**

Example: Clayton (trigger `@Clayton`) and OCPeyton (trigger `@OCPeyton`) share a channel. For back-and-forth:

- OCPeyton's message must contain `@Clayton` → Clayton is triggered
- Clayton's reply must contain `@OCPeyton` → OCPeyton is triggered

If an agent addresses itself by name, it consumes its own trigger → the message routes back to itself → filtered out (agents don't see their own messages) → conversation dies.

**Attentive follow-up** (one-shot): after an agent is triggered by an explicit mention, it stays "attentive" for the _next_ incoming message without needing a trigger. This is for human follow-ups, not for bot loops.

---

## Full consistency check

Run this to verify all the pieces align:

```bash
echo "=== Agents ==="
sqlite3 store/messages.db "SELECT id, name, agent_context_folder FROM agents"

echo ""
echo "=== Channel subscriptions (Discord) ==="
sqlite3 store/messages.db \
  "SELECT cs.channel_jid, a.name, cs.trigger_pattern, cs.discord_bot_id, cs.channel_folder
   FROM channel_subscriptions cs JOIN agents a ON a.id = cs.agent_id
   WHERE cs.channel_jid LIKE 'dc:%'"

echo ""
echo "=== Identity files ==="
for folder in $(sqlite3 store/messages.db "SELECT agent_context_folder FROM agents WHERE agent_context_folder IS NOT NULL"); do
  echo "$folder: $(head -3 "groups/$folder/CLAUDE.md" 2>/dev/null | tr '\n' ' ' || echo 'MISSING')"
done

echo ""
echo "=== Bot keys in .env ==="
grep "DISCORD_BOT_IDS\|DISCORD_BOT_DEFAULT" .env 2>/dev/null
```

**Checklist for a correctly configured agent:**

- [ ] Row in `agents` with correct `agent_context_folder`
- [ ] Row in `channel_subscriptions` for each channel it should join
- [ ] `discord_bot_id` in that row matches a key in `DISCORD_BOT_IDS`
- [ ] `channel_folder` and `category_folder` directories exist under `groups/`
- [ ] `groups/<agent_context_folder>/CLAUDE.md` says `You are <AgentName>` and lists co-agents' triggers
- [ ] All co-agents' identity files mention each other's triggers

---

## Adding a new agent to an existing channel

1. **Create identity file:**

   ```bash
   mkdir -p groups/agents/<name>
   # Write groups/agents/<name>/CLAUDE.md (see template above)
   ```

2. **Add bot token to `.env`:**

   ```dotenv
   DISCORD_BOT_IDS=...,<NEW_KEY>
   DISCORD_BOT_<NEW_KEY>_TOKEN=<token>
   ```

3. **Register the agent and subscription:**

   ```bash
   ./.claude/skills/setup/scripts/06-register-channel.sh \
     --jid "dc:<CHANNEL_ID>" \
     --name "<AgentName>" \
     --trigger "@<Trigger>" \
     --folder "<agent-folder>" \
     --discord-bot-id "<NEW_KEY>" \
     --agent-runtime "claude-agent-sdk"
   ```

   This creates the `agents` row and `channel_subscriptions` row.

4. **Set `agent_context_folder`** (the register script may not set this automatically):

   ```bash
   sqlite3 store/messages.db \
     "UPDATE agents SET agent_context_folder = 'agents/<name>' WHERE id = '<agent-id>'"
   ```

5. **Update co-agents' identity files** to mention the new agent's trigger.

6. **Restart the service** and verify with `tail -f logs/omniclaw.log`.
