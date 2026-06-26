import { createHash } from 'crypto';

import { ServerSentEventGenerator } from '@starfederation/datastar-sdk/web';

import { logger } from '../logger.js';
import { readRequestBody, RequestBodyTooLargeError } from '../request-body.js';
import {
  handleRequest,
  getRemotePeers,
  createRemotePeerResolver,
} from './routes.js';
import type { ScheduledTask } from '../types.js';
import { escapeHtml, renderPagePatch } from './shared.js';
import type { WebServerConfig, WebStateProvider, WsEvent } from './types.js';
import {
  createSessionStore,
  parseSessionCookie,
  makeSessionCookie,
  makeClearSessionCookie,
  verifyPassword,
  isAuthExemptPath,
  renderLoginPage,
  type SessionStore,
} from './session-auth.js';
import { createRateLimiter, type RateLimiter } from './rate-limit.js';
import {
  renderAgentDetailContent,
  buildAgentDetailData,
} from './agent-detail.js';
import {
  formatDashboardActiveTasksValue,
  renderDashboardContent,
} from './dashboard.js';
import { renderConversationsContent } from './conversations.js';
import { renderContextViewerContent } from './context-viewer.js';
import { renderIpcInspectorContent } from './ipc-inspector.js';
import {
  formatTrustedStatValue,
  renderNetworkContent,
  renderPeerRows,
  renderPendingRequests,
  type NetworkPageState,
} from './network.js';
import { checkPeerAuth } from '../discovery/routes.js';
import type { TrustStore } from '../discovery/trust-store.js';
import { serializeLogRecord } from './log-stream.js';
import { renderSystemContent } from './system.js';
import { renderSettingsContent } from './settings.js';
import { renderTasksContent } from './tasks.js';
import { renderLogsContent } from './logs.js';
import { renderAgentsContent, buildAgentRowsHtml } from './agents-page.js';
import {
  initSolidHandler,
  getSolidHandler,
  isMainProcessRoute,
} from './solid-handler.js';

const MAX_SSE_CLIENTS = 100;
const MAX_LOG_LINES = 500;
const SNAPSHOT_INTERVAL_MS = 5000;
const PORT_ZERO_RETRY_ATTEMPTS = 10;
const PORT_ZERO_FALLBACK_START = 40000;
const PORT_ZERO_FALLBACK_SPAN = 20000;
const MAX_PEER_AUTH_BODY_BYTES = 1024 * 1024;
const MAX_LOGIN_BODY_BYTES = 1024 * 1024;

interface RequestBodyHashResult {
  hash: string;
  exceededLimit: boolean;
}

interface SseClient {
  subscriptions: Set<string>;
  stream: ServerSentEventGenerator;
  logs: string[];
  logsDirty: boolean;
  close(): void;
}

/** JSON SSE client for SolidStart mode — sends raw JSON events. */
interface JsonSseClient {
  controller: ReadableStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
  closed: boolean;
  close(): void;
}

function isAddrInUseError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'EADDRINUSE'
  );
}

function randomFallbackPort(): number {
  return (
    PORT_ZERO_FALLBACK_START +
    Math.floor(Math.random() * PORT_ZERO_FALLBACK_SPAN)
  );
}

async function hashRequestBodyWithLimit(
  req: Request,
  maxBytes: number,
): Promise<RequestBodyHashResult> {
  const contentLength = Number.parseInt(
    req.headers.get('content-length') || '',
    10,
  );
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return {
      // Placeholder; callers reject over-limit requests before using the hash.
      hash: createHash('sha256').update('').digest('hex'),
      exceededLimit: true,
    };
  }

  const cloned = req.clone();
  const hash = createHash('sha256');
  if (!cloned.body) {
    return {
      hash: hash.update('').digest('hex'),
      exceededLimit: false,
    };
  }

  const reader = cloned.body.getReader();
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel('Peer-auth body exceeded size limit');
        } catch {
          // Ignore cancellation failures; the caller only needs the limit signal.
        }
        return {
          // Placeholder; callers reject over-limit requests before using the hash.
          hash: createHash('sha256').update('').digest('hex'),
          exceededLimit: true,
        };
      }

      hash.update(value);
    }
  } finally {
    reader.releaseLock();
  }

  return {
    hash: hash.digest('hex'),
    exceededLimit: false,
  };
}

/**
 * Start the OmniClaw web UI server.
 *
 * Returns a handle to broadcast events and shut down.
 */
