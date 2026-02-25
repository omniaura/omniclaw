# OmniClaw Roadmap

Last updated: 2026-02-23

## Guiding Principles

1. **Small enough to understand** — one process, a handful of source files, no microservices
2. **Security through true isolation** — OS-level containers, not application-level permissions
3. **Customization = code changes** — minimal config, fork-and-modify model
4. **AI-native development** — Claude Code guides setup, debugging, and maintenance
5. **Skills over features** — contributors build `/add-X` skills, not monolithic integrations

---

## Current Capabilities

### Channels (4)
| Channel | Adapter | Maturity | Notes |
|---------|---------|----------|-------|
| WhatsApp | baileys | Stable | Original channel, QR auth |
| Discord | discord.js | Stable | Threads, reactions, mentions, typing |
| Telegram | grammY | Stable | Bot API, no trigger prefix needed |
| Slack | @slack/bolt | Early | Socket Mode, basic messaging |

### Backends (6)
| Backend | Maturity | Notes |
|---------|----------|-------|
| Apple Container (local) | Stable | Default, macOS only |
| Docker (local) | Partial | Uses same LocalBackend, needs testing (#3) |
| Sprites (cloud) | Stable | Persistent VMs on Fly.io |

### Core Features
| Feature | Maturity | Notes |
|---------|----------|-------|
| Multi-channel routing | Stable | Agent/ChannelRoute decoupling |
| Scheduled tasks | Stable | Cron, interval, one-time; heartbeat support |
| Persistent memory | Stable | CLAUDE.md hierarchy, per-group files |
| Session management | Stable | Auto-rotation after 4 hours |
| Inter-agent communication | Stable | share_request, delegate_task, context sharing |
| Browser automation | Stable | agent-browser + Chromium in container |
| Mount security | Stable | Allowlist, path traversal protection, read-only project root |
| Structured logging | Stable | Pino JSON output, migrated from console.log |
| Thread streaming | Early | Stream intermediate output to Discord threads |

---

## Planned Work

### Near-term (Active / Next Up)

#### Versioned DB Migrations (#4)
SQLite schema changes are currently handled ad-hoc. Need a proper migration framework so schema updates are versioned, reversible, and safe to apply.

#### Docker Runtime Auto-detection (#3)
Auto-detect whether Apple Container or Docker is available, so the same codebase works on macOS and Linux without manual config.

#### Agent Runtime Agnosticism (#49)
OmniClaw is tightly coupled to Claude (Agent SDK, CLAUDE.md conventions, session resume). Define an `AgentRuntime` interface to support alternative backends like Codex, OpenCode, or local models.

- Define `AgentRuntime` interface: prompt-in/response-out with tool definitions
- Extract Claude-specific logic into `ClaudeRuntime`
- Make runtime configurable per-agent

#### Spec Maintenance (#51)
Keep SPEC.md accurate as the codebase evolves. Consider automated drift detection.

### Medium-term

#### Multi-Machine Orchestration (#50)
Run OmniClaw across multiple machines (e.g., Mac Mini as main orchestrator + MacBook as delegate) without building a complex distributed system.

- "Remote local" backend that proxies `AgentBackend` over SSH/Tailscale
- Route agents to specific machines by hardware capability
- Keep the main orchestrator as single source of truth
- Leverage existing `share_request` for cross-machine context, not a dedicated file bus

#### Codebase Simplification (Ongoing)
The codebase has grown (18K+ lines in `src/`). Continuously look for:
- Dead code and unused exports
- Duplicated logic that can be extracted to shared helpers
- Legacy compatibility shims that can be removed
- Backend code that could be lazily loaded

#### Test Coverage Expansion (Ongoing)
Good test coverage for IPC, scheduling, routing, security. Gaps remain in:
- Channel adapters (integration tests)
- Cloud backends (mock-based unit tests)
- End-to-end message flow

### Long-term

#### Declarative Agent Configuration
Move from SQLite-registered groups to a declarative config file (YAML/TOML) that describes the full agent topology — channels, backends, mounts, triggers, heartbeats. Keep SQLite for runtime state only.

#### Plugin Architecture for MCP Tools
Allow agents to bring custom MCP tools without modifying `ipc-mcp-stdio.ts`. A plugin directory where each file exports tool definitions.

#### Monitoring and Observability
Structured logs exist but there's no dashboard or alerting. Consider:
- Health check endpoint
- Agent uptime/latency metrics
- Task success/failure rates
- Channel connectivity status

---

## Completed Recently

### Feb 2026
- Multi-channel support (Discord, Telegram, Slack) — all four channels operational
- 6 compute backends (local + 4 cloud providers)
- Agent/ChannelRoute decoupling
- Comprehensive security hardening (path traversal, mount allowlist, .env blocking, IPC hardening, container PID limits)
- Structured logging migration (console.log → Pino)
- Typed IPC payloads (removed `any` from processing pipeline)
- CI: tsc --noEmit type checking
- Test coverage: IPC, scheduling, routing, config, file transfer, stream parsing
- Code simplification: extracted shared helpers, removed duplicates

---

## Non-Goals

Things we deliberately avoid:
- **Multi-user SaaS** — this is personal software, not a platform
- **Web dashboard** — Claude is the interface
- **Complex deployment** — single process, launchd/systemd, done
- **Every possible integration** — add what you need via skills
- **Backwards compatibility guarantees** — fork and modify
