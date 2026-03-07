import type { Server, ServerWebSocket } from 'bun';

import { logger } from '../logger.js';
import { handleRequest } from './routes.js';
import type {
  WebServerConfig,
  WebStateProvider,
  WsData,
  WsEvent,
} from './types.js';

const MAX_WS_CLIENTS = 50;
const MAX_SSE_CLIENTS = 100;

interface SseClient {
  subscriptions: Set<string>;
  send(payload: string): void;
  close(): void;
}

/**
 * Start the OmniClaw web UI server.
 *
 * Returns a handle to broadcast events and shut down.
 */
export function startWebServer(
  config: WebServerConfig,
  state: WebStateProvider,
): WebServerHandle {
  const { port, auth } = config;
  const wsClients = new Set<ServerWebSocket<WsData>>();
  const sseClients = new Set<SseClient>();
  const encoder = new TextEncoder();

  const server: Server<WsData> = Bun.serve<WsData>({
    port,
    development: false,

    fetch(req, server) {
      // --- WebSocket upgrade ---
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        // Auth check for WebSocket too
        if (auth && !checkBasicAuth(req, auth)) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="OmniClaw"' },
          });
        }
        if (wsClients.size >= MAX_WS_CLIENTS) {
          return new Response('Too many WebSocket connections', {
            status: 429,
          });
        }
        const upgraded = server.upgrade(req, {
          data: { subscriptions: new Set<string>() },
        });
        if (upgraded) return undefined as unknown as Response;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      // --- Basic auth for HTTP ---
      if (auth && !checkBasicAuth(req, auth)) {
        return new Response('Unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="OmniClaw"' },
        });
      }

      // --- SSE stream ---
      if (url.pathname === '/api/events') {
        if (req.method !== 'GET') {
          return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders(),
            },
          });
        }
        if (sseClients.size >= MAX_SSE_CLIENTS) {
          return new Response('Too many SSE connections', {
            status: 429,
            headers: corsHeaders(),
          });
        }

        const queryChannels =
          url.searchParams
            .get('channels')
            ?.split(',')
            .map((ch) => ch.trim())
            .filter((ch) => ch.length > 0) ?? [];
        const subscriptions = new Set<string>(
          queryChannels.length > 0 ? queryChannels : ['logs', 'stats'],
        );

        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let client: SseClient | undefined;
        const cleanup = () => {
          if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = undefined;
          }
          if (!client) return;
          const removed = sseClients.delete(client);
          if (removed) {
            logger.debug(
              { sseClients: sseClients.size },
              'SSE client disconnected',
            );
          }
          client = undefined;
        };

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const nextClient: SseClient = {
              subscriptions,
              send(payload: string) {
                controller.enqueue(encoder.encode(payload));
              },
              close() {
                try {
                  controller.close();
                } catch {
                  // Stream already closed.
                }
              },
            };
            client = nextClient;

            sseClients.add(nextClient);
            logger.debug(
              { sseClients: sseClients.size },
              'SSE client connected',
            );

            nextClient.send('event: connected\ndata: {"ok":true}\n\n');
            heartbeat = setInterval(() => {
              nextClient.send(': keepalive\n\n');
            }, 15000);

            req.signal.addEventListener('abort', () => {
              const currentClient = client;
              cleanup();
              currentClient?.close();
            });
          },
          cancel() {
            cleanup();
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            ...corsHeaders(),
          },
        });
      }

      // --- CORS for API routes ---
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(),
        });
      }

      const result = handleRequest(req, state);
      // handleRequest may return a Promise (for POST/PATCH with body parsing)
      const addCors = (response: Response) => {
        if (url.pathname.startsWith('/api/')) {
          for (const [k, v] of Object.entries(corsHeaders())) {
            response.headers.set(k, v);
          }
        }
        return response;
      };
      if (result instanceof Promise) {
        return result.then(addCors);
      }
      return addCors(result);
    },

    websocket: {
      open(ws) {
        wsClients.add(ws);
        logger.debug(
          { wsClients: wsClients.size },
          'WebSocket client connected',
        );
      },
      message(ws, message) {
        try {
          const data = JSON.parse(String(message));
          if (data.subscribe && Array.isArray(data.subscribe)) {
            for (const channel of data.subscribe) {
              if (typeof channel === 'string') {
                ws.data.subscriptions.add(channel);
              }
            }
          }
        } catch {
          // Ignore malformed messages
        }
      },
      close(ws) {
        wsClients.delete(ws);
        logger.debug(
          { wsClients: wsClients.size },
          'WebSocket client disconnected',
        );
      },
    },
  });

  logger.info({ port, auth: !!auth }, 'Web UI server started');

  const handle: WebServerHandle = {
    port: server.port!,
    broadcast(event: WsEvent) {
      const payload = JSON.stringify(event);
      const channel = eventChannel(event);

      for (const ws of wsClients) {
        try {
          if (ws.data.subscriptions.has(channel)) {
            ws.send(payload);
          }
        } catch {
          // Client disconnected; will be cleaned up in close handler
        }
      }

      const ssePayload = `event: ${event.type}\ndata: ${payload}\n\n`;
      for (const client of sseClients) {
        if (!client.subscriptions.has(channel)) continue;
        try {
          client.send(ssePayload);
        } catch {
          client.close();
          sseClients.delete(client);
        }
      }
    },
    async stop() {
      for (const ws of wsClients) {
        ws.close(1001, 'Server shutting down');
      }
      wsClients.clear();
      for (const client of sseClients) {
        client.close();
      }
      sseClients.clear();
      server.stop(true);
      logger.info('Web UI server stopped');
    },
    get clientCount() {
      return wsClients.size;
    },
  };

  return handle;
}

export interface WebServerHandle {
  port: number;
  broadcast(event: WsEvent): void;
  stop(): Promise<void>;
  readonly clientCount: number;
}

// ---- Auth helpers ----

function checkBasicAuth(
  req: Request,
  expected: { username: string; password: string },
): boolean {
  const header = req.headers.get('Authorization');
  if (!header?.startsWith('Basic ')) return false;
  try {
    const decoded = atob(header.slice(6));
    const idx = decoded.indexOf(':');
    if (idx === -1) return false;
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    // Constant-time comparison for password (timing-safe)
    return (
      user === expected.username &&
      pass?.length === expected.password.length &&
      timingSafeEqual(pass, expected.password)
    );
  } catch {
    return false;
  }
}

/** Simple constant-time string comparison to prevent timing attacks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
}

function eventChannel(event: WsEvent): string {
  if (event.type === 'log') return 'logs';
  if (event.type === 'agent_status' || event.type === 'task_update') {
    return 'stats';
  }
  return event.type;
}
