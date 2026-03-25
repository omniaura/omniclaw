import type { APIEvent } from '@solidjs/start/server';
import { getState } from '~/lib/server-state';

export function GET({ params }: APIEvent) {
  const state = getState();
  const agents = state.getAgents();
  const agent = agents[params.id];
  if (!agent) return Response.json({ error: 'Agent not found' }, { status: 404 });
  return Response.json({
    avatarUrl: agent.avatarUrl || null,
    avatarSource: agent.avatarSource || null,
  });
}

export async function POST({ params, request }: APIEvent) {
  const state = getState();
  const agents = state.getAgents();
  const agent = agents[params.id];
  if (!agent) return Response.json({ error: 'Agent not found' }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const validSources = new Set(['discord', 'telegram', 'slack', 'custom']);
  if (body.source && !validSources.has(body.source as string)) {
    return Response.json({ error: '"source" must be discord | telegram | slack | custom' }, { status: 400 });
  }

  state.updateAgentAvatar(params.id, (body.url as string) || null, (body.source as string) || null);
  return Response.json({ success: true, agentId: params.id });
}
