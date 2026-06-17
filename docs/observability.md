# Operator Observability Reference

This is a quick reference for the counters, badges, and reason codes that the
Web UI exposes on `/system` and `/ipc`, plus a symptom-first runbook for
diagnosing a slow or stuck multi-agent session.

It documents the surface that exists today — see the [Observability and
Operator UX](./ROADMAP.md) section of the roadmap for upcoming work, and
[#644](https://github.com/omniaura/omniclaw/issues/644) for the active
rollup tracker.

## Page index

| Route            | Purpose                                                                             |
| ---------------- | ----------------------------------------------------------------------------------- |
| `/system`        | Process and host health, plus a rollup of per-lane queue state across all groups.   |
| `/ipc`           | Per-group lane state, run age, retry counts, last error, recent IPC event timeline. |
| `/agents`        | Per-agent execution state badge plus the structured lane reason behind it.          |
| `/conversations` | Chat history per agent (browse, search, export).                                    |
| `/logs`          | Live log stream; landing target for "last error" links on `/ipc`.                   |
| `/network`       | Peer discovery, trusted peers, and remote agent visibility.                         |
| `/tasks`         | Scheduled-task list, create / pause / resume / cancel controls.                     |

## `/system` reference

Source: `src/web/system.ts` (`HealthData`, `renderSystemContent`).

### Top-level cards

| Card          | Fields                                                                                                                                                                     | What it tells you                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `server`      | version, uptime, started, sse clients                                                                                                                                      | Process identity; SSE client count tracks live UI subscribers.                        |
| `runtime`     | bun, platform, arch                                                                                                                                                        | Runtime info — useful when a build is misbehaving on a specific host.                 |
| `memory`      | rss, heap used, heap total                                                                                                                                                 | Orchestrator process memory; growth here points at a host-side leak.                  |
| `cpu`         | cores, load 1m / 5m / 15m                                                                                                                                                  | Host load average; sustained `load > cores` means CPU-bound work.                     |
| `host memory` | total, used (with %), free                                                                                                                                                 | Whole-machine memory pressure — distinct from the orchestrator's own usage.           |
| `containers`  | active (`active/max_active`), idle (`idle/max_idle`)                                                                                                                       | Agent container pool. Pinned at max → back-pressure source.                           |
| `agents`      | total, by state, by backend, by runtime                                                                                                                                    | Agent inventory plus the structured exec-state breakdown (see below).                 |
| `tasks`       | active, paused, completed, total                                                                                                                                           | Scheduled-task lifecycle counts (not the running queue — see `queue` card).           |
| `queue`       | groups, processing, running tasks, longest running, longest message run, pending msgs/tasks, retrying, total retries, max retries, message lane reasons, task lane reasons | Rollup of every group's lane state. Cross-reference with `/ipc` for per-group detail. |

### Queue card fields

Source: `HealthData.queue` in `src/web/system.ts`.

| Field                  | Source                                     | Meaning                                                                       |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| `groups`               | `queueDetails.length`                      | Group folders the orchestrator is currently tracking.                         |
| `processing`           | groups with `messageLane.active === true`  | Lanes actively processing inbound messages right now.                         |
| `running tasks`        | groups with `taskLane.activeTask !== null` | Scheduled tasks currently executing across all task lanes.                    |
| `longest running`      | `max(taskLane.activeTask.runningMs)`       | Age of the oldest in-flight task. Stays at `—` when no task is running.       |
| `longest message run`  | `max(messageLane.runningMs)`               | Age of the oldest in-flight message run. Stays at `—` when `processing` is 0. |
| `pending msgs`         | sum of `messageLane.pendingCount`          | Messages queued across all groups (back-pressure ceiling).                    |
| `pending tasks`        | sum of `taskLane.pendingCount`             | Scheduled tasks queued across all groups.                                     |
| `retrying`             | groups with `retryCount > 0`               | Breadth of retry pressure — how many groups are currently in backoff.         |
| `total retries`        | sum of `retryCount`                        | Intensity — one group stuck retrying many times will inflate this.            |
| `max retries`          | `max(retryCount)`                          | Highest individual retry depth, useful for spotting a single stuck group.     |
| `message lane reasons` | reason-code rollup (see below)             | Distribution of message lanes across the 5 message reason codes.              |
| `task lane reasons`    | reason-code rollup (see below)             | Distribution of task lanes across the 3 task reason codes.                    |

### Agent exec-state breakdown

Source: `AgentExecStatus` and `getAgentExecStatus` in `src/web/agents-page.ts`.

| State          | Meaning                                                                |
| -------------- | ---------------------------------------------------------------------- |
| `executing`    | Message lane active and not idle — agent is processing a turn now.     |
| `running-task` | Task lane active — agent is in the middle of a scheduled task.         |
| `idle`         | Container alive but lane idle (cooldown / post-turn wait).             |
| `queued`       | Messages or tasks pending but no container yet (waiting on a slot).    |
| `offline`      | No queue detail entry — orchestrator has no live or recent lane state. |
| `disabled`     | Agent disabled via the per-agent off switch (#651).                    |

## `/ipc` reference

Source: `src/web/ipc-inspector.ts` (`renderIpcInspectorContent`).

### Stat cards (top row)

| Card             | Meaning                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `processing`     | `(activeContainers - idleContainers) / maxActive`. Pin at max → container slot pressure. |
| `idle`           | `idleContainers / maxIdle`. Warm pool size.                                              |
| `groups tracked` | Same as `/system → queue → groups`.                                                      |
| `pending msgs`   | Sum of message-lane pending counts. Matches `/system`.                                   |
| `pending tasks`  | Sum of task-lane pending counts.                                                         |
| `retrying`       | `retryingGroups (totalRetries)` when any group is retrying, else `0`.                    |
| `recent events`  | Number of events in the timeline below (capped at 50). Suffixed with `(X err)` or `(X err, Y warn)` when any error or suppressed events fall in the window. |

### Group queue table (per-row)

| Column         | Source                             | Meaning                                                                  |
| -------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| `group`        | `folderKey`                        | Group folder name. Matches Discord channel / WhatsApp group identifier.  |
| `messages`     | message-lane status + reason + age | `active`/`idle`/`off` badge, reason code (see table below), running age. |
| `msg queue`    | `messageLane.pendingCount`         | Messages waiting on this lane.                                           |
| `tasks`        | task-lane status + reason          | `active`/`off` badge plus task reason code.                              |
| `task queue`   | `taskLane.pendingCount`            | Scheduled tasks waiting on this lane.                                    |
| `running task` | `taskLane.activeTask`              | Task id and running duration, or `—` when idle.                          |
| `retries`      | `retryCount`                       | Consecutive retry depth on the message lane.                             |
| `last error`   | `messageLane.lastError`            | Truncated message + age; links to `/logs` for the full trace (#691).     |

### IPC event timeline

Source: `WebStateProvider.getIpcEvents`. Each row: `time`, `kind`, `source`,
`summary`. Event kinds that contain `error` or `blocked` render red;
`suppressed` renders amber; everything else renders green. Common kinds:

| Kind               | Meaning                                                                     |
| ------------------ | --------------------------------------------------------------------------- |
| `ipc_backpressure` | Watcher hit a per-poll budget and deferred files this tick (#717 / #724).   |
| `ipc_error`        | IPC ingest or dispatch error.                                               |
| `*_blocked`        | A guard rejected a payload (path traversal, traversal-in-attachment, etc.). |
| `*_suppressed`     | Duplicate or stale event filtered out before dispatch.                      |

## Reason-code reference

### Message lane (`MessageLaneReason`)

Source: `src/group-queue.ts` (`deriveMessageLaneReason`).

| Code            | Meaning                                                                   |
| --------------- | ------------------------------------------------------------------------- |
| `running`       | Lane is currently processing a message turn.                              |
| `cooling-down`  | Container alive, lane idle in post-turn cooldown — healthy waiting state. |
| `back-pressure` | Lane idle with pending messages but no container/slot yet.                |
| `retrying`      | Lane idle, retry counter > 0 — last run failed and backoff is in effect.  |
| `no-work`       | Lane idle, queue empty, no retries pending.                               |

### Task lane (`TaskLaneReason`)

Source: `src/group-queue.ts` (`deriveTaskLaneReason`).

| Code            | Meaning                                                |
| --------------- | ------------------------------------------------------ |
| `running`       | A scheduled task is actively executing on this lane.   |
| `back-pressure` | Pending tasks but waiting for task-container capacity. |
| `no-work`       | No pending tasks and nothing running.                  |

## Diagnose by symptom

| Symptom                      | Look here first                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Messages backing up**      | `/system → queue → pending msgs` and `processing`. If `processing` == `max_active` → container slot pressure. Drill into `/ipc` to see which lanes are `back-pressure`.        |
| **Agent appears idle**       | `/agents` exec badge plus the lane reason. `cooling-down` is healthy; `retrying` means a backoff loop; `back-pressure` means slot starvation; `offline` means no recent state. |
| **Task retrying repeatedly** | `/system → queue → max retries` and `retrying`. Then `/ipc → retries` column to find the group; `last error` links to `/logs`.                                                 |
| **IPC drops in log**         | `/ipc → recent events` for `ipc_backpressure` or `ipc_error` rows. Backpressure means the watcher hit its per-poll file budget (#717 / #724) — files are deferred, not lost.   |
| **Peer offline**             | `/network` for trusted peer / discovery status. Cross-check `/system → agents → offline` count for a rollup.                                                                   |
| **Single group stuck**       | `/system → queue → max retries` vs `total retries`. A high `max` with low `total` and low `retrying` count = one outlier group; find it on `/ipc`.                             |

## See also

- `src/web/system.ts` — `HealthData` shape, queue rollup logic.
- `src/web/ipc-inspector.ts` — per-group table + event timeline rendering.
- `src/web/agents-page.ts` — `AgentExecStatus` derivation.
- `src/group-queue.ts` — reason-code derivation.
- `docs/ROADMAP.md` — operator-story roadmap items.
- [#644](https://github.com/omniaura/omniclaw/issues/644) — operator observability rollup tracker.
