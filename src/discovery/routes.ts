/**
 * HTTP route handlers for network discovery API.
 * All routes are prefixed with /api/discovery/.
 */
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { WEB_UI_PORT } from '../config.js';
import { logger } from '../logger.js';
import { listLocalContextFiles } from '../web/context-files.js';
import type { WebStateProvider } from '../web/types.js';
import { PeerClient, verifyPeerRequestSignature } from './peer-client.js';
import type { TrustStore } from './trust-store.js';
import type {
  ContextFileEntry,
  ContextSyncComparison,
  DiscoveredPeer,
  DiscoveryHandle,
  PairRequestBody,
  PeerView,
} from './types.js';

export interface DiscoveryRouteContext {
  instanceId: string;
  instanceName: string;
  version: string;
  trustStore: TrustStore;
  discovery: DiscoveryHandle | null;
  state: WebStateProvider;
  /** Callback to broadcast SSE events */
  broadcast?: (event: {
    type: string;
    data: unknown;
    timestamp: string;
  }) => void;
}

const PEER_AUTH_MAX_SKEW_MS = 30_000;
const seenPeerNonces = new Map<string, number>();

// Rate limiting for /api/discovery/pair
const pairRateLimiter = new Map<string, { count: number; resetAt: number }>();
const PAIR_RATE_LIMIT = 10;
const PAIR_RATE_WINDOW_MS = 60_000;

function checkPairRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = pairRateLimiter.get(ip);

  if (!entry || now > entry.resetAt) {
    pairRateLimiter.set(ip, { count: 1, resetAt: now + PAIR_RATE_WINDOW_MS });
    return true;
  }

  if (entry.count >= PAIR_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

/**
 * Handle a /api/discovery/* request.
 * Returns null if the path doesn't match any discovery route.
 */
export function handleDiscoveryRequest(
  req: Request,
  url: URL,
  ctx: DiscoveryRouteContext,
): Response | Promise<Response> | null {
  const { pathname } = url;
  const method = req.method;

  // --- Unauthenticated endpoints ---

  if (pathname === '/api/discovery/info' && method === 'GET') {
    return handleGetInfo(ctx);
  }

  if (pathname === '/api/discovery/pair' && method === 'POST') {
    return handlePairRequest(req, ctx);
  }

  if (pathname === '/api/discovery/complete-pairing' && method === 'POST') {
    return handleCompletePairing(req, ctx);
  }

  // --- Locally authenticated endpoints (protected by Basic Auth in server.ts) ---

  if (pathname === '/api/discovery/peers' && method === 'GET') {
    return handleGetPeers(ctx);
  }

  if (pathname === '/api/discovery/requests' && method === 'GET') {
    return handleGetRequests(ctx);
  }

  // POST /api/discovery/requests/:id/approve
  if (
    pathname.startsWith('/api/discovery/requests/') &&
    pathname.endsWith('/approve') &&
    method === 'POST'
  ) {
    const id = pathname.slice(
      '/api/discovery/requests/'.length,
      -'/approve'.length,
    );
    return handleApproveRequest(id, ctx);
  }

  // POST /api/discovery/requests/:id/reject
  if (
    pathname.startsWith('/api/discovery/requests/') &&
    pathname.endsWith('/reject') &&
    method === 'POST'
  ) {
    const id = pathname.slice(
      '/api/discovery/requests/'.length,
      -'/reject'.length,
    );
    return handleRejectRequest(id, ctx);
  }

  // POST /api/discovery/peers/:id/request-access
  if (
    pathname.startsWith('/api/discovery/peers/') &&
    pathname.endsWith('/request-access') &&
    method === 'POST'
  ) {
    const instanceId = decodeURIComponent(
      pathname.slice('/api/discovery/peers/'.length, -'/request-access'.length),
    );
    return handleRequestAccess(instanceId, ctx);
  }

  // DELETE /api/discovery/peers/:instanceId
  if (pathname.startsWith('/api/discovery/peers/') && method === 'DELETE') {
    const rest = pathname.slice('/api/discovery/peers/'.length);
    // Only match direct children, not sub-paths like /agents
    if (!rest.includes('/')) {
      const instanceId = decodeURIComponent(rest);
      return handleRevokePeer(instanceId, ctx);
    }
  }

  // --- Proxy routes for trusted remote peers ---

  // GET /api/discovery/peers/:id/agents
  if (
    pathname.startsWith('/api/discovery/peers/') &&
    pathname.endsWith('/agents') &&
    method === 'GET'
  ) {
    const instanceId = decodeURIComponent(
      pathname.slice('/api/discovery/peers/'.length, -'/agents'.length),
    );
    return handleProxyAgents(instanceId, ctx);
  }

  // GET /api/discovery/peers/:id/stats
  if (
    pathname.startsWith('/api/discovery/peers/') &&
    pathname.endsWith('/stats') &&
    method === 'GET'
  ) {
    const instanceId = decodeURIComponent(
      pathname.slice('/api/discovery/peers/'.length, -'/stats'.length),
    );
    return handleProxyStats(instanceId, ctx);
  }

  // GET /api/discovery/peers/:id/context/layers
  if (
    pathname.startsWith('/api/discovery/peers/') &&
    pathname.endsWith('/context/layers') &&
    method === 'GET'
  ) {
    const instanceId = decodeURIComponent(
      pathname.slice('/api/discovery/peers/'.length, -'/context/layers'.length),
    );
    return handleProxyContextLayers(instanceId, url, ctx);
  }

  // PUT /api/discovery/peers/:id/context/file
  if (
    pathname.startsWith('/api/discovery/peers/') &&
    pathname.endsWith('/context/file') &&
    method === 'PUT'
  ) {
    const instanceId = decodeURIComponent(
      pathname.slice('/api/discovery/peers/'.length, -'/context/file'.length),
    );
    return handleProxyContextWrite(instanceId, req, ctx);
  }

  // GET /api/discovery/peers/:id/context/compare — compare local vs remote context files
  if (
    pathname.startsWith('/api/discovery/peers/') &&
    pathname.endsWith('/context/compare') &&
    method === 'GET'
  ) {
    const instanceId = decodeURIComponent(
      pathname.slice(
        '/api/discovery/peers/'.length,
        -'/context/compare'.length,
      ),
    );
    return handleContextCompare(instanceId, ctx);
  }

  // POST /api/discovery/peers/:id/context/push — push a local file to the remote
  if (
    pathname.startsWith('/api/discovery/peers/') &&
    pathname.endsWith('/context/push') &&
    method === 'POST'
  ) {
    const instanceId = decodeURIComponent(
      pathname.slice('/api/discovery/peers/'.length, -'/context/push'.length),
    );
    return handleContextPush(instanceId, req, ctx);
  }

  // POST /api/discovery/peers/:id/context/pull — pull a remote file to local
  if (
    pathname.startsWith('/api/discovery/peers/') &&
    pathname.endsWith('/context/pull') &&
    method === 'POST'
  ) {
    const instanceId = decodeURIComponent(
      pathname.slice('/api/discovery/peers/'.length, -'/context/pull'.length),
    );
    return handleContextPull(instanceId, req, ctx);
  }

  return null; // not a discovery route
}

// --- Handlers ---

function handleGetInfo(ctx: DiscoveryRouteContext): Response {
  const agents = ctx.state.getAgents();
  return json({
    instanceId: ctx.instanceId,
    name: ctx.instanceName,
    version: ctx.version,
    agentCount: Object.keys(agents).length,
  });
}

async function handlePairRequest(
  req: Request,
  ctx: DiscoveryRouteContext,
): Promise<Response> {
  // Rate limit
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkPairRateLimit(ip)) {
    return json({ error: 'Rate limit exceeded' }, 429);
  }

  let body: PairRequestBody;
  try {
    body = (await req.json()) as PairRequestBody;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (
    !body.instanceId ||
    !body.name ||
    !body.host ||
    !body.port ||
    !body.callbackToken
  ) {
    return json(
      {
        error:
          'Missing required fields: instanceId, name, host, port, callbackToken',
      },
      400,
    );
  }

  // Check if already trusted
  if (ctx.trustStore.isPeerTrusted(body.instanceId)) {
    const sharedSecret = ctx.trustStore.getPeerSecret(body.instanceId);
    if (sharedSecret) {
      await sendPairingSecretToPeer(
        body.instanceId,
        sharedSecret,
        body.callbackToken,
        ctx,
      );
    }
    return json({ status: 'already_trusted' });
  }

  // Create or update pair request
  const request = ctx.trustStore.createPairRequest(
    body.instanceId,
    body.name,
    body.host,
    body.port,
    body.callbackToken,
  );

  // Broadcast SSE event for the web UI
  ctx.broadcast?.({
    type: 'pair_request',
    data: request,
    timestamp: new Date().toISOString(),
  });

  return json({
    status: 'pending',
    requestId: request.id,
  });
}

async function handleCompletePairing(
  req: Request,
  ctx: DiscoveryRouteContext,
): Promise<Response> {
  let body: {
    sharedSecret: string;
    instanceId: string;
    name: string;
    callbackToken: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (
    !body.sharedSecret ||
    !body.instanceId ||
    !body.name ||
    !body.callbackToken
  ) {
    return json(
      {
        error:
          'Missing required fields: sharedSecret, instanceId, name, callbackToken',
      },
      400,
    );
  }

  const now = new Date().toISOString();
  try {
    ctx.trustStore.completePendingPairing(
      body.instanceId,
      body.name,
      body.sharedSecret,
      body.callbackToken,
    );
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      403,
    );
  }

  logger.info(
    { instanceId: body.instanceId, name: body.name },
    'Pairing completed — remote instance trusted',
  );

  ctx.broadcast?.({
    type: 'pair_approved',
    data: { instanceId: body.instanceId, name: body.name },
    timestamp: now,
  });

  return json({ ok: true });
}

function handleGetPeers(ctx: DiscoveryRouteContext): Response {
  const discoveredPeers = ctx.discovery?.getPeers() ?? new Map();
  const storedPeers = ctx.trustStore.getAllPeers();
  const storedMap = new Map(storedPeers.map((p) => [p.instanceId, p]));

  const peers: PeerView[] = [];

  // Merge discovered + stored
  for (const [id, discovered] of discoveredPeers) {
    const stored = storedMap.get(id);
    peers.push({
      instanceId: id,
      name: discovered.name,
      host: discovered.host,
      port: discovered.port,
      addresses: discovered.addresses,
      status: stored?.status ?? 'discovered',
      online: true,
      approvedAt: stored?.approvedAt ?? null,
      lastSeen: stored?.lastSeen ?? null,
    });
    storedMap.delete(id);
  }

  // Add stored-only peers (offline but still trusted)
  for (const stored of storedMap.values()) {
    if (stored.status === 'revoked') continue;
    peers.push({
      instanceId: stored.instanceId,
      name: stored.name,
      host: stored.host ?? '',
      port: stored.port ?? 0,
      addresses: [],
      status: stored.status,
      online: false,
      approvedAt: stored.approvedAt,
      lastSeen: stored.lastSeen,
    });
  }

  return json(peers);
}

function handleGetRequests(ctx: DiscoveryRouteContext): Response {
  return json(ctx.trustStore.getPendingRequests());
}

async function handleApproveRequest(
  requestId: string,
  ctx: DiscoveryRouteContext,
): Promise<Response> {
  try {
    const { sharedSecret, request } =
      ctx.trustStore.approvePairRequest(requestId);

    try {
      await sendPairingSecretToPeer(
        request.fromInstanceId,
        sharedSecret,
        request.callbackToken ?? '',
        ctx,
      );
    } catch (err) {
      logger.warn(
        {
          requestId,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to send pairing callback to requester — they can re-request',
      );
    }

    ctx.broadcast?.({
      type: 'pair_approved',
      data: {
        instanceId: request.fromInstanceId,
        name: request.fromName,
      },
      timestamp: new Date().toISOString(),
    });

    return json({ approved: true });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : String(err) },
      400,
    );
  }
}

