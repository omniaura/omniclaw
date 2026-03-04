# Sender Identity Pipeline: Phase 0 Audit

> No behavior change. Map every sender identity touchpoint, classify trust level, and define instrumentation for Phase 1.

**Date:** 2026-03-04
**Issue:** #204
**Milestone:** Sender Identity Pipeline

---

## Executive Summary

The NanoClaw codebase maintains a **dual-field sender model**: an immutable platform ID (`sender`) and a mutable display name (`sender_name`). All four adapters (Discord, WhatsApp, Telegram, Slack) correctly extract immutable platform IDs as the primary identity key. However, **the agent prompt receives only the mutable display name** (via `formatMessages()` in `router.ts:16`), and several fallback paths can conflate identity keys with display labels.

The IPC layer uses **filesystem-derived identity** (`sourceGroup` from directory path), which is the strongest trust anchor in the system. No sender spoofing is possible through IPC unless the filesystem is compromised.

---

## 1. Identity Flow Map

### Zone A: External Platform (Untrusted Input)

Raw webhook/event payloads from Discord, WhatsApp, Telegram, Slack.

### Zone B: Adapter Normalization (Constrained Trust)

| Adapter | File | Lines | `sender` (Immutable ID) | `sender_name` (Mutable Label) | `sender_user_id` |
|---------|------|-------|-------------------------|-------------------------------|-------------------|
| Discord | `src/channels/discord.ts` | 634-638 | `message.author.id` (snowflake) | `member?.displayName \|\| author.displayName \|\| author.username` | Set to `sender` (redundant) |
| WhatsApp | `src/channels/whatsapp.ts` | 352-353 | `msg.key.participant \|\| msg.key.remoteJid` (JID) | `msg.pushName \|\| sender.split('@')[0]` | Not set |
| Telegram | `src/channels/telegram.ts` | 146-151 | `ctx.from?.id.toString()` (numeric) | `ctx.from?.first_name \|\| ctx.from?.username \|\| ctx.from?.id.toString()` | Not set |
| Slack | `src/channels/slack.ts` | 312-317 | `event.user` (e.g., `U12345678`) | `resolveSlackUserName()` with fallback to `userId` | Set to `sender` (redundant) |

**Key observation:** All adapters correctly use immutable platform IDs for `sender`. The `sender_user_id` field is redundantly populated by Discord and Slack only.

### Zone C: Router + Trigger Matching (Trusted Logic)

| Component | File | Lines | Sender Field Used | Purpose |
|-----------|------|-------|-------------------|---------|
| `formatMessages()` | `src/router.ts` | 13-35 | `m.sender_name` (MUTABLE) | XML `sender=` attribute in agent prompt |
| Participant roster | `src/router.ts` | 21-27 | `m.sender_name` (MUTABLE) | `participants=` attribute, deduplication by name |
| Self-echo filter | `src/index.ts` | 736 | `m.sender` (IMMUTABLE) | Skips `agent:{agentId}` tagged messages |
| Multi-agent filter | `src/index.ts` | 1531-1534 | `m.sender` (IMMUTABLE) | Prevents agents seeing own IPC notifications |

### Zone D: IPC Transport (Trusted but Validate)

| Component | File | Lines | Identity Source | Trust Level |
|-----------|------|-------|-----------------|-------------|
| `resolveOwnerGroupFolder()` | `src/ipc.ts` | 93-111 | Filesystem directory path | IMMUTABLE (strongest) |
| `processMessageIpc()` | `src/ipc.ts` | 168-327 | `sourceGroup` (verified dir) | IMMUTABLE |
| Task cancel auth | `src/ipc.ts` | 544-552 | `srcGroup` (verified dir) | IMMUTABLE |
| Share request tracking | `src/ipc.ts` | 117-147 | `sourceName` from agent config | IMMUTABLE (agent name, not user name) |
| `notifyGroup()` | `src/index.ts` | 2173-2184 | `agent:{sourceFolder}` tag | IMMUTABLE |

