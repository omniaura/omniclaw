import { getState } from '~/lib/server-state';

export function GET() {
  const state = getState();
  const stats = state.getQueueStats();
  const agents = state.getAgents();
  const tasks = state.getTasks() as any[];

  let activeTasks = 0,
    pausedTasks = 0,
    completedTasks = 0;
  for (const t of tasks) {
    if (t.status === 'active') activeTasks++;
    else if (t.status === 'paused') pausedTasks++;
    else if (t.status === 'completed') completedTasks++;
  }

  return Response.json({
    agents: Object.keys(agents).length,
    activeTasks,
    pausedTasks,
    completedTasks,
    ...stats,
  });
}
