import { afterEach, describe, expect, it, mock } from 'bun:test';

import type { ContainerOutput } from './backends/types.js';
import type { Logger } from './logger.js';
import {
  resetSchedulerLoopForTests,
  startSchedulerLoop,
} from './task-scheduler.js';
import type { SchedulerDependencies } from './task-scheduler.js';
import type { ScheduledTask } from './types.js';

afterEach(() => {
  resetSchedulerLoopForTests();
});

function createLoggerMock(): Logger {
  const logger = {
    level: 'debug',
    trace: mock(() => {}),
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    fatal: mock(() => {}),
    child: mock(() => logger),
    subscribe: mock(() => () => {}),
  };

  return logger;
}

describe('startSchedulerLoop task execution', () => {
  it('skips due tasks that are no longer active when the loop re-checks them', () => {
    const dueTasks: ScheduledTask[] = [
      {
        id: 'task-active',
        group_folder: 'main',
        chat_jid: 'main@g.us',
        prompt: 'run active',
        schedule_type: 'interval',
        schedule_value: '60000',
        context_mode: 'isolated',
        next_run: '2026-01-01T00:00:00.000Z',
        last_run: null,
        last_result: null,
        status: 'active',
        created_at: '2026-01-01T00:00:00.000Z',
        executing_since: null,
      },
      {
        id: 'task-paused',
        group_folder: 'main',
        chat_jid: 'main@g.us',
        prompt: 'skip paused',
        schedule_type: 'interval',
        schedule_value: '60000',
        context_mode: 'isolated',
        next_run: '2026-01-01T00:00:00.000Z',
        last_run: null,
        last_result: null,
        status: 'active',
        created_at: '2026-01-01T00:00:00.000Z',
        executing_since: null,
      },
      {
        id: 'task-deleted',
        group_folder: 'main',
        chat_jid: 'main@g.us',
        prompt: 'skip deleted',
        schedule_type: 'once',
        schedule_value: '2026-01-01T00:00:00.000Z',
        context_mode: 'isolated',
        next_run: '2026-01-01T00:00:00.000Z',
        last_run: null,
        last_result: null,
        status: 'active',
        created_at: '2026-01-01T00:00:00.000Z',
        executing_since: null,
      },
    ];
    const taskById = new Map<string, ScheduledTask | null>([
      ['task-active', dueTasks[0]],
      ['task-paused', { ...dueTasks[1], status: 'paused' }],
      ['task-deleted', null],
    ]);
    const getDueTasksMock = mock(() => dueTasks);
    const getTaskByIdMock = mock(
      (taskId: string) => taskById.get(taskId) ?? null,
    );
    const advanceTaskNextRunMock = mock(() => {});
    const enqueueTaskMock = mock(() => {});
    const loggerMock = createLoggerMock();
    const originalSetTimeout = globalThis.setTimeout;

    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
      _fn: Parameters<typeof setTimeout>[0],
    ) => ({ id: 'poll' })) as unknown as typeof setTimeout;

    try {
      const deps: SchedulerDependencies = {
        registeredGroups: () => ({}),
        getGroupForTask: () => undefined,
        getSessions: () => ({}),
        resumePositionStore: {
          get: () => undefined,
          set: () => {},
          getAll: () => ({}),
          clear: () => {},
        },
        queue: {
          enqueueTask: enqueueTaskMock,
          notifyIdle: mock(() => {}),
          closeStdin: mock(() => {}),
        } as unknown as SchedulerDependencies['queue'],
        onProcess: mock(() => {}),
        sendMessage: async () => undefined,
        findChannel: () => undefined,
      };

      startSchedulerLoop(deps, {
        calculateNextRun: mock(() => '2026-01-01T01:00:00.000Z'),
        resolveBackend: mock(() => ({ runAgent: mock(() => undefined) })),
        writeTasksSnapshot: mock(() => {}),
        advanceTaskNextRun: advanceTaskNextRunMock,
        markTaskExecuting: mock(() => {}),
        clearTaskExecuting: mock(() => {}),
        getStaleExecutingTasks: mock(() => []),
        getOrphanedOnceTasks: mock(() => []),
        hasSuccessfulRun: mock(() => false),
        getAllTasks: mock(() => dueTasks),
        getDueTasks: getDueTasksMock,
        getTaskById: getTaskByIdMock,
        logTaskRun: mock(() => {}),
        updateTaskAfterRun: mock(() => {}),
        writeScheduledRunHandoff: mock(() => 'handoff.json'),
        logger: loggerMock,
      } as any);

      expect(getDueTasksMock).toHaveBeenCalledTimes(1);
      expect(advanceTaskNextRunMock).toHaveBeenCalledTimes(1);
      expect(advanceTaskNextRunMock).toHaveBeenCalledWith(
        'task-active',
        '2026-01-01T01:00:00.000Z',
      );
      expect(enqueueTaskMock).toHaveBeenCalledTimes(1);
      expect(enqueueTaskMock).toHaveBeenCalledWith(
        'main@g.us',
        'task-active',
        expect.any(Function),
        'run active',
      );
    } finally {
      (globalThis as { setTimeout: typeof setTimeout }).setTimeout =
        originalSetTimeout;
    }
  });

  it('records backend failures for isolated tasks without scheduling a close timer', async () => {
    const task: ScheduledTask = {
      id: 'task-error',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'simulate backend failure',
      schedule_type: 'interval',
      schedule_value: '300000',
      context_mode: 'isolated',
      next_run: '2026-01-01T00:00:00.000Z',
      last_run: null,
      last_result: null,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      executing_since: null,
    };
    const getDueTasksMock = mock(() => [task]);
    const getTaskByIdMock = mock((taskId: string) =>
      taskId === task.id ? task : null,
    );
    const logTaskRunMock = mock(() => {});
    const updateTaskAfterRunMock = mock(() => {});
    const writeScheduledRunHandoffMock = mock(() => 'handoff.json');
    const closeStdinMock = mock(() => {});
    const notifyIdleMock = mock(() => {});
    let backendInput: Record<string, unknown> | undefined;
    const resolveBackendMock = mock(() => ({
      runAgent: async (
        _group: unknown,
        input: Record<string, unknown>,
        _onProcess: unknown,
        onOutput?: (output: ContainerOutput) => Promise<void>,
      ) => {
        backendInput = input;
        if (onOutput) {
          await onOutput({
            status: 'error',
            error: 'stream failure',
            result: null,
          });
        }

        return {
          status: 'error',
          error: 'final failure',
          result: null,
        } as ContainerOutput;
      },
    }));
    const loggerMock = createLoggerMock();
    const enqueuedRuns: Array<Promise<void>> = [];
    const timeoutCalls: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;

    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
      _fn: Parameters<typeof setTimeout>[0],
      ms?: number,
    ) => {
      timeoutCalls.push(ms ?? 0);
      return { id: timeoutCalls.length } as unknown as ReturnType<
        typeof setTimeout
      >;
    }) as unknown as typeof setTimeout;

    try {
      const deps: SchedulerDependencies = {
        registeredGroups: () => ({}),
        getGroupForTask: (chatJid: string, groupFolder: string) =>
          chatJid === 'main@g.us' && groupFolder === 'main'
            ? {
                name: 'Main',
                folder: 'main',
                trigger: '@Bot',
                added_at: '2026-01-01T00:00:00.000Z',
              }
            : undefined,
        getSessions: () => ({}),
        resumePositionStore: {
          get: () => 'should-not-be-used',
          set: () => {},
          getAll: () => ({}),
          clear: () => {},
        },
        queue: {
          enqueueTask: (
            _jid: string,
            _taskId: string,
            run: () => Promise<void>,
          ) => {
            enqueuedRuns.push(run());
          },
          notifyIdle: notifyIdleMock,
          closeStdin: closeStdinMock,
        } as unknown as SchedulerDependencies['queue'],
        onProcess: mock(() => {}),
        sendMessage: mock(async () => undefined),
        findChannel: () => undefined,
      };

      startSchedulerLoop(deps, {
        calculateNextRun: mock(() => '2026-01-01T00:05:00.000Z'),
        resolveBackend: resolveBackendMock,
        writeTasksSnapshot: mock(() => {}),
        advanceTaskNextRun: mock(() => {}),
        markTaskExecuting: mock(() => {}),
        clearTaskExecuting: mock(() => {}),
        getStaleExecutingTasks: mock(() => []),
        getOrphanedOnceTasks: mock(() => []),
        hasSuccessfulRun: mock(() => false),
        getAllTasks: mock(() => [task]),
        getDueTasks: getDueTasksMock,
        getTaskById: getTaskByIdMock,
        logTaskRun: logTaskRunMock,
        updateTaskAfterRun: updateTaskAfterRunMock,
        writeScheduledRunHandoff: writeScheduledRunHandoffMock,
        logger: loggerMock,
      } as any);

      await Promise.all(enqueuedRuns);

      expect(resolveBackendMock).toHaveBeenCalledTimes(1);
      expect(backendInput?.resumeAt).toBeUndefined();
      expect(logTaskRunMock).toHaveBeenCalledWith(
        expect.objectContaining({
          task_id: 'task-error',
          status: 'error',
          error: 'final failure',
          result: null,
        }),
      );
      expect(updateTaskAfterRunMock).toHaveBeenCalledWith(
        'task-error',
        '2026-01-01T00:05:00.000Z',
        'Error: final failure',
      );
      expect(writeScheduledRunHandoffMock).toHaveBeenCalledWith(
        expect.objectContaining({
          task_id: 'task-error',
          status: 'error',
          error: 'final failure',
          result: null,
        }),
      );
      expect(notifyIdleMock).not.toHaveBeenCalled();
      expect(closeStdinMock).not.toHaveBeenCalled();
      expect(timeoutCalls).toEqual([60000]);
    } finally {
      (globalThis as { setTimeout: typeof setTimeout }).setTimeout =
        originalSetTimeout;
    }
  });
});
