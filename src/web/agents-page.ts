/**
 * Agents page — top-level agent directory with search, filters, and quick actions.
 * Shows all local and remote agents in a clean table with backend badges,
 * channel/task counts, execution status, and links to detail pages.
 */

import { createHash } from 'crypto';

import {
  deriveMessageLaneReasonFromDetail,
  type GroupQueueDetail,
  type MessageLaneReason,
} from '../group-queue.js';
import type { WebStateProvider } from './types.js';
import { renderShell, escapeHtml } from './shared.js';
import { allPageScripts } from './page-scripts.js';
import {
  buildAgentChannelData,
  type AgentChannelData,
} from './agent-channels.js';
import type { RemotePeerAgents } from '../discovery/types.js';

export type AgentExecStatus =
  | 'executing'
  | 'running-task'
  | 'idle'
  | 'queued'
  | 'offline'
  | 'disabled';

/** Set of reason codes recognized by {@link renderExecStatusBadge}. */
const KNOWN_MESSAGE_LANE_REASONS: ReadonlySet<MessageLaneReason> = new Set([
  'running',
  'cooling-down',
  'back-pressure',
  'retrying',
  'no-work',
]);

/** Pending work depth for an agent broken out by lane. */
export interface AgentQueueDepth {
  messages: number;
  tasks: number;
  total: number;
}

/** Derive pending message and task counts for an agent. */
export function getAgentQueueDepth(
  folder: string,
  queueDetails: GroupQueueDetail[],
): AgentQueueDepth {
  const detail = queueDetails.find((d) => d.folderKey === folder);
  if (!detail) return { messages: 0, tasks: 0, total: 0 };
  const messages = detail.messageLane.pendingCount;
  const tasks = detail.taskLane.pendingCount;
  return { messages, tasks, total: messages + tasks };
}

/** Derive an agent's execution status from the group queue details. */
export function getAgentExecStatus(
  folder: string,
  queueDetails: GroupQueueDetail[],
): AgentExecStatus {
  const detail = queueDetails.find((d) => d.folderKey === folder);
  if (!detail) return 'offline';

  // Active message processing takes precedence
  if (detail.messageLane.active && !detail.messageLane.idle) return 'executing';

  // Running a scheduled task
  if (detail.taskLane.active) return 'running-task';

  // Container alive but idle-waiting
  if (detail.messageLane.idle) return 'idle';

  // Messages waiting in queue but no container yet
  if (detail.messageLane.pendingCount > 0 || detail.taskLane.pendingCount > 0)
    return 'queued';

  return 'offline';
}

/**
 * Resolve how long the currently active run on an agent's lane has been
 * executing, in milliseconds. Returns `null` when the agent is not actively
 * running anything (idle, queued, offline) or when the underlying lane
 * snapshot does not yet expose a running duration.
 *
 * Used by the agents directory to surface stuck/long-running work inline
 * with the status badge, without requiring an operator to drill into the
 * IPC inspector.
 */
export function getAgentRunningMs(
  folder: string,
  queueDetails: GroupQueueDetail[],
): number | null {
  const detail = queueDetails.find((d) => d.folderKey === folder);
  if (!detail) return null;

  // Message lane takes precedence — matches getAgentExecStatus.
  if (detail.messageLane.active && !detail.messageLane.idle) {
    const ms = detail.messageLane.runningMs;
    return typeof ms === 'number' && ms >= 0 ? ms : null;
  }

  if (detail.taskLane.active && detail.taskLane.activeTask) {
    const ms = detail.taskLane.activeTask.runningMs;
    return typeof ms === 'number' && ms >= 0 ? ms : null;
  }

  return null;
}

/**
 * Derive the underlying message-lane reason code for an agent.
 *
 * Returns the structured {@link MessageLaneReason} when the agent has a
 * queue detail entry (whether or not the lane is currently running). Returns
 * `null` when there is no detail for the folder (no live or recent state to
 * report). Operators use this to drill into *why* an idle/queued/offline
 * agent is in its current state — e.g. `cooling-down` (healthy idle) vs
 * `retrying` (backing off) vs `back-pressure` (waiting for a slot).
 */
