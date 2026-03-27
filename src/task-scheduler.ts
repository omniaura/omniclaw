import fs from 'fs';
import path from 'path';

import {
  GROUPS_DIR,
  MAIN_GROUP_FOLDER,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { calculateNextRun } from './schedule-utils.js';
import { resolveBackend } from './backends/index.js';
import type { AgentBackend, ContainerOutput } from './backends/types.js';
import { writeTasksSnapshot } from './ipc-snapshots.js';
import {
  advanceTaskNextRun,
  clearTaskExecuting,
  createTask,
  deleteTask,
  getAllTasks,
  getDueTasks,
  getOrphanedOnceTasks,
  getStaleExecutingTasks,
  getTaskById,
  hasSuccessfulRun,
  logTaskRun,
  markTaskExecuting,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { ResumePositionStore } from './resume-position-store.js';
import { writeScheduledRunHandoff } from './task-handoffs.js';
import type {
  Channel,
  ContainerProcess,
  RegisteredGroup,
  ScheduledTask,
  TaskOutcomeSignal,
  TaskOutcomeState,
} from './types.js';

const VALID_OUTCOME_STATES = new Set<TaskOutcomeState>([
  'done',
  'blocked',
  'abandoned',
]);

/**
 * Extract the outcome signal from agent output. If the agent signaled
 * explicitly, use that. Otherwise, infer from error/success:
 *   success → done, error → blocked, catch/timeout → abandoned.
 */
export function inferOutcome(
  output: ContainerOutput | null,
  error: string | null,
  timedOut: boolean,
): TaskOutcomeSignal {
  // Prefer explicit agent signal if present and valid
  if (output?.outcome && VALID_OUTCOME_STATES.has(output.outcome.state)) {
    return {
      state: output.outcome.state,
      reason: output.outcome.reason,
      question: output.outcome.question,
    };
  }
  if (timedOut) return { state: 'abandoned', reason: 'Execution timed out' };
  if (error) return { state: 'blocked', reason: error };
  return { state: 'done' };
}

interface SchedulerRuntime {
  calculateNextRun: typeof calculateNextRun;
  resolveBackend: (group: RegisteredGroup) => Pick<AgentBackend, 'runAgent'>;
  writeTasksSnapshot: typeof writeTasksSnapshot;
  advanceTaskNextRun: typeof advanceTaskNextRun;
  markTaskExecuting: typeof markTaskExecuting;
  clearTaskExecuting: typeof clearTaskExecuting;
  getStaleExecutingTasks: typeof getStaleExecutingTasks;
  getOrphanedOnceTasks: typeof getOrphanedOnceTasks;
  hasSuccessfulRun: typeof hasSuccessfulRun;
  getAllTasks: typeof getAllTasks;
  getDueTasks: typeof getDueTasks;
  getTaskById: typeof getTaskById;
  logTaskRun: typeof logTaskRun;
  updateTaskAfterRun: typeof updateTaskAfterRun;
  writeScheduledRunHandoff: typeof writeScheduledRunHandoff;
  logger: typeof logger;
}

const defaultSchedulerRuntime: SchedulerRuntime = {
  calculateNextRun,
  resolveBackend,
  writeTasksSnapshot,
  advanceTaskNextRun,
  markTaskExecuting,
  clearTaskExecuting,
  getStaleExecutingTasks,
  getOrphanedOnceTasks,
  hasSuccessfulRun,
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTaskAfterRun,
  writeScheduledRunHandoff,
  logger,
};

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  /**
   * Resolve the RegisteredGroup for a scheduled task, incorporating the full
   * 4-layer channel context (agent → server → category → channel).
   * Looks up the subscription for (chatJid, agentFolder) first so that
   * channelFolder/categoryFolder/agentContextFolder reflect the target channel,
   * not the agent's own primary channel.
   */
  getGroupForTask: (
    chatJid: string,
    agentFolder: string,
  ) => RegisteredGroup | undefined;
  getSessions: () => Record<string, string>;
  resumePositionStore: ResumePositionStore;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ContainerProcess,
    containerName: string,
    groupFolder: string,
    lane: 'task',
  ) => void;
  sendMessage: (
    jid: string,
    text: string,
    discordBotId?: string,
  ) => Promise<string | void>;
  findChannel: (jid: string, discordBotId?: string) => Channel | undefined;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  runtime: SchedulerRuntime = defaultSchedulerRuntime,
): Promise<void> {
  const runAt = new Date().toISOString();

  // Re-check task status: may have been cancelled/paused while queued
  const freshTask = runtime.getTaskById(task.id);
  if (!freshTask || freshTask.status !== 'active') {
    runtime.logger.info(
      { taskId: task.id, status: freshTask?.status ?? 'deleted' },
      'Task no longer active, skipping',
    );
    return;
  }

  try {
    const startTime = Date.now();
    const groupDir = path.join(GROUPS_DIR, task.group_folder);
    fs.mkdirSync(groupDir, { recursive: true });

    const log = runtime.logger.child({
      op: 'taskRun',
      taskId: task.id,
      group: task.group_folder,
    });
    log.info('Running scheduled task');

    const tryWriteHandoff = (
      handoff: Parameters<typeof runtime.writeScheduledRunHandoff>[0],
    ) => {
      try {
        runtime.writeScheduledRunHandoff(handoff);
      } catch (err) {
        log.warn({ err }, 'Failed to write scheduled task handoff');
      }
    };

    const group = deps.getGroupForTask(task.chat_jid, task.group_folder);

    if (!group) {
      log.error('Group not found for task');
      const groupError = `Group not found: ${task.group_folder}`;
      runtime.logTaskRun({
        task_id: task.id,
        run_at: runAt,
        duration_ms: Date.now() - startTime,
        status: 'error',
        result: null,
        error: groupError,
        outcome_state: 'abandoned',
        outcome_reason: groupError,
      });
      tryWriteHandoff({
        task_id: task.id,
        chat_jid: task.chat_jid,
        group_folder: task.group_folder,
        context_mode: task.context_mode,
        run_at: runAt,
        status: 'error',
        duration_ms: Date.now() - startTime,
        next_run: task.next_run,
        result: null,
        error: groupError,
        outcome_state: 'abandoned',
        outcome_reason: groupError,
      });
      return;
    }

    // Set execution lease only after preflight validation succeeds so
    // missing-group failures do not leave the task stuck in a running state.
    runtime.markTaskExecuting(task.id);

    const prompt = task.prompt;

    // Update tasks snapshot for container to read (filtered by group)
    const isMain = task.group_folder === MAIN_GROUP_FOLDER;
    const tasks = runtime.getAllTasks();
    runtime.writeTasksSnapshot(
      task.group_folder,
      isMain,
      tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
        last_outcome_state: t.last_outcome_state ?? null,
        last_outcome_reason: t.last_outcome_reason ?? null,
      })),
    );

    let result: string | null = null;
    let error: string | null = null;
    let finalOutput: ContainerOutput | null = null;
    let timedOut = false;

    // Always use isolated sessions for tasks to prevent session ID conflicts
    // between message and task containers running concurrently.
    // For group-context tasks, pass resumeAt so the container can skip replaying
    // the full session history and resume from the last known position.
    const sessionId = undefined;
    const resumeAt =
      task.context_mode === 'group'
        ? deps.resumePositionStore.get(task.group_folder)
        : undefined;

    // [Upstream PR #354] After the task produces a result, close the container
    // promptly. Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min)
    // for the query loop to time out. A short delay handles any final MCP calls.
    const TASK_CLOSE_DELAY_MS = 10_000;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleClose = () => {
      if (closeTimer) return; // already scheduled
      closeTimer = setTimeout(() => {
        runtime.logger.debug(
          { taskId: task.id },
          'Closing task container after result',
        );
        deps.queue.closeStdin(task.chat_jid, 'task');
      }, TASK_CLOSE_DELAY_MS);
    };

    try {
      const backend = runtime.resolveBackend(group);
      const output = await backend.runAgent(
        group,
        {
          prompt,
          sessionId,
          resumeAt,
          groupFolder: task.group_folder,
          chatJid: task.chat_jid,
          isMain,
          isScheduledTask: true,
          discordGuildId: group.discordGuildId,
          serverFolder: group.serverFolder,
          agentRuntime: group.agentRuntime,
          agentName: group.name,
          discordBotId: group.discordBotId,
          agentTrigger: group.trigger,
          channelFolder: group.channelFolder,
          categoryFolder: group.categoryFolder,
          agentContextFolder: group.agentContextFolder,
          mcpServers: group.containerConfig?.mcpServers,
        },
        (proc, containerName) =>
          deps.onProcess(
            task.chat_jid,
            proc,
            containerName,
            task.group_folder,
            'task',
          ),
        async (streamedOutput: ContainerOutput) => {
          if (streamedOutput.intermediate) {
            return;
          }

          if (streamedOutput.result) {
            result = streamedOutput.result;
            await deps.sendMessage(
              task.chat_jid,
              streamedOutput.result,
              group.discordBotId,
            );
            scheduleClose();
          }
          if (streamedOutput.status === 'success') {
            deps.queue.notifyIdle(task.chat_jid);
          }
          if (streamedOutput.status === 'error') {
            error = streamedOutput.error || 'Unknown error';
          }
        },
      );

      if (closeTimer) clearTimeout(closeTimer);
      finalOutput = output;

      if (output.status === 'error') {
        error = output.error || 'Unknown error';
      } else if (output.result) {
        result = output.result;
      }

      log.info({ durationMs: Date.now() - startTime }, 'Task completed');
    } catch (err) {
      if (closeTimer) clearTimeout(closeTimer);
      error = err instanceof Error ? err.message : String(err);
      timedOut = error.includes('timed out') || error.includes('timeout');
      log.error({ err: error }, 'Task failed');
    }

    const durationMs = Date.now() - startTime;
    const outcome = inferOutcome(finalOutput, error, timedOut);

    runtime.logTaskRun({
      task_id: task.id,
      run_at: runAt,
      duration_ms: durationMs,
      status: error ? 'error' : 'success',
      result,
      error,
      outcome_state: outcome.state,
      outcome_reason: outcome.reason,
      outcome_question: outcome.question,
    });

    // Calculate next run time (null for one-shot 'once' tasks)
    const nextRun =
      task.schedule_type === 'once'
        ? null
        : runtime.calculateNextRun(task.schedule_type, task.schedule_value);

    const resultSummary = error
      ? `Error: ${error}`
      : result
        ? result.slice(0, 200)
        : 'Completed';
    runtime.updateTaskAfterRun(task.id, nextRun, resultSummary, outcome);
    tryWriteHandoff({
      task_id: task.id,
      chat_jid: task.chat_jid,
      group_folder: task.group_folder,
      context_mode: task.context_mode,
      run_at: runAt,
      status: error ? 'error' : 'success',
      duration_ms: durationMs,
      next_run: nextRun,
      result,
      error,
      outcome_state: outcome.state,
      outcome_reason: outcome.reason,
      outcome_question: outcome.question,
    });
  } finally {
    runtime.clearTaskExecuting(task.id);
  }
}

