## Summary

- Make editable intermediate status messages default-on for channels with `editMessage`, while preserving `containerConfig.streamIntermediates: false` as an opt-out.
- Keep a bounded live activity buffer for intermediate output and replace that same message with the final reply when the turn completes.
- Forward Codex and OpenCode tool activity as intermediate output, including compact command/file summaries and capped stdout snippets.
- Coalesce status edits to avoid channel edit-rate-limit storms, guard first-message creation races, preserve full long final replies via send fallback, and redact streamed tool output.

## Operator Note

This changes Discord behavior by default: groups/agents on channels with editable messages now show one live status message during the turn. Set `containerConfig.streamIntermediates: false` to keep the old final-only behavior.

Closes #711.

## Verification

- `bun test ./src/index.test.ts ./container/agent-runner/src/__tests__/codex-runtime.test.ts`
- `bunx tsc --noEmit`
- `bun test`
- `bunx prettier --check .`
