## Summary

- stop replaying stored discovery secrets when an already-trusted peer re-requests access
- require pairing public keys for new discovery requests and encrypt all discovery secret delivery with per-request X25519 key agreement plus AES-GCM
- add regression coverage for the trusted-peer re-pair flow and encrypted pairing completion

## Validation

- `bun run typecheck`
- `bun test src/discovery/routes.test.ts src/discovery/pairing-crypto.test.ts`