function handleRejectRequest(
  requestId: string,
  ctx: DiscoveryRouteContext,
): Response {
  try {
    ctx.trustStore.rejectPairRequest(requestId);
    return json({ rejected: true });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : String(err) },
      400,
    );
  }
}

async function handleRequestAccess(
  instanceId: string,
  ctx: DiscoveryRouteContext,
): Promise<Response> {
  // Find the peer in mDNS discovered peers
  const discovered = ctx.discovery?.getPeers().get(instanceId);
  if (!discovered) {
    return json({ error: 'Peer not found in discovery' }, 404);
  }

  // Check if already trusted
  if (ctx.trustStore.isPeerTrusted(instanceId)) {
    return json({ status: 'already_trusted' });
  }

  // Send pair request to the remote instance
  try {
    const callbackToken = randomUUID();
    ctx.trustStore.markPeerPending(
      instanceId,
      discovered.name,
      discovered.host,
      discovered.port,
      callbackToken,
    );

    const client = new PeerClient(
      discovered.host,
      discovered.port,
      ctx.instanceId,
    );
    const response = await client.requestPairing({
      instanceId: ctx.instanceId,
      name: ctx.instanceName,
      host: getLocalAddress(),
      port: WEB_UI_PORT || 6001,
      callbackToken,
    });

    return json({ status: 'pending', requestId: response.requestId });
  } catch (err) {
    ctx.trustStore.resetPeerToDiscovered(instanceId);
    return json(
      {
        error: `Failed to contact peer: ${err instanceof Error ? err.message : String(err)}`,
      },
      502,
    );
  }
}

