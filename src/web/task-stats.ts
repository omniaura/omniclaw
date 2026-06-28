import type { GroupQueueDetail } from '../group-queue.js';
import type { ScheduledTask } from '../types.js';
import type { WebStateProvider } from './types.js';

export function countActiveTasks(tasks: readonly ScheduledTask[]): number {
  return tasks.filter((task) => task.status === 'active').length;
}

/**
 * Count local agents currently in flight on either lane — actively processing a
 * message (message lane active and not idle-waiting) or running a scheduled task
 * (task lane active). Mirrors the "working" annotation on the dashboard agents
 * card so the static render and the live SSE stats patch agree.
 */
export function countWorkingAgents(
  queueDetails: readonly GroupQueueDetail[],
): number {
  return queueDetails.reduce(
    (sum, g) =>
      sum +
      ((g.messageLane.active && !g.messageLane.idle) || g.taskLane.active
        ? 1
        : 0),
    0,
  );
}

/**
 * Format the dashboard "agents" stat-card value: the total agent count plus a
 * "(N working)" annotation when any agent lane is in flight. Shared by the
 * static dashboard render and the live SSE stats patch so the two never diverge
 * (the live patch previously dropped the annotation, resetting the card to a
 * bare count on the first update).
 */
export function formatAgentsValue(
  totalAgents: number,
  workingAgents: number,
): string {
  return workingAgents > 0
    ? `${totalAgents} (${workingAgents} working)`
    : `${totalAgents}`;
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