/** Default timeout after which an executing task is considered stale (30 minutes). */
const STALE_EXECUTION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Recover stale tasks on startup. Must run before the first scheduler poll.
 *
 * Handles two crash-recovery scenarios:
 * 1. Stale executing tasks — executing_since set but process crashed before completion
 * 2. Orphaned once tasks — active with null next_run, never executed (advanceTaskNextRun
 *    cleared next_run before the crash)
 */
export function recoverStaleTasks(
  runtime: SchedulerRuntime = defaultSchedulerRuntime,
): { recovered: number; completed: number } {
  let recovered = 0;
  let completed = 0;

  // Phase 1: Reset stale executing tasks
  const cutoff = new Date(
    Date.now() - STALE_EXECUTION_TIMEOUT_MS,
  ).toISOString();
  const staleTasks = runtime.getStaleExecutingTasks(cutoff);

  for (const task of staleTasks) {
    if (task.schedule_type === 'once') {
      // Check if the task actually completed before the crash
      if (runtime.hasSuccessfulRun(task.id)) {
        runtime.clearTaskExecuting(task.id);
        runtime.updateTaskAfterRun(task.id, null, 'Completed (recovered)');
        runtime.logger.info(
          { taskId: task.id },
          'Recovery: stale once task had successful run — marking completed',
        );
        completed++;
      } else {
        // Re-drive: set next_run to now so getDueTasks picks it up
        runtime.clearTaskExecuting(task.id);
        runtime.advanceTaskNextRun(task.id, new Date().toISOString());
        runtime.logger.info(
          { taskId: task.id },
          'Recovery: stale once task never completed — re-queuing',
        );
        recovered++;
      }
    } else {
      // Recurring: recalculate next_run and clear lease
      const nextRun = runtime.calculateNextRun(
        task.schedule_type,
        task.schedule_value,
      );
      runtime.clearTaskExecuting(task.id);
      if (nextRun) {
        runtime.advanceTaskNextRun(task.id, nextRun);
      }
      runtime.logger.info(
        { taskId: task.id, nextRun },
        'Recovery: stale recurring task — recalculated next run',
      );
      recovered++;
    }

    runtime.logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: 0,
      status: 'error',
      result: null,
      error: 'Recovered after crash — execution lease expired',
    });
  }

  // Phase 2: Find orphaned once tasks (active, next_run null, not executing)
  const orphaned = runtime.getOrphanedOnceTasks();
  for (const task of orphaned) {
    if (runtime.hasSuccessfulRun(task.id)) {
      runtime.updateTaskAfterRun(task.id, null, 'Completed (recovered)');
      runtime.logger.info(
        { taskId: task.id },
        'Recovery: orphaned once task had successful run — marking completed',
      );
      completed++;
    } else {
      // Re-drive: set next_run to now
      runtime.advanceTaskNextRun(task.id, new Date().toISOString());
      runtime.logger.info(
        { taskId: task.id },
        'Recovery: orphaned once task never completed — re-queuing',
      );
      recovered++;
    }
  }

  if (recovered > 0 || completed > 0) {
    runtime.logger.info(
      { recovered, completed },
      'Scheduler crash recovery complete',
    );
  }

  return { recovered, completed };
}

