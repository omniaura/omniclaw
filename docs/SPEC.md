# OmniClaw Specification

A personal AI assistant framework accessible via WhatsApp, Discord, Telegram, and Slack — with persistent memory per conversation, scheduled tasks, multiple compute backends, and inter-agent communication.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Folder Structure](#folder-structure)
3. [Configuration](#configuration)
4. [Memory System](#memory-system)
5. [Session Management](#session-management)
6. [Message Flow](#message-flow)
7. [Commands](#commands)
8. [Scheduled Tasks](#scheduled-tasks)
9. [MCP Servers](#mcp-servers)
10. [Deployment](#deployment)
11. [Security Considerations](#security-considerations)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          HOST (macOS / Linux)                            │
│                       (Main Bun/TypeScript Process)                      │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐           │
│  │  WhatsApp  │ │  Discord   │ │  Telegram  │ │   Slack    │           │
│  │ (baileys)  │ │(discord.js)│ │  (grammY)  │ │  (bolt)    │           │
│  └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └─────┬──────┘           │
│        └───────────────┴───────┬──────┴───────────────┘                  │
│                                │ Channel interface                       │
│                                ▼                                         │
│                   ┌────────────────────────┐                             │
│                   │    SQLite Database      │                             │
│                   │    (messages.db)        │                             │
│                   └────────────┬───────────┘                             │
│                                │                                         │
│     ┌──────────────────────────┼──────────────────────┐                  │
│     │                          │                      │                  │
│     ▼                          ▼                      ▼                  │
│  ┌──────────────┐  ┌──────────────────┐  ┌───────────────┐              │
│  │ Message Loop │  │ Scheduler Loop   │  │  IPC Watcher  │              │
│  │ (polls DB)   │  │ (checks tasks)   │  │  (file/S3)    │              │
│  └──────┬───────┘  └────────┬─────────┘  └───────────────┘              │
│         │                   │                                            │
│         └─────────┬─────────┘                                            │
│                   │ routes to backend                                    │
│                   ▼                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    BACKEND ABSTRACTION                           │    │
│  │  ┌────────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌───────┐ │    │
│  │  │   Local    │ │ Sprites │ │ Daytona │ │ Railway │ │Hetzner│ │    │
│  │  │(Apple/Dock)│ │ (cloud) │ │ (cloud) │ │ (cloud) │ │(cloud)│ │    │
│  │  └────────────┘ └─────────┘ └─────────┘ └─────────┘ └───────┘ │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│                     AGENT CONTAINER (Linux VM)                           │
├──────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                    AGENT RUNNER                               │       │
│  │                                                               │       │
│  │  Working directory: /workspace/group (mounted from host)      │       │
│  │  Volume mounts:                                               │       │
│  │    • groups/{name}/ → /workspace/group                        │       │
│  │    • groups/global/ → /workspace/global/ (non-main only)      │       │
│  │    • data/sessions/{group}/.claude/ → /home/bun/.claude/      │       │
│  │    • Additional dirs → /workspace/extra/*                     │       │
│  │                                                               │       │
│  │  Tools (all groups):                                          │       │
│  │    • Bash (safe — sandboxed in container)                     │       │
│  │    • Read, Write, Edit, Glob, Grep (file operations)          │       │
│  │    • WebSearch, WebFetch (internet access)                    │       │
│  │    • agent-browser (browser automation)                       │       │
│  │    • mcp__omniclaw__* (16 IPC tools, see MCP section)         │       │
│  │                                                               │       │
│  └──────────────────────────────────────────────────────────────┘       │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Bun | Host process, build, test, package management |
| WhatsApp | @whiskeysockets/baileys | WhatsApp Web protocol |
| Discord | discord.js | Discord bot gateway |
| Telegram | grammY | Telegram Bot API |
| Slack | @slack/bolt + @slack/web-api | Slack Socket Mode |
| Message Storage | SQLite (bun:sqlite) | Messages, groups, tasks, sessions, routing |
| Local Backend | Apple Container / Docker | Isolated Linux VMs on the host machine |
| Cloud Backends | Sprites, Daytona, Railway, Hetzner | Remote agent execution |
| Agent | Claude Agent SDK | Run Claude with tools and MCP servers |
| Cloud IPC | Backblaze B2 (S3-compatible) | IPC for cloud-backed agents |
| Browser | agent-browser + Chromium | Web interaction and screenshots |
| Structured Effects | Effect-TS | Message queue, user registry |
| Structured Logging | Pino | JSON log output |

### Key Abstractions

**Channel** (`src/types.ts: Channel`): Unified interface for messaging platforms. Each channel adapter (WhatsApp, Discord, Telegram, Slack) implements `connect()`, `sendMessage()`, `ownsJid()`, and optional features like typing indicators, threads, and reactions.

**AgentBackend** (`src/backends/types.ts`): Unified interface for agent execution environments. Each backend implements `runAgent()`, `sendMessage()`, `readFile()`, `writeFile()`. Local backends use Apple Container/Docker with file-based IPC; cloud backends use S3-based IPC.

**Agent / ChannelRoute** (`src/types.ts`): Decoupled model where Agents are compute entities and ChannelRoutes map channel JIDs to agents. Multiple channels can route to the same agent.

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
├── package.json                   # Bun/Node.js dependencies
├── tsconfig.json                  # TypeScript configuration
├── .mcp.json                      # MCP server configuration (reference)
│
├── src/
│   ├── index.ts                   # Orchestrator: state, message loop, agent invocation
│   ├── channels/
│   │   ├── whatsapp.ts            # WhatsApp adapter (baileys)
│   │   ├── discord.ts             # Discord adapter (discord.js)
│   │   ├── telegram.ts            # Telegram adapter (grammY)
│   │   ├── slack.ts               # Slack adapter (bolt)
│   │   └── utils.ts               # Shared channel utilities
│   ├── backends/
│   │   ├── index.ts               # Backend factory and resolution
│   │   ├── types.ts               # AgentBackend interface, ContainerInput/Output
│   │   ├── local-backend.ts       # Apple Container / Docker backend
│   │   ├── sprites-backend.ts     # Sprites cloud backend
│   │   ├── daytona-backend.ts     # Daytona cloud backend
│   │   ├── railway-backend.ts     # Railway cloud backend
│   │   ├── hetzner-backend.ts     # Hetzner cloud backend
│   │   ├── stream-parser.ts       # Parse streaming agent output
│   │   ├── sprites-ipc-poller.ts  # S3 IPC polling for Sprites
│   │   ├── daytona-ipc-poller.ts  # S3 IPC polling for Daytona
│   │   └── *-provisioning.ts      # Cloud resource provisioning
│   ├── effect/
│   │   ├── message-queue.ts       # Effect-TS based message queue
│   │   ├── user-registry.ts       # User identity registry
│   │   └── logger-layer.ts        # Effect logger layer
│   ├── shared/
│   │   └── *.ts                   # Shared utilities
│   ├── s3/
│   │   ├── client.ts              # S3/B2 client for cloud IPC
│   │   ├── file-sync.ts           # File synchronization via S3
│   │   ├── ipc-poller.ts          # S3 IPC message polling
│   │   └── types.ts               # S3 types
│   ├── ipc.ts                     # IPC watcher and task processing
│   ├── router.ts                  # Message formatting and outbound routing
│   ├── agents.ts                  # Agent CRUD operations
│   ├── channel-routes.ts          # Channel → Agent routing
│   ├── config.ts                  # Configuration constants
│   ├── types.ts                   # TypeScript interfaces
│   ├── logger.ts                  # Pino structured logger
│   ├── db.ts                      # SQLite database (tables, queries)
│   ├── group-queue.ts             # Per-group queue with global concurrency limit
│   ├── group-helpers.ts           # Group utility functions
│   ├── mount-security.ts          # Mount allowlist validation
│   ├── path-security.ts           # Path traversal protection
│   ├── ipc-file-security.ts       # IPC file intake hardening
│   ├── file-transfer.ts           # Agent file transfer support
│   ├── task-scheduler.ts          # Scheduled task execution
│   ├── schedule-utils.ts          # Cron/interval utilities
│   ├── thread-streaming.ts        # Stream intermediate output to threads
│   ├── container-runner.ts        # Legacy container runner (local backend)
│   ├── telegram.ts                # Legacy Telegram support
│   └── whatsapp-auth.ts           # Standalone WhatsApp authentication
│
├── container/
│   ├── Dockerfile                 # Container image (Bun runtime, Claude Code CLI)
│   ├── build.sh                   # Build script for container image
│   ├── agent-runner/              # Code that runs inside the container
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts           # Entry point (query loop, IPC polling, session resume)
│   │       └── ipc-mcp-stdio.ts   # Stdio MCP server (16 tools for host communication)
│   └── skills/
│       └── agent-browser.md       # Browser automation skill
│
├── .claude/skills/                # Claude Code skills for setup and customization
│
├── groups/                        # Per-group workspaces
│   ├── CLAUDE.md                  # Global memory (all groups read this)
│   ├── main/                      # Admin/control channel
│   └── {folder}/                  # Per-group folders
│
├── store/                         # Local data (gitignored)
│   ├── auth/                      # WhatsApp authentication state
│   └── messages.db                # SQLite database
│
├── data/                          # Application state (gitignored)
│   ├── sessions/                  # Per-group session data
│   ├── env/env                    # Auth credentials for container mounting
│   └── ipc/                       # Local container IPC (messages/, tasks/)
│
├── logs/                          # Runtime logs (gitignored)
│
└── launchd/
    └── com.omniclaw.plist         # macOS service configuration
```

---

## Configuration

Configuration constants are in `src/config.ts`:

```typescript
export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Omni';

// Channel tokens
export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
export const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || '';

// Core intervals
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Container configuration
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || 'omniclaw-agent:latest';
export const CONTAINER_TIMEOUT = 1800000;      // 30min default
export const CONTAINER_MEMORY = '4G';
export const MAX_CONCURRENT_CONTAINERS = 8;
export const SESSION_MAX_AGE = 14400000;        // 4 hours — auto-rotate sessions

// Cloud backend configs: SPRITES_TOKEN, DAYTONA_API_KEY, RAILWAY_API_TOKEN, HETZNER_API_TOKEN
// S3/B2 storage: B2_ENDPOINT, B2_ACCESS_KEY_ID, B2_SECRET_ACCESS_KEY, B2_BUCKET
```

**Note:** Paths must be absolute for container volume mounts to work correctly.

### Container Configuration

Groups/agents can have additional directories mounted via `containerConfig`. Example:

```typescript
containerConfig: {
  additionalMounts: [
    { hostPath: "~/projects/webapp", containerPath: "webapp", readonly: false }
  ],
  timeout: 600000,
  memory: 4096,
}
```

Additional mounts appear at `/workspace/extra/{containerPath}` inside the container. A mount allowlist at `~/.config/omniclaw/mount-allowlist.json` restricts which host paths can be mounted.

### Backend Configuration

Each agent can specify its compute backend:

| Backend | Config | Use Case |
|---------|--------|----------|
| `apple-container` | Default, no extra config | macOS local execution |
| `docker` | Uses same LocalBackend | Linux/cross-platform local execution |
| `sprites` | `SPRITES_TOKEN`, `SPRITES_ORG` | Cloud VMs (persistent, always-on) |
| `daytona` | `DAYTONA_API_KEY`, `DAYTONA_API_URL` | Cloud dev environments |
| `railway` | `RAILWAY_API_TOKEN` | Railway cloud deployment |
| `hetzner` | `HETZNER_API_TOKEN` | Hetzner cloud servers |

### Claude Authentication

Configure in `.env`:

```bash
# Option 1: Claude Subscription (OAuth token)
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...

# Option 2: Pay-per-use API Key
ANTHROPIC_API_KEY=sk-ant-api03-...
```

Only auth variables are extracted and mounted into containers at `/workspace/env-dir/env`.

---

## Memory System

OmniClaw uses a hierarchical memory system based on CLAUDE.md files.

### Memory Hierarchy

| Level | Location | Read By | Written By | Purpose |
|-------|----------|---------|------------|---------|
| **Global** | `groups/CLAUDE.md` | All groups | Main only | Preferences, facts, context shared across all conversations |
| **Group** | `groups/{name}/CLAUDE.md` | That group | That group | Group-specific context, conversation memory |
| **Server** | `groups/servers/{server}/` | Channels in server | Those channels | Shared context across Discord channels in the same server |
| **Files** | `groups/{name}/*.md` | That group | That group | Notes, research, documents created during conversation |

### How Memory Works

1. **Agent Context Loading**
   - Agent runs with `cwd` set to `groups/{group-name}/`
   - Claude Agent SDK with `settingSources: ['project']` automatically loads:
     - `../CLAUDE.md` (parent directory = global memory)
     - `./CLAUDE.md` (current directory = group memory)

2. **Writing Memory**
   - When user says "remember this", agent writes to `./CLAUDE.md`
   - Agent can create files in the group folder

3. **Inter-Agent Context Sharing**
   - `share_request` — request context from another agent or admin
   - `delegate_task` — delegate work to the local admin agent
   - `request_context` / `read_context` / `list_context_topics` — read shared context storage

---

## Session Management

Sessions enable conversation continuity.

1. Each group has a session ID stored in SQLite (`sessions` table, keyed by `group_folder`)
2. Session ID is passed to Claude Agent SDK's `resume` option
3. Sessions auto-rotate after `SESSION_MAX_AGE` (4 hours) to prevent unbounded context growth
4. Session transcripts are stored as JSONL files in `data/sessions/{group}/.claude/`

---

## Message Flow

### Incoming Message Flow

```
1. User sends message on any channel (WhatsApp, Discord, Telegram, Slack)
   │
   ▼
2. Channel adapter receives message via platform SDK
   │
   ▼
3. Message stored in SQLite (store/messages.db) via onInboundMessage callback
   │
   ▼
4. Message loop polls SQLite (every 2 seconds)
   │
   ▼
5. Router checks:
   ├── Is chat_jid in registered groups? → No: ignore
   └── Does message match trigger pattern? → No: store but don't process
   │       (configurable per-group: requiresTrigger, autoRespondToQuestions, autoRespondKeywords)
   ▼
6. Router catches up conversation:
   ├── Fetch all messages since last agent interaction
   ├── Format with timestamp and sender name
   └── Build prompt with full conversation context
   │
   ▼
7. Backend resolves and runs agent:
   ├── cwd: groups/{group-name}/
   ├── prompt: conversation history + current message
   ├── resume: session_id (for continuity)
   └── mcpServers: omniclaw (16 IPC tools)
   │
   ▼
8. Agent processes message, uses tools as needed
   │
   ▼
9. Response routed back via the originating channel
   │
   ▼
10. Router updates last agent timestamp and saves session ID
```

### Trigger Word Matching

Messages must match the group's trigger pattern (default: `@{ASSISTANT_NAME}`):
- `@Omni what's the weather?` → triggers
- `@omni help me` → triggers (case insensitive)
- `Hey @Omni` → ignored (trigger not at start)
- `What's up?` → ignored (unless `autoRespondToQuestions` is enabled)

### Conversation Catch-Up

When triggered, the agent receives all messages since its last interaction in that chat, formatted with timestamps and sender names.

---

## Commands

### Commands Available in Any Group

| Command | Effect |
|---------|--------|
| `@Assistant [message]` | Talk to the agent |

### Commands Available in Main Channel Only

| Command | Effect |
|---------|--------|
| `@Assistant add group "Name"` | Register a new group |
| `@Assistant remove group "Name"` | Unregister a group |
| `@Assistant list groups` | Show registered groups |

---

## Scheduled Tasks

OmniClaw has a built-in scheduler that runs tasks as full agents in their group's context.

### How Scheduling Works

1. **Group Context**: Tasks run with their group's working directory and memory
2. **Full Agent Capabilities**: Access to all tools (web search, file operations, bash, browser)
3. **Context Modes**: `group` (runs with chat history) or `isolated` (fresh session)
4. **Optional Messaging**: Tasks can send messages via `send_message`, or complete silently
5. **Heartbeat**: Groups can have a recurring heartbeat task (configurable interval/cron)

### Schedule Types

| Type | Value Format | Example |
|------|--------------|---------|
| `cron` | Cron expression | `0 9 * * 1` (Mondays at 9am) |
| `interval` | Milliseconds | `3600000` (every hour) |
| `once` | Local ISO timestamp (no Z) | `2025-12-25T09:00:00` |

---

## MCP Servers

### OmniClaw MCP (built-in)

The `omniclaw` MCP server runs as a stdio process inside the agent container, communicating with the host via file-based IPC (local) or S3 (cloud).

**Available Tools (16):**

| Tool | Purpose |
|------|---------|
| `send_message` | Send a message to the group (supports multi-channel routing) |
| `schedule_task` | Schedule a recurring or one-time task |
| `list_tasks` | Show tasks (group's tasks, or all if main) |
| `pause_task` | Pause a task |
| `resume_task` | Resume a paused task |
| `cancel_task` | Delete a task |
| `configure_heartbeat` | Enable/disable/configure group heartbeat |
| `register_group` | Register a new group/channel (main only) |
| `share_request` | Request context from another agent or admin |
| `delegate_task` | Delegate work to the local admin agent |
| `request_context` | Request context from admin (stored to shared storage) |
| `read_context` | Read shared context by topic |
| `list_context_topics` | List available shared context topics |
| `list_agents` | List all registered agents |
| `react_to_message` | Add/remove emoji reaction (Discord only) |
| `format_mention` | Format a user mention for Discord |

---

## Deployment

OmniClaw runs as a single macOS launchd service (or standalone Bun process).

### Startup Sequence

1. **Initialize backends** — starts needed backends (Apple Container, cloud connections)
2. Initialize SQLite database
3. Load state from SQLite (registered groups, agents, sessions, routes)
4. Connect all configured channels (WhatsApp, Discord, Telegram, Slack)
5. Start scheduler loop, IPC watcher, message polling loop
6. Recover any unprocessed messages from before shutdown

### Running

```bash
# Development
bun run dev

# Production
bun run start

# Or via launchd service (macOS)
launchctl load ~/Library/LaunchAgents/com.omniclaw.plist
```

---

## Security Considerations

### Container Isolation

All agents run in isolated containers (Apple Container / Docker / cloud VMs):
- **Filesystem isolation**: Agents can only access mounted directories
- **Safe Bash access**: Commands run inside the container, not on the host
- **Process isolation**: Container processes can't affect the host
- **PID limits and no-new-privileges**: Containers restricted via `--pids-limit` and `--no-new-privileges`
- **Path traversal protection**: `readFile`/`writeFile` validate paths to prevent cross-group access
- **Mount allowlist**: Host-side allowlist restricts which directories can be mounted
- **Project root read-only**: Project source is mounted read-only to prevent container escape
- **.env blocked**: Agent containers cannot read `.env` from the project root mount

### Prompt Injection Risk

Channel messages could contain malicious instructions.

**Mitigations:**
- Container isolation limits blast radius
- Only registered groups are processed
- Trigger word required (reduces accidental processing)
- Agents can only access their group's mounted directories
- Claude's built-in safety training
- IPC file intake hardened against symlinks, oversized payloads, and TOCTOU races

### Credential Storage

| Credential | Storage Location | Notes |
|------------|------------------|-------|
| Claude CLI Auth | data/sessions/{group}/.claude/ | Per-group isolation |
| WhatsApp Session | store/auth/ | Auto-created, persists ~20 days |
| Discord Bot Token | .env (host only) | Not mounted into containers |
| Telegram Bot Token | .env (host only) | Not mounted into containers |

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| No response to messages | Service not running | Check `launchctl list \| grep omniclaw` |
| Container exit code 1 | Backend failed to start | Check logs; verify container system running |
| Session not continuing | Session rotated | Normal after 4 hours; starts fresh context |
| "QR code expired" | WhatsApp session expired | Delete store/auth/ and restart |
| "No groups registered" | Haven't added groups | Use `@Omni add group "Name"` in main |

### Log Location

- `logs/omniclaw.log` — structured JSON logs (pipe through `jq` for readability)
- `logs/omniclaw.error.log` — stderr
- `groups/{folder}/logs/container-*.log` — per-container logs

### Debug Mode

```bash
bun run dev
```
