import type { APIEvent } from '@solidjs/start/server';
import { getState } from '~/lib/server-state';

export function GET({ params, request }: APIEvent) {
  const state = getState();
  const task = state.getTaskById(params.id);
  if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });

  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10) || 20), 100) : 20;
  const runs = state.getTaskRunLogs(params.id, limit);
  return Response.json(runs);
}
