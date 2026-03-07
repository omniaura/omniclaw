import type { WebStateProvider } from './types.js';
import { renderShell, escapeHtml } from './shared.js';
import { allPageScripts } from './page-scripts.js';

/** Render the dashboard content (no shell wrapper). */
export function renderDashboardContent(state: WebStateProvider): string {
  const stats = state.getQueueStats();
  const agents = Object.values(state.getAgents());
  const tasks = state.getTasks();
  const subs = state.getChannelSubscriptions();

  const activeContainers = Math.max(
    0,
    stats.activeContainers - stats.idleContainers,
  );
  const activeTasks = tasks.filter((t) => t.status === 'active').length;

  const agentRows = agents
    .map((a) => {
      const channels = Object.entries(subs)
        .filter(([, s]) => s.some((sub) => sub.agentId === a.id))
        .map(([jid]) => escapeHtml(jid));
      return `<tr>
        <td>${escapeHtml(a.id)}</td>
        <td>${escapeHtml(a.name)}</td>
        <td><span class="badge ${a.backend === 'apple-container' ? 'badge-apple-container' : a.backend === 'docker' ? 'badge-docker' : ''}">${escapeHtml(a.backend)}</span></td>
        <td>${escapeHtml(a.agentRuntime)}</td>
        <td>${a.isAdmin ? '<span class="badge badge-admin">admin</span>' : ''}</td>
        <td class="channels">${channels.join('<br>') || '\u2014'}</td>
      </tr>`;
    })
    .join('\n');

  const taskRows = tasks
    .slice(0, 50)
    .map((t) => {
      const statusClass =
        t.status === 'active'
          ? 'status-active'
          : t.status === 'paused'
            ? 'status-paused'
            : 'status-completed';
      const nextRun = t.next_run ? new Date(t.next_run).toLocaleString() : '\u2014';
      const lastRun = t.last_run ? new Date(t.last_run).toLocaleString() : '\u2014';
      const toggleLabel = t.status === 'active' ? 'Pause' : 'Resume';
      const toggleStatus = t.status === 'active' ? 'paused' : 'active';
      return `<tr data-task-id="${escapeHtml(t.id)}">
        <td title="${escapeHtml(t.id)}">${escapeHtml(t.id.slice(0, 8))}\u2026</td>
        <td>${escapeHtml(t.group_folder)}</td>
        <td><span class="badge ${statusClass}">${escapeHtml(t.status)}</span></td>
        <td>${escapeHtml(t.schedule_type)}: ${escapeHtml(t.schedule_value)}</td>
        <td title="${escapeHtml(t.prompt)}">${escapeHtml(t.prompt.slice(0, 80))}${t.prompt.length > 80 ? '\u2026' : ''}</td>
        <td>${escapeHtml(nextRun)}</td>
        <td>${escapeHtml(lastRun)}</td>
        <td class="actions">
          <button class="btn btn-sm btn-toggle" data-action="toggle" data-status="${toggleStatus}" title="${toggleLabel}">${toggleLabel}</button>
          <button class="btn btn-sm btn-danger" data-action="delete" title="Delete">Delete</button>
        </td>
      </tr>`;
    })
    .join('\n');

  const agentOptions = agents
    .map((a) => {
      const jids = Object.entries(subs)
        .filter(([, s]) => s.some((sub) => sub.agentId === a.id))
        .map(([jid]) => jid);
      return jids.map(
        (jid) =>
          `<option value="${escapeHtml(a.folder)}|${escapeHtml(jid)}">${escapeHtml(a.name)} (${escapeHtml(jid)})</option>`,
      );
    })
    .flat()
    .join('\n');

  return (
    `<div data-init="window.__initPage && window.__initPage('dashboard')">` +
    `<div class="dash-layout">` +
    `<div class="stats-grid">` +
    `<div class="stat-card"><div class="label">agents</div><div class="value" id="stat-agents">${agents.length}</div></div>` +
    `<div class="stat-card"><div class="label">active containers</div><div class="value" id="stat-active">${activeContainers}/${stats.maxActive}</div></div>` +
    `<div class="stat-card"><div class="label">idle containers</div><div class="value" id="stat-idle">${stats.idleContainers}/${stats.maxIdle}</div></div>` +
    `<div class="stat-card"><div class="label">active tasks</div><div class="value" id="stat-tasks">${activeTasks}</div></div>` +
    `</div>` +
    `<div class="tables-grid">` +
    `<div class="table-section">` +
    `<h2>agents</h2>` +
    `<div class="table-wrap"><table>` +
    `<thead><tr><th>id</th><th>name</th><th>backend</th><th>runtime</th><th>role</th><th>channels</th></tr></thead>` +
    `<tbody id="agents-tbody">${agentRows}</tbody>` +
    `</table></div></div>` +
    `<div class="table-section">` +
    `<div class="section-header"><h2>scheduled tasks</h2>` +
    `<button class="btn btn-primary btn-sm" id="btn-create-task">+ new</button></div>` +
    `<div class="table-wrap"><table>` +
    `<thead><tr><th>id</th><th>agent</th><th>status</th><th>schedule</th><th>prompt</th><th>next</th><th>last</th><th>actions</th></tr></thead>` +
    `<tbody id="tasks-tbody">${taskRows}</tbody>` +
    `</table></div></div>` +
    `</div></div>` +
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
