import { ServerSentEventGenerator } from '@starfederation/datastar-sdk/web';

import { logger } from '../logger.js';
import { handleRequest } from './routes.js';
import type { ScheduledTask } from '../types.js';
import { escapeHtml, renderNavLinks } from './shared.js';
import type { WebServerConfig, WebStateProvider, WsEvent } from './types.js';
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

const MAX_SSE_CLIENTS = 100;
const MAX_LOG_LINES = 500;
const SNAPSHOT_INTERVAL_MS = 5000;

interface SseClient {
  subscriptions: Set<string>;
  stream: ServerSentEventGenerator;
  logs: string[];
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
  trustStore?: TrustStore,
): WebServerHandle {
  const { port, auth, hostname, corsOrigin } = config;
  const sseClients = new Set<SseClient>();

  const server = Bun.serve({
    port,
    hostname: hostname || '127.0.0.1',
    development: false,

    fetch(req) {
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
        if (!checkPeerAuth(req, trustStore)) {
          return new Response('Unauthorized peer', {
            status: 403,
            headers: corsOrigin ? makeCorsHeaders(corsOrigin) : {},
          });
        }
        // Peer is authenticated — skip Basic Auth, fall through to routing
      } else if (auth && !checkBasicAuth(req, auth)) {
        // --- Basic auth for HTTP (optional on trusted local setups) ---
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
            logger.debug(
              { sseClients: sseClients.size },
              'SSE client connected',
            );

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
          { path: string; title: string; render: () => string }
        > = {
          dashboard: {
            path: '/',
            title: 'Dashboard',
            render: () => renderDashboardContent(state),
          },
          conversations: {
            path: '/conversations',
            title: 'Conversations',
            render: () => renderConversationsContent(state),
          },
          context: {
            path: '/context',
            title: 'Context',
            render: () => renderContextViewerContent(state),
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
                  peers: [],
                  pendingRequests: [],
                },
              ),
          },
        };

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

        // JSON response for shell-script SPA navigation
        return new Response(
          JSON.stringify({
            html: page.render(),
            title: page.title,
            path: page.path,
          }),
          {
            headers: {
              'Content-Type': 'application/json',
              ...(corsOrigin ? makeCorsHeaders(corsOrigin) : {}),
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

      const result = handleRequest(req, state);
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
    },
  });

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
    { port, hostname: hostname || '127.0.0.1', cors: corsOrigin || 'disabled' },
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
    pathname === '/api/stats' ||
    pathname === '/api/context/files' ||
    pathname === '/api/context/layers' ||
    pathname === '/api/context/file'
  );
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
      return (
        `<div class="task-card" data-task-id="${escapeHtml(task.id)}">` +
        `<div class="task-top"><span class="badge ${statusClass}">${escapeHtml(task.status)}</span>` +
        `<span class="task-agent">${escapeHtml(agentShort)}</span>` +
        `<span class="task-sched">${escapeHtml(task.schedule_value)}</span></div>` +
        `<div class="task-prompt" title="${escapeHtml(task.prompt)}">${escapeHtml(promptShort)}</div>` +
        `<div class="task-actions">` +
        `<button class="btn btn-sm btn-toggle" data-action="toggle" data-status="${toggleStatus}">${toggleLabel}</button>` +
        `<button class="btn btn-sm btn-danger" data-action="delete">Del</button>` +
        `</div></div>`
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
