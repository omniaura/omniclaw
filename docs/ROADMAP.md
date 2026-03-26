# OmniClaw Roadmap

Last updated: 2026-03-25

## Guiding Principles

1. **Small enough to understand** — one orchestrator process, a compact codebase, no mandatory distributed control plane
2. **Security through isolation** — real container boundaries, explicit trust, and aggressive path/input validation
3. **Customization through code and context** — CLAUDE.md layers, workspace files, and pragmatic repo changes over endless configuration surfaces
4. **AI-native operations** — the system should help build, debug, review, and maintain itself
5. **Ship the software factory** — improve the tooling that lets multiple agents collaborate safely and visibly

---

## Current Capabilities

### Channels

| Channel  | Adapter     | Maturity | Notes                                       |
| -------- | ----------- | -------- | ------------------------------------------- |
| WhatsApp | baileys     | Stable   | Original channel, reconnect handling, auth  |
| Discord  | discord.js  | Stable   | Mentions, threads, reactions, slash flows   |
| Telegram | grammY      | Stable   | Multi-bot support, no trigger prefix needed |
| Slack    | @slack/bolt | Early    | Multi-bot routing, Socket Mode              |

### Backends

| Backend                 | Maturity | Notes                                                              |
| ----------------------- | -------- | ------------------------------------------------------------------ |
| Apple Container (local) | Stable   | Default path, startup probing, split execution support             |
| Docker (local)          | Partial  | Supported through the same backend abstraction, less battle-tested |

### Product Features

| Feature                         | Maturity | Notes                                                                                                        |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| Agent/channel decoupling        | Stable   | One agent can own multiple channels                                                                          |
| Scheduled tasks                 | Stable   | Cron, interval, one-shot, pause/resume, recovery logic                                                       |
| Persistent session + memory     | Stable   | CLAUDE.md hierarchy, SQLite state, task/run persistence                                                      |
| Web UI (SolidStart)             | Stable   | 11 pages: dashboard, agents, logs, tasks, conversations, context, IPC, network, system, settings             |
| LAN discovery + pairing         | Active   | mDNS discovery, trust workflow, `/network` page, remote peer browsing                                        |
| GitHub context injection        | Stable   | Snapshot context, delta digest, linked PR/issue context                                                      |
| Inter-agent messaging           | Stable   | `send_message`, agent registry, IPC snapshots                                                                |
| Browser automation              | Stable   | Agent browser available inside containers                                                                    |
| Container split execution       | Stable   | Separate execution path for local runtime workloads                                                          |
| Startup confirmation on restart | Stable   | Agents wake and announce they are back after orchestrator restart                                            |
| Security hardening              | Stable   | Path traversal guards, mount allowlist, webhook replay defense, external MCP validation, remote image limits |

---

## Planned Work

### Near-term (Active / Next Up)

#### LAN Discovery -> Multi-Instance Sync (#278, #50)

The active multi-machine direction is now LAN discovery plus trust-based pairing, not ad hoc SSH/Tailscale proxying alone.

