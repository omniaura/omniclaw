# Factory Workflow Handoffs

This document defines the first durable handoff contract for the SDLC driver
commands (`/product-driver`, `/issue-driver`, `/research-driver`,
`/implement-driver`, and `/qa-driver`). The goal is to make driver outputs
retrievable by later drivers without relying on chat scrollback.

## Workflow Model

A workflow represents one bounded unit of software-factory work, usually a
single GitHub issue in one repository.

Recommended workflow id:

```text
<owner>/<repo>#<issue-or-pr-number>
```

If there is no issue or PR yet, use a synthetic id that includes the repository,
driver, and start timestamp:

```text
<owner>/<repo>:<driver>:<YYYYMMDD-HHMMSS>
```

## Phases

Phases are intentionally small and monotonic:

```text
discovery -> spec -> impl -> review -> qa -> done
```

Same-phase updates are allowed. Backward transitions are rejected so downstream
drivers can derive the current phase from the latest handoff record.

## Handoff Record

Records are stored in SQLite in `factory_handoff_records`. Human-readable
markdown can be exported later, but SQLite is the source of truth for restart
survival and queryability.

Required fields:

```json
{
  "id": "handoff-uuid",
  "workflowId": "omniaura/omniclaw#643",
  "repo": "omniaura/omniclaw",
  "phase": "spec",
  "ownerAgentId": "ocpeyton",
  "driver": "product-driver",
  "intent": "Define durable factory handoffs",
  "summary": "The next driver should implement persistence before UI.",
  "body": "Markdown handoff body for downstream driver context.",
  "decisions": ["Use SQLite for records and claims"],
  "artifacts": [
    {
      "type": "issue",
      "label": "#643",
      "url": "https://github.com/omniaura/omniclaw/issues/643"
    }
  ],
  "blockers": ["Lease primitive still pending"],
  "createdAt": "2026-05-04T00:00:00.000Z"
}
```

Optional fields:

```json
{
  "sourceIssue": "643",
  "sourcePr": "645",
  "nextDriver": "implement-driver",
  "nextScope": "schema/module spike",
  "metadata": { "priority": "P2" }
}
```

## Active Claims

Active ownership is stored in `factory_workflow_claims` and keyed by
`workflow_id`. A claim records:

- `repo`
- `owner_agent_id`
- `owner_run_id`
- `phase`
- `claimed_at`
- `heartbeat_at`
- `expires_at`

Before acquiring a claim, expired rows are deleted. If an unexpired claim exists,
the acquire call returns the conflicting claim instead of overwriting it. This
gives slash commands a deterministic duplicate-owner warning path.

## Retrieval

The first integration points should retrieve records by:

- workflow id, for explicit handoff continuation
- repository plus GitHub issue id, for issue-scoped driver invocations
- latest record for a workflow, to derive current phase and next driver

Missing or malformed records must not fail slash command startup. Drivers should
log the problem and proceed with empty handoff context.
