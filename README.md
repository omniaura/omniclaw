<p align="center">
  <img src="assets/omniclaw-logo.png" alt="OmniClaw" width="800">
</p>

<p align="center">
  Multi-channel AI agent orchestrator with container isolation, a live web UI, scheduling, and trusted peer discovery.
</p>

<p align="center">
  <a href="https://github.com/omniaura/omniclaw">GitHub</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VGWXrf8x"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

OmniClaw is a Bun-based agent system for running Claude Code, OpenCode, and Codex-style agents behind real container boundaries. It routes messages from WhatsApp, Discord, Telegram, and Slack into isolated agent workspaces, exposes a Datastar-powered web dashboard, and can coordinate scheduled tasks plus trusted remote peers.

## What OmniClaw Does

- Runs one orchestrator process with SQLite state, per-agent routing, and file-based IPC
- Supports WhatsApp, Discord, Telegram, and Slack, including multi-bot routing for Discord and Slack
- Executes agents in Apple Container or Docker with explicit mounts and runtime-specific credential allowlists
- Ships a live web UI for dashboard, agents, tasks, logs, conversations, context files, IPC, network discovery, system health, and settings
- Supports recurring and one-shot scheduled tasks with run logs and task controls
- Supports trusted peer discovery so OmniClaw instances can authenticate each other and share remote agent topology
- Preserves layered context across server, category, channel, and agent folders via `CLAUDE.md`

## Quick Start

```bash
git clone https://github.com/omniaura/omniclaw.git
cd omniclaw
bun install
claude
```

For first-time setup, run `/setup` inside Claude Code.

If you are developing locally instead of using the setup skill, the main entry points are:

```bash
bun run dev
bun run typecheck
bun test
./container/build.sh
```

## Requirements

- macOS or Linux
- Bun 1.3+
- [Claude Code](https://claude.ai/download) for setup/customization workflows
- [Apple Container](https://github.com/apple/container) on macOS or Docker on macOS/Linux

## Core Concepts

### Agents, not just groups

OmniClaw now routes channels to agents. An agent has:

- an `id`, `name`, `folder`, backend, and runtime
- one or more subscribed chats/channels
- optional server/category/agent context folders
- an isolated workspace and persisted session state

Multiple chats can map to the same agent, and one server can host multiple agents.

### Layered context

Context is no longer just a single per-group file. OmniClaw supports layered `CLAUDE.md` context at multiple scopes:

- server
- category
- channel
- agent

This lets one agent inherit shared instructions while still keeping channel-specific memory and files isolated.

### Multiple runtimes

Agents can run with different runtimes depending on the task and credentials you provide:

- `claude-agent-sdk`
- `opencode`
- `codex`

### Built-in web UI

The web UI is no longer optional or hypothetical. It is part of the product and includes:

- Dashboard with topology graph and live stats
- Agents directory and agent detail pages
- Conversations browser
- Context viewer/editor
- Tasks page with create/pause/resume/delete flows
- Live logs and IPC inspector
- Network discovery and peer management
- System and settings pages

The UI is server-rendered with Datastar and uses SSE for live updates.

## Architecture

```text
Messaging channels -> router/orchestrator -> group queue -> container backend -> agent runtime
                         |                    |                |
                         v                    v                v
                      SQLite              task scheduler    file IPC
                         |
                         v
                   Datastar web UI
```

Key modules:

- `src/index.ts` - orchestrator, startup, routing, web state, scheduler wiring
- `src/channels/` - WhatsApp, Discord, Telegram, Slack adapters
- `src/backends/` - Apple Container and Docker execution backends
- `src/group-queue.ts` - per-folder execution lanes and concurrency limits
- `src/ipc.ts` - agent IPC watcher and command handling
- `src/task-scheduler.ts` - cron, interval, and one-shot task execution
- `src/db.ts` - SQLite persistence for agents, channels, messages, tasks, and state
- `src/web/` - web UI pages, image proxy/cache, SSE streams, settings, logs, and network screens
- `src/discovery/` - trusted peer auth, pairing, remote agent discovery, and sync helpers

## Security Model

OmniClaw is designed around containment, not prompt-only policy.

- Agents run in isolated containers, not in the host process
- The project root is mounted read-only
- Writable mounts are explicit and limited
- Runtime credentials are allowlisted per backend/runtime
- `.env` and other sensitive files are blocked with multiple layers of defense
- Path traversal protections are applied across file and IPC entry points
- Discovery peer auth signs and validates requests instead of trusting the LAN blindly

See `docs/SECURITY.md` for the full model.

## Channel Support

Built into the main codebase today:

- WhatsApp via Baileys
- Discord via discord.js
- Telegram via grammy
- Slack via Bolt

OmniClaw also supports multi-bot routing where a platform has more than one configured bot identity.

## Scheduling and Automation

Scheduled tasks are first-class:

- cron schedules
- interval schedules
- one-time schedules
- task run logs
- pause/resume/delete controls
- optional message delivery back into the originating chat

Tasks run as full agents with the same tool access and isolation model as interactive sessions.

## Trusted Peer Discovery

OmniClaw instances can discover and trust each other on the network.

Once paired, peers can:

- expose remote agent inventories
- proxy remote avatar and chat icon assets safely
- sync context metadata
- appear in the web UI's network and agent views

This is intended for trusted OmniClaw-to-OmniClaw collaboration, not anonymous federation.

## Configuration Notes

OmniClaw still prefers code and AI-guided setup over sprawling config files, but it is no longer accurate to describe it as having almost no configuration.

Common environment-driven areas now include:

- channel credentials and multi-bot IDs
- web UI auth, host, port, and CORS
- container image, memory, and timeout limits
- runtime model selection
- discovery and trusted-LAN settings
- GitHub webhook integration
- roster scope and role filters

The committed `.env.example` is intentionally minimal; setup and upgrade skills document the supported variables in more detail.

## Development

Useful commands:

```bash
bun run dev
bun run build
bun run typecheck
bun run format:check
bun test
```

If you change container runner sources, rebuild the agent image:

```bash
./container/build.sh
```

For Apple Container builds, flush build cache aggressively when debugging stale images:

```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

## Contributing

Good contributions:

- security fixes
- bug fixes
- clearer documentation
- better tests
- web UI improvements that match the current architecture
- operational improvements for runtimes, routing, scheduling, and discovery

Please do not assume the project is WhatsApp-only or skill-only anymore. Multi-channel support, web UI, and peer discovery are already core parts of the product.

## FAQ

### Is this still a single-process system?

Yes. The orchestrator is still one Bun process. Isolation comes from the container boundary and file-based IPC, not from splitting the host app into microservices.

### Can I use this without the web UI?

Yes, but the web UI is now an important built-in operational surface for logs, tasks, conversations, context, and peer management.

### Does OmniClaw only support Claude?

No. Claude Agent SDK remains a primary runtime, but the codebase also supports OpenCode and Codex runtimes.

### Can I run it on Linux?

Yes. Docker is the normal backend on Linux.

### Why does the README still mention Claude Code setup?

Because `/setup`, `/customize`, and `/debug` are still the intended onboarding path for many users, even though the codebase has grown far beyond the original minimal WhatsApp-only setup.

## Community

Questions or ideas? [Join the Discord](https://discord.gg/VGWXrf8x).

## License

MIT
