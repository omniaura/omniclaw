import { afterEach, describe, expect, it, mock } from 'bun:test';

import {
  createControlPlaneFetch,
  startControlPlaneServer,
  type ControlPlaneDeps,
} from './control-plane.js';
import { logger } from './logger.js';
import type { RegisteredGroup, ScheduledTask } from './types.js';

const RealDate = Date;
const realBunServe = Bun.serve;
const realLoggerInfo = logger.info;
const controlPlaneToken = 'test-control-token';

function installFixedDate(iso: string) {
  const fixedTime = new RealDate(iso).getTime();
  class FixedDate extends RealDate {
    constructor(value?: string | number | Date) {
      if (value !== undefined) {
        super(value);
        return;
      }
      super(fixedTime);
    }

    static override now() {
      return fixedTime;
    }
  }

  globalThis.Date = FixedDate as DateConstructor;
}

afterEach(() => {
  globalThis.Date = RealDate;
  Bun.serve = realBunServe;
  logger.info = realLoggerInfo;
});

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
    executing_since: null,
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

function makeFetch(overrides: Partial<ControlPlaneDeps> = {}) {
  return createControlPlaneFetch(makeDeps(overrides), {
    bearerToken: controlPlaneToken,
  });
}

function controlPlaneRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${controlPlaneToken}`);
  return new Request(`http://localhost${path}`, { ...init, headers });
}

describe('control-plane routes', () => {
  it('serves health endpoint', async () => {
    installFixedDate('2026-04-23T12:34:56.000Z');
    const fetch = createControlPlaneFetch(makeDeps());
    const res = await fetch(new Request('http://localhost/healthz'));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; now: string };
    expect(body.ok).toBe(true);
    expect(body.now).toBe('2026-04-23T12:34:56.000Z');
  });

  it('returns state summary and queue snapshot', async () => {
    const fetch = makeFetch();
    const res = await fetch(controlPlaneRequest('/api/control-plane/state'));

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
    const fetch = makeFetch({ pauseTask });

    const res = await fetch(
      controlPlaneRequest('/api/control-plane/tasks/task-1/pause', {
        method: 'POST',
      }),
    );

    expect(res.status).toBe(200);
    expect(pauseTask).toHaveBeenCalledWith('task-1');
  });

  it('returns the current task list', async () => {
    const getTasks = mock(() => [
      makeTask('task-a', 'active'),
      makeTask('task-b', 'paused'),
      makeTask('task-c', 'completed'),
    ]);
    const fetch = makeFetch({ getTasks });

    const res = await fetch(controlPlaneRequest('/api/control-plane/tasks'));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; tasks: ScheduledTask[] };
    expect(body.ok).toBe(true);
    expect(body.tasks.map((task) => task.id)).toEqual([
      'task-a',
      'task-b',
      'task-c',
    ]);
    expect(getTasks).toHaveBeenCalledTimes(1);
  });

  it('maps missing tasks to 404 on actions', async () => {
    const fetch = makeFetch({
      runTaskNow: () => ({ ok: false, reason: 'not_found' }),
    });

    const res = await fetch(
      controlPlaneRequest('/api/control-plane/tasks/ghost/run-now', {
        method: 'POST',
      }),
    );

    expect(res.status).toBe(404);
  });

  it('maps invalid task state to 409 on actions', async () => {
    const fetch = makeFetch({
      pauseTask: () => ({ ok: false, reason: 'invalid_state' }),
    });

    const res = await fetch(
      controlPlaneRequest('/api/control-plane/tasks/task-a/pause', {
        method: 'POST',
      }),
    );

    expect(res.status).toBe(409);
  });

  it('maps other task action failures to 400', async () => {
    const fetch = makeFetch({
      cancelTask: () => ({ ok: false, reason: 'not_allowed' }),
    });

    const res = await fetch(
      controlPlaneRequest('/api/control-plane/tasks/task-a/cancel', {
        method: 'POST',
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'not_allowed' });
  });

  it('returns 404 for unsupported methods on task actions', async () => {
    const runTaskNow = mock(() => ({ ok: true as const }));
    const fetch = makeFetch({ runTaskNow });

    const res = await fetch(
      controlPlaneRequest('/api/control-plane/tasks/task-a/run-now'),
    );

    expect(res.status).toBe(404);
    expect(runTaskNow).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown routes', async () => {
    const fetch = makeFetch();

    const res = await fetch(controlPlaneRequest('/api/control-plane/missing'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'not_found' });
  });

  it('rejects control-plane API routes without bearer auth', async () => {
    const runTaskNow = mock(() => ({ ok: true as const }));
    const fetch = makeFetch({ runTaskNow });

    const res = await fetch(
      new Request('http://localhost/api/control-plane/tasks/task-a/run-now', {
        method: 'POST',
      }),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
    expect(runTaskNow).not.toHaveBeenCalled();
  });

  it('fails closed when control-plane auth is not configured', async () => {
    const getTasks = mock(() => [makeTask('task-a', 'active')]);
    const fetch = createControlPlaneFetch(makeDeps({ getTasks }));

    const res = await fetch(
      new Request('http://localhost/api/control-plane/tasks'),
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'control_plane_auth_required',
    });
    expect(getTasks).not.toHaveBeenCalled();
  });
});

describe('startControlPlaneServer', () => {
  it('starts Bun.serve with the control plane fetcher and logs startup metadata', async () => {
    const fakeServer = {
      hostname: '127.0.0.1',
      port: 4312,
      stop: mock(),
    } as unknown as ReturnType<typeof Bun.serve>;
    const serveMockFn = mock((options: Parameters<typeof Bun.serve>[0]) => ({
      hostname: options.hostname,
      port: options.port,
      stop: fakeServer.stop,
    }));
    const serveMock = serveMockFn as unknown as typeof Bun.serve;
    const infoMock = mock(() => {});
    Bun.serve = serveMock;
    logger.info = infoMock as typeof logger.info;

    const deps = makeDeps();
    const server = startControlPlaneServer(deps, {
      hostname: '127.0.0.1',
      port: 4312,
      bearerToken: controlPlaneToken,
    });

    expect(serveMockFn).toHaveBeenCalledTimes(1);
    const serveOptions = serveMockFn.mock.calls[0]?.[0];
    expect(serveOptions?.hostname).toBe('127.0.0.1');
    expect(serveOptions?.port).toBe(4312);
    const res = (await serveOptions!.fetch!.call(
      fakeServer,
      controlPlaneRequest('/api/control-plane/tasks'),
      fakeServer,
    )) as Response;
    expect(res.status).toBe(200);
    expect(server.hostname).toBe('127.0.0.1');
    expect(server.port).toBe(4312);
    expect(infoMock).toHaveBeenCalledWith(
      {
        hostname: '127.0.0.1',
        port: 4312,
        op: 'controlPlane',
      },
      'Control plane HTTP server started',
    );
  });

  it('refuses to start without a configured bearer token', () => {
    const serveMockFn = mock((options: Parameters<typeof Bun.serve>[0]) => ({
      hostname: options.hostname,
      port: options.port,
      stop: mock(),
    }));
    Bun.serve = serveMockFn as unknown as typeof Bun.serve;

    expect(() =>
      startControlPlaneServer(makeDeps(), {
        hostname: '0.0.0.0',
        port: 4312,
      }),
    ).toThrow('Control plane bearer token is required');
    expect(serveMockFn).not.toHaveBeenCalled();
  });
});