export function getAgentExecReason(
  folder: string,
  queueDetails: GroupQueueDetail[],
): MessageLaneReason | null {
  const detail = queueDetails.find((d) => d.folderKey === folder);
  if (!detail) return null;
  return deriveMessageLaneReasonFromDetail(detail);
}

const EXEC_STATUS_LABELS: Record<AgentExecStatus, string> = {
  executing: 'executing',
  'running-task': 'task',
  idle: 'idle',
  queued: 'queued',
  offline: 'offline',
  disabled: 'disabled',
};

const EXEC_STATUS_CSS: Record<AgentExecStatus, string> = {
  executing: 'exec-executing',
  'running-task': 'exec-task',
  idle: 'exec-idle',
  queued: 'exec-queued',
  offline: 'exec-offline',
  disabled: 'exec-disabled',
};

function imageRev(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function avatarSrc(agent: AgentChannelData): string | null {
  if (!agent.avatarUrl) return null;
  if (agent.remoteInstanceId) {
    return `/api/discovery/peers/${encodeURIComponent(agent.remoteInstanceId)}/agents/${encodeURIComponent(agent.id.split(':').slice(1).join(':'))}/avatar/image?rev=${imageRev(agent.avatarUrl)}`;
  }
  return `/api/agents/${encodeURIComponent(agent.id)}/avatar/image?rev=${imageRev(agent.avatarUrl)}`;
}

function backendBadgeClass(backend: string): string {
  if (backend === 'apple-container') return 'badge-apple-container';
  if (backend === 'docker') return 'badge-docker';
  if (backend === 'cursor-sdk') return 'badge-cursor-sdk';
  return '';
}

/** Format a millisecond duration as a compact age badge string. */
function formatRunningDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Render the execution status badge for an agent. */
export function renderExecStatusBadge(
  status: AgentExecStatus,
  reason: MessageLaneReason | null = null,
  runningMs: number | null = null,
): string {
  const label = EXEC_STATUS_LABELS[status];
  const css = EXEC_STATUS_CSS[status];
  const statusBadge = `<span class="badge badge-sm ${css}">${escapeHtml(label)}</span>`;
  // Only surface the reason for non-active states (executing/running-task
  // already convey the lane reason via the status label itself). `disabled`
  // is an operator override and has no underlying lane reason.
  const shouldShowReason =
    reason !== null &&
    KNOWN_MESSAGE_LANE_REASONS.has(reason) &&
    status !== 'executing' &&
    status !== 'running-task' &&
    status !== 'disabled';
  const reasonBadge = shouldShowReason
    ? `<span class="lane-reason reason-${reason}" data-exec-reason="${reason}">${escapeHtml(reason as string)}</span>`
    : '';
  // Surface the running duration only for actively executing agents — the
  // age tells an operator how long the current message or task has been
  // running, helping spot stuck or long-running work without leaving the
  // agents directory.
  const shouldShowAge =
    typeof runningMs === 'number' &&
    runningMs >= 0 &&
    (status === 'executing' || status === 'running-task');
  if (!shouldShowAge) return statusBadge + reasonBadge;
  const formatted = formatRunningDuration(runningMs);
  return (
    statusBadge +
    reasonBadge +
    `<span class="lane-age" data-exec-running-ms="${runningMs}" title="running for ${escapeHtml(formatted)}">${escapeHtml(formatted)}</span>`
  );
}

const ZERO_QUEUE_DEPTH: AgentQueueDepth = {
  messages: 0,
  tasks: 0,
  total: 0,
};

/** Render the queue-depth cell for an agent row. */
function renderQueueDepthCell(depth: AgentQueueDepth): string {
  if (depth.total === 0) {
    return `<td class="td-center td-queue-depth" data-queue-total="0"><span class="qd-zero">0</span></td>`;
  }
  const parts: string[] = [];
  if (depth.messages > 0) {
    parts.push(
      `<span class="qd-msgs" title="${depth.messages} pending messages">${depth.messages}m</span>`,
    );
  }
  if (depth.tasks > 0) {
    parts.push(
      `<span class="qd-tasks" title="${depth.tasks} pending tasks">${depth.tasks}t</span>`,
    );
  }
  return (
    `<td class="td-center td-queue-depth qd-nonzero" data-queue-total="${depth.total}" data-queue-messages="${depth.messages}" data-queue-tasks="${depth.tasks}">` +
    parts.join('') +
    `</td>`
  );
}

/** Render a single agent row in the agents table. */
export function renderAgentRow(
  agent: AgentChannelData,
  taskCount: number,
  execStatus: AgentExecStatus = 'offline',
  execReason: MessageLaneReason | null = null,
  queueDepth: AgentQueueDepth = ZERO_QUEUE_DEPTH,
  runningMs: number | null = null,
): string {
  const esc = escapeHtml;
  const avatar = avatarSrc(agent);
  const detailUrl = `/agents?id=${encodeURIComponent(agent.id)}`;

  const avatarHtml = avatar
    ? `<img class="ap-avatar" src="${avatar}" alt="${esc(agent.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` +
      `<span class="ap-avatar-ph" style="display:none">${esc(agent.name.charAt(0).toUpperCase())}</span>`
    : `<span class="ap-avatar-ph">${esc(agent.name.charAt(0).toUpperCase())}</span>`;

  // Local agents only — remote agents are toggled on their own host.
  const isLocal = !agent.remoteInstanceId;
  const isDisabled = execStatus === 'disabled';
  const toggleLabel = isDisabled ? 'enable' : 'disable';
  const toggleTarget = isDisabled ? 'true' : 'false';
  const toggleBtn = isLocal
    ? ` <button class="btn btn-sm" data-agent-toggle="${toggleTarget}" data-agent-id="${esc(agent.id)}">${toggleLabel}</button>`
    : '';

  return (
    `<tr class="ap-row" data-agent-id="${esc(agent.id)}" data-backend="${esc(agent.backend)}" data-runtime="${esc(agent.agentRuntime)}"` +
    (agent.remoteInstanceId ? ` data-remote="true"` : ` data-remote="false"`) +
    (agent.isAdmin ? ` data-admin="true"` : '') +
    (isDisabled ? ` data-disabled="true"` : '') +
    `>` +
    `<td class="td-agent-name">` +
    `<a href="${detailUrl}" data-nav data-page="agent-detail" data-agent-id="${esc(agent.id)}" class="ap-agent-link">` +
    `<span class="ap-avatar-wrap">${avatarHtml}</span>` +
    `<span class="ap-name">${esc(agent.name)}</span>` +
    `</a></td>` +
    `<td>${renderExecStatusBadge(execStatus, execReason, runningMs)}</td>` +
    `<td><span class="badge ${backendBadgeClass(agent.backend)}">${esc(agent.backend)}</span></td>` +
    `<td><span class="badge badge-sm">${esc(agent.agentRuntime)}</span></td>` +
    `<td class="td-center">${agent.channels.length}</td>` +
    renderQueueDepthCell(queueDepth) +
    `<td class="td-center">${taskCount}</td>` +
    `<td>` +
    (agent.isAdmin
      ? `<span class="badge badge-admin badge-sm">admin</span> `
      : '') +
    (agent.remoteInstanceId
      ? `<span class="badge badge-sm badge-remote">${esc(agent.remoteInstanceName || 'remote')}</span>`
      : '') +
    `</td>` +
    `<td class="td-actions">` +
    `<a href="${detailUrl}" data-nav data-page="agent-detail" data-agent-id="${esc(agent.id)}" class="btn btn-sm">detail</a>` +
    (agent.channels.length > 0
      ? ` <a href="/conversations?chat=${encodeURIComponent(agent.channels[0].jid)}" data-nav data-page="conversations" class="btn btn-sm">messages</a>`
      : '') +
    toggleBtn +
    `</td>` +
    `</tr>`
  );
}

/** Render the agents page content (no shell wrapper — for SPA nav). */
export function renderAgentsContent(
  state: WebStateProvider,
  remotePeers: RemotePeerAgents[] = [],
): string {
  const agentData = buildAgentChannelData(state, remotePeers);
  const tasks = state.getTasks();
  const queueDetails = state.getQueueDetails();

  // Count tasks per agent group folder
  const taskCounts: Record<string, number> = {};
  for (const t of tasks) {
    taskCounts[t.group_folder] = (taskCounts[t.group_folder] || 0) + 1;
  }

  // Collect unique backends and runtimes for filter dropdowns
  const backends = [...new Set(agentData.map((a) => a.backend))].sort();
  const runtimes = [...new Set(agentData.map((a) => a.agentRuntime))].sort();

  const localCount = agentData.filter((a) => !a.remoteInstanceId).length;
  const remoteCount = agentData.filter((a) => a.remoteInstanceId).length;

  const backendOptions = backends
    .map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`)
    .join('');

  const runtimeOptions = runtimes
    .map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`)
    .join('');

  const localAgents = state.getAgents();
  const rows = agentData
    .map((a) => {
      let status: AgentExecStatus;
      let reason: MessageLaneReason | null = null;
      let queueDepth: AgentQueueDepth = ZERO_QUEUE_DEPTH;
      let runningMs: number | null = null;
      if (a.remoteInstanceId) {
        status = 'offline';
      } else if (localAgents[a.id]?.enabled === false) {
        status = 'disabled';
      } else {
        status = getAgentExecStatus(a.folder, queueDetails);
        reason = getAgentExecReason(a.folder, queueDetails);
        queueDepth = getAgentQueueDepth(a.folder, queueDetails);
        runningMs = getAgentRunningMs(a.folder, queueDetails);
      }
      return renderAgentRow(
        a,
        taskCounts[a.folder] || 0,
        status,
        reason,
        queueDepth,
        runningMs,
      );
    })
    .join('\n');

  return (
    `<div data-init="window.__initPage && window.__initPage('agents')">` +
    `<div class="agents-page">` +
    // Header
    `<div class="ap-header">` +
    `<div class="ap-title-row">` +
    `<h2>Agents</h2>` +
    `<div class="ap-counts">` +
    `<span class="ap-count">${agentData.length} total</span>` +
    `<span class="ap-count">${localCount} local</span>` +
    (remoteCount > 0
      ? `<span class="ap-count">${remoteCount} remote</span>`
      : '') +
    `</div>` +
    `</div>` +
    // Filters row
    `<div class="ap-filters">` +
    `<input type="text" class="ap-search" id="ap-search" placeholder="Search agents\u2026">` +
    `<select class="ap-filter-select" id="ap-filter-backend"><option value="">All backends</option>${backendOptions}</select>` +
    `<select class="ap-filter-select" id="ap-filter-runtime"><option value="">All runtimes</option>${runtimeOptions}</select>` +
    `</div>` +
    `</div>` +
    // Table
    `<div class="ap-table-wrap">` +
    `<table class="ap-table">` +
    `<thead><tr>` +
    `<th>agent</th>` +
    `<th>status</th>` +
    `<th>backend</th>` +
    `<th>runtime</th>` +
    `<th class="th-center">channels</th>` +
    `<th class="th-center" title="pending messages and tasks waiting to run">queued</th>` +
    `<th class="th-center">tasks</th>` +
    `<th>flags</th>` +
    `<th>actions</th>` +
    `</tr></thead>` +
    `<tbody id="ap-tbody">${rows}</tbody>` +
    `</table>` +
    (agentData.length === 0
      ? `<div class="ap-empty">No agents registered.</div>`
      : '') +
    `</div>` +
    `</div></div>`
  );
}

/** Full agents page with SPA shell. */
export function renderAgentsPage(state: WebStateProvider): string {
  return renderAgentsPageWithRemote(state, []);
}

export function renderAgentsPageWithRemote(
  state: WebStateProvider,
  remotePeers: RemotePeerAgents[],
): string {
  return renderShell(
    '/agents-list',
    'Agents',
    renderAgentsContent(state, remotePeers),
    allPageScripts(),
  );
}
