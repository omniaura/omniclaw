import type { APIEvent } from '@solidjs/start/server';
import { getState } from '~/lib/server-state';

export function GET({ params }: APIEvent) {
  const state = getState();
  const task = state.getTaskById(params.id);
  if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });

  const phases = state.getTaskRunPhaseEvents(params.id, params.runAt);
  return Response.json(phases);
}
