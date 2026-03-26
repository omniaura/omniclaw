import type { APIEvent } from '@solidjs/start/server';
import { getState } from '~/lib/server-state';

export async function PUT({ request }: APIEvent) {
  const state = getState();

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { path: layerPath, content } = body;
  if (!layerPath || typeof layerPath !== 'string') {
    return Response.json(
      { error: 'Missing or invalid "path"' },
      { status: 400 },
    );
  }
  if (typeof content !== 'string') {
    return Response.json(
      { error: 'Missing or invalid "content"' },
      { status: 400 },
    );
  }
  if (layerPath.includes('..') || layerPath.startsWith('/')) {
    return Response.json(
      { error: 'Invalid path: must be relative, no ".."' },
      { status: 400 },
    );
  }

  try {
    state.writeContextFile(layerPath, content);
  } catch (err: any) {
    return Response.json(
      { error: `Failed to write: ${err.message}` },
      { status: 500 },
    );
  }

  return Response.json({ ok: true });
}