function handleRevokePeer(
  instanceId: string,
  ctx: DiscoveryRouteContext,
): Response {
  ctx.trustStore.revokePeer(instanceId);
  return json({ revoked: true });
}

// --- Proxy handlers ---

function getPeerClient(
  instanceId: string,
  ctx: DiscoveryRouteContext,
): PeerClient | null {
  const peer = ctx.trustStore.getPeer(instanceId);
  if (!peer || peer.status !== 'trusted' || !peer.sharedSecret) return null;

  // Prefer mDNS-discovered host (more current) over stored
  const discovered = ctx.discovery?.getPeers().get(instanceId);
  const host = discovered?.host ?? peer.host;
  const port = discovered?.port ?? peer.port;

  if (!host || !port) return null;

  ctx.trustStore.updatePeerLastSeen(instanceId);
  return new PeerClient(host, port, ctx.instanceId, peer.sharedSecret);
}

async function handleProxyAgents(
  instanceId: string,
  ctx: DiscoveryRouteContext,
): Promise<Response> {
  const client = getPeerClient(instanceId, ctx);
  if (!client) return json({ error: 'Peer not trusted or unreachable' }, 403);

  try {
    const agents = await client.getAgents();
    return json(agents);
  } catch (err) {
    return json(
      {
        error: `Proxy error: ${err instanceof Error ? err.message : String(err)}`,
      },
      502,
    );
  }
}

async function handleProxyStats(
  instanceId: string,
  ctx: DiscoveryRouteContext,
): Promise<Response> {
  const client = getPeerClient(instanceId, ctx);
  if (!client) return json({ error: 'Peer not trusted or unreachable' }, 403);

  try {
    const stats = await client.getStats();
    return json(stats);
  } catch (err) {
    return json(
      {
        error: `Proxy error: ${err instanceof Error ? err.message : String(err)}`,
      },
      502,
    );
  }
}

async function handleProxyContextLayers(
  instanceId: string,
  url: URL,
  ctx: DiscoveryRouteContext,
): Promise<Response> {
  const client = getPeerClient(instanceId, ctx);
  if (!client) return json({ error: 'Peer not trusted or unreachable' }, 403);

  try {
    const params: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      params[key] = value;
    }
    const layers = await client.getContextLayers(params);
    return json(layers);
  } catch (err) {
    return json(
      {
        error: `Proxy error: ${err instanceof Error ? err.message : String(err)}`,
      },
      502,
    );
  }
}

async function handleProxyContextWrite(
  instanceId: string,
  req: Request,
  ctx: DiscoveryRouteContext,
): Promise<Response> {
  const client = getPeerClient(instanceId, ctx);
  if (!client) return json({ error: 'Peer not trusted or unreachable' }, 403);

  let body: { path: string; content: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.path || typeof body.content !== 'string') {
    return json({ error: 'Missing path or content' }, 400);
  }

  try {
    const result = await client.writeContextFile(body.path, body.content);
    return json(result);
  } catch (err) {
    return json(
      {
        error: `Proxy error: ${err instanceof Error ? err.message : String(err)}`,
      },
      502,
    );
  }
}

// --- Context sync handlers ---

