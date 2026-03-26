import type { APIEvent } from '@solidjs/start/server';
import { getState } from '~/lib/server-state';

export function GET({ request }: APIEvent) {
  const state = getState();
  const url = new URL(request.url);
  const statusFilter = url.searchParams.get('status');
  let tasks = state.getTasks();
  if (statusFilter) {
    tasks = tasks.filter((t: any) => t.status === statusFilter);
  }
  return Response.json(tasks);
}

export async function POST({ request }: APIEvent) {
  const state = getState();

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const {
    group_folder,
    chat_jid,
    prompt,
    schedule_type,
    schedule_value,
    context_mode,
  } = body;

  if (!prompt || typeof prompt !== 'string') {
    return Response.json(
      { error: 'Missing or invalid "prompt"' },
      { status: 400 },
    );
  }
  if (
    !schedule_type ||
    !['cron', 'interval', 'once'].includes(schedule_type as string)
  ) {
    return Response.json(
      { error: 'Missing or invalid "schedule_type"' },
      { status: 400 },
    );
  }
  if (!schedule_value || typeof schedule_value !== 'string') {
    return Response.json(
      { error: 'Missing or invalid "schedule_value"' },
      { status: 400 },
    );
  }
  if (!group_folder || typeof group_folder !== 'string') {
    return Response.json(
      { error: 'Missing or invalid "group_folder"' },
      { status: 400 },
    );
  }
  if (!chat_jid || typeof chat_jid !== 'string') {
    return Response.json(
      { error: 'Missing or invalid "chat_jid"' },
      { status: 400 },
    );
  }

  const validContextMode =
    context_mode === 'group' || context_mode === 'isolated'
      ? context_mode
      : 'isolated';
  const nextRun = state.calculateNextRun(
    schedule_type as string,
    schedule_value as string,
  );
  if (nextRun === null) {
    return Response.json({ error: 'Invalid schedule' }, { status: 400 });
  }

  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const task = {
    id: taskId,
    group_folder: group_folder as string,
    chat_jid: chat_jid as string,
    prompt: prompt as string,
    schedule_type: schedule_type as string,
    schedule_value: schedule_value as string,
    context_mode: validContextMode,
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  };

  try {
    state.createTask(task);
  } catch (err: any) {
    return Response.json(
      { error: `Failed to create task: ${err.message}` },
      { status: 500 },
    );
  }

  return Response.json(
    { ...task, last_run: null, last_result: null },
    { status: 201 },
  );
}
