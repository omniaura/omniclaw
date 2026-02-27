---
name: migrate-to-channels
description: Migrate existing multi-agent Discord/Slack setup to the new agent/server/category/channel context architecture. Restructures group workspaces into isolated per-channel notebooks with shared category and agent identity layers.
---

# Migrate to Channel Architecture

This skill migrates your existing OmniClaw setup from the flat `groups/` workspace model to the new layered context architecture:

```
groups/
  agents/{agentId}/CLAUDE.md     ← agent identity (shared across channels)
  servers/{server}/{category}/    ← category team workspace
  servers/{server}/{category}/{channel}/  ← isolated channel notebook
  channels/{name}/               ← non-server channels (WhatsApp, Telegram)
```

## What This Skill Does

1. **Inspects** the live database — reads all `channel_subscriptions`, `agents`, and their current workspace mappings
2. **Consolidates** legacy agent entries that share the same persona
3. **Proposes** a folder mapping for each channel (server → category → channel path)
4. **Creates** new directories and CLAUDE.md stubs for missing layers
5. **Updates** `channel_folder`, `category_folder`, `agent_context_folder` in the DB for each subscription/agent
6. **Sets `is_primary`** correctly on each channel's subscriptions
7. **Verifies** agents without new fields still work (backward compat)

---

## Known Gotchas (from real migration)

### 1. Consolidate legacy agent entries first

In older OmniClaw setups, each channel got its own agent entry (e.g., `landing-astro-discord`, `spec-discord`, `backend-discord`) even though they all share the same persona. These are **not separate agents** — they're just channels.

**Before migrating**, merge them: re-point their subscriptions to the canonical agent and delete the stubs.

```sql
-- Example: landing-astro-discord was just another PeytonOmni channel
-- Move its subs to ditto-discord (if not already there)
INSERT OR IGNORE INTO channel_subscriptions (channel_jid, agent_id, trigger_pattern, requires_trigger, priority, is_primary, discord_bot_id, discord_guild_id, created_at)
SELECT channel_jid, 'ditto-discord', trigger_pattern, requires_trigger, priority, is_primary, discord_bot_id, discord_guild_id, created_at
FROM channel_subscriptions WHERE agent_id = 'landing-astro-discord';

DELETE FROM channel_subscriptions WHERE agent_id = 'landing-astro-discord';
DELETE FROM agents WHERE id = 'landing-astro-discord';
DELETE FROM registered_groups WHERE folder = 'landing-astro-discord';
```

### 2. Set `agent_context_folder` — or identity breaks

Without `agent_context_folder`, the fallback identity injection fires using `agent.name` from the DB (e.g., "Landing Astro", "Ditto Discord") — **not** the persona name. The agent will say "I am Landing Astro" instead of "I am PeytonOmni".

Set this immediately after adding the agent identity file:

```sql
UPDATE agents SET agent_context_folder = 'agents/peytonomi'
WHERE id IN ('ditto-discord', 'landing-astro-discord');
```

### 3. The identity fallback injects the bot key, not the numeric Discord ID

When `agent_context_folder` is NULL, the injected identity block contains the bot key string (e.g., `OCPEYTON`, `PRIMARY`) not the numeric Discord bot ID. This causes the agent to report conflicting identity info. The fix is always to set `agent_context_folder`.

### 4. `is_primary` controls more than routing — it controls channel name resolution

`is_primary` determines:
- Which Discord bot handles the channel (sends messages, reactions)
- Which agent's name is used as the display name when building channel lists
- Which subscriptions fire as a fallback when no trigger is explicitly matched

In a multi-agent channel (e.g., PeytonOmni + OCPeyton both in `#spec`), set `is_primary = 1` **only on the human-persona agent** (e.g., `ditto-discord`). The tool agent (`ocpeyton-discord`) should have `is_primary = 0` so it only responds to explicit `@OCPeyton` mentions and never fires via fallback.

