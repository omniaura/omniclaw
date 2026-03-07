import { z } from 'zod';

import { logger } from './logger.js';
import type { RegisteredGroup, ScheduledTask } from './types.js';

type TaskAction = 'pause' | 'resume' | 'cancel' | 'run-now';

interface TaskActionResult {
  ok: boolean;
  reason?: 'not_found' | 'not_allowed' | 'invalid_state' | 'enqueue_failed';
}

export interface QueueSnapshot {
  activeContainers: number;
  idleContainers: number;
  activeTaskContainers: number;
  waitingMessageGroups: number;
  waitingTaskGroups: number;
  runningTasks: Array<{
    groupKey: string;
    taskId: string;
    promptPreview: string;
    startedAt: number;
  }>;
}

export interface ControlPlaneDeps {
  getTasks: () => ScheduledTask[];
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getQueueSnapshot: () => QueueSnapshot;
  pauseTask: (taskId: string) => TaskActionResult;
  resumeTask: (taskId: string) => TaskActionResult;
  cancelTask: (taskId: string) => TaskActionResult;
  runTaskNow: (taskId: string) => TaskActionResult;
}

const taskActionSchema = z.object({
  taskId: z.string().min(1),
  action: z.enum(['pause', 'resume', 'cancel', 'run-now']),
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function mapTaskActionResult(result: TaskActionResult): Response {
  if (result.ok) return json({ ok: true });
  if (result.reason === 'not_found') {
    return json({ ok: false, error: 'task_not_found' }, 404);
  }
  if (result.reason === 'invalid_state') {
    return json({ ok: false, error: 'invalid_task_state' }, 409);
  }
  return json({ ok: false, error: result.reason ?? 'task_action_failed' }, 400);
}

function executeTaskAction(
  action: TaskAction,
  taskId: string,
  deps: ControlPlaneDeps,
): Response {
  switch (action) {
    case 'pause':
      return mapTaskActionResult(deps.pauseTask(taskId));
    case 'resume':
      return mapTaskActionResult(deps.resumeTask(taskId));
    case 'cancel':
      return mapTaskActionResult(deps.cancelTask(taskId));
    case 'run-now':
      return mapTaskActionResult(deps.runTaskNow(taskId));
  }
}

export function createControlPlaneFetch(deps: ControlPlaneDeps) {
  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/healthz') {
      return json({ ok: true, now: new Date().toISOString() });
    }

    if (req.method === 'GET' && pathname === '/api/control-plane/state') {
      const tasks = deps.getTasks();
      const queue = deps.getQueueSnapshot();
      const groups = deps.getRegisteredGroups();
      return json({
        ok: true,
        summary: {
          groupCount: Object.keys(groups).length,
          taskCount: tasks.length,
          activeTasks: tasks.filter((t) => t.status === 'active').length,
          pausedTasks: tasks.filter((t) => t.status === 'paused').length,
          completedTasks: tasks.filter((t) => t.status === 'completed').length,
        },
        queue,
      });
    }

    if (req.method === 'GET' && pathname === '/api/control-plane/tasks') {
      return json({ ok: true, tasks: deps.getTasks() });
    }

    const taskActionMatch = pathname.match(
      /^\/api\/control-plane\/tasks\/([^/]+)\/(pause|resume|cancel|run-now)$/,
    );
    if (req.method === 'POST' && taskActionMatch) {
      const parsed = taskActionSchema.safeParse({
        taskId: decodeURIComponent(taskActionMatch[1]),
        action: taskActionMatch[2],
      });
      if (!parsed.success) {
        return json({ ok: false, error: 'invalid_request' }, 400);
      }
      return executeTaskAction(parsed.data.action, parsed.data.taskId, deps);
    }

    return json({ ok: false, error: 'not_found' }, 404);
  };
}

export interface ControlPlaneServerOptions {
  hostname: string;
  port: number;
}

export function startControlPlaneServer(
  deps: ControlPlaneDeps,
  options: ControlPlaneServerOptions,
): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    fetch: createControlPlaneFetch(deps),
  });

  logger.info(
    {
      hostname: options.hostname,
      port: options.port,
      op: 'controlPlane',
    },
    'Control plane HTTP server started',
  );
  return server;
}
