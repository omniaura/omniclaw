import type { APIEvent } from '@solidjs/start/server';
import { getState } from '~/lib/server-state';

export function GET({ request }: APIEvent) {
  const state = getState();
  const url = new URL(request.url);
  const query = url.searchParams.get('q') || '';
  if (!query.trim())
    return Response.json({ error: 'Missing search query' }, { status: 400 });

  const chatJid = url.searchParams.get('chatJid') || undefined;
  const limit = Math.min(
    Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50),
    200,
  );
  const results = state.searchMessages(query, chatJid, limit);
  return Response.json(results);
}
