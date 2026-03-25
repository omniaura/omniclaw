import type { APIEvent } from '@solidjs/start/server';
import { getState } from '~/lib/server-state';

export function GET({ request }: APIEvent) {
  const state = getState();
  const url = new URL(request.url);
  const countParam = url.searchParams.get('count');
  const count = countParam ? Math.min(Math.max(1, parseInt(countParam, 10) || 50), 200) : 50;
  return Response.json(state.getIpcEvents(count));
}
