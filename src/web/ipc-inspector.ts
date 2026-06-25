import type { WebStateProvider } from './types.js';
import {
  deriveMessageLaneReasonFromDetail,
  deriveTaskLaneReasonFromDetail,
  type MessageLaneReason,
  type TaskLaneReason,
} from '../group-queue.js';
import { renderShell, escapeHtml, formatDurationCompact } from './shared.js';
import { allPageScripts } from './page-scripts.js';

const MESSAGE_REASON_CODES = new Set<MessageLaneReason>([
  'running',
  'cooling-down',
  'back-pressure',
  'retrying',
  'no-work',
]);

const TASK_REASON_CODES = new Set<TaskLaneReason>([
  'running',
  'back-pressure',
  'no-work',
]);

/** Render IPC inspector content (no shell). */
export function renderIpcInspectorContent(state: WebStateProvider): string {
  const stats = state.getQueueStats();
  const queueDetails = state.getQueueDetails();
  const events = state.getIpcEvents(50);

  let pendingMessages = 0;
  let pendingTasks = 0;
  let retryingGroups = 0;
  let totalRetries = 0;
  // Count groups with either lane currently in flight. Matches the
  // dashboard "agents (N working)" definition so the two surfaces agree:
  // - messageLane active and not idle (processing a message), or
  // - taskLane active (running a scheduled task).
  // Idle-waiting message lanes (active && idle — warm container in
  // cooldown) are intentionally excluded; they are "ready" but not "doing
  // work", mirroring getAgentExecStatus.
  let activeGroups = 0;
  for (const g of queueDetails) {
    pendingMessages += g.messageLane.pendingCount;
    pendingTasks += g.taskLane.pendingCount;
    if (g.retryCount > 0) retryingGroups++;
    totalRetries += g.retryCount;
    if ((g.messageLane.active && !g.messageLane.idle) || g.taskLane.active) {
      activeGroups++;
    }
  }
  const groupsTrackedValue =
    activeGroups > 0
      ? `${queueDetails.length} (${activeGroups} active)`
      : `${queueDetails.length}`;

  const groupRows = queueDetails
    .map((g) => {
      const msgStatus = g.messageLane.idle
        ? 'idle'
        : g.messageLane.active
          ? 'active'
          : 'off';
      const taskStatus = g.taskLane.active ? 'active' : 'off';
      const taskInfo = g.taskLane.activeTask
        ? `${escapeHtml(g.taskLane.activeTask.taskId)} (${formatDurationCompact(g.taskLane.activeTask.runningMs)})`
        : '\u2014';
      const msgReason = renderLaneReason(
        deriveMessageLaneReasonFromDetail(g),
        MESSAGE_REASON_CODES,
      );
      const taskReason = renderLaneReason(
        deriveTaskLaneReasonFromDetail(g),
        TASK_REASON_CODES,
      );
      const msgRunningMs = g.messageLane.runningMs;
      // Match agents-page `shouldShowAge`: only render the chip when we have a
      // positive duration. A `0ms` chip on a freshly-transitioned row is more
      // noise than signal, and keeping the threshold aligned across surfaces
      // means a future consumer of runningMs only has one rule to follow.
      const msgAge =
        typeof msgRunningMs === 'number' && msgRunningMs > 0
          ? `<span class="lane-age" title="running for ${escapeHtml(formatDurationCompact(msgRunningMs))}">${escapeHtml(formatDurationCompact(msgRunningMs))}</span>`
          : '';
      const retryCell =
        g.retryCount > 0
          ? `<span class="retry-count">${g.retryCount}</span>`
          : '\u2014';
      const lastErrorCell = renderLastErrorCell(
        g.messageLane.lastError,
        g.taskLane.lastError,
      );
      return `<tr>
        <td class="folder-key">${escapeHtml(g.folderKey)}</td>
        <td><span class="lane-badge lane-${msgStatus}">${msgStatus}</span>${msgReason}${msgAge}</td>
        <td>${g.messageLane.pendingCount}</td>
        <td><span class="lane-badge lane-${taskStatus}">${taskStatus}</span>${taskReason}</td>
        <td>${g.taskLane.pendingCount}</td>
        <td class="task-info">${taskInfo}</td>
        <td>${retryCell}</td>
        <td class="last-error">${lastErrorCell}</td>
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
    `<div class="stat-card"><div class="label">groups tracked</div><div class="value" id="stat-groups">${groupsTrackedValue}</div></div>` +
    `<div class="stat-card"><div class="label">pending msgs</div><div class="value" id="stat-pending-messages">${pendingMessages}</div></div>` +
    `<div class="stat-card"><div class="label">pending tasks</div><div class="value" id="stat-pending-tasks">${pendingTasks}</div></div>` +
    `<div class="stat-card"><div class="label">retrying</div><div class="value" id="stat-retrying">${retryingGroups > 0 ? `${retryingGroups} (${totalRetries})` : '0'}</div></div>` +
    `<div class="stat-card"><div class="label">recent events</div><div class="value" id="stat-events">${events.length}</div></div>` +
    `</div>` +
    `<section><h2>group queue state</h2>` +
    (queueDetails.length > 0
      ? `<table id="queue-table"><thead><tr>` +
        `<th>group</th><th>messages</th><th>msg queue</th><th>tasks</th><th>task queue</th><th>running task</th><th>retries</th><th>last error</th>` +
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

/**
 * Render the "last error" cell, combining the message and task lanes. The two
 * lanes fail independently, so a busy group can carry an error on either or
 * both. When both are present each link is prefixed with its lane label so the
 * operator can tell them apart; a single error renders bare for compactness.
 */
function renderLastErrorCell(
  msgErr: { message: string; at: number } | null | undefined,
  taskErr: { message: string; at: number } | null | undefined,
): string {
  if (!msgErr && !taskErr) return '\u2014';
  const showLabels = !!msgErr && !!taskErr;
  const segments: string[] = [];
  if (msgErr) segments.push(renderLastError(msgErr, showLabels ? 'msg' : ''));
  if (taskErr)
    segments.push(renderLastError(taskErr, showLabels ? 'task' : ''));
  return segments.join('');
}

function renderLastError(
  err: { message: string; at: number } | null | undefined,
  laneLabel: string = '',
): string {
  if (!err) return '\u2014';
  const ageMs = Math.max(0, Date.now() - err.at);
  const label = laneLabel
    ? `<span class="last-error-lane">${escapeHtml(laneLabel)}</span>`
    : '';
  return (
    `<a href="/logs" class="last-error-link" title="${escapeHtml(err.message)}">` +
    label +
    `<span class="last-error-text">${escapeHtml(err.message)}</span>` +
    `<span class="last-error-age">${formatDurationCompact(ageMs)}</span>` +
    `</a>`
  );
}

function renderLaneReason<T extends string>(
  reason: T,
  allowedCodes: ReadonlySet<T>,
): string {
  const code = allowedCodes.has(reason) ? reason : 'unknown';
  return `<span class="lane-reason reason-${code}">${escapeHtml(code)}</span>`;
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
