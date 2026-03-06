import { describe, expect, it, mock } from 'bun:test';

import {
  createControlPlaneFetch,
  type ControlPlaneDeps,
} from './control-plane.js';
import type { RegisteredGroup, ScheduledTask } from './types.js';

function makeTask(id: string, status: ScheduledTask['status']): ScheduledTask {
  return {
    id,
    group_folder: 'main',
    chat_jid: 'main@g.us',
    prompt: 'Do work',
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'isolated',
    next_run: null,
    last_run: null,
    last_result: null,
    status,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function makeDeps(overrides: Partial<ControlPlaneDeps> = {}): ControlPlaneDeps {
  const groups: Record<string, RegisteredGroup> = {
    'main@g.us': {
      name: 'Main',
      folder: 'main',
      trigger: '@Omni',
      added_at: '2026-01-01T00:00:00.000Z',
    },
  };

  return {
    getTasks: () => [
      makeTask('task-a', 'active'),
      makeTask('task-b', 'paused'),
    ],
    getRegisteredGroups: () => groups,
    getQueueSnapshot: () => ({
      activeContainers: 1,
      idleContainers: 0,
      activeTaskContainers: 1,
      waitingMessageGroups: 0,
      waitingTaskGroups: 0,
      runningTasks: [
        {
          groupKey: 'main',
          taskId: 'task-a',
          promptPreview: 'Do work',
          startedAt: Date.now(),
        },
      ],
    }),
    pauseTask: () => ({ ok: true }),
    resumeTask: () => ({ ok: true }),
    cancelTask: () => ({ ok: true }),
    runTaskNow: () => ({ ok: true }),
    ...overrides,
  };
}

describe('control-plane routes', () => {
  it('serves health endpoint', async () => {
    const fetch = createControlPlaneFetch(makeDeps());
    const res = await fetch(new Request('http://localhost/healthz'));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('returns state summary and queue snapshot', async () => {
    const fetch = createControlPlaneFetch(makeDeps());
    const res = await fetch(
      new Request('http://localhost/api/control-plane/state'),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: { taskCount: number; activeTasks: number; pausedTasks: number };
      queue: { activeTaskContainers: number };
    };
    expect(body.summary.taskCount).toBe(2);
    expect(body.summary.activeTasks).toBe(1);
    expect(body.summary.pausedTasks).toBe(1);
    expect(body.queue.activeTaskContainers).toBe(1);
  });

  it('runs task action endpoints', async () => {
    const pauseTask = mock(() => ({ ok: true as const }));
    const fetch = createControlPlaneFetch(makeDeps({ pauseTask }));

    const res = await fetch(
      new Request('http://localhost/api/control-plane/tasks/task-1/pause', {
        method: 'POST',
      }),
    );

    expect(res.status).toBe(200);
    expect(pauseTask).toHaveBeenCalledWith('task-1');
  });

  it('maps missing tasks to 404 on actions', async () => {
    const fetch = createControlPlaneFetch(
      makeDeps({ runTaskNow: () => ({ ok: false, reason: 'not_found' }) }),
    );

    const res = await fetch(
      new Request('http://localhost/api/control-plane/tasks/ghost/run-now', {
        method: 'POST',
      }),
    );

    expect(res.status).toBe(404);
  });

  it('maps invalid task state to 409 on actions', async () => {
    const fetch = createControlPlaneFetch(
      makeDeps({ pauseTask: () => ({ ok: false, reason: 'invalid_state' }) }),
    );

    const res = await fetch(
      new Request('http://localhost/api/control-plane/tasks/task-a/pause', {
        method: 'POST',
      }),
    );

    expect(res.status).toBe(409);
  });
});
