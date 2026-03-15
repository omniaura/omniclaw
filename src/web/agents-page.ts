/**
 * Agents page — top-level agent directory with search, filters, and quick actions.
 * Shows all local and remote agents in a clean table with backend badges,
 * channel/task counts, and links to detail pages.
 */

import { createHash } from 'crypto';

import type { WebStateProvider } from './types.js';
import { renderShell, escapeHtml } from './shared.js';
import { allPageScripts } from './page-scripts.js';
import {
  buildAgentChannelData,
  type AgentChannelData,
} from './agent-channels.js';
import type { RemotePeerAgents } from '../discovery/types.js';

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
  return '';
}

/** Render a single agent row in the agents table. */
export function renderAgentRow(
  agent: AgentChannelData,
  taskCount: number,
): string {
  const esc = escapeHtml;
  const avatar = avatarSrc(agent);
  const detailUrl = `/agents?id=${encodeURIComponent(agent.id)}`;

  const avatarHtml = avatar
    ? `<img class="ap-avatar" src="${avatar}" alt="${esc(agent.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
    + `<span class="ap-avatar-ph" style="display:none">${esc(agent.name.charAt(0).toUpperCase())}</span>`
    : `<span class="ap-avatar-ph">${esc(agent.name.charAt(0).toUpperCase())}</span>`;

  return (
    `<tr class="ap-row" data-agent-id="${esc(agent.id)}" data-backend="${esc(agent.backend)}" data-runtime="${esc(agent.agentRuntime)}"` +
    (agent.remoteInstanceId ? ` data-remote="true"` : ` data-remote="false"`) +
    (agent.isAdmin ? ` data-admin="true"` : '') +
    `>` +
    `<td class="td-agent-name">` +
    `<a href="${detailUrl}" data-nav data-page="agent-detail" data-agent-id="${esc(agent.id)}" class="ap-agent-link">` +
    `<span class="ap-avatar-wrap">${avatarHtml}</span>` +
    `<span class="ap-name">${esc(agent.name)}</span>` +
    `</a></td>` +
    `<td><span class="badge ${backendBadgeClass(agent.backend)}">${esc(agent.backend)}</span></td>` +
    `<td><span class="badge badge-sm">${esc(agent.agentRuntime)}</span></td>` +
    `<td class="td-center">${agent.channels.length}</td>` +
    `<td class="td-center">${taskCount}</td>` +
    `<td>` +
    (agent.isAdmin ? `<span class="badge badge-admin badge-sm">admin</span> ` : '') +
    (agent.remoteInstanceId
      ? `<span class="badge badge-sm badge-remote">${esc(agent.remoteInstanceName || 'remote')}</span>`
      : '') +
    `</td>` +
    `<td class="td-actions">` +
    `<a href="${detailUrl}" data-nav data-page="agent-detail" data-agent-id="${esc(agent.id)}" class="btn btn-sm">detail</a>` +
    (agent.channels.length > 0
      ? ` <a href="/conversations?chat=${encodeURIComponent(agent.channels[0].jid)}" data-nav data-page="conversations" class="btn btn-sm">messages</a>`
      : '') +
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
    .map(
      (b) =>
        `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`,
    )
    .join('');

  const runtimeOptions = runtimes
    .map(
      (r) =>
        `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`,
    )
    .join('');

  const rows = agentData
    .map((a) => renderAgentRow(a, taskCounts[a.folder] || 0))
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
    `<th>backend</th>` +
    `<th>runtime</th>` +
    `<th class="th-center">channels</th>` +
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