### Zone E: Runtime + Memory + Logs (Authoritative Storage)

| Component | File | Lines | Identity Field | Usage |
|-----------|------|-------|----------------|-------|
| DB schema | `src/db.ts` | 225-235 | `sender TEXT, sender_name TEXT` | Both stored, no FK constraint |
| `storeMessage()` | `src/db.ts` | 573-586 | `msg.sender`, `msg.sender_name` | INSERT OR REPLACE |
| `getNewMessages()` | `src/db.ts` | 604-629 | Returns both fields | Filtered by `is_from_me = 0` |
| User registry | `src/channels/discord.ts` | 45-98 | Keyed by `name.toLowerCase()` | Maps display name -> platform ID |
| User registry (Effect) | `src/effect/user-registry.ts` | 10-26 | `{ id, name, platform }` | Mention formatting utility |
| Thread streaming | `src/thread-streaming.ts` | 8-15, 107-136 | `groupFolder` (immutable) | Directory paths only |
| Task scheduler | `src/task-scheduler.ts` | 84-102 | `task.group_folder` (immutable) | Identity from task config |

### Synthetic Message Sources

| Source | File | Lines | `sender` | `sender_name` |
|--------|------|-------|----------|----------------|
| System notifications | `src/index.ts` | 1734-1742 | `'system'` | `'System'` |
| Reaction notifications | `src/index.ts` | 1783-1791 | `'system'` | `'System'` |
| GitHub webhooks | `src/index.ts` | 1868-1874 | `'system'` | `'GitHub Webhook'` |
| IPC agent notifications | `src/index.ts` | 2178-2184 | `'agent:{sourceFolder}'` | `'Omni (Main)'` |

---

## 2. Risk Table

### Identity Confusion Risks

| ID | Location | Risk Level | Field | Issue | Impact |
|----|----------|------------|-------|-------|--------|
| R1 | `router.ts:16` | **HIGH** | `sender_name` in XML | Agent prompt uses mutable display name as `sender` attribute; immutable ID is not exposed to agent | Agent cannot reliably distinguish senders if display names change or collide |
| R2 | `router.ts:21-27` | **HIGH** | Participant roster | Deduplication by `sender_name`; if same user changes name mid-conversation, appears as two participants | Conversation compaction/summarization misattributes messages |
| R3 | `whatsapp.ts:353` | **CRITICAL** | `sender_name` fallback | Falls back to `sender.split('@')[0]` (phone number) when `pushName` absent; phone number is technically immutable but semantically a different field | Display name becomes a phone number string; can't distinguish from a real display name |
| R4 | `telegram.ts:149` | **HIGH** | `sender_name` fallback | Falls back to `ctx.from?.id.toString()` when `first_name` and `username` are absent; numeric ID used as display name | `sender_name` becomes identical to `sender`, collapsing the key/label distinction |
| R5 | `slack.ts:32-48` | **MEDIUM** | `sender_name` fallback | `resolveSlackUserName()` falls back to `userId` on API error; display name becomes the Slack user ID | Same ID-as-name confusion as R4 but less likely (requires API failure) |
| R6 | `discord.ts:68` | **LOW** | User registry key | Registry keyed by `name.toLowerCase().trim()`; two users with same display name overwrite each other | `format_mention` MCP tool may resolve to wrong user; low impact since it only affects outbound @mentions |
| R7 | `types.ts:82` | **LOW** | `sender_user_id` redundancy | Optional field duplicates `sender` for Discord/Slack, absent for WhatsApp/Telegram; inconsistent across platforms | Code that relies on `sender_user_id` will get `undefined` for WhatsApp/Telegram messages |
| R8 | `db.ts:575` | **LOW** | Mutable data in permanent storage | `sender_name` stored in DB but not updated when user changes display name; historical messages show stale names | Old messages show outdated sender names; minor UX issue |

### Authorization / Policy Risks

