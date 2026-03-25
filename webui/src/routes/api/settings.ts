import { getState } from '~/lib/server-state';

export function GET() {
  // Settings are built from config constants in the main process.
  // Since the SolidStart API routes run in-process, we import the builder
  // dynamically from the main source tree.
  try {
    // The main process should have set a settings getter on state
    const state = getState();
    if (typeof state.getSettings === 'function') {
      return Response.json(state.getSettings());
    }
  } catch {
    // fall through
  }
  return Response.json({ error: 'Settings not available' }, { status: 503 });
}
