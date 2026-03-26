import { getState } from '~/lib/server-state';

export function GET() {
  const state = getState();
  const agents = Object.values(state.getAgents()) as any[];
  const tasks = state.getTasks() as any[];
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

  return Response.json({
    status: 'healthy',
    version: process.env.npm_package_version || 'unknown',
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
    sse_clients: 0,
    started_at: new Date().toISOString(),
  });
}
