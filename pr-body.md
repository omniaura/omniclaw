## Summary

- stop replaying stored discovery secrets when an already-trusted peer re-requests access
- keep the existing `already_trusted` response path, but avoid sending the long-lived shared secret back over plaintext pairing callbacks
- add a regression test for the trusted-peer re-pair flow and update the network UI toast handling for `already_trusted`

## Validation

- `bun run typecheck`
- `bun test src/discovery/routes.test.ts`
