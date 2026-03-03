import type { ScheduledTask } from '../types.js';
import type { WebStateProvider } from './types.js';
import { renderDashboard } from './dashboard.js';

/**
 * Handle an authenticated HTTP request and return a Response.
 * Routing is prefix-based: /api/* for JSON, / for the dashboard HTML.
 */
export function handleRequest(
  req: Request,
  state: WebStateProvider,
): Response | Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  // --- API routes ---
  if (pathname === '/api/agents') return handleGetAgents(state);

  // Tasks — CRUD
  if (pathname === '/api/tasks') {
    if (method === 'GET') return handleGetTasks(req, state);
    if (method === 'POST') return handleCreateTask(req, state);
    return json({ error: 'Method not allowed' }, 405);
  }
  if (pathname.startsWith('/api/tasks/')) {
    const taskId = decodeURIComponent(
      pathname.slice('/api/tasks/'.length),
    );
    if (!taskId) return json({ error: 'Missing task ID' }, 400);
    if (method === 'GET') return handleGetSingleTask(taskId, state);
    if (method === 'PATCH') return handleUpdateTask(taskId, req, state);
    if (method === 'DELETE') return handleDeleteTask(taskId, state);
    return json({ error: 'Method not allowed' }, 405);
  }

  if (pathname === '/api/chats') return handleGetChats(state);
  if (pathname.startsWith('/api/messages/'))
    return handleGetMessages(url, state);
  if (pathname === '/api/stats') return handleGetStats(state);

  // --- Dashboard ---
  if (pathname === '/' || pathname === '/index.html')
    return new Response(renderDashboard(state), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });

  return json({ error: 'Not found' }, 404);
}

// ---- Handlers ----

function handleGetAgents(state: WebStateProvider): Response {
  const agents = state.getAgents();
  const subscriptions = state.getChannelSubscriptions();

  // Enrich each agent with its channel list
  const agentList = Object.values(agents).map((agent) => {
    const channels: string[] = [];
    for (const [jid, subs] of Object.entries(subscriptions)) {
      if (subs.some((s) => s.agentId === agent.id)) {
        channels.push(jid);
      }
    }
    return { ...agent, channels };
  });

  return json(agentList);
}

function handleGetTasks(req: Request, state: WebStateProvider): Response {
  const url = new URL(req.url);
  const statusFilter = url.searchParams.get('status');
  let tasks = state.getTasks();
  if (statusFilter) {
    tasks = tasks.filter((t) => t.status === statusFilter);
  }
  return json(tasks);
}

function handleGetSingleTask(
  taskId: string,
  state: WebStateProvider,
): Response {
  const task = state.getTaskById(taskId);
  if (!task) return json({ error: 'Task not found' }, 404);
  return json(task);
}

