import { createHash } from 'crypto';

import { sanitizeTelegramAvatarUrl } from '../telegram-avatar.js';
import type { RemotePeerAgents } from '../discovery/types.js';
import type { MessageLaneReason } from '../group-queue.js';
import type { TaskOutcomeState } from '../types.js';
import type { WebStateProvider } from './types.js';
import { renderShell, escapeHtml } from './shared.js';
import { allPageScripts } from './page-scripts.js';
import { buildAgentChannelData } from './agent-channels.js';
import {
  getAgentExecReason,
  getAgentExecStatus,
  renderExecStatusBadge,
  type AgentExecStatus,
} from './agents-page.js';

function imageRev(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/**
 * Format a past timestamp into a short relative string for the agent detail
 * tasks table. Mirrors the unit progression used on `/tasks` so the two
 * surfaces agree at a glance. `now` is injectable for deterministic tests.
 */
export function formatTaskLastRun(
  isoStr: string | null,
  now: number = Date.now(),
): string {
  if (!isoStr) return '—';
  const t = new Date(isoStr).getTime();
  if (Number.isNaN(t)) return isoStr;
  const diff = Math.max(0, now - t);
  if (diff < 60_000) return '<1m ago';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

/**
 * Map a task's outcome into the same CSS class used by `/tasks`
 * (`run-success` / `run-error`). Keeps the success/error colors aligned
 * across surfaces.
 *
 * The scheduler stores a normalized {@link TaskOutcomeState} in
 * `last_outcome_state` *and* a free-text summary in `last_result`
 * (e.g. `Completed`, `Error: ...`, or a result excerpt). The normalized state
 * is the source of truth — when present it drives the color, so summary-string
 * rows still pick up the badge. `last_result` is only consulted for older
 * pre-normalization rows where the state was never written but the legacy
 * `success` / `error` tokens were (see #858).
 */
export function lastRunOutcomeClass(
  state: TaskOutcomeState | null | undefined,
  result?: string | null,
): string {
  if (state === 'done') return 'run-success';
  if (state === 'blocked' || state === 'abandoned') return 'run-error';
  if (state) return '';
  if (result === 'success') return 'run-success';
  if (result === 'error') return 'run-error';
  return '';
}

export interface AgentDetailData {
  id: string;
  name: string;
  folder: string;
  backend: string;
  agentRuntime: string;
  isAdmin: boolean;
  /** Whether the agent is enabled. Undefined for remote agents. */
  enabled?: boolean;
  /** Per-agent model override. Undefined for remote agents or when unset. */
  model?: string;
  description?: string;
  createdAt: string;
  remoteInstanceId?: string;
  remoteInstanceName?: string;
  remoteHost?: string;
  remotePort?: number;
  serverFolder?: string;
  agentContextFolder?: string;
  avatarUrl?: string;
  channels: Array<{
    jid: string;
    displayName: string;
    channelFolder?: string;
    categoryFolder?: string;
  }>;
  tasks: Array<{
    id: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
    last_run: string | null;
    last_result: string | null;
    last_outcome_state: TaskOutcomeState | null;
  }>;
  recentChats: Array<{
    jid: string;
    name: string;
    last_message_time: string;
  }>;
  /**
   * Server-derived execution status for the header badge. Mirrors the
   * /agents list so the initial render matches the live poll instead of
   * flashing "offline" before the first /api/ipc/queue response.
   */
  execStatus: AgentExecStatus;
  /**
   * Structured message-lane reason code (e.g. "cooling-down", "back-pressure",
   * "retrying"). Surfaced alongside the status badge for non-active states so
   * operators can see *why* an idle/queued agent is in its current state.
   * Null when the agent has no queue detail entry or the state is active.
   */
  execReason: MessageLaneReason | null;
}

/** Build enriched agent detail data from the state provider. */
export function buildAgentDetailData(
  agentId: string,
  state: WebStateProvider,
  remotePeers: RemotePeerAgents[] = [],
): AgentDetailData | null {
  const agents = state.getAgents();
  const agent = agents[agentId];

  if (!agent) {
    const remoteAgent = buildAgentChannelData(state, remotePeers).find(
      (candidate) => candidate.id === agentId && candidate.remoteInstanceId,
    );

    if (!remoteAgent) return null;

    return {
      id: remoteAgent.id,
      name: remoteAgent.name,
      folder: remoteAgent.folder,
      backend: remoteAgent.backend,
      agentRuntime: remoteAgent.agentRuntime,
      isAdmin: remoteAgent.isAdmin,
      createdAt: '',
      remoteInstanceId: remoteAgent.remoteInstanceId,
      remoteInstanceName: remoteAgent.remoteInstanceName,
      remoteHost: remoteAgent.remoteHost,
      remotePort: remoteAgent.remotePort,
      serverFolder: remoteAgent.serverFolder,
      agentContextFolder: remoteAgent.agentContextFolder,
      avatarUrl: remoteAgent.avatarUrl,
      channels: remoteAgent.channels.map((ch) => ({
        jid: ch.jid,
        displayName: ch.displayName,
        channelFolder: ch.channelFolder,
        categoryFolder: ch.categoryFolder,
      })),
      tasks: [],
      recentChats: [],
      execStatus: 'offline',
      execReason: null,
    };
  }

  const agentChannelData = buildAgentChannelData(state);
  const agentEntry = agentChannelData.find((a) => a.id === agentId);

  const channels = (agentEntry?.channels ?? []).map((ch) => ({
    jid: ch.jid,
    displayName: ch.displayName,
    channelFolder: ch.channelFolder,
    categoryFolder: ch.categoryFolder,
  }));

  const channelJids = new Set(channels.map((ch) => ch.jid));

  // Filter tasks that belong to this agent's group folder
  const tasks = state
    .getTasks()
    .filter((t) => t.group_folder === agent.folder)
    .map((t) => ({
      id: t.id,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
      last_run: t.last_run,
      last_result: t.last_result,
      last_outcome_state: t.last_outcome_state ?? null,
    }));

  // Find recent chats for this agent's channels
  const allChats = state.getChats();
  const recentChats = allChats
    .filter((c) => channelJids.has(c.jid))
    .map((c) => ({
      jid: c.jid,
      name: c.name || c.jid,
      last_message_time: c.last_message_time,
    }));

  // Server-derived live status. `disabled` is an operator override that
  // takes precedence over the queue-derived status, matching the agents-list
  // row treatment. Queue details may be empty (e.g. test stubs), in which
  // case `getAgentExecStatus` returns "offline" and the badge falls back to
  // the same value the previous hardcoded render produced.
  const queueDetails = state.getQueueDetails();
  let execStatus: AgentExecStatus;
  let execReason: MessageLaneReason | null = null;
  if (agent.enabled === false) {
    execStatus = 'disabled';
  } else {
    execStatus = getAgentExecStatus(agent.folder, queueDetails);
    execReason = getAgentExecReason(agent.folder, queueDetails);
  }

  return {
    id: agent.id,
    name: agent.name,
    folder: agent.folder,
    backend: agent.backend,
    agentRuntime: agent.agentRuntime,
    isAdmin: agent.isAdmin,
    // Default missing/undefined to true (agent is enabled unless explicitly off).
    enabled: agent.enabled !== false,
    model: agent.model || undefined,
    remoteInstanceId: undefined,
    remoteInstanceName: undefined,
    remoteHost: undefined,
    remotePort: undefined,
    description: agent.description,
    createdAt: agent.createdAt,
    serverFolder: agent.serverFolder,
    agentContextFolder: agent.agentContextFolder,
    avatarUrl: sanitizeTelegramAvatarUrl(agent.avatarUrl, agent.avatarSource),
    channels,
    tasks,
    recentChats,
    execStatus,
    execReason,
  };
}

/** Render agent detail content (no shell wrapper). */
export function renderAgentDetailContent(
  data: AgentDetailData | null,
  agentId: string,
): string {
  if (!data) {
    return (
      `<div data-init="window.__initPage && window.__initPage('agent-detail')">` +
      `<div class="agent-detail-empty">` +
      `<p>Agent not found: <code>${escapeHtml(agentId)}</code></p>` +
      `<a href="/" class="btn">Back to Dashboard</a>` +
      `</div></div>`
    );
  }

  const esc = escapeHtml;
  const avatarSrc = data.avatarUrl
    ? data.remoteInstanceId
      ? `/api/discovery/peers/${encodeURIComponent(data.remoteInstanceId)}/agents/${encodeURIComponent(data.id.split(':').slice(1).join(':'))}/avatar/image?rev=${imageRev(data.avatarUrl)}`
      : `/api/agents/${encodeURIComponent(data.id)}/avatar/image?rev=${imageRev(data.avatarUrl)}`
    : null;

  const backendBadge =
    data.backend === 'apple-container'
      ? 'badge-apple-container'
      : data.backend === 'docker'
        ? 'badge-docker'
        : data.backend === 'cursor-sdk'
          ? 'badge-cursor-sdk'
          : '';

  // --- Channels table ---
  const channelsHtml =
    data.channels.length > 0
      ? data.channels
          .map(
            (ch) =>
              `<tr>` +
              `<td>${esc(ch.displayName)}</td>` +
              `<td class="td-dim">${esc(ch.jid)}</td>` +
              `<td class="td-dim">${esc(ch.channelFolder || '\u2014')}</td>` +
              `<td class="actions">` +
              (data.remoteInstanceId
                ? `<span class="td-dim">remote</span>`
                : `<a href="/conversations?chat=${encodeURIComponent(ch.jid)}" data-nav data-page="conversations" class="btn btn-sm">messages</a>`) +
              `</td>` +
              `</tr>`,
          )
          .join('')
      : `<tr><td colspan="4" class="td-dim">No channels subscribed</td></tr>`;

  // --- Tasks table ---
  const isLocal = !data.remoteInstanceId;
  const tasksHtml =
    data.tasks.length > 0
      ? data.tasks
          .map((t) => {
            const statusClass =
              t.status === 'active'
                ? 'status-active'
                : t.status === 'paused'
                  ? 'status-paused'
                  : 'status-completed';
            const nextRun = t.next_run
              ? new Date(t.next_run).toLocaleString()
              : '\u2014';
            const lastRunLabel = formatTaskLastRun(t.last_run);
            const lastRunClass = lastRunOutcomeClass(
              t.last_outcome_state,
              t.last_result,
            );
            const lastRunTitle = t.last_run
              ? `${new Date(t.last_run).toLocaleString()}${t.last_result ? ` \u2014 ${t.last_result}` : ''}`
              : 'never run';
            const promptPreview =
              t.prompt.length > 80
                ? t.prompt.slice(0, 80) + '\u2026'
                : t.prompt;
            const toggleTarget = t.status === 'active' ? 'paused' : 'active';
            const toggleLabel = t.status === 'active' ? 'pause' : 'resume';
            const actionCell =
              isLocal && t.status !== 'completed'
                ? `<td class="actions"><button class="btn btn-sm" data-task-toggle="${toggleTarget}" data-task-id="${esc(t.id)}">${toggleLabel}</button></td>`
                : isLocal
                  ? `<td></td>`
                  : '';
            return (
              `<tr>` +
              `<td><span class="badge badge-sm ${statusClass}">${esc(t.status)}</span></td>` +
              `<td class="td-prompt" title="${esc(t.prompt)}">${esc(promptPreview)}</td>` +
              `<td class="td-dim">${esc(t.schedule_type)}: ${esc(t.schedule_value)}</td>` +
              `<td class="td-dim">${nextRun}</td>` +
              `<td class="td-dim ${lastRunClass}" title="${esc(lastRunTitle)}">${esc(lastRunLabel)}</td>` +
              actionCell +
              `</tr>`
            );
          })
          .join('')
      : `<tr><td colspan="${isLocal ? '6' : '5'}" class="td-dim">No scheduled tasks</td></tr>`;

  // --- Recent chats ---
  const chatsHtml =
    data.recentChats.length > 0
      ? data.recentChats
          .map((c) => {
            const lastTime = c.last_message_time
              ? new Date(c.last_message_time).toLocaleString()
              : '\u2014';
            return (
              `<tr>` +
              `<td>${esc(c.name)}</td>` +
              `<td class="td-dim">${lastTime}</td>` +
              `<td class="actions"><a href="/conversations?chat=${encodeURIComponent(c.jid)}" data-nav data-page="conversations" class="btn btn-sm">view</a></td>` +
              `</tr>`
            );
          })
          .join('')
      : `<tr><td colspan="3" class="td-dim">No conversations</td></tr>`;

  const createdDate = data.createdAt
    ? new Date(data.createdAt).toLocaleString()
    : '\u2014';

  return (
    `<div data-init="window.__initPage && window.__initPage('agent-detail')" data-agent-folder="${esc(data.folder)}">` +
    `<div class="agent-detail">` +
    // Back link
    `<div class="ad-back"><a href="/" data-nav data-page="dashboard" class="btn btn-sm">\u2190 dashboard</a></div>` +
    // Header
    `<div class="ad-header">` +
    (avatarSrc
      ? `<img class="ad-avatar" src="${avatarSrc}" alt="${esc(data.name)}" onerror="this.style.display='none'">`
      : `<div class="ad-avatar-placeholder">${esc(data.name.charAt(0).toUpperCase())}</div>`) +
    `<div class="ad-header-info">` +
    `<h2 class="ad-name">${esc(data.name)} <span id="ad-exec-status" class="ad-exec-status-wrap" data-exec-status="${data.execStatus}"${data.execReason ? ` data-exec-reason="${data.execReason}"` : ''}>` +
    renderExecStatusBadge(data.execStatus, data.execReason) +
    `</span></h2>` +
    `<div class="ad-meta">` +
    `<span class="badge ${backendBadge}">${esc(data.backend)}</span>` +
    `<span class="badge">${esc(data.agentRuntime)}</span>` +
    (data.remoteInstanceId
      ? `<span class="badge badge-remote">${esc(data.remoteInstanceName || data.remoteInstanceId)}</span>`
      : '') +
    (data.isAdmin ? `<span class="badge badge-admin">admin</span>` : '') +
    (!data.remoteInstanceId
      ? ` <button class="btn btn-sm" data-agent-toggle="${data.enabled === false ? 'true' : 'false'}" data-agent-id="${esc(data.id)}">${data.enabled === false ? 'enable' : 'disable'}</button>`
      : '') +
    `</div>` +
    (data.description
      ? `<div class="ad-desc">${esc(data.description)}</div>`
      : '') +
    `</div>` +
    `</div>` +
    // Info grid
    `<div class="ad-info-grid">` +
    `<div class="ad-info-item"><span class="ad-info-label">id</span><span class="ad-info-value">${esc(data.id)}</span></div>` +
    `<div class="ad-info-item"><span class="ad-info-label">folder</span><span class="ad-info-value">${esc(data.folder)}</span></div>` +
    `<div class="ad-info-item"><span class="ad-info-label">created</span><span class="ad-info-value">${createdDate}</span></div>` +
    (data.remoteInstanceId
      ? `<div class="ad-info-item"><span class="ad-info-label">remote peer</span><span class="ad-info-value">${esc(data.remoteInstanceName || data.remoteInstanceId)}</span></div>`
      : '') +
    (data.serverFolder
      ? `<div class="ad-info-item"><span class="ad-info-label">server</span><span class="ad-info-value">${esc(data.serverFolder)}</span></div>`
      : '') +
    (data.agentContextFolder
      ? `<div class="ad-info-item"><span class="ad-info-label">context folder</span><span class="ad-info-value">${esc(data.agentContextFolder)}</span></div>`
      : '') +
    `</div>` +
    // Model override (local agents only). Editable inline; empty clears.
    (!data.remoteInstanceId
      ? `<div class="ad-section ad-model-section">` +
        `<h3 class="ad-section-title">model</h3>` +
        `<form class="ad-model-form" data-agent-model-form data-agent-id="${esc(data.id)}">` +
        `<input type="text" class="ad-model-input" name="model" value="${esc(data.model || '')}" placeholder="(use .env default)" maxlength="200" autocomplete="off">` +
        `<button class="btn btn-sm" type="submit">save</button>` +
        `</form>` +
        `<div class="ad-model-help td-dim">Overrides the host .env value. ` +
        `Claude → claude-opus-4-7, OpenCode → anthropic/claude-sonnet-4-5, Codex → CODEX_MODEL, Cursor → CURSOR_AGENT_MODEL. ` +
        `Leave blank to fall back to .env.</div>` +
        `</div>`
      : '') +
    // Channels section
    `<div class="ad-section">` +
    `<h3 class="ad-section-title">channels <span class="ad-count">${data.channels.length}</span></h3>` +
    `<div class="ad-table-wrap"><table>` +
    `<thead><tr><th>name</th><th>jid</th><th>folder</th><th></th></tr></thead>` +
    `<tbody>${channelsHtml}</tbody>` +
    `</table></div></div>` +
    // Tasks section
    `<div class="ad-section">` +
    `<h3 class="ad-section-title">scheduled tasks <span class="ad-count">${data.tasks.length}</span></h3>` +
    `<div class="ad-table-wrap"><table>` +
    `<thead><tr><th>status</th><th>prompt</th><th>schedule</th><th>next run</th><th>last run</th>${isLocal ? '<th></th>' : ''}</tr></thead>` +
    `<tbody>${tasksHtml}</tbody>` +
    `</table></div></div>` +
    // Recent conversations section
    `<div class="ad-section">` +
    `<h3 class="ad-section-title">conversations <span class="ad-count">${data.recentChats.length}</span></h3>` +
    `<div class="ad-table-wrap"><table>` +
    `<thead><tr><th>chat</th><th>last message</th><th></th></tr></thead>` +
    `<tbody>${chatsHtml}</tbody>` +
    `</table></div></div>` +
    `</div></div>`
  );
}

/** Full agent detail page with SPA shell. */
export function renderAgentDetail(
  agentId: string,
  state: WebStateProvider,
  remotePeers: RemotePeerAgents[] = [],
): string {
  const data = buildAgentDetailData(agentId, state, remotePeers);
  const title = data ? data.name : 'Agent Not Found';
  return renderShell(
    '/agents',
    title,
    renderAgentDetailContent(data, agentId),
    allPageScripts(),
  );
}
