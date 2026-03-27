import type { APIEvent } from '@solidjs/start/server';
import { getState } from '~/lib/server-state';

export async function POST({ params, request }: APIEvent) {
  const state = getState();
  const agentId = params.id;
  if (!agentId) {
    return Response.json({ error: 'Missing agent ID' }, { status: 400 });
  }

  if (typeof state.sendMessage !== 'function') {
    return Response.json(
      { error: 'Message sending is not available' },
      { status: 501 },
    );
  }

  const agents = state.getAgents();
  const agent = agents[agentId];
  if (!agent) {
    return Response.json({ error: 'Agent not found' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { channel, content, sender_name } = body;

  if (!content || typeof content !== 'string') {
    return Response.json(
      { error: 'Missing or invalid "content" (string required)' },
      { status: 400 },
    );
  }
  if ((content as string).length > 10000) {
    return Response.json(
      { error: '"content" exceeds 10000 character limit' },
      { status: 400 },
    );
  }
  if (!channel || typeof channel !== 'string') {
    return Response.json(
      { error: 'Missing or invalid "channel" (chat JID required)' },
      { status: 400 },
    );
  }

  // Verify channel is subscribed by this agent
  const subs = state.getChannelSubscriptions();
  const agentChannels = (subs[channel as string] || []).filter(
    (s: any) => s.agentId === agentId,
  );
  if (agentChannels.length === 0) {
    return Response.json(
      {
        error: `Agent "${agent.name}" is not subscribed to channel "${channel}"`,
      },
      { status: 400 },
    );
  }

  const senderLabel =
    typeof sender_name === 'string' && sender_name.trim()
      ? sender_name.trim()
      : 'Web UI Admin';

  try {
    const messageId = state.sendMessage(
      channel as string,
      content as string,
      senderLabel,
    );
    return Response.json(
      { id: messageId, channel, content, sender_name: senderLabel },
      { status: 201 },
    );
  } catch (err: any) {
    return Response.json(
      { error: `Failed to send message: ${err.message}` },
      { status: 500 },
    );
  }
}