async function handleCreateTask(
  req: Request,
  state: WebStateProvider,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  // Validate required fields
  const { group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode } = body;

  if (!prompt || typeof prompt !== 'string') {
    return json({ error: 'Missing or invalid "prompt" (string required)' }, 400);
  }
  if (!schedule_type || !['cron', 'interval', 'once'].includes(schedule_type as string)) {
    return json({ error: 'Missing or invalid "schedule_type" (cron | interval | once)' }, 400);
  }
  if (!schedule_value || typeof schedule_value !== 'string') {
    return json({ error: 'Missing or invalid "schedule_value" (string required)' }, 400);
  }
  if (!group_folder || typeof group_folder !== 'string') {
    return json({ error: 'Missing or invalid "group_folder" (string required)' }, 400);
  }
  if (!chat_jid || typeof chat_jid !== 'string') {
    return json({ error: 'Missing or invalid "chat_jid" (string required)' }, 400);
  }

  const validContextMode =
    context_mode === 'group' || context_mode === 'isolated'
      ? context_mode
      : 'isolated';

  // Validate the schedule produces a valid next_run
  const nextRun = state.calculateNextRun(
    schedule_type as 'cron' | 'interval' | 'once',
    schedule_value as string,
  );
  if (nextRun === null) {
    return json({ error: 'Invalid schedule: could not calculate next run time' }, 400);
  }

  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const task: Omit<ScheduledTask, 'last_run' | 'last_result'> = {
    id: taskId,
    group_folder: group_folder as string,
    chat_jid: chat_jid as string,
    prompt: prompt as string,
    schedule_type: schedule_type as 'cron' | 'interval' | 'once',
    schedule_value: schedule_value as string,
    context_mode: validContextMode,
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  };

  try {
    state.createTask(task);
  } catch (err) {
    return json(
      { error: `Failed to create task: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }

  return json({ ...task, last_run: null, last_result: null }, 201);
}

async function handleUpdateTask(
  taskId: string,
  req: Request,
  state: WebStateProvider,
): Promise<Response> {
  const existing = state.getTaskById(taskId);
  if (!existing) return json({ error: 'Task not found' }, 404);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  > = {};

  if (body.prompt !== undefined) {
    if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
      return json({ error: '"prompt" must be a non-empty string' }, 400);
    }
    updates.prompt = body.prompt;
  }
  if (body.schedule_type !== undefined) {
    if (!['cron', 'interval', 'once'].includes(body.schedule_type as string)) {
      return json({ error: '"schedule_type" must be cron | interval | once' }, 400);
    }
    updates.schedule_type = body.schedule_type as 'cron' | 'interval' | 'once';
  }
  if (body.schedule_value !== undefined) {
    if (typeof body.schedule_value !== 'string' || body.schedule_value.length === 0) {
      return json({ error: '"schedule_value" must be a non-empty string' }, 400);
    }
    updates.schedule_value = body.schedule_value;
  }
  if (body.status !== undefined) {
    if (!['active', 'paused'].includes(body.status as string)) {
      return json({ error: '"status" must be active | paused' }, 400);
    }
    updates.status = body.status as 'active' | 'paused';
  }

  if (Object.keys(updates).length === 0) {
    return json({ error: 'No valid fields to update' }, 400);
  }

  // Recalculate next_run when schedule changes or task is being resumed
  const effectiveStatus = updates.status ?? existing.status;
  const scheduleChanged = !!(updates.schedule_type || updates.schedule_value);
  const beingResumed = updates.status === 'active' && existing.status !== 'active';

  if (effectiveStatus === 'active' && (scheduleChanged || beingResumed)) {
    const newType = (updates.schedule_type ?? existing.schedule_type) as
      | 'cron'
      | 'interval'
      | 'once';
    const newValue = updates.schedule_value ?? existing.schedule_value;
    if (scheduleChanged || newType !== 'once') {
      const nextRun = state.calculateNextRun(newType, newValue);
      if (nextRun !== null) updates.next_run = nextRun;
    }
  }

  try {
    state.updateTask(taskId, updates);
  } catch (err) {
    return json(
      { error: `Failed to update task: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }

  // Return updated task
  const updated = state.getTaskById(taskId);
  return json(updated ?? { id: taskId, ...updates });
}

function handleDeleteTask(
  taskId: string,
  state: WebStateProvider,
): Response {
  const existing = state.getTaskById(taskId);
  if (!existing) return json({ error: 'Task not found' }, 404);

  try {
    state.deleteTask(taskId);
  } catch (err) {
    return json(
      { error: `Failed to delete task: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }

  return json({ deleted: true, id: taskId });
}

function handleGetChats(state: WebStateProvider): Response {
  return json(state.getChats());
}

function handleGetMessages(url: URL, state: WebStateProvider): Response {
  // /api/messages/{chatJid}?since=...&limit=...
  const chatJid = decodeURIComponent(url.pathname.slice('/api/messages/'.length));
  if (!chatJid) return json({ error: 'Missing chatJid' }, 400);

  const since = url.searchParams.get('since') || '1970-01-01T00:00:00.000Z';
  const limit = Math.min(
    parseInt(url.searchParams.get('limit') || '100', 10) || 100,
    500,
  );
  const messages = state.getMessages(chatJid, since, limit);
  return json(messages);
}

function handleGetStats(state: WebStateProvider): Response {
  const stats = state.getQueueStats();
  const agents = state.getAgents();
  const tasks = state.getTasks();
  return json({
    agents: Object.keys(agents).length,
    activeTasks: tasks.filter((t) => t.status === 'active').length,
    pausedTasks: tasks.filter((t) => t.status === 'paused').length,
    completedTasks: tasks.filter((t) => t.status === 'completed').length,
    ...stats,
  });
}

// ---- Helpers ----

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    },
  });
}
