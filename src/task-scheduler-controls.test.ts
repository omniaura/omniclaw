import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  cancelScheduledTask,
  pauseScheduledTask,
  resumeScheduledTask,
  triggerTaskNow,
} from './task-scheduler.js';
import type { SchedulerDependencies } from './task-scheduler.js';

describe('task scheduler controls', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('pauses and resumes active tasks', () => {
    createTask({
      id: 'task-pause-resume',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'Run reports',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() + 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const pauseResult = pauseScheduledTask('task-pause-resume');
    expect(pauseResult).toEqual({ ok: true });
    expect(getTaskById('task-pause-resume')?.status).toBe('paused');

    const resumeResult = resumeScheduledTask('task-pause-resume');
    expect(resumeResult).toEqual({ ok: true });
    expect(getTaskById('task-pause-resume')?.status).toBe('active');
  });

  it('returns not_found for controls on unknown tasks', () => {
    expect(pauseScheduledTask('missing')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(resumeScheduledTask('missing')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(cancelScheduledTask('missing')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('cancels a scheduled task', () => {
    createTask({
      id: 'task-cancel',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'Run reports',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() + 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const cancelResult = cancelScheduledTask('task-cancel');
    expect(cancelResult).toEqual({ ok: true });
    expect(getTaskById('task-cancel')).toBeNull();
  });
});

describe('triggerTaskNow', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('queues a manual run for an existing active task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'Run reports',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() + 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const enqueueTask = mock((..._args: unknown[]) => {});
    const deps: SchedulerDependencies = {
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      getResumePositions: () => ({}),
      queue: { enqueueTask } as unknown as SchedulerDependencies['queue'],
      onProcess: () => {},
      sendMessage: async () => undefined,
      findChannel: () => undefined,
    };

    const result = triggerTaskNow('task-1', deps);

    expect(result).toEqual({ ok: true });
    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(enqueueTask).toHaveBeenCalledWith(
      'main@g.us',
      expect.any(String),
      expect.any(Function),
      'Run reports',
    );
  });

  it('rejects run-now for completed tasks', () => {
    createTask({
      id: 'task-complete',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'Completed task',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'completed',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const enqueueTask = mock((..._args: unknown[]) => {});
    const deps: SchedulerDependencies = {
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      getResumePositions: () => ({}),
      queue: { enqueueTask } as unknown as SchedulerDependencies['queue'],
      onProcess: () => {},
      sendMessage: async () => undefined,
      findChannel: () => undefined,
    };

    const result = triggerTaskNow('task-complete', deps);

    expect(result).toEqual({ ok: false, reason: 'invalid_state' });
    expect(enqueueTask).not.toHaveBeenCalled();
  });
});
