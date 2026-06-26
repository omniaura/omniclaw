/**
 * Task Manager page — full CRUD for scheduled tasks.
 * Lists all tasks with status badges, schedule info, and actions.
 * Supports create, edit, pause/resume, delete, and run-history viewing.
 */

import type { ScheduledTask, TaskOutcomeState } from '../types.js';
import type { WebStateProvider } from './types.js';
import { renderShell, escapeHtml } from './shared.js';
import { allPageScripts } from './page-scripts.js';
import { buildAgentChannelData } from './agent-channels.js';
import { lastRunOutcomeClass } from './agent-detail.js';

/** Render the task manager content (no shell wrapper — for SPA nav). */
export function renderTasksContent(state: WebStateProvider): string {
  const tasks = state.getTasks();
  const agentData = buildAgentChannelData(state);

  const activeTasks = tasks.filter((t) => t.status === 'active').length;
  const pausedTasks = tasks.filter((t) => t.status === 'paused').length;
  const completedTasks = tasks.filter((t) => t.status === 'completed').length;
  const executingTasks = tasks.filter(
    (t) => t.status !== 'completed' && t.executing_since != null,
  ).length;

  // Build agent/channel options for create/edit forms
  const agentOptions = agentData
    .filter((a) => !a.remoteInstanceId)
    .map((a) =>
      a.channels.map(
        (ch) =>
          `<option value="${escapeHtml(a.folder)}|${escapeHtml(ch.jid)}">${escapeHtml(a.name)} \u2014 ${escapeHtml(ch.displayName)}</option>`,
      ),
    )
    .flat()
    .join('\n');

  return (
    `<div data-init="window.__initPage && window.__initPage('tasks')">` +
    `<div class="tasks-page">` +
    // Header
    `<div class="tasks-header">` +
    `<div class="tasks-title-row">` +
    `<h2>Task Manager</h2>` +
    `<button class="btn btn-primary" id="tm-btn-create">+ Create Task</button>` +
    `</div>` +
    // Stats row
    `<div class="tasks-stats">` +
    `<span class="tasks-stat">${tasks.length} total</span>` +
    `<span class="tasks-stat stat-active">${activeTasks} active</span>` +
    (executingTasks > 0
      ? `<span class="tasks-stat stat-executing">${executingTasks} executing</span>`
      : '') +
    `<span class="tasks-stat stat-paused">${pausedTasks} paused</span>` +
    `<span class="tasks-stat stat-completed">${completedTasks} completed</span>` +
    `</div>` +
    // Filter tabs
    `<div class="tasks-filters" id="tm-filters">` +
    `<button class="filter-btn active" data-filter="all">All</button>` +
    `<button class="filter-btn" data-filter="active">Active</button>` +
    `<button class="filter-btn" data-filter="paused">Paused</button>` +
    `<button class="filter-btn" data-filter="completed">Completed</button>` +
    `</div>` +
    `</div>` +
    // Task table
    `<div class="tasks-table-wrap">` +
    `<table class="tasks-table">` +
    `<thead><tr>` +
    `<th>status</th>` +
    `<th>agent</th>` +
    `<th>prompt</th>` +
    `<th>schedule</th>` +
    `<th>next run</th>` +
    `<th>last run</th>` +
    `<th>context</th>` +
    `<th>actions</th>` +
    `</tr></thead>` +
    `<tbody id="tm-tbody">` +
    renderTaskTableRows(tasks) +
    `</tbody>` +
    `</table>` +
    (tasks.length === 0
      ? `<div class="tasks-empty">No scheduled tasks yet. Create one to get started.</div>`
      : '') +
    `</div>` +
    // Run history panel (slides open below table)
    `<div class="tm-run-panel" id="tm-run-panel" style="display:none">` +
    `<div class="tm-run-header">` +
    `<h3 id="tm-run-title">Run History</h3>` +
    `<button class="btn btn-sm" id="tm-run-close">\u2715 Close</button>` +
    `</div>` +
    `<div id="tm-run-body"></div>` +
    `</div>` +
    `</div>` +
    // Create task modal
    renderTaskModal('create', agentOptions) +
    // Edit task modal
    renderTaskModal('edit', agentOptions) +
    // Delete confirmation modal
    `<div class="modal-overlay" id="tm-delete-modal">` +
    `<div class="modal">` +
    `<h3>Delete Task</h3>` +
    `<p class="tm-delete-msg" id="tm-delete-msg">Are you sure you want to delete this task?</p>` +
    `<div class="form-actions">` +
    `<button type="button" class="btn" id="tm-delete-cancel">Cancel</button>` +
    `<button type="button" class="btn btn-danger" id="tm-delete-confirm">Delete</button>` +
    `</div>` +
    `</div>` +
    `</div>` +
    `</div>`
  );
}

/** Full page with SPA shell. */
export function renderTasks(state: WebStateProvider): string {
  return renderShell(
    '/tasks',
    'Tasks',
    renderTasksContent(state),
    allPageScripts(),
  );
}

