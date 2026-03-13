import { createHash } from 'crypto';

import type { WebStateProvider } from './types.js';
import { renderShell, escapeHtml } from './shared.js';
import { allPageScripts } from './page-scripts.js';
import { buildAgentChannelData } from './agent-channels.js';

function imageRev(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export interface AgentDetailData {
  id: string;
  name: string;
  folder: string;
  backend: string;
  agentRuntime: string;
  isAdmin: boolean;
  description?: string;
  createdAt: string;
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
  }>;
  recentChats: Array<{
    jid: string;
    name: string;
    last_message_time: string;
  }>;
}

/** Build enriched agent detail data from the state provider. */
export function buildAgentDetailData(
  agentId: string,
  state: WebStateProvider,
): AgentDetailData | null {
  const agents = state.getAgents();
  const agent = agents[agentId];
  if (!agent) return null;

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

  return {
    id: agent.id,
    name: agent.name,
    folder: agent.folder,
    backend: agent.backend,
    agentRuntime: agent.agentRuntime,
    isAdmin: agent.isAdmin,
    description: agent.description,
    createdAt: agent.createdAt,
    serverFolder: agent.serverFolder,
    agentContextFolder: agent.agentContextFolder,
    avatarUrl: agent.avatarUrl,
    channels,
    tasks,
    recentChats,
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
    ? `/api/agents/${encodeURIComponent(data.id)}/avatar/image?rev=${imageRev(data.avatarUrl)}`
    : null;

  const backendBadge =
    data.backend === 'apple-container'
      ? 'badge-apple-container'
      : data.backend === 'docker'
        ? 'badge-docker'
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
              `<td class="actions"><a href="/conversations?chat=${encodeURIComponent(ch.jid)}" data-nav data-page="conversations" class="btn btn-sm">messages</a></td>` +
              `</tr>`,
          )
          .join('')
      : `<tr><td colspan="4" class="td-dim">No channels subscribed</td></tr>`;

  // --- Tasks table ---
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
            const promptPreview =
              t.prompt.length > 80
                ? t.prompt.slice(0, 80) + '\u2026'
                : t.prompt;
            return (
              `<tr>` +
              `<td><span class="badge badge-sm ${statusClass}">${esc(t.status)}</span></td>` +
              `<td class="td-prompt" title="${esc(t.prompt)}">${esc(promptPreview)}</td>` +
              `<td class="td-dim">${esc(t.schedule_type)}: ${esc(t.schedule_value)}</td>` +
              `<td class="td-dim">${nextRun}</td>` +
              `</tr>`
            );
          })
          .join('')
      : `<tr><td colspan="4" class="td-dim">No scheduled tasks</td></tr>`;

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
    `<div data-init="window.__initPage && window.__initPage('agent-detail')">` +
    `<div class="agent-detail">` +
    // Back link
    `<div class="ad-back"><a href="/" data-nav data-page="dashboard" class="btn btn-sm">\u2190 dashboard</a></div>` +
    // Header
    `<div class="ad-header">` +
    (avatarSrc
      ? `<img class="ad-avatar" src="${avatarSrc}" alt="${esc(data.name)}" onerror="this.style.display='none'">`
      : `<div class="ad-avatar-placeholder">${esc(data.name.charAt(0).toUpperCase())}</div>`) +
    `<div class="ad-header-info">` +
    `<h2 class="ad-name">${esc(data.name)}</h2>` +
    `<div class="ad-meta">` +
    `<span class="badge ${backendBadge}">${esc(data.backend)}</span>` +
    `<span class="badge">${esc(data.agentRuntime)}</span>` +
    (data.isAdmin
      ? `<span class="badge badge-admin">admin</span>`
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
    (data.serverFolder
      ? `<div class="ad-info-item"><span class="ad-info-label">server</span><span class="ad-info-value">${esc(data.serverFolder)}</span></div>`
      : '') +
    (data.agentContextFolder
      ? `<div class="ad-info-item"><span class="ad-info-label">context folder</span><span class="ad-info-value">${esc(data.agentContextFolder)}</span></div>`
      : '') +
    `</div>` +
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
    `<thead><tr><th>status</th><th>prompt</th><th>schedule</th><th>next run</th></tr></thead>` +
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
): string {
  const data = buildAgentDetailData(agentId, state);
  const title = data ? data.name : 'Agent Not Found';
  return renderShell(
    '/agents',
    title,
    renderAgentDetailContent(data, agentId),
    allPageScripts(),
  );
}