If `is_primary` is wrong, you'll see another agent's name appear as a channel name in the multi-channel list (e.g., "OCPeyton" showing up as a channel name in PeytonOmni's channel list).

```sql
-- Set primary correctly for each channel
UPDATE channel_subscriptions SET is_primary = 1
WHERE agent_id = 'ditto-discord';  -- persona agent owns the channel

UPDATE channel_subscriptions SET is_primary = 0
WHERE agent_id = 'ocpeyton-discord';  -- tool agent never owns
```

---

## Steps

### Step 1: Inspect current state

```bash
sqlite3 store/messages.db "
SELECT id, name, agent_context_folder FROM agents ORDER BY id;
SELECT '---';
SELECT channel_jid, agent_id, trigger_pattern, is_primary, channel_folder FROM channel_subscriptions ORDER BY channel_jid, agent_id;
"
```

Look for:
- Multiple agent entries that are really the same persona (different channel, same trigger/bot)
- Agents with `agent_context_folder` = NULL (identity will be wrong)
- Channels where `is_primary` isn't set correctly

### Step 2: Consolidate legacy agent entries

Identify agents that are actually just channels for an existing persona. Re-point their subscriptions and delete the agent entry (see gotcha #1 above).

### Step 3: Create agent identity files

For each distinct persona, create `groups/agents/{id}/CLAUDE.md`:

```bash
mkdir -p groups/agents/peytonomi
cat > groups/agents/peytonomi/CLAUDE.md << 'EOF'
# PeytonOmni Identity
You are **PeytonOmni** (@PeytonOmni), ...
EOF
```

Then set `agent_context_folder` in the DB immediately (gotcha #2).

### Step 4: Create category directories and CLAUDE.md stubs

```bash
mkdir -p groups/servers/{server}/{category}/{channel}
```

Create a `CLAUDE.md` in each category folder documenting the project context shared across channels.

### Step 5: Migrate legacy folder content to new channel dirs

For each old flat group folder (e.g., `spec-discord/`, `agentflow-discord/`), copy its contents into the new channel workspace. Use `cp` — never `mv` at this stage, so the original is preserved as a fallback.

```bash
# Copy all files except logs/ from old folder to new channel dir
find groups/spec-discord -maxdepth 1 -not -name 'logs' -not -path 'groups/spec-discord' \
  -exec cp -r {} groups/servers/omni-aura/ditto-assistant/spec/ \;
```

Repeat for each old folder → new path mapping. After copying, verify the new dirs have the expected files.

**If a channel has content in two legacy locations** (e.g., both `ocpeyton-discord/` and `landing-astro-discord/` map to the same new channel), merge them manually — copy one first, then copy the other, skipping any collisions.

#### Offer to clean up old folders

After all content is verified in the new locations, use `AskUserQuestion` to ask the user:

> All legacy folder content has been copied to the new channel structure. Want to delete the old folders?
>
> - **Yes, delete them** — removes the duplicates, keeps `groups/` clean
> - **No, keep them** — I'll show you where everything lives so you can clean up manually later

**If yes:** delete the migrated legacy folders:

```bash
rm -rf groups/spec-discord groups/agentflow-discord groups/ditto-discord # etc.
```

**If no:** print a summary table of old → new paths so the user knows where to look:

```
Legacy folder                          → New location
groups/spec-discord/                   → groups/servers/omni-aura/ditto-assistant/spec/
groups/agentflow-discord/              → groups/servers/omni-aura/omniaura/agentflow/
groups/ditto-discord/                  → groups/servers/omni-aura/omniaura/agent-debug/
...
```

#### Handle orphaned folders

Some old folders may have no active DB entry (no `registered_groups` row, no `channel_subscriptions`). These are stale experiments. Show the user a list and ask if they want them deleted too. Safe to delete if they're just a CLAUDE.md — worth reviewing first if they have real content.

```bash
# Find folders with no DB entry
for f in groups/*/; do
  name=$(basename "$f")
  count=$(sqlite3 store/messages.db "SELECT COUNT(*) FROM registered_groups WHERE folder='$name'")
  [ "$count" = "0" ] && echo "Orphaned: $f ($(ls $f | grep -v logs | wc -l | tr -d ' ') files)"
done
```

### Step 6: Update subscriptions with channel/category folders

```sql
UPDATE channel_subscriptions
SET channel_folder = 'servers/omni-aura/ditto-assistant/spec',
    category_folder = 'servers/omni-aura/ditto-assistant'
WHERE channel_jid = 'dc:...' AND agent_id = 'ditto-discord';
```

### Step 7: Set `is_primary` correctly

```sql
-- Persona agent owns all channels
UPDATE channel_subscriptions SET is_primary = 1 WHERE agent_id = 'ditto-discord';
-- Tool agents never own
UPDATE channel_subscriptions SET is_primary = 0 WHERE agent_id = 'ocpeyton-discord';
```

### Step 8: Restart and verify

```bash
launchctl unload ~/Library/LaunchAgents/com.omniclaw.plist
launchctl load ~/Library/LaunchAgents/com.omniclaw.plist
```

Ask each agent: "what are your debug info / loaded contexts?" — verify:
- Identity name matches the persona (not the DB agent name)
- `/workspace/agent/CLAUDE.md` appears in loaded contexts
- Channel list shows real channel names, not agent names

---

## Backward Compatibility

- Agents without `agent_context_folder` → no `/workspace/agent/` mount, identity via `agentName` fallback (works but name may be wrong — see gotcha #2)
- Subscriptions without `channel_folder` → workspace falls back to agent folder (unchanged behavior)
- Subscriptions without `category_folder` → no `/workspace/category/` mount (unchanged behavior)
