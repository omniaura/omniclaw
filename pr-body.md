## Summary
- treat Discord attachments as images when their filename extension is image-like, even if Discord omits `contentType`
- keep the existing content-type path first, then fall back to extension-based detection for common image formats
- add regression coverage for missing-content-type image attachments in `src/channels/discord.test.ts`

## Testing
- `bun test src/channels/discord.test.ts`
- `bun run typecheck`

Follow-up hardening for the Discord image attachment path from #254.