export function startWebServer(
  config: WebServerConfig,
  state: WebStateProvider,
  trustStore?: TrustStore,
): WebServerHandle {
  const {
    port,
    auth,
    sessionPassword,
    hostname,
    corsOrigin,
    trustLanDiscoveryAdmin,
  } = config;
  const sessionStore = sessionPassword ? createSessionStore() : null;
  const loginRateLimiter = sessionPassword ? createRateLimiter() : null;
  const bindHostname = hostname || '127.0.0.1';
  const sseClients = new Set<SseClient>();
  const recentLogs: string[] = [];
  const solidMode = process.env.WEB_UI_SOLID === 'true';
  /** JSON-only SSE clients used in SolidStart mode. */
  const jsonSseClients = new Set<JsonSseClient>();
  let rawLogStreamClients = 0;
  const subscribeToRawLogs =
    typeof logger.subscribe === 'function'
      ? logger.subscribe.bind(logger)
      : null;

  // Initialize SolidStart handler if enabled.
  // Store the promise so the first proxied request can await it.
  const solidReady = solidMode ? initSolidHandler(state) : null;

  const fetchHandler = async (req: Request, bunServer: Bun.Server<unknown>) => {
    const url = new URL(req.url);
    const resolveRemotePeers = createRemotePeerResolver(getRemotePeers);
    if (url.pathname === '/ws') {
      return new Response('WebSocket is deprecated for the web dashboard', {
        status: 410,
        headers: corsOrigin ? makeCorsHeaders(corsOrigin) : {},
      });
    }

    // --- Peer auth: trusted remote OmniClaw instances bypass Basic Auth ---
    const isPeerRequest =
      isPeerRoute(url.pathname) && req.headers.has('X-OmniClaw-Instance');
    if (isPeerRequest && trustStore) {
      // Read the body from a clone so checkPeerAuth can verify the claimed
      // body hash against the bytes actually received without consuming the
      // original request stream that downstream handlers still need.
      const bodyHashResult = await hashRequestBodyWithLimit(
        req,
        MAX_PEER_AUTH_BODY_BYTES,
      );
      if (bodyHashResult.exceededLimit) {
        return new Response('Peer request body too large', {
          status: 413,
          headers: corsOrigin ? makeCorsHeaders(corsOrigin) : {},
        });
      }
      if (!checkPeerAuth(req, trustStore, bodyHashResult.hash)) {
        return new Response('Unauthorized peer', {
          status: 403,
          headers: corsOrigin ? makeCorsHeaders(corsOrigin) : {},
        });
      }
      // Peer is authenticated — skip auth, fall through to routing
    } else if (sessionStore && sessionPassword) {
      // --- Session-based auth (WEB_PASSWORD) ---
      // Handle login/logout before checking session
      if (url.pathname === '/login') {
        const clientIp = bunServer.requestIP(req)?.address ?? 'unknown';

        if (req.method === 'GET') {
          const blocked = loginRateLimiter?.isBlocked(clientIp);
          return new Response(
            renderLoginPage(
              blocked
                ? 'Too many failed attempts. Please try again later.'
                : undefined,
            ),
            {
              status: blocked ? 429 : 200,
              headers: {
                'Content-Type': 'text/html; charset=utf-8',
                ...(blocked
                  ? {
                      'Retry-After': String(
                        loginRateLimiter!.retryAfter(clientIp),
                      ),
                    }
                  : {}),
              },
            },
          );
        }
        if (req.method === 'POST') {
          // Reject if rate-limited before doing any password work.
          if (loginRateLimiter?.isBlocked(clientIp)) {
            const retryAfter = loginRateLimiter.retryAfter(clientIp);
            return new Response(
              renderLoginPage(
                'Too many failed attempts. Please try again later.',
              ),
              {
                status: 429,
                headers: {
                  'Content-Type': 'text/html; charset=utf-8',
                  'Retry-After': String(retryAfter),
                },
              },
            );
          }

          let rawBody: string;
          try {
            rawBody = await readRequestBody(req, MAX_LOGIN_BODY_BYTES);
          } catch (err) {
            if (err instanceof RequestBodyTooLargeError) {
              return new Response('Request body too large', {
                status: 413,
                headers: { 'Content-Type': 'text/plain' },
              });
            }

            return new Response('Bad request', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            });
          }

          const password = new URLSearchParams(rawBody).get('password');
          if (
            typeof password === 'string' &&
            verifyPassword(password, sessionPassword)
          ) {
            // Successful login — clear any failure history for this IP.
            loginRateLimiter?.reset(clientIp);
            const token = sessionStore.create();
            return new Response(null, {
              status: 302,
              headers: {
                Location: '/',
                'Set-Cookie': makeSessionCookie(token),
              },
            });
          }

          // Failed login — record the attempt.
          loginRateLimiter?.recordFailure(clientIp);
          return new Response(renderLoginPage('Invalid password'), {
            status: 401,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
      }
      if (url.pathname === '/logout') {
        const sessionToken = parseSessionCookie(req.headers.get('Cookie'));
        if (sessionToken) sessionStore.revoke(sessionToken);
        return new Response(null, {
          status: 302,
          headers: {
            Location: '/login',
            'Set-Cookie': makeClearSessionCookie(),
          },
        });
      }
      // Check session cookie for all other routes
      const sessionToken = parseSessionCookie(req.headers.get('Cookie'));
      if (!sessionToken || !sessionStore.validate(sessionToken)) {
        // API routes return 401 JSON; page routes redirect to login
        if (url.pathname.startsWith('/api/')) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(null, {
          status: 302,
          headers: { Location: '/login' },
        });
      }
    } else if (auth && !checkBasicAuth(req, auth)) {
      // --- Basic auth for HTTP ---
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="OmniClaw"' },
      });
    } else if (
      !auth &&
      !sessionPassword &&
      url.pathname.startsWith('/api/discovery/') &&
      !isUnauthDiscoveryRoute(url.pathname) &&
      !isTrustedLanDiscoveryAdminRequest(
        req,
        url.pathname,
        bindHostname,
        // When no auth is configured, implicitly trust private-network requests
        // so WiFi-based discovery works out of the box without WEB_UI_USER/WEB_UI_PASS.
        true, // no auth configured → implicitly trust private network
      )
    ) {
      // Discovery admin routes from the public internet MUST have auth.
      // Private-network requests (loopback, LAN) are allowed without credentials.
      return new Response(
        JSON.stringify({
          error:
            'Discovery admin routes require authentication (set WEB_PASSWORD or WEB_UI_USER/WEB_UI_PASS or access from a private network)',
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    // --- SolidStart mode: JSON SSE + delegate to SolidStart handler ---
    if (solidMode && url.pathname === '/api/events') {
      if (req.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: {
            'Content-Type': 'application/json',
            ...(corsOrigin ? makeCorsHeaders(corsOrigin) : {}),
          },
        });
      }
      if (jsonSseClients.size >= MAX_SSE_CLIENTS) {
        return new Response('Too many SSE connections', {
          status: 429,
          headers: corsOrigin ? makeCorsHeaders(corsOrigin) : {},
        });
      }

      let jsonClient: JsonSseClient | undefined;
      const encoder = new TextEncoder();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(': connected\n\n'));
          // Send initial connected event
          controller.enqueue(
            encoder.encode(
              `event: connected\ndata: ${JSON.stringify({ status: 'connected' })}\n\n`,
            ),
          );

          jsonClient = {
            controller,
            encoder,
            closed: false,
            close() {
              if (this.closed) return;
              this.closed = true;
              try {
                controller.close();
              } catch {
                // already closed
              }
            },
          };
          jsonSseClients.add(jsonClient);
          logger.debug(
            { jsonSseClients: jsonSseClients.size },
            'JSON SSE client connected',
          );
        },
        cancel() {
          if (jsonClient) {
            jsonClient.closed = true;
            jsonSseClients.delete(jsonClient);
            logger.debug(
              { jsonSseClients: jsonSseClients.size },
              'JSON SSE client disconnected',
            );
          }
        },
      });

      req.signal.addEventListener(
        'abort',
        () => {
          if (jsonClient) {
            jsonClient.close();
            jsonSseClients.delete(jsonClient);
          }
        },
        { once: true },
      );

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
          ...(corsOrigin ? makeCorsHeaders(corsOrigin) : {}),
        },
      });
    }

    // In SolidStart mode, delegate non-SSE routes to the SolidStart handler
    if (solidMode && !isMainProcessRoute(url.pathname)) {
      if (solidReady) await solidReady;
      const handler = getSolidHandler();
      if (handler) {
        const response = await handler(req);
        if (corsOrigin && url.pathname.startsWith('/api/')) {
          for (const [k, v] of Object.entries(makeCorsHeaders(corsOrigin))) {
            response.headers.set(k, v);
          }
        }
        return response;
      }
      // Fall through to Datastar UI if SolidStart handler not ready
    }

    if (url.pathname === '/api/logs/stream') {
      if (req.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: {
            'Content-Type': 'application/json',
            ...(corsOrigin ? makeCorsHeaders(corsOrigin) : {}),
          },
        });
      }
      if (rawLogStreamClients >= MAX_SSE_CLIENTS) {
        return new Response('Too many SSE connections', {
          status: 429,
          headers: corsOrigin ? makeCorsHeaders(corsOrigin) : {},
        });
      }

      let unsubscribe: (() => void) | undefined;
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (rawLogStreamClients > 0) rawLogStreamClients -= 1;
        unsubscribe?.();
        unsubscribe = undefined;
      };

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          rawLogStreamClients += 1;
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(': connected\n\n'));
          unsubscribe = subscribeToRawLogs?.((record) => {
            if (record.level === 'trace') return;
            try {
              controller.enqueue(
                encoder.encode(
                  `event: log\ndata: ${JSON.stringify(serializeLogRecord(record))}\n\n`,
                ),
              );
            } catch {
              cleanup();
              controller.close();
            }
          });
        },
        cancel() {
          cleanup();
        },
      });

      req.signal.addEventListener(
        'abort',
        () => {
          cleanup();
        },
        { once: true },
      );

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
          ...(corsOrigin ? makeCorsHeaders(corsOrigin) : {}),
        },
      });
    }

    // --- SSE stream ---
    if (url.pathname === '/api/events') {
      if (req.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: {
            'Content-Type': 'application/json',
            ...(corsOrigin ? makeCorsHeaders(corsOrigin) : {}),
          },
        });
      }
      if (sseClients.size >= MAX_SSE_CLIENTS) {
        return new Response('Too many SSE connections', {
          status: 429,
          headers: corsOrigin ? makeCorsHeaders(corsOrigin) : {},
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

      let client: SseClient | undefined;
      const cleanup = () => {
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

      const responseInit = {
        headers: {
          ...(corsOrigin ? makeCorsHeaders(corsOrigin) : {}),
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      };

      return ServerSentEventGenerator.stream(
        (stream) => {
          const nextClient: SseClient = {
            subscriptions,
            stream,
            logs: recentLogs.slice(),
            logsDirty: subscriptions.has('logs'),
            close() {
              stream.close();
            },
          };

          client = nextClient;
          sseClients.add(nextClient);
          logger.debug({ sseClients: sseClients.size }, 'SSE client connected');

          stream.patchElements(renderStatusBadge('connected', 'connected'));
          patchSnapshot(nextClient, state);
        },
        {
          keepalive: true,
          onAbort: cleanup,
          responseInit,
        },
      );
    }

    // --- SPA page navigation via SSE ---
    if (url.pathname.startsWith('/api/page/')) {
      const pageName = url.pathname.slice('/api/page/'.length);
      const pageRenderers: Record<
        string,
        {
          path: string;
          title: string;
          render: () => string | Promise<string>;
        }
      > = {
        dashboard: {
          path: '/',
          title: 'Dashboard',
          render: async () =>
            renderDashboardContent(state, await resolveRemotePeers()),
        },
        agents: {
          path: '/agents-list',
          title: 'Agents',
          render: async () =>
            renderAgentsContent(state, await resolveRemotePeers()),
        },
        conversations: {
          path: '/conversations',
          title: 'Conversations',
          render: () => renderConversationsContent(state),
        },
        context: {
          path: '/context',
          title: 'Context',
          render: async () =>
            renderContextViewerContent(state, await resolveRemotePeers()),
        },
        ipc: {
          path: '/ipc',
          title: 'IPC Inspector',
          render: () => renderIpcInspectorContent(state),
        },
        network: {
          path: '/network',
          title: 'Network',
          render: () =>
            renderNetworkContent(
              networkPageStateGetter?.() ?? {
                instanceId: '',
                instanceName: '',
                discoveryAvailable: false,
                discoveryEnabled: false,
                runtime: {
                  enabled: false,
                  active: false,
                  currentNetwork: null,
                  trustedNetworks: [],
                },
                peers: [],
                pendingRequests: [],
              },
            ),
        },
        tasks: {
          path: '/tasks',
          title: 'Tasks',
          render: () => renderTasksContent(state),
        },
        logs: {
          path: '/logs',
          title: 'Logs',
          render: () => renderLogsContent(state),
        },
        system: {
          path: '/system',
          title: 'System',
          render: () => renderSystemContent(state, sseClients.size),
        },
        settings: {
          path: '/settings',
          title: 'Settings',
          render: () => renderSettingsContent(),
        },
      };

      // Handle parametric pages (e.g., agent-detail?id=xxx)
      if (pageName === 'agent-detail') {
        const agentId = url.searchParams.get('id') || '';
        const data = buildAgentDetailData(
          agentId,
          state,
          await resolveRemotePeers(),
        );
        const title = data ? data.name : 'Agent Not Found';
        const qs = agentId ? `?id=${encodeURIComponent(agentId)}` : '';
        return ServerSentEventGenerator.stream(
          (stream) => {
            stream.patchElements(
              renderPagePatch(
                `/agents${qs}`,
                title,
                renderAgentDetailContent(data, agentId),
              ),
            );
          },
          {
            responseInit: {
              headers: {
                ...(corsOrigin ? makeCorsHeaders(corsOrigin) : {}),
                'Cache-Control': 'no-cache, no-transform',
                'X-Accel-Buffering': 'no',
              },
            },
          },
        );
      }

      const page = pageRenderers[pageName];
      if (!page) {
        return new Response(JSON.stringify({ error: 'Unknown page' }), {
          status: 404,
          headers: {
            'Content-Type': 'application/json',
            ...(corsOrigin ? makeCorsHeaders(corsOrigin) : {}),
          },
        });
      }

      const html = await page.render();
      return ServerSentEventGenerator.stream(
        (stream) => {
          stream.patchElements(renderPagePatch(page.path, page.title, html));
        },
        {
          responseInit: {
            headers: {
              ...(corsOrigin ? makeCorsHeaders(corsOrigin) : {}),
              'Cache-Control': 'no-cache, no-transform',
              'X-Accel-Buffering': 'no',
            },
          },
        },
      );
    }

    // --- CORS preflight (only when corsOrigin is configured) ---
    if (req.method === 'OPTIONS' && corsOrigin) {
      return new Response(null, {
        status: 204,
        headers: makeCorsHeaders(corsOrigin),
      });
    }

    const result = handleRequest(req, state, sseClients.size);
    // handleRequest may return a Promise (for POST/PATCH with body parsing)
    const addCors = (response: Response) => {
      if (corsOrigin && url.pathname.startsWith('/api/')) {
        for (const [k, v] of Object.entries(makeCorsHeaders(corsOrigin))) {
          response.headers.set(k, v);
        }
      }
      return response;
    };
    if (result instanceof Promise) {
      return result.then(addCors);
    }
    return addCors(result);
  };

  let server: Bun.Server<unknown>;
  let requestedPort = port;
  let attempts = 0;
  while (true) {
    try {
      server = Bun.serve({
        port: requestedPort,
        hostname: bindHostname,
        development: false,
        fetch: fetchHandler,
      });
      break;
    } catch (err) {
      attempts += 1;
      if (
        port !== 0 ||
        !isAddrInUseError(err) ||
        attempts >= PORT_ZERO_RETRY_ATTEMPTS
      ) {
        throw err;
      }
      requestedPort = randomFallbackPort();
    }
  }

  const snapshotTicker = setInterval(() => {
    for (const client of sseClients) {
      try {
        patchSnapshot(client, state);
      } catch {
        client.close();
        sseClients.delete(client);
      }
    }
  }, SNAPSHOT_INTERVAL_MS);

  logger.info(
    {
      port: server.port!,
      hostname: bindHostname,
      cors: corsOrigin || 'disabled',
    },
    'Web UI server started',
  );

  const handle: WebServerHandle = {
    port: server.port!,
    broadcast(event: WsEvent) {
      const channel = eventChannel(event);

      for (const client of sseClients) {
        if (!client.subscriptions.has(channel)) continue;
        try {
          if (event.type === 'log') {
            const logHtml = renderLogLine(event.data);
            recentLogs.push(logHtml);
            if (recentLogs.length > MAX_LOG_LINES) {
              recentLogs.splice(0, recentLogs.length - MAX_LOG_LINES);
            }
            client.logs.push(logHtml);
            if (client.logs.length > MAX_LOG_LINES) {
              client.logs.splice(0, client.logs.length - MAX_LOG_LINES);
            }
            client.logsDirty = true;
            client.stream.patchElements(client.logs.join(''), {
              selector: '#log-container',
              mode: 'inner',
            });
            client.stream.patchElements(
              `<span class="log-count" id="log-count">${client.logs.length} lines</span>`,
            );
            // Also append to the full-page logs viewer (if present)
            client.stream.patchElements(logHtml, {
              selector: '#logs-output',
              mode: 'append',
            });
            continue;
          }

          if (event.type === 'agent_status') {
            patchStats(client, state);
            patchAgentsPage(client, state);
            continue;
          }

          if (event.type === 'task_update') {
            patchTasks(client, state);
            patchStats(client, state);
            continue;
          }

          if (channel === 'network') {
            patchNetwork(client);
            continue;
          }
        } catch {
          client.close();
          sseClients.delete(client);
        }
      }

      // JSON SSE broadcast for SolidStart mode
      if (solidMode) {
        const jsonPayload = JSON.stringify(event.data);
        for (const client of jsonSseClients) {
          if (client.closed) {
            jsonSseClients.delete(client);
            continue;
          }
          try {
            client.controller.enqueue(
              client.encoder.encode(
                `event: ${event.type}\ndata: ${jsonPayload}\n\n`,
              ),
            );
          } catch {
            client.close();
            jsonSseClients.delete(client);
          }
        }
      }
    },
    async stop() {
      clearInterval(snapshotTicker);
      loginRateLimiter?.dispose();
      for (const client of sseClients) {
        client.close();
      }
      sseClients.clear();
      for (const client of jsonSseClients) {
        client.close();
      }
      jsonSseClients.clear();
      server.stop(true);
      logger.info('Web UI server stopped');
    },
    get clientCount() {
      return sseClients.size + jsonSseClients.size;
    },
    setNetworkPageState(getter: () => NetworkPageState) {
      networkPageStateGetter = getter;
    },
  };

  return handle;
}

export interface WebServerHandle {
  port: number;
  broadcast(event: WsEvent): void;
  stop(): Promise<void>;
  readonly clientCount: number;
  /** Set the network page state getter (called after discovery is initialized). */
  setNetworkPageState(getter: () => NetworkPageState): void;
}

/** Network page state getter — set after discovery is initialized. */
let networkPageStateGetter: (() => NetworkPageState) | null = null;

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

function makeCorsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
}

function eventChannel(event: WsEvent): string {
  if (event.type === 'log') return 'logs';
  if (event.type === 'agent_status' || event.type === 'task_update') {
    return 'stats';
  }
  if (event.type === 'new_message') return 'messages';
  if (
    event.type === 'peer_discovered' ||
    event.type === 'peer_lost' ||
    event.type === 'pair_request' ||
    event.type === 'pair_approved'
  ) {
    return 'network';
  }
  return event.type;
}

function isPeerRoute(pathname: string): boolean {
  return (
    pathname === '/api/agents' ||
    pathname === '/api/logs/stream' ||
    pathname === '/api/stats' ||
    pathname === '/api/context/files' ||
    pathname === '/api/context/layers' ||
    pathname === '/api/context/file'
  );
}

/** Discovery routes that intentionally allow unauthenticated access. */
function isUnauthDiscoveryRoute(pathname: string): boolean {
  return (
    pathname === '/api/discovery/info' ||
    pathname === '/api/discovery/pair' ||
    pathname === '/api/discovery/complete-pairing'
  );
}

export function isTrustedLanDiscoveryAdminRequest(
  req: Request,
  pathname: string,
  listenerHostname: string | undefined,
  enabled: boolean | undefined,
): boolean {
  if (!enabled || !pathname.startsWith('/api/discovery/')) return false;
  if (isUnauthDiscoveryRoute(pathname)) return false;

  const remoteAddress = (
    req as unknown as { socket?: { remoteAddress?: string } }
  ).socket?.remoteAddress;

  // Auth bypass must key off the actual peer address. The listener hostname is
  // the server's own bind target, not a property of the client request.
  if (remoteAddress) {
    return isLoopbackOrPrivateAddress(remoteAddress);
  }

  // Bun may not always expose a socket address in tests or some deployments.
  // Preserve the loopback-only fallback for local-only listeners.
  return isLoopbackAddress(listenerHostname);
}

function isLoopbackAddress(address?: string): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();

  return (
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1' ||
    normalized === 'localhost' ||
    normalized.startsWith('127.')
  );
}

