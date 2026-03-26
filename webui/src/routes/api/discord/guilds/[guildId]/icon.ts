import type { APIEvent } from '@solidjs/start/server';
import { getState } from '~/lib/server-state';

export async function GET({ params, request }: APIEvent) {
  const state = getState();
  if (!state.resolveDiscordGuildImage) {
    return Response.json({ error: 'Not supported' }, { status: 404 });
  }

  const url = new URL(request.url);
  const botId = url.searchParams.get('botId') || undefined;

  if (typeof state.resolveDiscordGuildImageResponse === 'function') {
    const response = await state.resolveDiscordGuildImageResponse(
      params.guildId,
      botId,
    );
    if (response) return response;
  }

  return Response.json({ error: 'Icon not found' }, { status: 404 });
}
