/**
 * Discovery API fallback. The main OmniClaw process handles discovery
 * routes directly. If a request reaches here, discovery is not wired up.
 */
export function GET() {
  return Response.json({ error: 'Discovery not available' }, { status: 503 });
}

export function POST() {
  return Response.json({ error: 'Discovery not available' }, { status: 503 });
}