function isLoopbackOrPrivateAddress(address?: string): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();

  if (isLoopbackAddress(normalized)) return true;

  const ipv4 = normalized.startsWith('::ffff:')
    ? normalized.slice('::ffff:'.length)
    : normalized;

  if (/^10\./.test(ipv4)) return true;
  if (/^192\.168\./.test(ipv4)) return true;

  const match172 = ipv4.match(/^172\.(\d{1,3})\./);
  if (match172) {
    const octet = Number.parseInt(match172[1], 10);
    if (octet >= 16 && octet <= 31) return true;
  }

  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe80:')) return true;

  return false;
}

function patchSnapshot(client: SseClient, state: WebStateProvider): void {
  patchStats(client, state);
  patchAgents(client, state);
  patchAgentsPage(client, state);
  patchTasks(client, state);
  patchLogs(client);
}

function patchLogs(client: SseClient): void {
  if (!client.subscriptions.has('logs') || !client.logsDirty) return;
  client.logsDirty = false;
  client.stream.patchElements(
    `<span class="log-count" id="log-count">${client.logs.length} lines</span>`,
  );
  if (client.logs.length === 0) return;
  client.stream.patchElements(client.logs.join(''), {
    selector: '#log-container',
    mode: 'inner',
  });
}

function patchStats(client: SseClient, state: WebStateProvider): void {
  if (!client.subscriptions.has('stats')) return;
  const stats = state.getQueueStats();
  const activeContainers = Math.max(
    0,
    stats.activeContainers - stats.idleContainers,
  );

  client.stream.patchElements(
    `<div class="value" id="stat-agents">${Object.keys(state.getAgents()).length}</div>`,
  );
  client.stream.patchElements(
    `<div class="value" id="stat-active">${activeContainers}/${stats.maxActive}</div>`,
  );
  client.stream.patchElements(
    `<div class="value" id="stat-idle">${stats.idleContainers}/${stats.maxIdle}</div>`,
  );
  client.stream.patchElements(
    `<div class="value" id="stat-tasks">${formatDashboardActiveTasksValue(state)}</div>`,
  );
}

