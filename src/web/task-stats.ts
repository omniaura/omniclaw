import type { GroupQueueDetail } from '../group-queue.js';
import type { ScheduledTask } from '../types.js';
import type { WebStateProvider } from './types.js';

export function countActiveTasks(tasks: readonly ScheduledTask[]): number {
  return tasks.filter((task) => task.status === 'active').length;
}

export function countRunningTasks(
  queueDetails: readonly GroupQueueDetail[],
): number {
  return queueDetails.reduce(
    (sum, detail) => sum + (detail.taskLane.activeTask ? 1 : 0),
    0,
  );
}

export function countOverdueActiveTasks(
  tasks: readonly ScheduledTask[],
  nowMs = Date.now(),
): number {
  return tasks.reduce((sum, task) => {
    if (task.status !== 'active' || !task.next_run) return sum;
    const nextRunMs = Date.parse(task.next_run);
    return Number.isFinite(nextRunMs) && nextRunMs < nowMs ? sum + 1 : sum;
  }, 0);
}

export function formatActiveTaskStats(
  activeTasks: number,
  runningTasks: number,
  options: { includeActiveLabel?: boolean; overdueTasks?: number } = {},
): string {
  const base = options.includeActiveLabel
    ? `${activeTasks} active`
    : `${activeTasks}`;
  const annotations: string[] = [];
  if ((options.overdueTasks ?? 0) > 0) {
    annotations.push(`${options.overdueTasks} overdue`);
  }
  if (runningTasks > 0) {
    annotations.push(`${runningTasks} running`);
  }

  return annotations.length > 0 ? `${base} (${annotations.join(', ')})` : base;
}

export function formatActiveTaskStatsFromState(
  state: Pick<WebStateProvider, 'getTasks' | 'getQueueDetails'>,
  options: { includeActiveLabel?: boolean; includeOverdue?: boolean } = {},
): string {
  const tasks = state.getTasks();
  return formatActiveTaskStats(
    countActiveTasks(tasks),
    countRunningTasks(state.getQueueDetails()),
    {
      includeActiveLabel: options.includeActiveLabel,
      overdueTasks: options.includeOverdue
        ? countOverdueActiveTasks(tasks)
        : undefined,
    },
  );
}
