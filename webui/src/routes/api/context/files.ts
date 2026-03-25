import { getState } from '~/lib/server-state';

export function GET() {
  const state = getState();
  if (typeof state.listContextFiles === 'function') {
    return Response.json(state.listContextFiles());
  }
  return Response.json([]);
}