/** Render task table body rows. */
export function renderTaskTableRows(tasks: ScheduledTask[]): string {
  if (tasks.length === 0) return '';
  return tasks
    .map((task) => {
      const statusClass =
        task.status === 'active'
          ? 'status-active'
          : task.status === 'paused'
            ? 'status-paused'
            : 'status-completed';
      const runningBadge = renderRunningBadge(task);
      const toggleLabel = task.status === 'active' ? 'Pause' : 'Resume';
      const toggleStatus = task.status === 'active' ? 'paused' : 'active';
      const runButton =
        task.status === 'completed'
          ? ''
          : `<button class="btn btn-sm" data-tm-action="run">Run</button>`;
      const promptShort =
        task.prompt.length > 60
          ? task.prompt.slice(0, 57) + '\u2026'
          : task.prompt;
      const schedLabel = formatScheduleLabel(
        task.schedule_type,
        task.schedule_value,
      );
      const nextRun = task.next_run
        ? formatRelativeTime(task.next_run)
        : '\u2014';
      const lastRun = task.last_run
        ? formatRelativeTime(task.last_run)
        : '\u2014';
      const lastResultClass = lastRunOutcomeClass(
        task.last_outcome_state ?? null,
        task.last_result,
      );
      const outcomeBadge = renderOutcomeStateBadge(
        task.last_outcome_state ?? null,
        task.last_outcome_reason ?? null,
      );

      return (
        `<tr data-task-id="${escapeHtml(task.id)}" data-status="${escapeHtml(task.status)}">` +
        `<td><span class="badge ${statusClass}">${escapeHtml(task.status)}</span>${runningBadge}</td>` +
        `<td class="td-agent" title="${escapeHtml(task.chat_jid)}">${escapeHtml(task.group_folder)}</td>` +
        `<td class="td-prompt" title="${escapeHtml(task.prompt)}">${escapeHtml(promptShort)}</td>` +
        `<td class="td-sched"><span class="sched-type badge badge-sm">${escapeHtml(task.schedule_type)}</span> ` +
        `<span class="sched-label">${escapeHtml(schedLabel)}</span></td>` +
        `<td class="td-time" title="${escapeHtml(task.next_run ?? '')}">${escapeHtml(nextRun)}</td>` +
        `<td class="td-time ${lastResultClass}" title="${escapeHtml(task.last_run ?? '')}">${escapeHtml(lastRun)}${outcomeBadge}</td>` +
        `<td><span class="badge badge-sm">${escapeHtml(task.context_mode)}</span></td>` +
        `<td class="td-actions">` +
        `<button class="btn btn-sm btn-toggle" data-tm-action="toggle" data-status="${toggleStatus}">${toggleLabel}</button>` +
        runButton +
        `<button class="btn btn-sm" data-tm-action="edit">Edit</button>` +
        `<button class="btn btn-sm" data-tm-action="runs">Runs</button>` +
        `<button class="btn btn-sm btn-danger" data-tm-action="delete">Del</button>` +
        `</td>` +
        `</tr>`
      );
    })
    .join('\n');
}

/**
 * Map a TaskOutcomeState to the CSS color variable used by the badge.
 * Mirrors the palette in the task runs modal (page-scripts.ts).
 */
export function outcomeStateColor(
  state: TaskOutcomeState | null | undefined,
): string | null {
  if (state === 'done') return 'var(--green)';
  if (state === 'skipped') return 'var(--text-dim)';
  if (state === 'blocked') return 'var(--yellow)';
  if (state === 'abandoned') return 'var(--red)';
  return null;
}

/**
 * Render an inline outcome state badge for the /tasks last-run cell.
 * Returns an empty string when no outcome state is set. The reason, if
 * present, is surfaced as the tooltip; otherwise the badge tooltips the
 * state name itself.
 */
export function renderOutcomeStateBadge(
  state: TaskOutcomeState | null | undefined,
  reason: string | null | undefined,
): string {
  const color = outcomeStateColor(state);
  if (!color || !state) return '';
  const tooltip = reason && reason.length > 0 ? reason : state;
  return (
    ` <span class="task-outcome-badge"` +
    ` data-outcome-state="${escapeHtml(state)}"` +
    ` title="${escapeHtml(tooltip)}"` +
    ` style="background:color-mix(in srgb,${color} 20%,transparent);color:${color};` +
    `padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px;` +
    `vertical-align:middle">${escapeHtml(state)}</span>`
  );
}