| ID | Location | Risk Level | Finding |
|----|----------|------------|---------|
| A1 | `index.ts:736` | **SAFE** | Self-echo prevention uses `m.sender` (immutable ID) to filter `agent:{id}` tags |
| A2 | `ipc.ts:93-111` | **SAFE** | IPC sender verification uses filesystem directory path, not user-controlled fields |
| A3 | `ipc.ts:168-327` | **SAFE** | IPC message authorization checks `sourceGroup` (verified dir) against registered groups |
| A4 | `ipc.ts:544-552` | **SAFE** | Task cancel authorization checks `srcGroup` ownership |
| A5 | `github-webhooks.ts:175-187` | **SAFE** | HMAC signature verification for webhook payloads; sender identity from `payload.sender.login` used only in summary text |

---

## 3. Where Label-Derived Identity Is Still Possible

These are the specific code paths where a mutable display name could be confused with or used as an identity key:

### 3.1 Agent Prompt Attribution (R1, R2)

```
router.ts:16  — sender="${escapeXml(m.sender_name)}"
router.ts:24  — messages.map((m) => m.sender_name)
```

The agent sees `<message sender="Alice">` not `<message sender="discord:123456">`. If "Alice" changes her display name to "Bob", the agent sees a new participant. This is the **primary identity gap** in the system.

### 3.2 WhatsApp Phone Number as Display Name (R3)

```
whatsapp.ts:353  — const senderName = msg.pushName || sender.split('@')[0];
```

When `pushName` is absent, `sender_name` becomes `"15551234567"` — a phone number that looks like an ID but is stored in the display name field.

### 3.3 Telegram Numeric ID as Display Name (R4)

```
telegram.ts:149  — ctx.from?.id.toString()
```

When `first_name` and `username` are both absent, `sender_name` becomes `"123456789"` — indistinguishable from the `sender` field.

### 3.4 User Registry Name-to-ID Mapping (R6)

```
discord.ts:68  — const key = name.toLowerCase().trim();
```

The registry maps `"alice" -> { id: "123", name: "Alice", ... }`. If two users have display name "Alice" (e.g., different server nicknames resolving to the same normalized key), the second entry overwrites the first.

---

## 4. Instrumentation Counters Spec

Add additive-only counters to detect identity anomalies without changing behavior. All counters emit via the existing `logger` (structured pino) with a shared `op: 'senderIdentity'` field for easy filtering.

### Counter Definitions

| Counter | Location | Fires When | Log Level | Fields |
|---------|----------|------------|-----------|--------|
| `sender_name_fallback_to_id` | Each adapter | `sender_name` fallback produces a value matching `sender` (ID used as display name) | `warn` | `{ op: 'senderIdentity', counter: 'sender_name_fallback_to_id', platform, sender, sender_name }` |
| `sender_name_empty` | Each adapter | `sender_name` is empty string after extraction | `warn` | `{ op: 'senderIdentity', counter: 'sender_name_empty', platform, sender }` |
| `sender_missing` | `storeMessage()` | `msg.sender` is empty/falsy | `error` | `{ op: 'senderIdentity', counter: 'sender_missing', chat_jid, msg_id }` |
| `sender_name_changed` | `storeMessage()` | Same `sender` ID seen with different `sender_name` than last known (requires in-memory cache) | `info` | `{ op: 'senderIdentity', counter: 'sender_name_changed', platform, sender, old_name, new_name }` |
| `participant_roster_inflation` | `formatMessages()` | Number of unique `sender_name` values exceeds number of unique `sender` values in same batch | `info` | `{ op: 'senderIdentity', counter: 'participant_roster_inflation', expected_count, actual_count, chat_jid }` |
| `user_registry_collision` | `updateUserRegistry()` | A registry key already exists with a different `id` | `warn` | `{ op: 'senderIdentity', counter: 'user_registry_collision', key, existing_id, new_id }` |

### Implementation Notes

