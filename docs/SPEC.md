# OmniClaw Specification

A multi-channel agent orchestration framework powered by Claude, with persistent memory, scheduled tasks, inter-agent communication, and pluggable backends.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Folder Structure](#folder-structure)
3. [Configuration](#configuration)
4. [Channels](#channels)
5. [Backends](#backends)
6. [Agent-Channel Model](#agent-channel-model)
7. [Memory System](#memory-system)
8. [Session Management](#session-management)
9. [Message Flow](#message-flow)
10. [Scheduled Tasks](#scheduled-tasks)
11. [MCP Tools](#mcp-tools)
12. [Inter-Agent Communication](#inter-agent-communication)
13. [Deployment](#deployment)
14. [Security Considerations](#security-considerations)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         HOST (macOS / Linux)                                 │
│                       (Main Bun Process)                                     │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐ ┌────────────┐ ┌──────────────┐ ┌───────────────┐         │
│  │  WhatsApp    │ │  Discord   │ │  Telegram    │ │    Slack      │         │
│  │  (baileys)   │ │ (discord.js│ │  (grammy)    │ │ (bolt, socket │         │
│  │              │ │            │ │              │ │  mode)        │         │
│  └──────┬───────┘ └─────┬──────┘ └──────┬───────┘ └──────┬────────┘         │
│         │               │               │                │                   │
│         └───────────────┴───────────────┴────────────────┘                   │
│                                   │                                          │
│                         ┌─────────▼──────────┐                               │
│                         │  SQLite Database   │                               │
│                         │  (messages.db)     │                               │
│                         └─────────┬──────────┘                               │
│                                   │                                          │
│  ┌──────────────────┐  ┌─────────▼──────────┐  ┌───────────────┐            │
│  │  Message Loop    │  │  Scheduler Loop    │  │  IPC Watcher  │            │
│  │  (polls SQLite)  │  │  (checks tasks)    │  │  (file-based  │            │
│  └────────┬─────────┘  └────────┬───────────┘  │  + S3 cloud)  │            │
│           │                     │               └───────────────┘            │
│           └──────────┬──────────┘                                            │
│                      │ resolves backend                                      │
│                      ▼                                                       │
│  ┌───────────────────────────────────────────────────────────┐               │
│  │              BACKEND ABSTRACTION LAYER                    │               │
│  │  ┌──────────────┐ ┌────────────┐ ┌─────────────────┐     │               │
│  │  │ Apple        │ │  Sprites   │ │  Daytona /      │     │               │
│  │  │ Container    │ │  (Fly.io)  │ │  Railway /      │     │               │
│  │  │ (local)      │ │  (cloud)   │ │  Hetzner /      │     │               │
│  │  │              │ │            │ │  Docker         │     │               │
│  │  └──────────────┘ └────────────┘ └─────────────────┘     │               │
│  └───────────────────────────────────────────────────────────┘               │
│                      │ spawns container / VM                                 │
│                      ▼                                                       │
├──────────────────────────────────────────────────────────────────────────────┤
│                      CONTAINER / VM (Linux)                                  │
├──────────────────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                         AGENT RUNNER                                   │  │
│  │                                                                        │  │
│  │  Working directory: /workspace/group (mounted from host/S3)            │  │
│  │  Volume mounts:                                                        │  │
│  │    • groups/{name}/ → /workspace/group                                 │  │
│  │    • groups/global/ → /workspace/global/ (non-main only)               │  │
│  │    • data/sessions/{group}/.claude/ → /home/bun/.claude/               │  │
│  │    • project root → /workspace/project (read-only, main only)          │  │
│  │    • Additional dirs → /workspace/extra/*                              │  │
│  │                                                                        │  │
│  │  Tools (via Claude Code CLI):                                          │  │
│  │    • Bash, Read, Write, Edit, Glob, Grep (sandboxed)                   │  │
│  │    • WebSearch, WebFetch (internet access)                             │  │
│  │    • agent-browser (browser automation via Chromium)                    │  │
│  │    • mcp__omniclaw__* (16 IPC tools via stdio MCP server)              │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Bun 1.x | Host process and build tool |
| WhatsApp | @whiskeysockets/baileys | WhatsApp Web protocol |
| Discord | discord.js | Discord bot integration |
| Telegram | grammy | Telegram Bot API |
| Slack | @slack/bolt + @slack/web-api | Slack Socket Mode integration |
| Message Storage | SQLite (bun:sqlite) | Store messages, groups, tasks, sessions |
| Agent SDK | @anthropic-ai/claude-agent-sdk | Run Claude with tools and MCP servers |
| Browser | agent-browser + Chromium | Web interaction and screenshots |
| Cloud IPC | S3 (Backblaze B2) | Inter-agent communication for cloud backends |
| Effect System | Effect | Structured error handling and observability |
| Logging | Pino (structured JSON) | Runtime logging |

---

## Folder Structure

```
omniclaw/
├── CLAUDE.md                      # Project context for Claude Code
├── docs/
│   ├── SPEC.md                    # This specification document
│   ├── ROADMAP.md                 # Product roadmap
│   ├── REQUIREMENTS.md            # Architecture decisions and philosophy
│   ├── SECURITY.md                # Security model
│   └── *.md                       # Additional docs (networking, debugging, etc.)
├── README.md                      # User documentation
├── package.json                   # Bun dependencies
├── tsconfig.json                  # TypeScript configuration
├── vitest.config.ts               # Test configuration
├── bunfig.toml                    # Bun configuration
├── Justfile                       # Task runner commands
│
├── src/
│   ├── index.ts                   # Orchestrator: state, message loop, agent invocation
│   ├── config.ts                  # Configuration constants and env vars
│   ├── types.ts                   # TypeScript interfaces (Channel, Agent, ChannelRoute, etc.)
│   ├── db.ts                      # SQLite database initialization and queries
│   ├── router.ts                  # Message formatting and outbound routing
│   ├── logger.ts                  # Pino structured logger setup
│   ├── ipc-snapshots.ts           # Task and group snapshot utilities for IPC
│   ├── ipc.ts                     # IPC watcher and task/message processing
│   ├── ipc-file-security.ts       # IPC file intake hardening (symlink, TOCTOU, size)
│   ├── file-transfer.ts           # Push/pull file transfers between agents
│   ├── path-security.ts           # Shared path traversal prevention
│   ├── mount-security.ts          # Mount allowlist validation for containers
│   ├── group-queue.ts             # Per-group queue with global concurrency limit
│   ├── group-helpers.ts           # Group/JID resolution utilities
│   ├── channel-routes.ts          # Agent-to-channel routing logic
│   ├── agents.ts                  # Agent registry and cloud agent discovery
│   ├── task-scheduler.ts          # Runs scheduled tasks when due
│   ├── schedule-utils.ts          # Cron/interval/once schedule helpers
│   ├── thread-streaming.ts        # Stream intermediate output to channel threads
│   ├── whatsapp-auth.ts           # Standalone WhatsApp QR authentication
│   │
│   ├── channels/
│   │   ├── whatsapp.ts            # WhatsApp channel (baileys)
│   │   ├── discord.ts             # Discord channel (discord.js)
│   │   ├── telegram.ts            # Telegram channel (grammy)
│   │   ├── slack.ts               # Slack channel (bolt, Socket Mode)
│   │   └── utils.ts               # Shared channel utilities (splitMessage, safeJsonParse)
│   │
│   ├── backends/
│   │   ├── index.ts               # Backend initialization and resolution
│   │   ├── types.ts               # Backend interfaces (ContainerInput, ContainerOutput, Backend)
│   │   ├── local-backend.ts       # Apple Container + Docker backend
│   │   ├── sprites-backend.ts     # Sprites (Fly.io) cloud backend
│   │   ├── sprites-ipc-poller.ts  # S3-based IPC polling for Sprites
│   │   ├── sprites-provisioning.ts# Sprites VM provisioning
│   │   ├── daytona-backend.ts     # Daytona dev environment backend
│   │   ├── daytona-ipc-poller.ts  # S3-based IPC polling for Daytona
│   │   ├── daytona-provisioning.ts# Daytona workspace provisioning
│   │   ├── railway-backend.ts     # Railway cloud backend
│   │   ├── railway-api.ts         # Railway API client
│   │   ├── hetzner-backend.ts     # Hetzner Cloud backend
│   │   ├── hetzner-api.ts         # Hetzner API client
│   │   └── stream-parser.ts       # Container output stream parsing
│   │
│   ├── s3/
│   │   ├── client.ts              # S3 client (Backblaze B2)
│   │   ├── ipc-poller.ts          # S3-based IPC polling for cloud agents
│   │   ├── file-sync.ts           # File synchronization to/from S3
│   │   └── types.ts               # S3 types
│   │
│   ├── effect/
│   │   ├── logger-layer.ts        # Effect-based structured logging
│   │   ├── message-queue.ts       # Effect-based message queue
│   │   └── user-registry.ts       # User registry for @mention resolution
│   │
│   └── shared/
│       ├── index.ts               # Shared helper exports
│       ├── quarterplan.ts         # Quarterly planning utilities
│       └── s3-client.ts           # Shared S3 client configuration
│
├── container/
│   ├── Dockerfile                 # Container image (runs as 'bun' user)
│   ├── build.sh                   # Build script for container image
│   ├── agent-runner/              # Code that runs inside the container
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts           # Entry point (query loop, IPC polling, session resume)
│   │       └── ipc-mcp-stdio.ts   # Stdio-based MCP server (16 tools)
│   └── skills/
│       ├── agent-browser.md       # Browser automation skill
│       ├── github.md              # GitHub CLI operations
│       ├── github-pr.md           # PR review management
│       └── graphite.md            # Stacked PRs with Graphite CLI
│
├── .claude/
│   └── skills/                    # Host-side skills (for setup/management)
│       ├── setup/SKILL.md
│       ├── customize/SKILL.md
│       ├── debug/SKILL.md
│       ├── add-telegram/SKILL.md
│       └── ...
│
├── groups/
│   ├── CLAUDE.md                  # Global memory (all groups read this)
│   ├── main/                      # Self-chat (main control channel)
│   │   └── CLAUDE.md              # Main channel memory
│   └── {agent-folder}/            # Per-agent folders
│       ├── CLAUDE.md              # Agent-specific memory
│       └── *.md                   # Files created by the agent
│
├── store/                         # Local data (gitignored)
│   ├── auth/                      # WhatsApp authentication state
│   └── messages.db                # SQLite database
│
├── data/                          # Application state (gitignored)
│   ├── sessions/                  # Per-group Claude sessions (.claude/ dirs)
│   ├── env/env                    # Auth credentials for container mounting
│   └── ipc/                       # Local IPC (messages/, tasks/)
│
└── logs/                          # Runtime logs (gitignored)
    ├── omniclaw.log               # Host stdout (structured JSON)
    └── omniclaw.error.log         # Host stderr
```

---

## Configuration

Configuration constants are in `src/config.ts`. All values can be overridden via environment variables.

### Core Settings

| Variable | Default | Purpose |
|----------|---------|---------|
| `ASSISTANT_NAME` | `Omni` | Bot name and trigger pattern |
| `POLL_INTERVAL` | `2000` | Message polling interval (ms) |
| `SCHEDULER_POLL_INTERVAL` | `60000` | Task scheduler check interval (ms) |
| `IPC_POLL_INTERVAL` | `30000` | S3 IPC polling interval for cloud backends (ms) |
| `CONTAINER_TIMEOUT` | `1800000` | Container execution timeout (30min) |
| `CONTAINER_STARTUP_TIMEOUT` | `120000` | Container startup timeout (2min) |
| `IDLE_TIMEOUT` | `1800000` | Keep container alive after last result (30min) |
| `SESSION_MAX_AGE` | `14400000` | Rotate sessions after 4 hours |
| `MAX_CONCURRENT_CONTAINERS` | `8` | Global container concurrency limit |
| `MAX_TASK_CONTAINERS` | `MAX_CONCURRENT_CONTAINERS - 1` | Containers reserved for scheduled tasks |
| `CONTAINER_IMAGE` | `omniclaw-agent:latest` | Container image name |
| `CONTAINER_MEMORY` | `4G` | Container memory limit |
| `TZ` | System timezone | Timezone for scheduled tasks |

### Channel Credentials

| Variable | Required For | Purpose |
|----------|-------------|---------|
| `DISCORD_BOT_TOKEN` | Discord | Bot token |
| `TELEGRAM_BOT_TOKEN` | Telegram | Bot token |
| `TELEGRAM_ONLY` | Telegram | Run Telegram-only mode (no WhatsApp) |
| `TELEGRAM_BOT_POOL` | Telegram | Comma-separated tokens for multi-bot |
| `SLACK_BOT_TOKEN` | Slack | Bot token (xoxb-...) |
| `SLACK_APP_TOKEN` | Slack | App-level token for Socket Mode (xapp-...) |

### Backend Credentials

| Variable | Backend | Purpose |
|----------|---------|---------|
| `SPRITES_TOKEN` | Sprites | API token for Fly.io |
| `SPRITES_ORG` | Sprites | Organization name |
| `SPRITES_REGION` | Sprites | Deployment region |
| `DAYTONA_API_KEY` | Daytona | API key |
| `DAYTONA_API_URL` | Daytona | API endpoint |
| `RAILWAY_API_TOKEN` | Railway | API token |
| `HETZNER_API_TOKEN` | Hetzner | API token |
| `B2_ENDPOINT` | S3 IPC | Backblaze B2 endpoint |
| `B2_ACCESS_KEY_ID` | S3 IPC | Backblaze access key |
| `B2_SECRET_ACCESS_KEY` | S3 IPC | Backblaze secret key |
| `B2_BUCKET` | S3 IPC | S3 bucket name |

### Claude Authentication

Configure in `.env` (project root):

**Option 1: Claude Subscription (OAuth)**
```bash
# Option 1: Claude Subscription (OAuth token)
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

# Option 2: Pay-per-use API Key
ANTHROPIC_API_KEY=sk-ant-api03-...
```

Only auth variables are extracted to `data/env/env` and mounted into containers at `/workspace/env-dir/env`. Other `.env` variables are not exposed to agents.

### Container Configuration

Groups can have additional directories mounted via `containerConfig`:

```typescript
containerConfig: {
  additionalMounts: [
    {
      hostPath: "~/projects/webapp",
      containerPath: "webapp",  // Appears at /workspace/extra/webapp
      readonly: false,
    },
  ],
  timeout: 600000,
  memory: 4096,  // MB
}
```

---

## Channels

OmniClaw supports 4 messaging platforms simultaneously. Channels are abstracted via the `Channel` interface.

### Channel Interface

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string, replyToMessageId?: string): Promise<string | void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  createThread?(jid: string, messageId: string, name: string): Promise<any>;
  sendToThread?(thread: any, text: string): Promise<void>;
  addReaction?(jid: string, messageId: string, emoji: string): Promise<void>;
  removeReaction?(jid: string, messageId: string, emoji: string): Promise<void>;
  prefixAssistantName?: boolean;
}
```

### Supported Channels

| Channel | Library | JID Format | Features |
|---------|---------|------------|----------|
| WhatsApp | baileys | `123@s.whatsapp.net`, `123@g.us` | Messages, reactions, typing, groups |
| Discord | discord.js | `dc:channel_id` | Messages, reactions, typing, threads, guild context |
| Telegram | grammy | `tg:chat_id` | Messages, reactions, typing, groups, DMs |
| Slack | @slack/bolt | `slack:channel_id` | Messages, typing, Socket Mode, threads |

### Trigger Behavior

- **Main group**: No trigger needed (all messages processed)
- **Groups with `requiresTrigger: false`**: All messages processed (1-on-1 or solo chats)
- **Other groups** (default): Messages must start with `@AssistantName` to be processed
- Per-group triggers supported (e.g., `@OmarOmni`, `@PeytonOmni`)

---

## Backends

Agents can run on different infrastructure via the backend abstraction layer.

### Backend Interface

All backends implement the `Backend` interface from `src/backends/types.ts`:

```typescript
interface Backend {
  type: BackendType;
  runAgent(input: ContainerInput): Promise<ContainerOutput>;
  isAvailable(): boolean;
  shutdown(): Promise<void>;
}
```

### Supported Backends

| Backend | Type | Environment | Use Case |
|---------|------|-------------|----------|
| Apple Container | `apple-container` | macOS (local) | Development, local agents |
| Docker | `docker` | Any (local) | Cross-platform local execution |
| Sprites | `sprites` | Fly.io (cloud) | Production 24/7 agents |
| Daytona | `daytona` | Daytona (cloud) | Dev environments |
| Railway | `railway` | Railway (cloud) | Cloud deployment |
| Hetzner | `hetzner` | Hetzner (cloud) | Budget cloud VMs |

### Backend Selection

Each agent has a `backend` field that determines where it runs:

```typescript
interface Agent {
  id: string;
  backend: BackendType;  // 'apple-container' | 'sprites' | 'daytona' | ...
  // ...
}
```

The orchestrator calls `resolveBackend(agent.backend)` to get the appropriate backend implementation, then invokes `backend.runAgent(input)`.

### Cloud IPC

Cloud backends (Sprites, Daytona) use S3-based IPC via Backblaze B2:
- Agents write IPC messages/tasks to S3
- Host polls S3 for new messages at `IPC_POLL_INTERVAL`
- File sync pushes workspace files to S3 for cloud agents
- Separate IPC pollers per backend (`sprites-ipc-poller.ts`, `daytona-ipc-poller.ts`)

---

## Agent-Channel Model

OmniClaw decouples **agents** from **channels** via a routing layer. One agent can serve multiple channels.

### Agent

```typescript
interface Agent {
  id: string;                // "main", "omniaura-discord"
  name: string;
  folder: string;            // Workspace folder
  backend: BackendType;
  containerConfig?: ContainerConfig;
  heartbeat?: HeartbeatConfig;
  isAdmin: boolean;          // Main agent = true
  isLocal: boolean;          // Runs on local machine
  serverFolder?: string;     // Shared server context
}
```

### Channel Route

```typescript
interface ChannelRoute {
  channelJid: string;        // "dc:123", "tg:-100...", "123@g.us"
  agentId: string;           // FK to Agent.id
  trigger: string;
  requiresTrigger: boolean;
  discordGuildId?: string;
}
```

Multiple `ChannelRoute` entries can point to the same `Agent`. For example, a Telegram DM and a Telegram group can both route to the same agent, sharing one container and workspace.

---

## Memory System

OmniClaw uses a hierarchical memory system based on CLAUDE.md files.

### Memory Hierarchy

| Level | Location | Read By | Written By | Purpose |
|-------|----------|---------|------------|---------|
| **Global** | `groups/CLAUDE.md` | All agents | Main only | Shared preferences, facts, context |
| **Agent** | `groups/{folder}/CLAUDE.md` | That agent | That agent | Agent-specific context and memory |
| **Files** | `groups/{folder}/*.md` | That agent | That agent | Notes, research, documents |
| **Server** | `groups/servers/{guild}/` | Guild agents | Guild agents | Shared Discord server context |

### How Memory Works

1. Agent runs with `cwd` set to `groups/{agent-folder}/`
2. Claude Agent SDK with `settingSources: ['project']` loads:
   - `../CLAUDE.md` (parent = global memory)
   - `./CLAUDE.md` (current = agent memory)
3. Agent can write to `./CLAUDE.md` and create files in the workspace

### Main Channel Privileges

- Write to global memory
- Manage registered groups, agents, and channel routes
- Schedule tasks for any group
- Configure additional directory mounts
- Access project root (read-only)

---

## Session Management

### How Sessions Work

1. Each agent has a session ID stored in SQLite (`sessions` table, keyed by `group_folder`)
2. Session ID is passed to Claude Agent SDK's `resume` option
3. Claude continues the conversation with full context
4. Sessions auto-rotate after `SESSION_MAX_AGE` (4 hours) to prevent unbounded context growth
5. Session transcripts stored as JSONL files in `data/sessions/{group}/.claude/`

### Container Resume

Agents support `resumeAt` persistence — the byte offset is saved so subsequent invocations skip replaying the full session transcript. This prevents slow startup times for agents with long histories.

---

## Message Flow

### Incoming Message Flow

```
1. User sends message on any platform (WhatsApp / Discord / Telegram / Slack)
   │
   ▼
2. Platform-specific channel receives and normalizes the message
   │ (WhatsApp: baileys event, Discord: messageCreate, Telegram: grammy, Slack: bolt)
   │
   ▼
3. Channel calls onInbound callback → message stored in SQLite
   │
   ▼
4. Message loop polls SQLite (every 2 seconds)
   │
   ▼
5. Channel route resolution:
   ├── resolveAgentForChannel(jid) → find the Agent for this channel
   ├── Check trigger pattern (per-group trigger or global)
   └── No route or no trigger match → ignore
   │
   ▼
6. Conversation catch-up:
   ├── Fetch all messages since last agent interaction
   ├── Format as XML with timestamps, sender names, participant roster
   └── Build prompt with full conversation context
   │
   ▼
7. Backend resolution and agent invocation:
   ├── resolveBackend(agent.backend) → get backend implementation
   ├── backend.runAgent({prompt, sessionId, groupFolder, ...})
   └── Container spawned with mounted workspace + IPC MCP server
   │
   ▼
8. Agent processes message:
   ├── Reads CLAUDE.md files for context
   ├── Uses tools as needed (Bash, WebSearch, agent-browser, etc.)
   └── Writes response via stdout stream
   │
   ▼
9. Response routing:
   ├── Strip <internal> tags
   ├── Prefix with agent name (platform-dependent)
   └── Route to correct channel via routeOutbound()
```

### Conversation Catch-Up

When a triggered message arrives, the agent receives all messages since its last interaction, formatted as XML:

```xml
<messages participants="John, Sarah">
<message id="msg1" sender="John" time="2026-02-23T14:32:00Z">hey everyone, should we do pizza tonight?</message>
<message id="msg2" sender="Sarah" time="2026-02-23T14:33:00Z">sounds good to me</message>
<message id="msg3" sender="John" time="2026-02-23T14:35:00Z">@Omni what toppings do you recommend?</message>
</messages>
```

---

## Scheduled Tasks

### How Scheduling Works

1. **Agent Context**: Tasks run with their group's working directory and memory
2. **Full Agent Capabilities**: Scheduled tasks have access to all tools
3. **Context Modes**: `group` (with conversation history) or `isolated` (fresh session)
4. **Duplicate Prevention**: Active task tracking prevents concurrent duplicate runs
5. **Idle Preemption**: Idle containers are preempted when a scheduled task needs to run

### Schedule Types

| Type | Value Format | Example |
|------|--------------|---------|
| `cron` | Cron expression (local time) | `0 9 * * 1` (Mondays at 9am) |
| `interval` | Milliseconds | `3600000` (every hour) |
| `once` | Local ISO timestamp (no Z suffix) | `2026-12-25T09:00:00` |

### Heartbeat System

Agents can have recurring background tasks via the heartbeat config:

```typescript
heartbeat: {
  enabled: true,
  interval: "1800000",     // 30 minutes
  scheduleType: "interval"
}
```

The heartbeat reads `## Goals` and `## Heartbeat` sections from the agent's CLAUDE.md.

---

## MCP Tools

The `omniclaw` MCP server runs inside each container via stdio, providing 16 tools:

### Task Management

| Tool | Purpose |
|------|---------|
| `send_message` | Send a message to the group (supports multi-channel routing) |
| `schedule_task` | Schedule a recurring or one-time task |
| `list_tasks` | Show tasks (group's tasks, or all if main) |
| `pause_task` | Pause a task |
| `resume_task` | Resume a paused task |
| `cancel_task` | Delete a task |

### Messaging & Reactions

| Tool | Purpose |
|------|---------|
| `send_message` | Send a message to the current channel |
| `react_to_message` | Add/remove emoji reaction on a message |
| `format_mention` | Format an @mention for the current platform |

### Heartbeat & Groups

| Tool | Purpose |
|------|---------|
| `configure_heartbeat` | Enable/disable heartbeat for a group |
| `register_group` | Register a new group/channel |

### Inter-Agent Communication

| Tool | Purpose |
|------|---------|
| `share_request` | Request/share context or files with another agent |
| `delegate_task` | Delegate a task to the local (admin) agent |
| `request_context` | Request shared context topics |
| `read_context` | Read a shared context topic |
| `list_context_topics` | List available shared context topics |
| `list_agents` | List all registered agents |

---

## Inter-Agent Communication

OmniClaw supports multi-agent topologies where agents communicate and coordinate.

### Communication Patterns

1. **Direct Messaging** — Send messages to specific agents via `send_message` with agent JID
2. **Context Sharing** — `share_request` to push/pull files and context between agents
3. **Task Delegation** — `delegate_task` to request the local agent perform local-only tasks
4. **Shared Context Storage** — Topics stored at `/workspace/ipc/context/`, readable by all agents

### Agent Registry

All agents are registered in `/workspace/ipc/agent_registry.json`:

```json
{
  "agents": [
    {
      "id": "main",
      "name": "PeytonOmni",
      "jid": "...",
      "backend": "sprites",
      "description": "Main orchestrator"
    }
  ]
}
```

### Example: Local-Cloud Coordination

```
Code Review Request:
1. PeytonOmni (Cloud/Sprites) — Fetch PR, analyze changes
2. Delegate to LocalOmni — "Run tests locally"
3. LocalOmni (Apple Container) — Checkout branch, run tests
4. Share results back — via IPC context
5. PeytonOmni (Cloud) — Post review with test results
```

---

## Deployment

### Local Deployment (macOS)

Run as a macOS launchd service:

```bash
# Install
cp launchd/com.omniclaw.plist ~/Library/LaunchAgents/

# Start
launchctl load ~/Library/LaunchAgents/com.omniclaw.plist

# Stop
launchctl unload ~/Library/LaunchAgents/com.omniclaw.plist

# Check status
launchctl list | grep omniclaw

# Logs
tail -f logs/omniclaw.log
```

### Cloud Deployment (Sprites)

Sprites agents run on Fly.io VMs:
- Persistent VMs (not serverless) — 24/7 availability
- Workspace synced via S3 (Backblaze B2)
- IPC messages polled from S3
- Auto health checks and restart

### Startup Sequence

1. Initialize SQLite database (migrate schemas if needed)
2. Load state: registered groups, agents, channel routes, sessions
3. Initialize backends (`initializeBackends()`)
4. Connect all configured channels (WhatsApp, Discord, Telegram, Slack)
5. On channel connection:
   - Start scheduler loop
   - Start IPC watcher (local file-based)
   - Start S3 IPC poller (if cloud backends configured)
   - Set up per-group message queue
   - Reconcile heartbeats
   - Start message polling loop

---

## Security Considerations

See [SECURITY.md](./SECURITY.md) for the complete security model. Key points:

### Container Isolation (Primary Boundary)

All agents run in isolated containers (Apple Container, Docker, or cloud VMs):
- **Filesystem isolation** — Only mounted directories visible
- **Process isolation** — Container processes cannot affect host
- **Non-root execution** — Runs as unprivileged `bun` user
- **Resource limits** — `--pids-limit 256`, `--no-new-privileges`
- **Ephemeral** — Fresh environment per invocation (`--rm`)

### Read-Only Project Root

Main group's project root mounted read-only at `/workspace/project`. Prevents container escape via code modification.

### Mount Security

- External allowlist at `~/.config/omniclaw/mount-allowlist.json` (never mounted into containers)
- Default blocked patterns: `.ssh`, `.gnupg`, `.aws`, `.env`, `credentials`, `private_key`, etc.
- Symlink resolution before validation
- Path traversal prevention in all backends

### IPC File Security

- Symlink rejection with `O_NOFOLLOW`
- TOCTOU guard (stat → read race protection)
- 1 MiB file size limit
- Chunked reads
- JSON validation

### Secret Protection

- `.env` mounted as `/dev/null` overlay in containers
- Bash hook blocks `/proc/*/environ` access
- Read hook blocks `.env` file access
- Only auth tokens extracted to `data/env/env`

### Path Traversal Prevention

Multi-layer defense across:
- IPC handlers (`ipc-file-security.ts`)
- File transfer (`file-transfer.ts`)
- All backends (`path-security.ts`)
- Mount validation (`mount-security.ts`)
- Image attachment paths in `buildContent`

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| No response to messages | Service not running | Check `launchctl list \| grep omniclaw` |
| Agent timeout | Container startup stuck | Check `CONTAINER_STARTUP_TIMEOUT` (default 2min) |
| Slow session resume | Large session transcript | `resumeAt` should be persisted; check session age |
| Session not continuing | Session expired | Sessions rotate after `SESSION_MAX_AGE` (4 hours) |
| "QR code expired" | WhatsApp session expired | Delete `store/auth/` and restart |
| Cloud agent not responding | S3 IPC issue | Check B2 credentials and `s3/ipc-poller.ts` logs |
| Multiple containers for same agent | Multi-channel duplicate spawn | Fixed by agent-channel model (one container per agent folder) |

### Log Location

- `logs/omniclaw.log` — structured JSON stdout
- `logs/omniclaw.error.log` — stderr
- Per-container: `groups/{folder}/logs/container-*.log`

### Debug Mode

```bash
bun run dev
# or
bun run src/index.ts
```
