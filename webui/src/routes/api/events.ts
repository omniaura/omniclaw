/**
 * SSE event stream endpoint.
 *
 * When running in SolidStart mode, the main OmniClaw process handles this
 * endpoint directly (it manages SSE client tracking and broadcasts).
 * This route exists as a fallback/documentation placeholder.
 *
 * The actual SSE handling is wired up in the main process's server.ts
 * which intercepts /api/events before it reaches the SolidStart handler.
 */
export function GET() {
  // In integrated mode, the main process intercepts this route.
  // If we reach here, SSE is not available.
  return Response.json(
    { error: 'SSE endpoint is handled by the main process' },
    { status: 503 },
  );
}