- Counters are **log-based only** (no metrics backend required at this stage).
- The `sender_name_changed` counter requires a small in-memory `Map<string, string>` (`sender` -> last known `sender_name`). TTL: 24 hours. Max entries: 10,000 (LRU eviction).
- All counters use `op: 'senderIdentity'` for log filtering: `grep 'senderIdentity'` or structured query.
- **No behavior change**: counters log and return; no rejections, no mutations.

### Observation

To verify counters are firing correctly after deployment:

```bash
# Filter structured logs for identity counters
cat logs/nanoclaw.log | jq 'select(.op == "senderIdentity")'

# Count by type
cat logs/nanoclaw.log | jq 'select(.op == "senderIdentity") | .counter' | sort | uniq -c
```

---

## 5. Phase 1 Touch List

Based on this audit, Phase 1 (Canonicalization at Adapters) needs to touch the following files:

### Priority 1: Core Schema + Formatter

| File | What to Change | Why |
|------|----------------|-----|
| `src/types.ts:73-89` | Add `sender_platform` field to `NewMessage`; document `sender` as `<platform>:<immutable_id>` format | Establish canonical key format |
| `src/router.ts:13-35` | Include `sender` (immutable ID) in XML output alongside `sender_name`; e.g., `sender_id="${m.sender}"` | Give agents access to immutable identity |
| `src/router.ts:21-27` | Deduplicate participant roster by `sender` (immutable), display via `sender_name` | Fix roster inflation risk (R2) |
| `src/db.ts:225-235` | Add `sender_platform TEXT` column | Store platform type explicitly |

### Priority 2: Adapter Canonicalization

| File | What to Change | Why |
|------|----------------|-----|
| `src/channels/discord.ts:634-638` | Format `sender` as `discord:<user_id>`; populate `sender_platform: 'discord'` | Canonical key format |
| `src/channels/whatsapp.ts:352-353` | Format `sender` as `whatsapp:<jid>`; fix fallback to use explicit label (not phone number) for `sender_name` | Fix R3 |
| `src/channels/telegram.ts:146-151` | Format `sender` as `telegram:<user_id>`; fix fallback to use `'User <id>'` instead of raw numeric ID for `sender_name` | Fix R4 |
| `src/channels/slack.ts:312-317` | Format `sender` as `slack:<user_id>`; fix fallback in `resolveSlackUserName()` | Fix R5 |

### Priority 3: IPC + Synthetics

| File | What to Change | Why |
|------|----------------|-----|
| `src/index.ts:2178-2184` | Update `notifyGroup()` to use canonical `agent:<folder>` format with `sender_platform: 'ipc'` | Consistency |
| `src/index.ts:1734-1742, 1783-1791, 1868-1874` | Update synthetic messages to use `system:notification` canonical format | Consistency |

### Priority 4: Observability (Instrumentation Counters)

| File | What to Change | Why |
|------|----------------|-----|
| `src/channels/discord.ts` | Add `sender_name_fallback_to_id` and `sender_name_empty` counters | Phase 0 instrumentation |
| `src/channels/whatsapp.ts` | Add `sender_name_fallback_to_id` and `sender_name_empty` counters | Phase 0 instrumentation |
| `src/channels/telegram.ts` | Add `sender_name_fallback_to_id` and `sender_name_empty` counters | Phase 0 instrumentation |
| `src/channels/slack.ts` | Add `sender_name_fallback_to_id` and `sender_name_empty` counters | Phase 0 instrumentation |
| `src/db.ts:573-586` | Add `sender_missing` counter in `storeMessage()` | Phase 0 instrumentation |
| `src/router.ts:13-35` | Add `participant_roster_inflation` counter in `formatMessages()` | Phase 0 instrumentation |
| `src/channels/discord.ts:45-98` | Add `user_registry_collision` counter in `updateUserRegistry()` | Phase 0 instrumentation |

### Priority 5: Tests

