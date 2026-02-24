# OmniClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Bun process that connects to WhatsApp, routes messages to Claude Agent SDK running in Apple Container (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/backends/` | Pluggable backend system (Apple Container, Sprites, Docker) |
| `src/ipc-snapshots.ts` | Task and group snapshot utilities for IPC |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
bun run dev          # Run with hot reload
bun run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

### Environment Variables

- **Never** read or modify `.env` — it contains secrets and is denied in settings.
- When a new environment variable is needed, add it to `.env.example` with an empty or placeholder value and a descriptive comment.
- Tell the user to fill in the actual value in `.env`.

Service management:
```bash
launchctl load ~/Library/LaunchAgents/com.omniclaw.plist
launchctl unload ~/Library/LaunchAgents/com.omniclaw.plist
```

## Container Build Cache

Apple Container's buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild:

```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

Always verify after rebuild: `container run -i --rm --entrypoint wc omniclaw-agent:latest -l /app/src/index.ts`

## Git Remotes & Pull Requests

This repo is `omniaura/omniclaw`. Always pass `--repo omniaura/omniclaw --base main` when creating PRs with `gh pr create`.

We still passively monitor the original upstream (`qwibitai/nanoclaw`) for security fixes and interesting features via `.github/workflows/upstream-sync.yml`, but we don't open PRs against it.

## Public Repo Awareness

This is an **open-source public repository** that others clone to run their own assistants on completely different projects. When making changes for Peyton's personal setup:

- **NEVER edit templates or checked-in files** (e.g. `groups/main/CLAUDE.md.template`, `groups/global/CLAUDE.md.template`, source code, skills) with user-specific content like project names, directory paths, personal preferences, or org-specific details.
- **Personal config goes in runtime files** that are gitignored: `groups/main/CLAUDE.md`, `groups/global/CLAUDE.md`, `.env`, `data/`, `store/`, `~/.config/omniclaw/`.
- **Templates are starting points** for all users. They should remain generic and project-agnostic.
- When in doubt, check `.gitignore` — if a file is tracked by git, treat it as public.
