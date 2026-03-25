import type { APIEvent } from '@solidjs/start/server';
import { getState } from '~/lib/server-state';

export function GET({ params, request }: APIEvent) {
  const state = getState();
  const chatJid = params.chatJid;
  if (!chatJid) return Response.json({ error: 'Missing chatJid' }, { status: 400 });

  const url = new URL(request.url);
  const since = url.searchParams.get('since') || '1970-01-01T00:00:00.000Z';
  const limit = Math.min(Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10) || 100), 500);
  const messages = state.getMessages(chatJid, since, limit);
  return Response.json(messages);
}