let schedulerRunning = false;

export function resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}

export function startSchedulerLoop(
  deps: SchedulerDependencies,
  runtime: SchedulerRuntime = defaultSchedulerRuntime,
): void {
  if (schedulerRunning) {
    runtime.logger.debug(
      'Scheduler loop already running, skipping duplicate start',
    );
    return;
  }
  schedulerRunning = true;

  // Run crash recovery before first poll
  recoverStaleTasks(runtime);

  runtime.logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = runtime.getDueTasks();
      if (dueTasks.length > 0) {
        runtime.logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = runtime.getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        // Advance next_run BEFORE enqueuing so this task isn't
        // re-discovered on subsequent ticks while it's running/queued.
        // 'once' tasks (no recurrence) get next_run set to null which
        // also removes them from getDueTasks results.
        const nextRun =
          currentTask.schedule_type === 'once'
            ? null
            : runtime.calculateNextRun(
                currentTask.schedule_type,
                currentTask.schedule_value,
              );
        runtime.advanceTaskNextRun(currentTask.id, nextRun);

        const promptPreview = currentTask.prompt.slice(0, 100);
        deps.queue.enqueueTask(
          currentTask.chat_jid,
          currentTask.id,
          () => runTask(currentTask, deps, runtime),
          promptPreview,
        );
      }
    } catch (err) {
      runtime.logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

// ---------------------------------------------------------------------------
// Scheduler control functions (pause/resume/cancel/trigger)
// ---------------------------------------------------------------------------

interface TaskActionResult {
  ok: boolean;
  reason?: 'not_found' | 'invalid_state';
}

export function pauseScheduledTask(taskId: string): TaskActionResult {
  const task = getTaskById(taskId);
  if (!task) return { ok: false, reason: 'not_found' };
  updateTask(taskId, { status: 'paused' });
  return { ok: true };
}

export function resumeScheduledTask(taskId: string): TaskActionResult {
  const task = getTaskById(taskId);
  if (!task) return { ok: false, reason: 'not_found' };
  updateTask(taskId, { status: 'active' });
  return { ok: true };
}

export function cancelScheduledTask(taskId: string): TaskActionResult {
  const task = getTaskById(taskId);
  if (!task) return { ok: false, reason: 'not_found' };
  deleteTask(taskId);
  return { ok: true };
}

export function triggerTaskNow(
  taskId: string,
  deps: SchedulerDependencies,
): TaskActionResult {
  const task = getTaskById(taskId);
  if (!task) return { ok: false, reason: 'not_found' };
  if (task.status !== 'active' && task.status !== 'paused') {
    return { ok: false, reason: 'invalid_state' };
  }
  const promptPreview = task.prompt.slice(0, 100);
  deps.queue.enqueueTask(
    task.chat_jid,
    task.id,
    () => runTask(task, deps),
    promptPreview,
  );
  return { ok: true };
}
