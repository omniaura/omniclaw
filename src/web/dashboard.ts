import { createHash } from 'crypto';

import type { WebStateProvider } from './types.js';
import { renderShell, escapeHtml } from './shared.js';
import { allPageScripts } from './page-scripts.js';
import { buildAgentChannelData } from './agent-channels.js';

function imageRev(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/** Render the dashboard content (no shell wrapper). */
export function renderDashboardContent(state: WebStateProvider): string {
  const stats = state.getQueueStats();
  const agentData = buildAgentChannelData(state);
  const tasks = state.getTasks();

  const activeContainers = Math.max(
    0,
    stats.activeContainers - stats.idleContainers,
  );
  const activeTasks = tasks.filter((t) => t.status === 'active').length;

  // Serialize agent topology data for canvas renderer
  const topoData = JSON.stringify(
    agentData.map((a) => ({
      id: a.id,
      name: a.name,
      backend: a.backend,
      runtime: a.agentRuntime,
      isAdmin: a.isAdmin,
      server: a.serverFolder || null,
      serverIconUrl: a.serverIconUrl || null,
      avatarUrl: a.avatarUrl
        ? `/api/agents/${encodeURIComponent(a.id)}/avatar/image?rev=${imageRev(a.avatarUrl)}`
        : null,
      channels: a.channels.map((ch) => ({
        jid: ch.jid,
        name: ch.displayName,
        category: ch.categoryFolder || null,
        channelFolder: ch.channelFolder || null,
        iconUrl: ch.iconUrl || null,
      })),
    })),
  );

  const agentOptions = agentData
    .map((a) =>
      a.channels.map(
        (ch) =>
          `<option value="${escapeHtml(a.folder)}|${escapeHtml(ch.jid)}">${escapeHtml(a.name)} \u2014 ${escapeHtml(ch.displayName)}</option>`,
      ),
    )
    .flat()
    .join('\n');

  return (
    `<div data-init="window.__initPage && window.__initPage('dashboard')">` +
    `<div class="dash-layout">` +
    // Main area: stats + topology
    `<div class="dash-main">` +
    `<div class="stats-grid">` +
    `<div class="stat-card"><div class="label">agents</div><div class="value" id="stat-agents">${agentData.length}</div></div>` +
    `<div class="stat-card"><div class="label">active containers</div><div class="value" id="stat-active">${activeContainers}/${stats.maxActive}</div></div>` +
    `<div class="stat-card"><div class="label">idle containers</div><div class="value" id="stat-idle">${stats.idleContainers}/${stats.maxIdle}</div></div>` +
    `<div class="stat-card"><div class="label">active tasks</div><div class="value" id="stat-tasks">${activeTasks}</div></div>` +
    `</div>` +
    `<div class="topo-section">` +
    `<div class="section-header"><h2>agent topology</h2>` +
    `<div class="topo-legend">` +
    `<span class="legend-item"><span class="legend-dot legend-agent"></span>agent</span>` +
    `<span class="legend-item"><span class="legend-dot legend-server"></span>server</span>` +
    `<span class="legend-item"><span class="legend-dot legend-category"></span>category</span>` +
    `<span class="legend-item"><span class="legend-dot legend-channel"></span>channel</span>` +
    `</div></div>` +
    `<div class="topo-canvas-wrap"><canvas id="topo-canvas"></canvas></div>` +
    `<div class="topo-tooltip" id="topo-tooltip"></div>` +
    `</div>` +
    `</div>` +
    `</div>` +
    `<script type="application/json" id="topo-data">${topoData}</script>` +
    `<div id="agents-tbody" style="display:none"></div>` +
    // Create task modal
    `<div class="modal-overlay" id="create-task-modal">` +
    `<div class="modal"><h3>Create Scheduled Task</h3>` +
    `<form id="create-task-form">` +
    `<div class="form-group"><label for="ct-agent">Agent / Channel</label>` +
    `<select id="ct-agent" required><option value="">Select agent\u2026</option>${agentOptions}</select></div>` +
    `<div class="form-group"><label for="ct-prompt">Prompt</label>` +
    `<textarea id="ct-prompt" placeholder="What should the agent do?" required></textarea></div>` +
    `<div class="form-group"><label for="ct-schedule-type">Schedule Type</label>` +
    `<select id="ct-schedule-type" required><option value="cron">Cron</option><option value="interval">Interval (ms)</option><option value="once">Once (ISO)</option></select></div>` +
    `<div class="form-group"><label for="ct-schedule-value">Schedule Value</label>` +
    `<input id="ct-schedule-value" type="text" placeholder="0 9 * * *" required></div>` +
    `<div class="form-group"><label for="ct-context-mode">Context Mode</label>` +
    `<select id="ct-context-mode"><option value="isolated">Isolated</option><option value="group">Group (with history)</option></select></div>` +
    `<div id="ct-error" class="form-error"></div>` +
    `<div class="form-actions">` +
    `<button type="button" class="btn" id="ct-cancel">Cancel</button>` +
    `<button type="submit" class="btn btn-primary" id="ct-submit">Create</button>` +
    `</div></form></div></div>` +
    `</div>`
  );
}

/** Full dashboard page with SPA shell. */
export function renderDashboard(state: WebStateProvider): string {
  return renderShell(
    '/',
    'Dashboard',
    renderDashboardContent(state),
    allPageScripts(),
  );
}