function patchAgents(client: SseClient, state: WebStateProvider): void {
  if (!client.subscriptions.has('agents')) return;
  client.stream.patchElements(renderAgentRows(state), {
    selector: '#agents-tbody',
    mode: 'inner',
  });
}

function patchAgentsPage(client: SseClient, state: WebStateProvider): void {
  if (!client.subscriptions.has('agents')) return;
  client.stream.patchElements(buildAgentRowsHtml(state), {
    selector: '#ap-tbody',
    mode: 'inner',
  });
}

function patchTasks(client: SseClient, state: WebStateProvider): void {
  if (
    !client.subscriptions.has('tasks') &&
    !client.subscriptions.has('stats')
  ) {
    return;
  }
  client.stream.patchElements(renderTaskRows(state.getTasks()), {
    selector: '#sidebar-tasks',
    mode: 'inner',
  });
}

function patchNetwork(client: SseClient): void {
  if (!client.subscriptions.has('network') || !networkPageStateGetter) return;
  const pageState = networkPageStateGetter();
  client.stream.patchElements(renderPeerRows(pageState.peers), {
    selector: '#peers-tbody',
    mode: 'inner',
  });
  client.stream.patchElements(
    renderPendingRequests(pageState.pendingRequests),
    {
      selector: '#pending-requests',
      mode: 'inner',
    },
  );
  client.stream.patchElements(
    `<div class="value" id="stat-peers-online">${pageState.peers.filter((peer) => peer.online).length}</div>`,
  );
  client.stream.patchElements(
    `<div class="value" id="stat-peers-trusted">${formatTrustedStatValue(pageState.peers)}</div>`,
  );
  client.stream.patchElements(
    `<span class="badge" id="pending-count">${pageState.pendingRequests.length}</span>`,
  );
}

