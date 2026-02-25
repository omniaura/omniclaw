# OmniClaw Roadmap

Last updated: 2026-02-24

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

### Backends
| Backend | Maturity | Notes |
|---------|----------|-------|
| Apple Container (local) | Stable | Default, macOS only |
| Docker (local) | Partial | Uses same LocalBackend, needs testing (#3) |

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
| CI type checking | Stable | tsc --noEmit in CI pipeline |
| Thread streaming | Early | Stream intermediate output to Discord threads |

---

## Planned Work

### Near-term (Active / Next Up)

#### Security Fixes (#76, #77, #78)
Three open security issues requiring attention:
- **#78**: S3 key construction lacks agentId validation — allows cross-agent data access
- **#77**: `read_context` MCP tool path traversal via topic parameter
- **#76**: S3 credentials embedded in Hetzner cloud-init plaintext (High severity)

#### Graceful Shutdown (#82)
No SIGTERM/SIGINT handler — process exits uncleanly on service stop. Add signal handlers to drain in-flight work and close connections.

#### Health Checks (#83)
No liveness probe for the long-running orchestrator process. Add a health check endpoint or mechanism for service managers to detect hangs.

#### IPC Error Feedback (#74)
IPC reactions are fire-and-forget — agents get no error feedback on failure. Surface errors back to the agent so it can retry or inform the user.

#### Documentation Fixes (#79, #80, #81)
- **#81**: Remove stale `SIMPLIFICATION_SUMMARY.md`
- **#80**: SPEC.md references nonexistent `src/shared/` directory
- **#79**: SECURITY.md refers to 'node' user but container runs as 'bun'

#### Versioned DB Migrations (#4)
SQLite schema changes are currently handled ad-hoc. Need a proper migration framework so schema updates are versioned, reversible, and safe to apply.

#### Docker Runtime Auto-detection (#3)
Auto-detect whether Apple Container or Docker is available, so the same codebase works on macOS and Linux without manual config.

### Medium-term

#### Agent Runtime Agnosticism (#49)
OmniClaw is tightly coupled to Claude (Agent SDK, CLAUDE.md conventions, session resume). Define an `AgentRuntime` interface to support alternative backends like Codex, OpenCode, or local models.

- Define `AgentRuntime` interface: prompt-in/response-out with tool definitions
- Extract Claude-specific logic into `ClaudeRuntime`
- Make runtime configurable per-agent

#### Multi-Machine Orchestration (#50)
Run OmniClaw across multiple machines (e.g., Mac Mini as main orchestrator + MacBook as delegate) without building a complex distributed system.

- "Remote local" backend that proxies `AgentBackend` over SSH/Tailscale
- Route agents to specific machines by hardware capability
- Keep the main orchestrator as single source of truth
- Leverage existing `share_request` for cross-machine context, not a dedicated file bus

#### Codebase Simplification (Ongoing)
Significant progress made (475+ lines of dead code removed, duplicated handlers extracted). Continue:
- Unused exports and dead code paths
- Backend code that could be lazily loaded
- Legacy compatibility shims

#### Test Coverage Expansion (Ongoing)
Good coverage for IPC, scheduling, routing, security, config, file transfer, stream parsing (125+ unit tests added in Feb 2026). Gaps remain in:
- Channel adapters (integration tests)
- Backend implementations (mock-based unit tests)
- End-to-end message flow

### Long-term

#### Declarative Agent Configuration (#57)
Move from SQLite-registered groups to a declarative config file (YAML/TOML) that describes the full agent topology — channels, backends, mounts, triggers, heartbeats. Keep SQLite for runtime state only.

#### Plugin Architecture for MCP Tools
Allow agents to bring custom MCP tools without modifying `ipc-mcp-stdio.ts`. A plugin directory where each file exports tool definitions.

#### Monitoring and Observability
Structured logs exist but there's no dashboard or alerting. Consider:
- Health check endpoint (see #83 for near-term work)
- Agent uptime/latency metrics
- Task success/failure rates
- Channel connectivity status

---

## Completed Recently

### Feb 23-24, 2026
Major hardening push — 30+ PRs merged in 48 hours:

**Security**
- Path traversal protection in `buildContent` (#41)
- Block `.env` access from project root (#43)
- Container hardening: `--pids-limit` and `--no-new-privileges` (#53)
- Gate `--pids-limit` on Docker + `LOCAL_RUNTIME` config

**Testing**
- 125+ unit tests added across IPC, DB CRUD, splitMessage, config, security (#75, #46, #38, #37)
- Fix fs mock leak between test files (#71)

**Refactoring & Code Quality**
- Remove ~475 lines dead code (#64)
- Replace `any` types across 8 files (#62)
- Typed IPC payloads — removed `any` from processing pipeline (#48)
- Extract task lifecycle handler (#54)
- Extract duplicated reaction handlers (-90 lines) (#45)
- Extract shared helpers (#39)
- Remove duplicate `storeMessageDirect` (#36)

**Bug Fixes**
- Fix SQLite FK crash on task deletion (#61)
- Fix agent response delivery on tool call (#63)
- Fix WhatsApp reconnect logic (#72)

**Infrastructure & CI**
- Add `tsc --noEmit` to CI (#52)
- SPEC.md rewrite (#59, #60)
- Docs cleanup: REQUIREMENTS.md, stale references (#65, #66, #67)
- Task ownership visibility in `list_tasks` (#69)

### Earlier Feb 2026
- Multi-channel support (Discord, Telegram, Slack) — all four channels operational
- 2 compute backends (Apple Container + Docker)
- Agent/ChannelRoute decoupling
- Structured logging migration (console.log → Pino)

---

## Non-Goals

Things we deliberately avoid:
- **Multi-user SaaS** — this is personal software, not a platform
- **Web dashboard** — Claude is the interface
- **Complex deployment** — single process, launchd/systemd, done
- **Every possible integration** — add what you need via skills
- **Backwards compatibility guarantees** — fork and modify