function renderTaskModal(
  mode: 'create' | 'edit',
  agentOptions: string,
): string {
  const prefix = mode === 'create' ? 'tmc' : 'tme';
  const title = mode === 'create' ? 'Create Scheduled Task' : 'Edit Task';
  const submitLabel = mode === 'create' ? 'Create' : 'Save Changes';

  return (
    `<div class="modal-overlay" id="tm-${mode}-modal">` +
    `<div class="modal"><h3>${title}</h3>` +
    `<form id="${prefix}-form">` +
    `<div class="form-group"><label for="${prefix}-agent">Agent / Channel</label>` +
    `<select id="${prefix}-agent" ${mode === 'create' ? 'required' : ''}><option value="">Select agent\u2026</option>${agentOptions}</select></div>` +
    `<div class="form-group"><label for="${prefix}-prompt">Prompt</label>` +
    `<textarea id="${prefix}-prompt" placeholder="What should the agent do?" required></textarea></div>` +
    `<div class="form-group"><label for="${prefix}-schedule-type">Schedule Type</label>` +
    `<select id="${prefix}-schedule-type" required>` +
    `<option value="cron">Cron</option>` +
    `<option value="interval">Interval</option>` +
    `<option value="once">Once</option>` +
    `</select></div>` +
    // Cron input (shown by default)
    `<div class="form-group schedule-input" id="${prefix}-cron-group">` +
    `<label for="${prefix}-schedule-value">Cron Expression</label>` +
    `<input id="${prefix}-schedule-value" type="text" placeholder="0 9 * * *" required>` +
    `<div class="schedule-preview" id="${prefix}-schedule-preview"></div></div>` +
    // Interval input with unit selector
    `<div class="form-group schedule-input" id="${prefix}-interval-group" style="display:none">` +
    `<label>Repeat Every</label>` +
    `<div class="interval-row">` +
    `<input id="${prefix}-interval-num" type="number" min="1" step="1" value="60" class="interval-num">` +
    `<select id="${prefix}-interval-unit" class="interval-unit">` +
    `<option value="1000">seconds</option>` +
    `<option value="60000" selected>minutes</option>` +
    `<option value="3600000">hours</option>` +
    `</select>` +
    `</div>` +
    `<div class="schedule-preview" id="${prefix}-interval-preview"></div></div>` +
    // One-shot datetime picker
    `<div class="form-group schedule-input" id="${prefix}-once-group" style="display:none">` +
    `<label for="${prefix}-once-datetime">Run At</label>` +
    `<input id="${prefix}-once-datetime" type="datetime-local" class="datetime-input">` +
    `<div class="schedule-preview" id="${prefix}-once-preview"></div></div>` +
    `<div class="form-group"><label for="${prefix}-context-mode">Context Mode</label>` +
    `<select id="${prefix}-context-mode">` +
    `<option value="isolated">Isolated</option>` +
    `<option value="group">Group (with history)</option>` +
    `</select></div>` +
    `<div id="${prefix}-error" class="form-error"></div>` +
    `<div class="form-actions">` +
    `<button type="button" class="btn" id="${prefix}-cancel">Cancel</button>` +
    `<button type="submit" class="btn btn-primary" id="${prefix}-submit">${submitLabel}</button>` +
    `</div></form></div></div>`
  );
}

/**
 * Render the running-now badge for a task that's currently executing.
 * Returns an empty string when the task is completed, paused without an
 * active run, or has no `executing_since` timestamp.
 */
export function renderRunningBadge(task: ScheduledTask): string {
  if (task.status === 'completed') return '';
  if (!task.executing_since) return '';
  const runningMs = computeRunningMs(task.executing_since);
  if (runningMs == null || runningMs < 0) return '';
  const label = formatRunningAge(runningMs);
  return (
    `<span class="lane-age" title="running for ${escapeHtml(label)} (since ${escapeHtml(task.executing_since)})">` +
    `running ${escapeHtml(label)}</span>`
  );
}

function computeRunningMs(executingSince: string): number | null {
  try {
    const startedAt = new Date(executingSince).getTime();
    if (!Number.isFinite(startedAt)) return null;
    return Date.now() - startedAt;
  } catch {
    return null;
  }
}

/** Format a running duration with ms / s / m / h buckets. */
export function formatRunningAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Format a schedule value into a human-readable label. */
function formatScheduleLabel(type: string, value: string): string {
  if (type === 'interval') {
    const ms = parseInt(value, 10);
    if (isNaN(ms)) return value;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
    if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}m`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
  }
  if (type === 'once') {
    try {
      return new Date(value).toLocaleString();
    } catch {
      return value;
    }
  }
  // cron — return as-is; JS-side script will add human-readable preview
  return value;
}

/** Format a timestamp into a relative time string. */
function formatRelativeTime(isoStr: string): string {
  try {
    const date = new Date(isoStr);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const absDiff = Math.abs(diffMs);

    if (absDiff < 60_000) return diffMs > 0 ? 'in <1m' : '<1m ago';
    if (absDiff < 3_600_000) {
      const mins = Math.round(absDiff / 60_000);
      return diffMs > 0 ? `in ${mins}m` : `${mins}m ago`;
    }
    if (absDiff < 86_400_000) {
      const hours = Math.round(absDiff / 3_600_000);
      return diffMs > 0 ? `in ${hours}h` : `${hours}h ago`;
    }
    const days = Math.round(absDiff / 86_400_000);
    return diffMs > 0 ? `in ${days}d` : `${days}d ago`;
  } catch {
    return isoStr;
  }
}
