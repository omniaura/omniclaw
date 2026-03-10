import fs from 'fs';

import type { WebStateProvider } from './types.js';
import { renderShell, escapeHtml } from './shared.js';
import { allPageScripts } from './page-scripts.js';

export interface HealthData {
  status: 'healthy';
  version: string;
  uptime_seconds: number;
  memory: {
    rss_mb: number;
    heap_used_mb: number;
    heap_total_mb: number;
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
  const mem = process.memoryUsage();

  const byBackend: Record<string, number> = {};
  const byRuntime: Record<string, number> = {};
  for (const agent of agents) {
    byBackend[agent.backend] = (byBackend[agent.backend] || 0) + 1;
    byRuntime[agent.agentRuntime] = (byRuntime[agent.agentRuntime] || 0) + 1;
  }

  let activeTasks = 0,
    pausedTasks = 0,
    completedTasks = 0;
  for (const t of tasks) {
    if (t.status === 'active') activeTasks++;
    else if (t.status === 'paused') pausedTasks++;
    else if (t.status === 'completed') completedTasks++;
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
    runtime: {
      bun: typeof Bun !== 'undefined' ? Bun.version : process.version,
      platform: process.platform,
      arch: process.arch,
    },
    agents: {
      total: agents.length,
      by_backend: byBackend,
      by_runtime: byRuntime,
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
    sse_clients: sseClientCount,
    started_at: startedAt,
  };
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
