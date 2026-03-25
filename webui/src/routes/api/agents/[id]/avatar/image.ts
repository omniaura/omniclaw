import type { APIEvent } from '@solidjs/start/server';
import { getState } from '~/lib/server-state';

export async function GET({ params }: APIEvent) {
  const state = getState();
  const agents = state.getAgents();
  const agent = agents[params.id];
  if (!agent) return Response.json({ error: 'Agent not found' }, { status: 404 });
  if (!agent.avatarUrl) return Response.json({ error: 'Avatar not found' }, { status: 404 });

  // Delegate to the main process avatar resolver if available
  if (typeof state.resolveAgentAvatarImage === 'function') {
    const response = await state.resolveAgentAvatarImage(params.id);
    if (response) return response;
  }

  return Response.json({ error: 'Avatar resolution not available' }, { status: 404 });
}