function renderStatusBadge(
  label: string,
  statusClass: 'connected' | 'disconnected',
): string {
  return `<span id="ws-status" class="ws-status ${statusClass}">${escapeHtml(label)}</span>`;
}

function renderAgentRows(state: WebStateProvider): string {
  const agents = Object.values(state.getAgents());
  const subs = state.getChannelSubscriptions();
  return agents
    .map((agent) => {
      const channels = Object.entries(subs)
        .filter(([, subscriptions]) =>
          subscriptions.some((sub) => sub.agentId === agent.id),
        )
        .map(([jid]) => escapeHtml(jid));
      return `<tr>
        <td>${escapeHtml(agent.id)}</td>
        <td>${escapeHtml(agent.name)}</td>
        <td><span class="badge ${agent.backend === 'apple-container' ? 'badge-apple-container' : agent.backend === 'docker' ? 'badge-docker' : agent.backend === 'cursor-sdk' ? 'badge-cursor-sdk' : ''}">${escapeHtml(agent.backend)}</span></td>
        <td>${escapeHtml(agent.agentRuntime)}</td>
        <td>${agent.isAdmin ? '<span class="badge badge-admin">admin</span>' : ''}</td>
        <td class="channels">${channels.join('<br>') || '—'}</td>
      </tr>`;
    })
    .join('\n');
}

