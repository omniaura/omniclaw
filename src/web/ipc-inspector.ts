import type { WebStateProvider } from './types.js';
import { renderShell, escapeHtml } from './shared.js';
import { allPageScripts } from './page-scripts.js';

/** Render IPC inspector content (no shell). */
export function renderIpcInspectorContent(state: WebStateProvider): string {
  const stats = state.getQueueStats();
  const queueDetails = state.getQueueDetails();
  const events = state.getIpcEvents(50);

  const groupRows = queueDetails
    .map((g) => {
      const msgStatus = g.messageLane.idle
        ? 'idle'
        : g.messageLane.active
          ? 'active'
          : 'off';
      const taskStatus = g.taskLane.active ? 'active' : 'off';
      const taskInfo = g.taskLane.activeTask
        ? `${escapeHtml(g.taskLane.activeTask.taskId)} (${formatDuration(g.taskLane.activeTask.runningMs)})`
        : '\u2014';
      return `<tr>
        <td class="folder-key">${escapeHtml(g.folderKey)}</td>
        <td><span class="lane-badge lane-${msgStatus}">${msgStatus}</span></td>
        <td>${g.messageLane.pendingCount}</td>
        <td><span class="lane-badge lane-${taskStatus}">${taskStatus}</span></td>
        <td>${g.taskLane.pendingCount}</td>
        <td class="task-info">${taskInfo}</td>
        <td>${g.retryCount > 0 ? `<span class="retry-count">${g.retryCount}</span>` : '\u2014'}</td>
      </tr>`;
    })
    .join('\n');

  const eventRows = events
    .map((e) => {
      const kindClass =
        e.kind.includes('error') || e.kind.includes('blocked')
          ? 'event-error'
          : e.kind.includes('suppressed')
            ? 'event-warn'
            : 'event-ok';
      const time = new Date(e.timestamp).toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      return `<tr class="${kindClass}">
        <td class="event-time">${time}</td>
        <td><span class="event-kind-badge">${escapeHtml(e.kind)}</span></td>
        <td class="event-source">${escapeHtml(e.sourceGroup)}</td>
        <td class="event-summary">${escapeHtml(e.summary)}</td>
      </tr>`;
    })
    .join('\n');

  return (
    `<div data-init="window.__initPage && window.__initPage('ipc')">` +
    `<div class="ipc-layout">` +
    `<div class="stats-grid">` +
    `<div class="stat-card"><div class="label">processing</div><div class="value" id="stat-processing">${Math.max(0, stats.activeContainers - stats.idleContainers)}/${stats.maxActive}</div></div>` +
    `<div class="stat-card"><div class="label">idle</div><div class="value" id="stat-ipc-idle">${stats.idleContainers}/${stats.maxIdle}</div></div>` +
    `<div class="stat-card"><div class="label">groups tracked</div><div class="value" id="stat-groups">${queueDetails.length}</div></div>` +
    `<div class="stat-card"><div class="label">recent events</div><div class="value" id="stat-events">${events.length}</div></div>` +
    `</div>` +
    `<section><h2>group queue state</h2>` +
    (queueDetails.length > 0
      ? `<table id="queue-table"><thead><tr>` +
        `<th>group</th><th>messages</th><th>msg queue</th><th>tasks</th><th>task queue</th><th>running task</th><th>retries</th>` +
        `</tr></thead><tbody id="queue-body">${groupRows}</tbody></table>`
      : '<div class="ipc-empty">No groups currently tracked.</div>') +
    `</section>` +
    `<section><h2>ipc event timeline</h2>` +
    (events.length > 0
      ? `<table id="events-table"><thead><tr>` +
        `<th>time</th><th>kind</th><th>source</th><th>summary</th>` +
        `</tr></thead><tbody id="events-body">${eventRows}</tbody></table>`
      : '<div class="ipc-empty">No IPC events recorded yet.</div>') +
    `</section>` +
    `</div></div>`
  );
}

/** Full IPC inspector page with shell. */
export function renderIpcInspector(state: WebStateProvider): string {
  return renderShell(
    '/ipc',
    'IPC Inspector',
    renderIpcInspectorContent(state),
    allPageScripts(),
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
