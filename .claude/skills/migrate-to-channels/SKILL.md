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
2. **Proposes** a folder mapping for each channel (server → category → channel path)
3. **Creates** new directories and CLAUDE.md stubs for missing layers
4. **Updates** `channel_folder`, `category_folder`, `agent_context_folder` in the DB for each subscription/agent
5. **Optionally copies** notes from old workspace to new channel workspace
6. **Verifies** agents without new fields still work (backward compat)

## Steps

### Step 1: Inspect current state

Read the current DB state:

```bash
cd /workspace/project
bun -e "
const { getAllAgents, getAllChannelSubscriptions } = await import('./dist/db.js');
const agents = getAllAgents();
const subs = getAllChannelSubscriptions();
console.log('Agents:', JSON.stringify(agents, null, 2));
console.log('Subscriptions:', JSON.stringify(subs, null, 2));
"
```

Use `AskUserQuestion` to present the current state and ask which server/category structure to use.

### Step 2: Determine the mapping

For each agent, ask the user:
- Which `agents/{id}/` identity folder to use (or create a new one)
- Which server folder it belongs to (from `groups/servers/`)
- Which category within that server

For each channel subscription, determine:
- The `channel_folder` path (e.g., `servers/omni-aura/ditto-assistant/spec`)
- The `category_folder` path (e.g., `servers/omni-aura/ditto-assistant`)

### Step 3: Create directories

Create missing directories:
```bash
mkdir -p groups/agents/{agentId}
mkdir -p groups/servers/{server}/{category}/{channel}
```

Create `CLAUDE.md` stubs where they don't exist yet.

### Step 4: Update the database

For each agent, set `agent_context_folder`:
```bash
bun -e "
import { initDatabase, getAgent, setAgent } from './dist/db.js';
initDatabase();
const agent = getAgent('ditto-discord');
setAgent({ ...agent, agentContextFolder: 'agents/peytonomi' });
"
```

For each channel subscription, set `channel_folder` and `category_folder`:
```bash
bun -e "
import { initDatabase, getSubscriptionsForAgent, setChannelSubscription } from './dist/db.js';
initDatabase();
const subs = getSubscriptionsForAgent('ditto-discord');
for (const sub of subs) {
  const channelFolder = 'servers/omni-aura/ditto-assistant/' + sub.channelJid.slice(-8);
  setChannelSubscription({ ...sub, channelFolder, categoryFolder: 'servers/omni-aura/ditto-assistant' });
}
"
```

### Step 5: Restart and verify

```bash
launchctl unload ~/Library/LaunchAgents/com.omniclaw.plist
launchctl load ~/Library/LaunchAgents/com.omniclaw.plist
```

Then trigger an agent to verify it sees the right context layers.

## Backward Compatibility

- Agents without `agent_context_folder` → no `/workspace/agent/` mount, identity via `agentName` field (unchanged)
- Subscriptions without `channel_folder` → workspace falls back to agent folder (unchanged)
- Subscriptions without `category_folder` → no `/workspace/category/` mount (unchanged)

All existing agents continue working without any changes.
