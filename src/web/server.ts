import { ServerSentEventGenerator } from '@starfederation/datastar-sdk/web';

import { logger } from '../logger.js';
import { handleRequest } from './routes.js';
import type { ScheduledTask } from '../types.js';
import { escapeHtml } from './shared.js';
import type { WebServerConfig, WebStateProvider, WsEvent } from './types.js';

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
): WebServerHandle {
  const { port, auth } = config;
  const sseClients = new Set<SseClient>();

  const server = Bun.serve({
    port,
    development: false,

    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        return new Response('WebSocket is deprecated for the web dashboard', {
          status: 410,
          headers: corsHeaders(),
        });
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
            ...corsHeaders(),
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

  logger.info({ port, auth: !!auth }, 'Web UI server started');

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
    selector: '#tasks-tbody',
    mode: 'inner',
  });
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
      const nextRun = task.next_run
        ? new Date(task.next_run).toLocaleString()
        : '—';
      const lastRun = task.last_run
        ? new Date(task.last_run).toLocaleString()
        : '—';
      const toggleLabel = task.status === 'active' ? 'Pause' : 'Resume';
      const toggleStatus = task.status === 'active' ? 'paused' : 'active';
      return `<tr data-task-id="${escapeHtml(task.id)}">
        <td title="${escapeHtml(task.id)}">${escapeHtml(task.id.slice(0, 8))}…</td>
        <td>${escapeHtml(task.group_folder)}</td>
        <td><span class="badge ${statusClass}">${escapeHtml(task.status)}</span></td>
        <td>${escapeHtml(task.schedule_type)}: ${escapeHtml(task.schedule_value)}</td>
        <td title="${escapeHtml(task.prompt)}">${escapeHtml(task.prompt.slice(0, 80))}${task.prompt.length > 80 ? '…' : ''}</td>
        <td>${escapeHtml(nextRun)}</td>
        <td>${escapeHtml(lastRun)}</td>
        <td class="actions">
          <button class="btn btn-sm btn-toggle" data-action="toggle" data-status="${toggleStatus}" title="${toggleLabel}">${toggleLabel}</button>
          <button class="btn btn-sm btn-danger" data-action="delete" title="Delete">Delete</button>
        </td>
      </tr>`;
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