| File | What to Add | Scope |
|------|-------------|-------|
| `src/channels/discord.test.ts` | Test canonical sender format, fallback handling, registry collision detection | Unit |
| `src/channels/whatsapp.test.ts` | Test canonical sender format, pushName fallback, JID parsing | Unit |
| `src/channels/telegram.test.ts` | Test canonical sender format, missing first_name/username fallback | Unit |
| `src/channels/slack.test.ts` | Test canonical sender format, API failure fallback | Unit |
| `src/router.test.ts` | Test XML output includes `sender_id`, roster deduplication by immutable ID | Unit |

---

## 6. Data Flow Diagram

```
                         ZONE A: UNTRUSTED
                    ┌─────────────────────────┐
                    │  Platform Webhook/Event  │
                    │  (Discord, WA, TG, Slack)│
                    └────────────┬────────────┘
                                 │
                         ZONE B: ADAPTER
                    ┌────────────▼────────────┐
                    │  Extract:                │
                    │   sender = platform_id   │  ← IMMUTABLE
                    │   sender_name = display  │  ← MUTABLE
                    │   sender_user_id = id?   │  ← OPTIONAL (Discord/Slack only)
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │  storeMessage() [db.ts]  │
                    │   → INSERT both fields   │
                    └────────────┬────────────┘
                                 │
                         ZONE C: ROUTER
                    ┌────────────▼────────────┐
                    │  getNewMessages() [db.ts]│
                    │   → Returns both fields  │
                    │                          │
                    │  formatMessages()        │
                    │   → XML sender=NAME ⚠️   │  ← USES MUTABLE NAME
                    │   → participants=NAMES ⚠️│  ← DEDUP BY MUTABLE NAME
                    │                          │
                    │  Self-echo filter         │
                    │   → m.sender check ✅    │  ← USES IMMUTABLE ID
                    └────────────┬────────────┘
                                 │
                         ZONE D: IPC
                    ┌────────────▼────────────┐
                    │  resolveOwnerGroupFolder │
                    │   → Filesystem path ✅   │  ← STRONGEST TRUST
                    │                          │
                    │  processMessageIpc()     │
                    │   → sourceGroup auth ✅  │
                    │                          │
                    │  notifyGroup()           │
                    │   → sender: agent:folder │  ← IMMUTABLE TAG
                    └────────────┬────────────┘
                                 │
                         ZONE E: RUNTIME
                    ┌────────────▼────────────┐
                    │  Agent receives prompt   │
                    │   → Sees sender_name only│  ← GAP: No immutable ID
                    │                          │
                    │  User registry            │
                    │   → Keyed by name.lower()│  ← COLLISION RISK (minor)
                    │                          │
                    │  Thread logs              │
                    │   → Uses groupFolder ✅  │  ← IMMUTABLE
                    └──────────────────────────┘
```

---

## 7. Summary of Current State

### What's Working Well

1. **Adapters correctly extract immutable IDs** — All four adapters use platform-native immutable identifiers for the `sender` field.
2. **IPC identity is filesystem-derived** — `resolveOwnerGroupFolder()` is the strongest identity mechanism, immune to payload spoofing.
3. **Self-echo prevention uses immutable IDs** — The `agent:{folder}` tagging pattern is correct and safe.
4. **Database stores both fields** — The dual-field model supports migration to canonical envelopes.
5. **Authorization checks are correct** — No policy decisions depend on mutable display names.

### What Needs Fixing

1. **Agent prompt only receives mutable display names** (R1, R2) — This is the biggest gap.
2. **Fallback paths conflate IDs with display names** (R3, R4, R5) — Phone numbers and numeric IDs appear in the `sender_name` field.
3. **No canonical sender key format** — `sender` contains raw platform IDs without platform prefix, making cross-platform operations ambiguous.
4. **No instrumentation** — Identity anomalies are invisible in logs today.

### No Behavior Changes in This Phase

This audit is observational only. The instrumentation counters specified in Section 4 are the only code additions, and they are strictly additive (log-only, no rejections, no mutations).

---

*Last updated: 2026-03-04*
*Next: Phase 1 PRs based on the touch list in Section 5.*
