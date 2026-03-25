import type { APIEvent } from '@solidjs/start/server';
import { getState } from '~/lib/server-state';

export function GET({ params }: APIEvent) {
  const state = getState();
  const task = state.getTaskById(params.id);
  if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
  return Response.json(task);
}

export async function PATCH({ params, request }: APIEvent) {
  const state = getState();
  const existing = state.getTaskById(params.id);
  if (!existing) return Response.json({ error: 'Task not found' }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};

  if (body.prompt !== undefined) {
    if (typeof body.prompt !== 'string' || !body.prompt) {
      return Response.json({ error: '"prompt" must be a non-empty string' }, { status: 400 });
    }
    updates.prompt = body.prompt;
  }
  if (body.schedule_type !== undefined) {
    if (!['cron', 'interval', 'once'].includes(body.schedule_type as string)) {
      return Response.json({ error: '"schedule_type" must be cron | interval | once' }, { status: 400 });
    }
    updates.schedule_type = body.schedule_type;
  }
  if (body.schedule_value !== undefined) {
    if (typeof body.schedule_value !== 'string' || !body.schedule_value) {
      return Response.json({ error: '"schedule_value" must be a non-empty string' }, { status: 400 });
    }
    updates.schedule_value = body.schedule_value;
  }
  if (body.status !== undefined) {
    if (!['active', 'paused'].includes(body.status as string)) {
      return Response.json({ error: '"status" must be active | paused' }, { status: 400 });
    }
    updates.status = body.status;
  }

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: 'No valid fields to update' }, { status: 400 });
  }

  // Recalculate next_run when schedule changes or task is being resumed
  const effectiveStatus = (updates.status as string) ?? existing.status;
  const scheduleChanged = !!(updates.schedule_type || updates.schedule_value);
  const beingResumed = updates.status === 'active' && existing.status !== 'active';
  const newType = (updates.schedule_type ?? existing.schedule_type) as string;
  const newValue = (updates.schedule_value ?? existing.schedule_value) as string;

  if (scheduleChanged) {
    const validated = state.calculateNextRun(newType, newValue);
    if (validated === null) {
      return Response.json({ error: 'Invalid schedule' }, { status: 400 });
    }
    if (effectiveStatus === 'active') updates.next_run = validated;
  } else if (effectiveStatus === 'active' && beingResumed && newType !== 'once') {
    const nextRun = state.calculateNextRun(newType, newValue);
    if (nextRun === null) {
      return Response.json({ error: 'Invalid schedule' }, { status: 400 });
    }
    updates.next_run = nextRun;
  }

  try {
    state.updateTask(params.id, updates);
  } catch (err: any) {
    return Response.json({ error: `Failed to update task: ${err.message}` }, { status: 500 });
  }

  const updated = state.getTaskById(params.id);
  return Response.json(updated);
}

export function DELETE({ params }: APIEvent) {
  const state = getState();
  const existing = state.getTaskById(params.id);
  if (!existing) return Response.json({ error: 'Task not found' }, { status: 404 });

  try {
    state.deleteTask(params.id);
  } catch (err: any) {
    return Response.json({ error: `Failed to delete task: ${err.message}` }, { status: 500 });
  }

  return Response.json({ deleted: true, id: params.id });
}
