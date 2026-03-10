## Summary

- stop replaying stored discovery secrets when an already-trusted peer re-requests access
- encrypt new discovery secret delivery by default using per-request X25519 key agreement plus AES-GCM, while keeping a legacy plaintext fallback only for older peers that do not advertise a pairing key
- add regression coverage for the trusted-peer re-pair flow and encrypted pairing completion

## Validation

- `bun run typecheck`
- `bun test src/discovery/routes.test.ts src/discovery/pairing-crypto.test.ts`
