import fs from 'fs';
import os from 'os';

import type { WebStateProvider } from './types.js';
import {
  deriveMessageLaneReasonFromDetail,
  deriveTaskLaneReasonFromDetail,
  type MessageLaneReason,
  type TaskLaneReason,
} from '../group-queue.js';
import { getAgentExecStatus, type AgentExecStatus } from './agents-page.js';
import { renderShell, escapeHtml } from './shared.js';
import { allPageScripts } from './page-scripts.js';

const MESSAGE_LANE_REASONS: readonly MessageLaneReason[] = [
  'running',
  'cooling-down',
  'back-pressure',
  'retrying',
  'no-work',
];

const TASK_LANE_REASONS: readonly TaskLaneReason[] = [
  'running',
  'back-pressure',
  'no-work',
];

const AGENT_EXEC_STATUSES: readonly AgentExecStatus[] = [
  'executing',
  'running-task',
  'idle',
  'queued',
  'offline',
  'disabled',
];

export interface HealthData {
  status: 'healthy';
  version: string;
  uptime_seconds: number;
  memory: {
    rss_mb: number;
    heap_used_mb: number;
    heap_total_mb: number;
  };
  cpu: {
    count: number;
    load_1m: number;
    load_5m: number;
    load_15m: number;
  };
  host_memory: {
    total_mb: number;
    free_mb: number;
    used_mb: number;
    used_pct: number;
  };
  runtime: {
    bun: string;
    platform: string;
    arch: string;
  };
  agents: {
    total: number;
    by_backend: Record<string, number>;
    by_runtime: Record<string, number>;
    /**
     * Count of local agents by derived execution status (idle, executing,
     * running-task, queued, offline, disabled). Mirrors the per-agent badge
     * shown on the /agents page so /system and /agents agree on the rollup.
     */
    by_exec_status: Record<AgentExecStatus, number>;
  };
  containers: {
    active: number;
    idle: number;
    max_active: number;
    max_idle: number;
  };
  tasks: {
    active: number;
    paused: number;
    completed: number;
    total: number;
  };
  queue: {
    /** Number of group folders currently tracked by the orchestrator. */
    groups: number;
    /** Total messages waiting across all message lanes. */
    pending_messages: number;
    /** Total scheduled tasks waiting across all task lanes. */
    pending_tasks: number;
    /** Number of groups whose message lane is actively processing. */
    processing_groups: number;
    /** Number of groups whose task lane has a task running. */
    running_tasks: number;
    /**
     * Longest currently-running task age in milliseconds across all task lanes.
     * Zero when no task is running. Useful for spotting stuck or long-running
     * tasks without drilling into /ipc.
     */
    longest_running_task_ms: number;
    /** Number of group folders whose consecutive retry count is greater than zero. */
    retrying_groups: number;
    /**
     * Sum of consecutive retry counts across all group folders. A single
     * group stuck retrying many times will inflate this without changing
     * `retrying_groups`, so the two together describe both the breadth
     * and the intensity of retry pressure.
     */
    total_retries: number;
    /**
     * Highest consecutive retry count observed across all group folders.
     * Useful for spotting a single stuck group at a glance, since
     * `retrying_groups` only counts groups but not their individual depth.
     */
    max_retries: number;
    /**
     * Count of message lanes by structured reason code. Keys are the same
     * `MessageLaneReason` values exposed on the IPC inspector page.
     */
    message_lane_reasons: Record<MessageLaneReason, number>;
    /**
     * Count of task lanes by structured reason code. Keys are the same
     * `TaskLaneReason` values exposed on the IPC inspector page.
     */
    task_lane_reasons: Record<TaskLaneReason, number>;
  };
  sse_clients: number;
  started_at: string;
}

const startedAt = new Date().toISOString();
const APP_VERSION = getAppVersion();

