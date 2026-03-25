import type { APIEvent } from '@solidjs/start/server';
import { getState } from '~/lib/server-state';

export async function GET({ params }: APIEvent) {
  const state = getState();
  if (!state.resolveChatImage) {
    return Response.json({ error: 'Not supported' }, { status: 404 });
  }

  if (typeof state.resolveChatImageResponse === 'function') {
    const response = await state.resolveChatImageResponse(params.chatJid);
    if (response) return response;
  }

  return Response.json({ error: 'Icon not found' }, { status: 404 });
}
