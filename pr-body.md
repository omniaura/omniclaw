## Summary
- expose immutable sender metadata more explicitly in agent prompts by adding `sender_key`, `sender_label`, and `participant_keys` alongside the existing attributes
- add sender identity observability for participant roster inflation and display-name changes on a stable sender key
- refresh the sender identity audit doc so it matches the current formatter and logging behavior

## Testing
- `bun test src/formatting.test.ts src/db.test.ts`
- `bun run typecheck`

Refs #204.