function getAppVersion(): string {
  if (process.env.npm_package_version) {
    return process.env.npm_package_version;
  }

  try {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ) as { version?: string };
    return packageJson.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function buildHealthData(
  state: WebStateProvider,
  sseClientCount: number,
): HealthData {
  const agents = Object.values(state.getAgents());
  const tasks = state.getTasks();
  const stats = state.getQueueStats();
  const queueDetails = state.getQueueDetails();
  const mem = process.memoryUsage();
  const load = os.loadavg();
  const cpuCount = os.cpus().length;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const usedPct = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;

  const byBackend: Record<string, number> = {};
  const byRuntime: Record<string, number> = {};
  const byExecStatus: Record<AgentExecStatus, number> = {
    executing: 0,
    'running-task': 0,
    idle: 0,
    queued: 0,
    offline: 0,
    disabled: 0,
  };
  for (const agent of agents) {
    byBackend[agent.backend] = (byBackend[agent.backend] || 0) + 1;
    byRuntime[agent.agentRuntime] = (byRuntime[agent.agentRuntime] || 0) + 1;
    const status: AgentExecStatus =
      agent.enabled === false
        ? 'disabled'
        : getAgentExecStatus(agent.folder, queueDetails);
    byExecStatus[status]++;
  }

  let activeTasks = 0,
    pausedTasks = 0,
    completedTasks = 0;
  for (const t of tasks) {
    if (t.status === 'active') activeTasks++;
    else if (t.status === 'paused') pausedTasks++;
    else if (t.status === 'completed') completedTasks++;
  }

  let pendingMessages = 0;
  let pendingTasks = 0;
  let processingGroups = 0;
  let runningTasks = 0;
  let longestRunningTaskMs = 0;
  let retryingGroups = 0;
  let totalRetries = 0;
  let maxRetries = 0;
  const messageLaneReasons: Record<MessageLaneReason, number> = {
    running: 0,
    'cooling-down': 0,
    'back-pressure': 0,
    retrying: 0,
    'no-work': 0,
  };
  const taskLaneReasons: Record<TaskLaneReason, number> = {
    running: 0,
    'back-pressure': 0,
    'no-work': 0,
  };
  for (const g of queueDetails) {
    pendingMessages += g.messageLane.pendingCount;
    pendingTasks += g.taskLane.pendingCount;
    if (g.messageLane.active) processingGroups++;
    if (g.taskLane.activeTask) {
      runningTasks++;
      if (g.taskLane.activeTask.runningMs > longestRunningTaskMs) {
        longestRunningTaskMs = g.taskLane.activeTask.runningMs;
      }
    }
    if (g.retryCount > 0) retryingGroups++;
    totalRetries += g.retryCount;
    if (g.retryCount > maxRetries) maxRetries = g.retryCount;
    messageLaneReasons[deriveMessageLaneReasonFromDetail(g)]++;
    taskLaneReasons[deriveTaskLaneReasonFromDetail(g)]++;
  }

  return {
    status: 'healthy',
    version: APP_VERSION,
    uptime_seconds: Math.floor(process.uptime()),
    memory: {
      rss_mb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
      heap_used_mb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
      heap_total_mb: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
    },
    cpu: {
      count: cpuCount,
      load_1m: Math.round((load[0] ?? 0) * 100) / 100,
      load_5m: Math.round((load[1] ?? 0) * 100) / 100,
      load_15m: Math.round((load[2] ?? 0) * 100) / 100,
    },
    host_memory: {
      total_mb: Math.round((totalMem / 1024 / 1024) * 10) / 10,
      free_mb: Math.round((freeMem / 1024 / 1024) * 10) / 10,
      used_mb: Math.round((usedMem / 1024 / 1024) * 10) / 10,
      used_pct: Math.round(usedPct * 10) / 10,
    },
    runtime: {
      bun: typeof Bun !== 'undefined' ? Bun.version : process.version,
      platform: process.platform,
      arch: process.arch,
    },
    agents: {
      total: agents.length,
      by_backend: byBackend,
      by_runtime: byRuntime,
      by_exec_status: byExecStatus,
    },
    containers: {
      active: Math.max(0, stats.activeContainers - stats.idleContainers),
      idle: stats.idleContainers,
      max_active: stats.maxActive,
      max_idle: stats.maxIdle,
    },
    tasks: {
      active: activeTasks,
      paused: pausedTasks,
      completed: completedTasks,
      total: tasks.length,
    },
    queue: {
      groups: queueDetails.length,
      pending_messages: pendingMessages,
      pending_tasks: pendingTasks,
      processing_groups: processingGroups,
      running_tasks: runningTasks,
      longest_running_task_ms: longestRunningTaskMs,
      retrying_groups: retryingGroups,
      total_retries: totalRetries,
      max_retries: maxRetries,
      message_lane_reasons: messageLaneReasons,
      task_lane_reasons: taskLaneReasons,
    },
    sse_clients: sseClientCount,
    started_at: startedAt,
  };
}

/**
 * Format a millisecond duration for human-friendly display in operator surfaces.
 * Mirrors the helper used by the IPC inspector so the unit progression matches:
 * `<1s` → ms, `<1m` → seconds (one decimal), otherwise minutes (one decimal).
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function metricRow(label: string, value: string, id?: string): string {
  const idAttr = id ? ` id="${escapeHtml(id)}"` : '';
  return (
    `<div class="metric-row">` +
    `<span class="metric-label">${escapeHtml(label)}</span>` +
    `<span class="metric-value"${idAttr}>${escapeHtml(value)}</span>` +
    `</div>`
  );
}

function metricCard(title: string, rows: string): string {
  return (
    `<div class="metric-card">` +
    `<div class="metric-card-title">${escapeHtml(title)}</div>` +
    `${rows}` +
    `</div>`
  );
}

function breakdownList(obj: Record<string, number>): string {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([key, count]) =>
        `<div class="breakdown-item">` +
        `<span class="breakdown-key">${escapeHtml(key)}</span>` +
        `<span class="breakdown-val">${count}</span>` +
        `</div>`,
    )
    .join('');
}

function reasonRollup<T extends string>(
  obj: Record<T, number>,
  order: readonly T[],
  idPrefix: string,
  keyClassPrefix: string = 'reason',
): string {
  return order
    .map(
      (reason) =>
        `<div class="breakdown-item">` +
        `<span class="breakdown-key ${keyClassPrefix}-${reason}">${escapeHtml(reason)}</span>` +
        `<span class="breakdown-val" id="${idPrefix}-${reason}">${obj[reason] ?? 0}</span>` +
        `</div>`,
    )
    .join('');
}

/** Render the system page content (no shell wrapper). */
export function renderSystemContent(
  state: WebStateProvider,
  sseClientCount: number,
): string {
  const health = buildHealthData(state, sseClientCount);

  return (
    `<div class="system-page" data-init="window.__initPage && window.__initPage('system')">` +
    `<div class="system-header">` +
    `<h2>system health</h2>` +
    `<span class="health-badge" id="health-status">${escapeHtml(health.status)}</span>` +
    `</div>` +
    `<div class="system-grid" id="system-metrics">` +
    // Server info
    metricCard(
      'server',
      metricRow('version', health.version, 'sys-version') +
        metricRow('uptime', formatUptime(health.uptime_seconds), 'sys-uptime') +
        metricRow(
          'started',
          new Date(health.started_at).toLocaleString(),
          'sys-started',
        ) +
        metricRow('sse clients', String(health.sse_clients), 'sys-sse'),
    ) +
    // Runtime
    metricCard(
      'runtime',
      metricRow('bun', health.runtime.bun, 'sys-bun') +
        metricRow('platform', health.runtime.platform, 'sys-platform') +
        metricRow('arch', health.runtime.arch, 'sys-arch'),
    ) +
    // Memory
    metricCard(
      'memory',
      metricRow('rss', `${health.memory.rss_mb} MB`, 'sys-rss') +
        metricRow(
          'heap used',
          `${health.memory.heap_used_mb} MB`,
          'sys-heap-used',
        ) +
        metricRow(
          'heap total',
          `${health.memory.heap_total_mb} MB`,
          'sys-heap-total',
        ),
    ) +
    // CPU
    metricCard(
      'cpu',
      metricRow('cores', String(health.cpu.count), 'sys-cpu-count') +
        metricRow('load 1m', health.cpu.load_1m.toFixed(2), 'sys-cpu-load-1m') +
        metricRow('load 5m', health.cpu.load_5m.toFixed(2), 'sys-cpu-load-5m') +
        metricRow(
          'load 15m',
          health.cpu.load_15m.toFixed(2),
          'sys-cpu-load-15m',
        ),
    ) +
    // Host memory
    metricCard(
      'host memory',
      metricRow(
        'total',
        `${health.host_memory.total_mb} MB`,
        'sys-host-mem-total',
      ) +
        metricRow(
          'used',
          `${health.host_memory.used_mb} MB (${health.host_memory.used_pct.toFixed(1)}%)`,
          'sys-host-mem-used',
        ) +
        metricRow(
          'free',
          `${health.host_memory.free_mb} MB`,
          'sys-host-mem-free',
        ),
    ) +
    // Containers
    metricCard(
      'containers',
      metricRow(
        'active',
        `${health.containers.active}/${health.containers.max_active}`,
        'sys-containers-active',
      ) +
        metricRow(
          'idle',
          `${health.containers.idle}/${health.containers.max_idle}`,
          'sys-containers-idle',
        ),
    ) +
    // Agents
    metricCard(
      'agents',
      metricRow('total', String(health.agents.total), 'sys-agents-total') +
        `<div class="metric-sub">by state</div>` +
        reasonRollup(
          health.agents.by_exec_status,
          AGENT_EXEC_STATUSES,
          'sys-agents-state',
          'exec',
        ) +
        `<div class="metric-sub">by backend</div>` +
        breakdownList(health.agents.by_backend) +
        `<div class="metric-sub">by runtime</div>` +
        breakdownList(health.agents.by_runtime),
    ) +
    // Tasks
    metricCard(
      'tasks',
      metricRow('active', String(health.tasks.active), 'sys-tasks-active') +
        metricRow('paused', String(health.tasks.paused), 'sys-tasks-paused') +
        metricRow(
          'completed',
          String(health.tasks.completed),
          'sys-tasks-completed',
        ) +
        metricRow('total', String(health.tasks.total), 'sys-tasks-total'),
    ) +
    // Queue rollup (per-group lane aggregates from /ipc, summarized here)
    metricCard(
      'queue',
      metricRow('groups', String(health.queue.groups), 'sys-queue-groups') +
        metricRow(
          'processing',
          String(health.queue.processing_groups),
          'sys-queue-processing',
        ) +
        metricRow(
          'running tasks',
          String(health.queue.running_tasks),
          'sys-queue-running-tasks',
        ) +
        metricRow(
          'longest running',
          health.queue.running_tasks > 0
            ? formatDuration(health.queue.longest_running_task_ms)
            : '\u2014',
          'sys-queue-longest-running',
        ) +
        metricRow(
          'pending msgs',
          String(health.queue.pending_messages),
          'sys-queue-pending-messages',
        ) +
        metricRow(
          'pending tasks',
          String(health.queue.pending_tasks),
          'sys-queue-pending-tasks',
        ) +
        metricRow(
          'retrying',
          String(health.queue.retrying_groups),
          'sys-queue-retrying',
        ) +
        metricRow(
          'total retries',
          String(health.queue.total_retries),
          'sys-queue-total-retries',
        ) +
        metricRow(
          'max retries',
          String(health.queue.max_retries),
          'sys-queue-max-retries',
        ) +
        `<div class="metric-sub">message lane reasons</div>` +
        reasonRollup(
          health.queue.message_lane_reasons,
          MESSAGE_LANE_REASONS,
          'sys-queue-msg-reason',
        ) +
        `<div class="metric-sub">task lane reasons</div>` +
        reasonRollup(
          health.queue.task_lane_reasons,
          TASK_LANE_REASONS,
          'sys-queue-task-reason',
        ),
    ) +
    `</div>` +
    `</div>`
  );
}

/** Full system page with SPA shell. */
export function renderSystem(
  state: WebStateProvider,
  sseClientCount: number,
): string {
  return renderShell(
    '/system',
    'System',
    renderSystemContent(state, sseClientCount),
    allPageScripts(),
  );
}
