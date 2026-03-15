import { createHash } from 'crypto';

import { ServerSentEventGenerator } from '@starfederation/datastar-sdk/web';

import { logger } from '../logger.js';
import { handleRequest, getRemotePeers } from './routes.js';
import type { ScheduledTask } from '../types.js';
import { escapeHtml, renderPagePatch } from './shared.js';
import type { WebServerConfig, WebStateProvider, WsEvent } from './types.js';
import {
  renderAgentDetailContent,
  buildAgentDetailData,
} from './agent-detail.js';
import { renderDashboardContent } from './dashboard.js';
import { renderConversationsContent } from './conversations.js';
import { renderContextViewerContent } from './context-viewer.js';
import { renderIpcInspectorContent } from './ipc-inspector.js';
import {
  renderNetworkContent,
  renderPeerRows,
  renderPendingRequests,
  type NetworkPageState,
} from './network.js';
import { checkPeerAuth } from '../discovery/routes.js';
import type { TrustStore } from '../discovery/trust-store.js';
import { serializeLogRecord } from './log-stream.js';
import { renderSystemContent } from './system.js';
import { renderTasksContent } from './tasks.js';

const MAX_SSE_CLIENTS = 100;
const MAX_LOG_LINES = 500;
const SNAPSHOT_INTERVAL_MS = 5000;
const PORT_ZERO_RETRY_ATTEMPTS = 10;
const PORT_ZERO_FALLBACK_START = 40000;
const PORT_ZERO_FALLBACK_SPAN = 20000;

interface SseClient {
  subscriptions: Set<string>;
  stream: ServerSentEventGenerator;
  logs: string[];
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
  const { port, auth, hostname, corsOrigin, trustLanDiscoveryAdmin } = config;
  const bindHostname = hostname || '127.0.0.1';
  const sseClients = new Set<SseClient>();
  let rawLogStreamClients = 0;
  const subscribeToRawLogs =
    typeof logger.subscribe === 'function'
      ? logger.subscribe.bind(logger)
      : null;
  const fetchHandler = async (req: Request) => {
    const url = new URL(req.url);
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
      // Read the raw body and compute its SHA-256 so checkPeerAuth can
      // verify the claimed X-OmniClaw-Body-SHA256 header matches the
      // bytes actually received. This prevents body-tampering attacks
      // where an on-path attacker modifies the body while keeping the
      // signed headers intact.
      const cloned = req.clone();
      const rawBody = await cloned.text();
      const computedBodyHash = createHash('sha256')
        .update(rawBody)
        .digest('hex');
      if (!checkPeerAuth(req, trustStore, computedBodyHash)) {
        return new Response('Unauthorized peer', {
          status: 403,
          headers: corsOrigin ? makeCorsHeaders(corsOrigin) : {},
        });
      }
      // Peer is authenticated — skip Basic Auth, fall through to routing
    } else if (auth && !checkBasicAuth(req, auth)) {
      // --- Basic auth for HTTP ---
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="OmniClaw"' },
      });
    } else if (
      !auth &&
      url.pathname.startsWith('/api/discovery/') &&
      !isUnauthDiscoveryRoute(url.pathname) &&
      !isTrustedLanDiscoveryAdminRequest(
        req,
        url.pathname,
        bindHostname,
        trustLanDiscoveryAdmin,
      )
    ) {
      // Discovery admin routes MUST have auth — reject if credentials not configured
      return new Response(
        JSON.stringify({
          error:
            'Discovery admin routes require WEB_UI_USER/WEB_UI_PASS to be configured',
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        },
      );
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
            logs: [],
            close() {
              stream.close();
            },
          };

          client = nextClient;
          sseClients.add(nextClient);
          logger.debug({ sseClients: sseClients.size }, 'SSE client connected');

          stream.patchElements(
            renderStatusBadge('connected (datastar)', 'connected'),
          );
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
            renderDashboardContent(state, await getRemotePeers()),
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
            renderContextViewerContent(state, await getRemotePeers()),
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
        system: {
          path: '/system',
          title: 'System',
          render: () => renderSystemContent(state, sseClients.size),
        },
      };

      // Handle parametric pages (e.g., agent-detail?id=xxx)
      if (pageName === 'agent-detail') {
        const agentId = url.searchParams.get('id') || '';
        const data = buildAgentDetailData(agentId, state);
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
            client.logs.push(renderLogLine(event.data));
            if (client.logs.length > MAX_LOG_LINES) {
              client.logs.splice(0, client.logs.length - MAX_LOG_LINES);
            }
            client.stream.patchElements(client.logs.join(''), {
              selector: '#log-container',
              mode: 'inner',
            });
            client.stream.patchElements(
              `<span class="log-count" id="log-count">${client.logs.length} lines</span>`,
            );
            continue;
          }

          if (event.type === 'agent_status') {
            patchStats(client, state);
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
    },
    async stop() {
      clearInterval(snapshotTicker);
      for (const client of sseClients) {
        client.close();
      }
      sseClients.clear();
      server.stop(true);
      logger.info('Web UI server stopped');
    },
    get clientCount() {
      return sseClients.size;
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

  // Only trust the actual socket peer or the configured listener host. URL/Host
  // are attacker-controlled and must not influence auth decisions.
  return (
    isLoopbackOrPrivateAddress(remoteAddress) ||
    isLoopbackOrPrivateAddress(listenerHostname)
  );
}

function isLoopbackOrPrivateAddress(address?: string): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();

  if (normalized === '::1' || normalized === '::ffff:127.0.0.1') return true;
  if (normalized === 'localhost') return true;
  if (normalized.startsWith('127.')) return true;

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
  patchTasks(client, state);
}

function patchStats(client: SseClient, state: WebStateProvider): void {
  if (!client.subscriptions.has('stats')) return;
  const stats = state.getQueueStats();
  const tasks = state.getTasks();
  const activeContainers = Math.max(
    0,
    stats.activeContainers - stats.idleContainers,
  );
  const activeTasks = tasks.filter((task) => task.status === 'active').length;

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
    `<div class="value" id="stat-tasks">${activeTasks}</div>`,
  );
}

function patchAgents(client: SseClient, state: WebStateProvider): void {
  if (!client.subscriptions.has('agents')) return;
  client.stream.patchElements(renderAgentRows(state), {
    selector: '#agents-tbody',
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
    `<div class="value" id="stat-peers-trusted">${pageState.peers.filter((peer) => peer.status === 'trusted').length}</div>`,
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
        <td><span class="badge ${agent.backend === 'apple-container' ? 'badge-apple-container' : agent.backend === 'docker' ? 'badge-docker' : ''}">${escapeHtml(agent.backend)}</span></td>
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

  return `<div class="${lineClass}" data-level="${escapeHtml(level)}">
    <span class="ts">${escapeHtml(timestamp)}</span>
    <span class="level-badge ${escapeHtml(level)}">${escapeHtml(level)}</span>
    ${context ? `<span class="context">${escapeHtml(String(context))}</span>` : ''}
    ${log.op ? `<span class="op">[${escapeHtml(String(log.op))}]</span>` : ''}
    <span class="msg">${escapeHtml(message)}</span>
    ${log.err ? `<span class="err-detail">${escapeHtml(String(log.err))}</span>` : ''}
  </div>`;
}