- mDNS peer discovery and approval-based trust shipped in #277
- next step is useful multi-instance sync: context exchange, remote coordination, and safe cross-instance workflows (#278)
- keep one orchestrator simple; add networking only where it improves real operator workflows

#### Web UI for OmniClaw (#157, closed)

The web UI is core product surface area, now built on SolidStart (SolidJS + Vinxi + Tailwind CSS).

- all original scope delivered: dashboard, agents, logs, tasks, conversations, context viewer, IPC inspector, network, system, settings
- SolidStart migration from Datastar completed in #418 (11 pages, 8.7K lines)
- next work tracked in #420: remove `WEB_UI_SOLID` feature flag, clean up old Datastar route handlers, add SolidStart component test coverage

#### Scheduler Reliability and Chat Cohesion (#162, #186)

Recovery work has landed, but the full scheduler/chat cohesion vision is still open.

- stale task recovery and deterministic scheduler coverage have improved the base
- #186 remains open for shared progress, isolated execution workspaces, lease/lock semantics, and structured handoffs between scheduled and chat work

#### Share Request Security Follow-through (#237, #240)

Recent hardening reduced risk in approval and transfer paths, but cleanup is still in progress.

- finish removing obsolete approval flow paths
- keep approval, provenance, and auditability crisp for cross-agent context sharing

#### Test Reliability and Coverage Expansion (#200 and follow-ons)

Coverage has improved materially, but there are still gaps in end-to-end confidence and a few brittle areas.

- stabilize remaining flaky suites and document root causes
- keep filling high-value gaps in orchestrator, backend, and security-sensitive paths

#### Effect.ts Selective Adoption (#136)

Effect remains a targeted tool, not a migration goal.

- use it where concurrency/retry/streaming genuinely benefits
- keep leaf modules simple async/await when Effect adds more weight than value

### Medium-term

#### Agent Runtime Agnosticism (#49)

OmniClaw still carries Claude-first assumptions in prompt assembly, context conventions, and session handling.

- keep pushing runtime abstraction so Claude Agent SDK, OpenCode, Codex, and future local runtimes fit the same orchestration model
- preserve per-agent runtime selection without forking the orchestrator

#### Multi-bot / Multi-token Maturity (#100, #101, #102)

Telegram and Slack multi-bot support have moved forward; the remaining work is consistency and polish across all channels.

- make multi-bot routing predictable across Discord, Telegram, and Slack
- keep channel ownership, slash flow targeting, and avatar identity aligned

#### Codebase Simplification

Continue removing weight while the architecture settles.

- trim dead code, stale compatibility layers, and duplicate control paths
- prefer shared helpers and narrow modules over sprawling orchestration logic

#### Observability and Operator UX

Logs and web pages exist, but the operator story is still incomplete.

- better surfacing of active runs, queue state, peer health, and task outcomes
- lightweight diagnostics for why an agent is idle, blocked, retrying, or offline

### Long-term

#### Declarative Agent Topology (#57)

Move toward a declarative source of truth for agent/channel topology while keeping SQLite for runtime state.

#### Extensible MCP / Tool Plugin Model

Make it easier to add tool bundles without modifying core runtime glue.

#### Software Factory Workflow Layer

Push from "personal assistant with tasks" toward a genuine multi-agent factory.

- backlog -> spec -> implementation -> review -> verification loops
- stronger handoff contracts between agents
- better visibility into who is working on what and why

---

## Completed Recently

### Mar 2026

- SolidStart web UI migration completed (#418) — replaced Datastar SSE with SolidJS reactive components, Tailwind CSS, and SolidStart server endpoints across all 11 pages
- LAN discovery with mDNS, trust-based pairing, remote peer browsing, and `/network` UI shipped (#277)
- Apple Container split execution landed (#399)
- auto-update PR CI backstop landed (#394)
- external MCP config validation landed (#386)
- webhook replay handling tightened so deliveries are marked processed only after success (#391)
- live agent execution status and keyboard shortcuts improved the web UI (#387, #381)
- remote image cache byte cap shipped to close a security issue (#396, closes #395)
- restart startup confirmation shipped (#402, closes #251)
- scheduler reliability and coverage improved, but #186 is still open and only partially delivered

### Feb 2026 hardening sprint

- major path traversal, mount, IPC, and attachment hardening landed across many PRs
- broad unit test expansion landed across IPC, DB, routing, config, security, and scheduler paths
- structured logging and code simplification work removed dead code and improved operator visibility

### Earlier milestones

- four channel families operational: WhatsApp, Discord, Telegram, Slack
- backend abstraction established for Apple Container and Docker
- agent/channel decoupling shipped
- scheduled task system and persistent runtime state established

---

## Non-Goals

Things OmniClaw still deliberately avoids:

- **Multi-user SaaS platforming** — this is operator-owned software, not a hosted product
- **Distributed systems for their own sake** — keep one clear source of truth and add networking pragmatically
- **Infinite compatibility layers** — simplify aggressively when old paths stop earning their keep
- **Every possible integration** — prioritize capabilities that improve the agent factory itself
