import { describe, it, expect, mock } from 'bun:test';

import type { ContainerOutput } from './backends/types.js';
import type { Logger } from './logger.js';
import type { ScheduledTask } from './types.js';

const dueTasks: ScheduledTask[] = [
  {
    id: 'task-success',
    group_folder: 'main',
    chat_jid: 'main@g.us',
    prompt: 'x'.repeat(140),
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'group',
    next_run: '2026-01-01T00:00:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'task-missing-group',
    group_folder: 'ghost',
    chat_jid: 'ghost@g.us',
    prompt: 'missing',
    schedule_type: 'once',
    schedule_value: '2026-01-01T00:00:00.000Z',
    context_mode: 'isolated',
    next_run: '2026-01-01T00:00:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
  },
];

const taskById = new Map(dueTasks.map((t) => [t.id, t]));

const getDueTasksMock = mock(() => dueTasks);
const getTaskByIdMock = mock((taskId: string) => taskById.get(taskId) ?? null);
const getAllTasksMock = mock(() => dueTasks);
const advanceTaskNextRunMock = mock(() => {});
const updateTaskAfterRunMock = mock(() => {});
const logTaskRunMock = mock(() => {});
const writeTasksSnapshotMock = mock(() => {});
const calculateNextRunMock = mock((scheduleType: string) =>
  scheduleType === 'once' ? null : '2026-01-01T01:00:00.000Z',
);

let lastBackendInput: Record<string, unknown> | undefined;
const resolveBackendMock = mock(() => ({
  runAgent: async (
    _group: unknown,
    input: Record<string, unknown>,
    _onProcess: unknown,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ) => {
    lastBackendInput = input;
    if (onOutput) {
      await onOutput({ status: 'success', result: null, intermediate: true });
      await onOutput({ status: 'success', result: 'stream result' });
    }
    return { status: 'success', result: 'final result' } as ContainerOutput;
  },
}));

const childLoggerMock: Logger = {
  level: 'debug',
  trace: mock(() => {}),
  info: mock(() => {}),
  debug: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  fatal: mock(() => {}),
  child: mock(() => childLoggerMock),
  subscribe: mock(() => () => {}),
};

const loggerMock: Logger = {
  level: 'debug',
  trace: mock(() => {}),
  info: mock(() => {}),
  debug: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  fatal: mock(() => {}),
  child: mock(() => childLoggerMock),
  subscribe: mock(() => () => {}),
};

import { startSchedulerLoop } from './task-scheduler.js';

describe('startSchedulerLoop', () => {
  it('runs due tasks once, executes queued callbacks, and blocks duplicate loop startup', async () => {
    const sentMessages: Array<{ jid: string; text: string }> = [];
    const enqueued: Array<{ taskId: string; promptPreview: string }> = [];
    const runPromises: Array<Promise<void>> = [];
    const timeoutCalls: number[] = [];
    const clearedTimeouts: unknown[] = [];
    const timeoutTokens = [{ id: 'poll' }, { id: 'close' }, { id: 'extra' }];
    let timeoutIndex = 0;

    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    type TimeoutHandler = Parameters<typeof setTimeout>[0];

    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
      _fn: TimeoutHandler,
      ms?: number,
    ) => {
      timeoutCalls.push(ms ?? 0);
      const token = timeoutTokens[timeoutIndex] ?? { id: timeoutIndex };
      timeoutIndex += 1;
      return token as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    (globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = ((
      timeout: ReturnType<typeof setTimeout>,
    ) => {
      clearedTimeouts.push(timeout);
    }) as typeof clearTimeout;

    try {
      const runtime = {
        calculateNextRun: calculateNextRunMock,
        resolveBackend: resolveBackendMock,
        writeTasksSnapshot: writeTasksSnapshotMock,
        advanceTaskNextRun: advanceTaskNextRunMock,
        getAllTasks: getAllTasksMock,
        getDueTasks: getDueTasksMock,
        getTaskById: getTaskByIdMock,
        logTaskRun: logTaskRunMock,
        updateTaskAfterRun: updateTaskAfterRunMock,
        logger: loggerMock,
      };

      const deps = {
        registeredGroups: () => ({}),
        getGroupForTask: (chatJid: string) => {
          if (chatJid === 'main@g.us') {
            return {
              name: 'Main',
              folder: 'main',
              trigger: '@Bot',
              added_at: '2026-01-01T00:00:00.000Z',
              discordBotId: 'bot-1',
            };
          }
          return undefined;
        },
        getSessions: () => ({}),
        resumePositionStore: {
          get: () => 'resume-marker',
        },
        queue: {
          enqueueTask: (
            _jid: string,
            taskId: string,
            run: () => Promise<void>,
            promptPreview: string,
          ) => {
            enqueued.push({ taskId, promptPreview });
            runPromises.push(run());
          },
          notifyIdle: mock(() => {}),
          closeStdin: mock(() => {}),
        },
        onProcess: mock(() => {}),
        sendMessage: async (jid: string, text: string) => {
          sentMessages.push({ jid, text });
          return 'sent';
        },
        findChannel: () => undefined,
      };

      startSchedulerLoop(deps as any, runtime as any);
      startSchedulerLoop(deps as any, runtime as any);

      await Promise.all(runPromises);

      expect(getDueTasksMock).toHaveBeenCalledTimes(1);
      expect(enqueued).toHaveLength(2);
      expect(enqueued[0].taskId).toBe('task-success');
      expect(enqueued[1].taskId).toBe('task-missing-group');
      expect(enqueued[0].promptPreview.length).toBe(100);

      expect(advanceTaskNextRunMock).toHaveBeenCalledTimes(2);
      expect(advanceTaskNextRunMock).toHaveBeenNthCalledWith(
        1,
        'task-success',
        '2026-01-01T01:00:00.000Z',
      );
      expect(advanceTaskNextRunMock).toHaveBeenNthCalledWith(
        2,
        'task-missing-group',
        null,
      );

      expect(resolveBackendMock).toHaveBeenCalledTimes(1);
      expect(writeTasksSnapshotMock).toHaveBeenCalledTimes(1);
      expect(sentMessages).toEqual([
        { jid: 'main@g.us', text: 'stream result' },
      ]);
      expect(lastBackendInput?.resumeAt).toBe('resume-marker');
      expect(lastBackendInput?.isScheduledTask).toBe(true);
      expect(lastBackendInput?.chatJid).toBe('main@g.us');

      expect(logTaskRunMock).toHaveBeenCalledTimes(2);
      expect(updateTaskAfterRunMock).toHaveBeenCalledTimes(1);
      expect(updateTaskAfterRunMock).toHaveBeenNthCalledWith(
        1,
        'task-success',
        '2026-01-01T01:00:00.000Z',
        'final result',
      );

      expect(timeoutCalls).toContain(60000);
      expect(timeoutCalls).toContain(10000);
      expect(clearedTimeouts).toHaveLength(1);
      expect(loggerMock.debug).toHaveBeenCalledWith(
        'Scheduler loop already running, skipping duplicate start',
      );
    } finally {
      (globalThis as { setTimeout: typeof setTimeout }).setTimeout =
        originalSetTimeout;
      (globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout =
        originalClearTimeout;
    }
  });
});
