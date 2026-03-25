import type { APIEvent } from '@solidjs/start/server';
import { getState } from '~/lib/server-state';

export function GET({ params }: APIEvent) {
  const state = getState();
  const agentId = params.id;
  if (!agentId) {
    return Response.json({ error: 'Missing agent ID' }, { status: 400 });
  }

  if (typeof state.getAgentDetail === 'function') {
    const data = state.getAgentDetail(agentId);
    if (!data) return Response.json({ error: 'Agent not found' }, { status: 404 });
    return Response.json(data);
  }

  const agents = state.getAgents();
  const agent = agents[agentId];
  if (!agent) return Response.json({ error: 'Agent not found' }, { status: 404 });
  return Response.json(agent);
}
