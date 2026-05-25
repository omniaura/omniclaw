# Changelog

## Unreleased

- Added per-agent model override (`agents.model`) persisted in SQLite. Set via the web UI's agent detail page, `POST /api/agents/{id}/model`, or `model:` in `agents.yaml`. Overrides the host `.env` value and is mapped to the runtime's expected env var (CLAUDE_MODEL / OPENCODE_MODEL / CODEX_MODEL / CURSOR_AGENT_MODEL) when the container starts.
- Changed Discord intermediate agent activity streaming to be on by default for channels that support message edits. Operators who prefer the previous behavior can set `containerConfig.streamIntermediates: false` on the group or agent.
