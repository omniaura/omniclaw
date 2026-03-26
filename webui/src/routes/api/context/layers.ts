import type { APIEvent } from '@solidjs/start/server';
import { getState } from '~/lib/server-state';

export function GET({ request }: APIEvent) {
  const state = getState();
  const url = new URL(request.url);
  const folder = url.searchParams.get('folder') || '';
  const serverFolder = url.searchParams.get('server_folder') || '';
  const agentContextFolder = url.searchParams.get('agent_context_folder') || '';
  const channelFolder = url.searchParams.get('channel_folder') || '';
  const categoryFolder = url.searchParams.get('category_folder') || '';

  const channelPath = channelFolder || folder;
  const agentPath = agentContextFolder || null;
  const categoryPath = categoryFolder || null;
  const serverPath = serverFolder || null;

  const layers: Record<
    string,
    { path: string | null; content: string | null; exists: boolean }
  > = {
    channel: {
      path: channelPath || null,
      content: channelPath ? state.readContextFile(channelPath) : null,
      exists: channelPath ? state.readContextFile(channelPath) !== null : false,
    },
    agent: {
      path: agentPath,
      content: agentPath ? state.readContextFile(agentPath) : null,
      exists: agentPath ? state.readContextFile(agentPath) !== null : false,
    },
    category: {
      path: categoryPath,
      content: categoryPath ? state.readContextFile(categoryPath) : null,
      exists: categoryPath
        ? state.readContextFile(categoryPath) !== null
        : false,
    },
    server: {
      path: serverPath,
      content: serverPath ? state.readContextFile(serverPath) : null,
      exists: serverPath ? state.readContextFile(serverPath) !== null : false,
    },
  };

  return Response.json(layers);
}