function renderTaskRows(tasks: ScheduledTask[]): string {
  return tasks
    .slice(0, 50)
    .map((task) => {
      const statusClass =
        task.status === 'active'
          ? 'status-active'
          : task.status === 'paused'
            ? 'status-paused'
            : 'status-completed';
      const toggleLabel = task.status === 'active' ? 'Pause' : 'Resume';
      const toggleStatus = task.status === 'active' ? 'paused' : 'active';
      const agentShort = task.group_folder.split('-')[0] || task.group_folder;
      const promptShort =
        task.prompt.slice(0, 40) + (task.prompt.length > 40 ? '…' : '');
      const lastRunInfo = task.last_run
        ? `<span class="task-last-run" title="Last run: ${escapeHtml(task.last_run)}">${escapeHtml(task.last_result ?? '—')}</span>`
        : '';
      return (
        `<div class="task-card" data-task-id="${escapeHtml(task.id)}">` +
        `<div class="task-top"><span class="badge ${statusClass}">${escapeHtml(task.status)}</span>` +
        `<span class="task-agent">${escapeHtml(agentShort)}</span>` +
        `<span class="task-sched">${escapeHtml(task.schedule_value)}</span></div>` +
        `<div class="task-prompt" title="${escapeHtml(task.prompt)}">${escapeHtml(promptShort)}</div>` +
        (lastRunInfo
          ? `<div class="task-last-run-row">${lastRunInfo}</div>`
          : '') +
        `<div class="task-actions">` +
        `<button class="btn btn-sm btn-toggle" data-action="toggle" data-status="${toggleStatus}">${toggleLabel}</button>` +
        `<button class="btn btn-sm" data-action="runs">Runs</button>` +
        `<button class="btn btn-sm btn-danger" data-action="delete">Del</button>` +
        `</div>` +
        `<div class="task-runs" style="display:none"></div>` +
        `</div>`
      );
    })
    .join('\n');
}