async function handleContextCompare(
  instanceId: string,
  ctx: DiscoveryRouteContext,
): Promise<Response> {
  const client = getPeerClient(instanceId, ctx);
  if (!client) return json({ error: 'Peer not trusted or unreachable' }, 403);

  try {
    // Get local files directly, fetch remote in parallel
    const [localFiles, remoteFiles] = await Promise.all([
      Promise.resolve(listLocalContextFiles()),
      client.listContextFiles(),
    ]);

    const localMap = new Map(localFiles.map((f) => [f.path, f]));
    const remoteMap = new Map(remoteFiles.map((f) => [f.path, f]));

    const comparison: ContextSyncComparison = {
      same: [],
      differs: [],
      localOnly: [],
      remoteOnly: [],
    };

    // Check local files against remote
    for (const [filePath, local] of localMap) {
      const remote = remoteMap.get(filePath);
      if (!remote) {
        comparison.localOnly.push(local);
      } else if (local.hash === remote.hash) {
        comparison.same.push(local);
      } else {
        comparison.differs.push({ local, remote });
      }
    }

    // Check remote-only files
    for (const [filePath, remote] of remoteMap) {
      if (!localMap.has(filePath)) {
        comparison.remoteOnly.push(remote);
      }
    }

    return json(comparison);
  } catch (err) {
    return json(
      {
        error: `Compare failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      502,
    );
  }
}

async function handleContextPush(
  instanceId: string,
  req: Request,
  ctx: DiscoveryRouteContext,
): Promise<Response> {
  const client = getPeerClient(instanceId, ctx);
  if (!client) return json({ error: 'Peer not trusted or unreachable' }, 403);

  let body: { path: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.path || typeof body.path !== 'string') {
    return json({ error: 'Missing path' }, 400);
  }

  // Read local content
  const layerPath = toLayerPath(body.path);
  const content = ctx.state.readContextFile(layerPath);
  if (content === null) {
    return json({ error: 'Local file not found' }, 404);
  }

  try {
    await client.writeContextFile(layerPath, content);
    logger.info({ instanceId, path: body.path }, 'Context file pushed to peer');
    return json({ ok: true, direction: 'push', path: body.path });
  } catch (err) {
    return json(
      {
        error: `Push failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      502,
    );
  }
}

async function handleContextPull(
  instanceId: string,
  req: Request,
  ctx: DiscoveryRouteContext,
): Promise<Response> {
  const client = getPeerClient(instanceId, ctx);
  if (!client) return json({ error: 'Peer not trusted or unreachable' }, 403);

  let body: { path: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.path || typeof body.path !== 'string') {
    return json({ error: 'Missing path' }, 400);
  }

  try {
    // Fetch content from remote via their context layers API
    const layers = (await client.getContextLayers({
      folder: toLayerPath(body.path),
    })) as Record<
      string,
      { path: string | null; content: string | null; exists: boolean }
    >;

    // Get the channel layer content (primary layer for a given path)
    const layer = layers.channel;
    if (!layer?.content) {
      return json({ error: 'Remote file not found or empty' }, 404);
    }

    // Write locally
    ctx.state.writeContextFile(toLayerPath(body.path), layer.content);
    logger.info(
      { instanceId, path: body.path },
      'Context file pulled from peer',
    );
    return json({ ok: true, direction: 'pull', path: body.path });
  } catch (err) {
    return json(
      {
        error: `Pull failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      502,
    );
  }
}

// --- Helpers ---

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    },
  });
}

function getLocalAddress(): string {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
  } catch {
    // fallback
  }
  return '127.0.0.1';
}

/**
 * Check if an incoming API request is from a trusted peer.
 * Used by the web server to authenticate peer-to-peer API calls.
 */
export function checkPeerAuth(req: Request, trustStore: TrustStore): boolean {
  const instanceId = req.headers.get('X-OmniClaw-Instance');
  const timestamp = req.headers.get('X-OmniClaw-Timestamp');
  const nonce = req.headers.get('X-OmniClaw-Nonce');
  const bodyHash = req.headers.get('X-OmniClaw-Body-SHA256');
  const signature = req.headers.get('X-OmniClaw-Signature');

  if (!instanceId || !timestamp || !nonce || !bodyHash || !signature) {
    return false;
  }

  const requestTime = Number(timestamp);
  if (!Number.isFinite(requestTime)) return false;
  if (Math.abs(Date.now() - requestTime) > PEER_AUTH_MAX_SKEW_MS) {
    return false;
  }

  const now = Date.now();
  for (const [key, expiresAt] of seenPeerNonces.entries()) {
    if (expiresAt <= now) seenPeerNonces.delete(key);
  }
  const nonceKey = `${instanceId}:${nonce}`;
  if (seenPeerNonces.has(nonceKey)) return false;

  const storedSecret = trustStore.getPeerSecret(instanceId);

  if (
    !storedSecret ||
    !verifyPeerRequestSignature({
      sharedSecret: storedSecret,
      method: req.method.toUpperCase(),
      path: new URL(req.url).pathname + new URL(req.url).search,
      timestamp,
      nonce,
      bodyHash,
      signature,
    })
  ) {
    return false;
  }

  seenPeerNonces.set(nonceKey, now + PEER_AUTH_MAX_SKEW_MS);
  trustStore.updatePeerLastSeen(instanceId);
  return true;
}

function toLayerPath(contextFilePath: string): string {
  const layerPath = path.dirname(contextFilePath);
  return layerPath === '.' ? '' : layerPath;
}

async function sendPairingSecretToPeer(
  peerInstanceId: string,
  sharedSecret: string,
  callbackToken: string,
  ctx: DiscoveryRouteContext,
): Promise<void> {
  const discoveredPeer = ctx.discovery?.getPeers().get(peerInstanceId);
  if (!discoveredPeer) {
    throw new Error(`Peer ${peerInstanceId} is not currently discoverable`);
  }

  const client = new PeerClient(
    discoveredPeer.host,
    discoveredPeer.port,
    ctx.instanceId,
  );
  await client.completePairing(
    sharedSecret,
    ctx.instanceId,
    ctx.instanceName,
    callbackToken,
  );
}
