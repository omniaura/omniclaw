import { getState } from '~/lib/server-state';

export function GET() {
  const state = getState();
  return Response.json(state.getAgentChannelData());
}