function renderLogLine(data: unknown): string {
  const log = (data ?? {}) as Record<string, unknown>;
  const level = String(log.level ?? 'info');
  const lineClass =
    level === 'error' || level === 'fatal'
      ? 'log-line error'
      : level === 'warn'
        ? 'log-line warn'
        : 'log-line';
  const timestamp = new Date(
    typeof log.ts === 'number' ? log.ts : Date.now(),
  ).toLocaleTimeString();
  const context = log.container || log.group;
  let message = String(log.msg ?? '');
  if (typeof log.durationMs === 'number') message += ` (${log.durationMs}ms)`;
  if (typeof log.costUsd === 'number') message += ` $${log.costUsd}`;

  return `<div class="${lineClass}" data-level="${escapeHtml(level)}" data-source="${escapeHtml(String(context || ''))}">
    <span class="ts">${escapeHtml(timestamp)}</span>
    <span class="level-badge ${escapeHtml(level)}">${escapeHtml(level)}</span>
    ${context ? `<span class="context">${escapeHtml(String(context))}</span>` : ''}
    ${log.op ? `<span class="op">[${escapeHtml(String(log.op))}]</span>` : ''}
    <span class="msg">${escapeHtml(message)}</span>
    ${log.err ? `<span class="err-detail">${escapeHtml(String(log.err))}</span>` : ''}
  </div>`;
}
