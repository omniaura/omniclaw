/**
 * Admin API — runs on a separate port to control the fake state.
 * Provides levers to trigger any scenario the web UI could render.
 *
 * All endpoints are JSON. No auth required (simtest only).
 */

import type { IpcEventKind } from '../web/ipc-events.js';
import type { WsEventType } from '../web/types.js';
import type { WebServerHandle } from '../web/server.js';
import { calculateNextRun } from '../schedule-utils.js';
import type { SimDiscoveryEnvironment } from './discovery-sim.js';
import type { FakeState } from './fake-state.js';

export interface AdminApiConfig {
  port: number;
  hostname?: string;
}

export interface AdminApiHandle {
  port: number;
  stop(): void;
}

export function startAdminApi(
  config: AdminApiConfig,
  state: FakeState,
  webServer: WebServerHandle,
  discovery?: SimDiscoveryEnvironment,
): AdminApiHandle {
  const hostname = config.hostname || '127.0.0.1';

  const server = Bun.serve({
    port: config.port,
    hostname,
    development: false,
    fetch: async (req) => {
      const url = new URL(req.url);
      const method = req.method;

      // CORS for browser-based admin tools
      if (method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods':
              'GET, POST, PUT, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      }

      try {
        const result = await handleAdminRequest(
          method,
          url,
          req,
          state,
          webServer,
          discovery,
        );
        result.headers.set('Access-Control-Allow-Origin', '*');
        return result;
      } catch (err) {
        const status = isInvalidJsonError(err) ? 400 : 500;
        const response = json(
          { error: err instanceof Error ? err.message : String(err) },
          status,
        );
        response.headers.set('Access-Control-Allow-Origin', '*');
        return response;
      }
    },
  });

  console.log(
    `[simtest] Admin API running on http://${hostname}:${server.port}`,
  );

  return {
    port: server.port!,
    stop() {
      server.stop(true);
    },
  };
}

async function handleAdminRequest(
  method: string,
  url: URL,
  req: Request,
  state: FakeState,
  webServer: WebServerHandle,
  discovery?: SimDiscoveryEnvironment,
): Promise<Response> {
  const path = url.pathname;

  // ---- Overview ----
  if (path === '/' || path === '/help') {
    return json({
      simtest: 'OmniClaw Web UI Simulation Test Harness',
      endpoints: {
        'GET /state': 'Full state snapshot',
        'POST /reset': 'Reset to seed data',
        'POST /agents':
          'Add agent { id, name?, backend?, agentRuntime?, isAdmin? }',
        'DELETE /agents/:id': 'Remove agent',
        'POST /subscriptions':
          'Add subscription { channelJid, agentId, trigger?, priority? }',
        'POST /chats': 'Add/update chat { jid, name }',
        'POST /messages':
          'Add message { chatJid, sender, senderName, content }',
        'POST /tasks':
          'Add task { id, group_folder?, prompt?, schedule_type?, schedule_value?, status? }',
        'PATCH /tasks/:id':
          'Update task { prompt?, status?, schedule_type?, schedule_value? }',
        'DELETE /tasks/:id': 'Delete task',
        'POST /task-runs':
          'Add task run log { taskId, durationMs, status, result?, error? }',
        'POST /ipc-events':
          'Add IPC event { kind, sourceGroup, summary, details? }',
        'POST /queue-stats':
          'Set queue stats { activeContainers?, idleContainers?, maxActive?, maxIdle? }',
        'POST /queue-details': 'Set queue details (array of GroupQueueDetail)',
        'POST /broadcast': 'Broadcast event to web UI { type, data }',
        'GET /remote-peers': 'List simulated trusted remote peers',
        'POST /remote-peers/:id/logs':
          'Append remote peer log { level, msg, source?, time? }',
        'POST /scenario/:name':
          'Run predefined scenario (agent-overload, task-storm, error-cascade, idle-fleet, multi-peer-transitions, empty)',
      },
    });
  }

  // ---- State snapshot ----
  if (path === '/state' && method === 'GET') {
    return json({
      agents: state.agents,
      subscriptions: state.subscriptions,
      tasks: state.tasks,
      chats: state.chats,
      messages: state.messages.length,
      ipcEvents: state.ipcEvents.length,
      queueStats: state.queueStats,
      queueDetails: state.queueDetails,
      remotePeers: discovery?.listRemotePeers() ?? [],
    });
  }

  if (path === '/remote-peers' && method === 'GET') {
    return json(discovery?.listRemotePeers() ?? []);
  }

  if (
    path.startsWith('/remote-peers/') &&
    path.endsWith('/logs') &&
    method === 'POST'
  ) {
    if (!discovery)
      return json({ error: 'Remote peer simulation unavailable' }, 404);
    const instanceId = decodeURIComponent(
      path.slice('/remote-peers/'.length, -'/logs'.length),
    );
    const body = (await req.json()) as Record<string, unknown>;
    if (typeof body.level !== 'string' || typeof body.msg !== 'string') {
      return json({ error: '"level" and "msg" are required' }, 400);
    }
    discovery.addRemoteLog(instanceId, {
      level: body.level,
      msg: body.msg,
      source:
        typeof body.source === 'string' ? body.source : `remote:${instanceId}`,
      time: typeof body.time === 'string' ? body.time : undefined,
    });
    return json({ ok: true, instanceId }, 201);
  }

  // ---- Reset ----
  if (path === '/reset' && method === 'POST') {
    state.reset();
    discovery?.reset();
    broadcast(webServer, 'agent_status', { reset: true });
    broadcast(webServer, 'task_update', { reset: true });
    return json({ ok: true, message: 'State reset to seed data' });
  }

  // ---- Agents ----
  if (path === '/agents' && method === 'POST') {
    const body = (await req.json()) as Record<string, unknown>;
    if (!body.id || typeof body.id !== 'string') {
      return json({ error: '"id" is required' }, 400);
    }
    const agent = state.addAgent(
      body as { id: string } & Record<string, unknown>,
    );
    broadcast(webServer, 'agent_status', { added: agent.id });
    return json(agent, 201);
  }
  if (path.startsWith('/agents/') && method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/agents/'.length));
    const removed = state.removeAgent(id);
    if (!removed) return json({ error: 'Agent not found' }, 404);
    broadcast(webServer, 'agent_status', { removed: id });
    return json({ ok: true, removed: id });
  }

  // ---- Subscriptions ----
  if (path === '/subscriptions' && method === 'POST') {
    const body = (await req.json()) as Record<string, unknown>;
    if (!body.channelJid || !body.agentId) {
      return json({ error: '"channelJid" and "agentId" are required' }, 400);
    }
    state.addSubscription(
      body.channelJid as string,
      body.agentId as string,
      body,
    );
    broadcast(webServer, 'agent_status', {
      subscriptionAdded: body.channelJid,
    });
    return json({ ok: true }, 201);
  }

  // ---- Chats ----
  if (path === '/chats' && method === 'POST') {
    const body = (await req.json()) as Record<string, unknown>;
    if (!body.jid || !body.name) {
      return json({ error: '"jid" and "name" are required' }, 400);
    }
    state.addChat(body.jid as string, body.name as string);
    return json({ ok: true }, 201);
  }

  // ---- Messages ----
  if (path === '/messages' && method === 'POST') {
    const body = (await req.json()) as Record<string, unknown>;
    if (!body.chatJid || !body.sender || !body.content) {
      return json(
        { error: '"chatJid", "sender", and "content" are required' },
        400,
      );
    }
    const msg = state.addMessage(
      body.chatJid as string,
      body.sender as string,
      (body.senderName as string) || (body.sender as string),
      body.content as string,
    );
    return json(msg, 201);
  }

  // ---- Tasks ----
  if (path === '/tasks' && method === 'POST') {
    const body = (await req.json()) as Record<string, unknown>;
    if (!body.id || typeof body.id !== 'string') {
      return json({ error: '"id" is required' }, 400);
    }
    const scheduleType = normalizeScheduleType(body.schedule_type);
    const scheduleValue =
      typeof body.schedule_value === 'string' ? body.schedule_value : '300000';
    const status = normalizeTaskStatus(body.status);
    const createdAt = new Date().toISOString();
    const nextRun =
      status === 'completed'
        ? null
        : calculateNextRun(scheduleType, scheduleValue, new Date(createdAt));

    if (status !== 'completed' && nextRun === null) {
      return json(
        { error: 'Invalid schedule: could not calculate next run time' },
        400,
      );
    }

    state.createTask({
      id: body.id,
      group_folder:
        typeof body.group_folder === 'string' ? body.group_folder : 'main',
      chat_jid:
        typeof body.chat_jid === 'string' ? body.chat_jid : 'sim:general',
      prompt: typeof body.prompt === 'string' ? body.prompt : 'Simulated task',
      schedule_type: scheduleType,
      schedule_value: scheduleValue,
      context_mode: body.context_mode === 'group' ? 'group' : 'isolated',
      next_run: nextRun,
      status,
      created_at: createdAt,
    });
    broadcast(webServer, 'task_update', { created: body.id });
    return json({ ok: true, id: body.id }, 201);
  }
  if (path.startsWith('/tasks/') && method === 'PATCH') {
    const id = decodeURIComponent(path.slice('/tasks/'.length));
    const body = (await req.json()) as Record<string, unknown>;
    try {
      const existing = state.getTaskById(id);
      if (!existing) {
        return json({ error: 'Task not found' }, 404);
      }

      const updates: Partial<{
        prompt: string;
        schedule_type: 'cron' | 'interval' | 'once';
        schedule_value: string;
        next_run: string | null;
        status: 'active' | 'paused' | 'completed';
      }> = {};

      if (typeof body.prompt === 'string') {
        updates.prompt = body.prompt;
      }

      const scheduleType =
        body.schedule_type === undefined
          ? existing.schedule_type
          : normalizeScheduleType(body.schedule_type);
      const scheduleValue =
        body.schedule_value === undefined
          ? existing.schedule_value
          : typeof body.schedule_value === 'string'
            ? body.schedule_value
            : null;
      const status =
        body.status === undefined
          ? existing.status
          : normalizeTaskStatus(body.status);

      if (body.schedule_value !== undefined && scheduleValue === null) {
        return json({ error: '"schedule_value" must be a string' }, 400);
      }

      if (body.schedule_type !== undefined) {
        updates.schedule_type = scheduleType;
      }

      if (body.schedule_value !== undefined && scheduleValue !== null) {
        updates.schedule_value = scheduleValue;
      }

      if (body.status !== undefined) {
        updates.status = status;
      }

      if (
        body.schedule_type !== undefined ||
        body.schedule_value !== undefined ||
        body.status !== undefined
      ) {
        updates.next_run =
          status === 'completed'
            ? null
            : calculateNextRun(
                scheduleType,
                scheduleValue ?? existing.schedule_value,
              );

        if (status !== 'completed' && updates.next_run === null) {
          return json(
            { error: 'Invalid schedule: could not calculate next run time' },
            400,
          );
        }
      }

      state.updateTask(id, updates);
      broadcast(webServer, 'task_update', { updated: id });
      return json(state.getTaskById(id));
    } catch (err) {
      return json(
        { error: err instanceof Error ? err.message : String(err) },
        404,
      );
    }
  }
  if (path.startsWith('/tasks/') && method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/tasks/'.length));
    try {
      state.deleteTask(id);
      broadcast(webServer, 'task_update', { deleted: id });
      return json({ ok: true, deleted: id });
    } catch (err) {
      return json(
        { error: err instanceof Error ? err.message : String(err) },
        404,
      );
    }
  }

  // ---- Task Run Logs ----
  if (path === '/task-runs' && method === 'POST') {
    const body = (await req.json()) as Record<string, unknown>;
    if (!body.taskId) return json({ error: '"taskId" is required' }, 400);
    state.addTaskRunLog(body.taskId as string, {
      run_at: new Date().toISOString(),
      duration_ms: (body.durationMs as number) || 1000,
      status: (body.status as 'success' | 'error') || 'success',
      result: (body.result as string) || null,
      error: (body.error as string) || null,
    });
    // Also update the task's last_run
    const task = state.getTaskById(body.taskId as string);
    if (task) {
      task.last_run = new Date().toISOString();
      task.last_result =
        (body.result as string) || (body.error as string) || null;
    }
    broadcast(webServer, 'task_update', { taskRun: body.taskId });
    return json({ ok: true }, 201);
  }

  // ---- IPC Events ----
  if (path === '/ipc-events' && method === 'POST') {
    const body = (await req.json()) as Record<string, unknown>;
    if (!body.kind || !body.sourceGroup || !body.summary) {
      return json(
        { error: '"kind", "sourceGroup", and "summary" are required' },
        400,
      );
    }
    if (!isIpcEventKind(body.kind)) {
      return json({ error: '"kind" must be a valid IPC event kind' }, 400);
    }
    if (
      typeof body.sourceGroup !== 'string' ||
      typeof body.summary !== 'string'
    ) {
      return json(
        { error: '"sourceGroup" and "summary" must be strings' },
        400,
      );
    }
    if (body.details !== undefined && !isRecord(body.details)) {
      return json({ error: '"details" must be an object when provided' }, 400);
    }
    const event = state.addIpcEvent(
      body.kind,
      body.sourceGroup,
      body.summary,
      body.details,
    );
    broadcast(webServer, 'ipc_event', event);
    return json(event, 201);
  }

  // ---- Queue Stats ----
  if (path === '/queue-stats' && method === 'POST') {
    const body = (await req.json()) as Record<string, unknown>;
    state.setQueueStats(body);
    broadcast(webServer, 'agent_status', { queueStats: state.queueStats });
    return json(state.queueStats);
  }

  // ---- Queue Details ----
  if (path === '/queue-details' && method === 'POST') {
    const body = await req.json();
    if (!Array.isArray(body))
      return json({ error: 'Expected array of GroupQueueDetail' }, 400);
    state.setQueueDetails(body);
    return json({ ok: true, count: body.length });
  }

  // ---- Broadcast arbitrary event ----
  if (path === '/broadcast' && method === 'POST') {
    const body = (await req.json()) as Record<string, unknown>;
    if (!body.type) return json({ error: '"type" is required' }, 400);
    broadcast(webServer, body.type as WsEventType, body.data ?? {});
    return json({ ok: true, type: body.type });
  }

  // ---- Predefined scenarios ----
  if (path.startsWith('/scenario/') && method === 'POST') {
    const scenario = path.slice('/scenario/'.length);
    return runScenario(scenario, state, webServer, discovery);
  }

  return json({ error: 'Not found' }, 404);
}

// ---- Predefined scenarios ----

function runScenario(
  name: string,
  state: FakeState,
  webServer: WebServerHandle,
  discovery?: SimDiscoveryEnvironment,
): Response {
  state.reset();
  discovery?.reset();

  switch (name) {
    case 'agent-overload': {
      // Simulate many agents with high activity
      for (let i = 0; i < 12; i++) {
        state.addAgent({
          id: `overload-agent-${i}`,
          name: `Overload Bot ${i}`,
        });
        state.addSubscription('sim:general', `overload-agent-${i}`);
      }
      state.setQueueStats({
        activeContainers: 10,
        idleContainers: 5,
        maxActive: 10,
        maxIdle: 5,
      });
      broadcast(webServer, 'agent_status', { scenario: 'agent-overload' });
      return json({ ok: true, scenario: 'agent-overload', agentsAdded: 12 });
    }

    case 'task-storm': {
      // Create many tasks in various states
      const statuses: Array<'active' | 'paused' | 'completed'> = [
        'active',
        'paused',
        'completed',
      ];
      const types: Array<'cron' | 'interval' | 'once'> = [
        'cron',
        'interval',
        'once',
      ];
      const agentFolders = Object.keys(state.agents);
      const chatJids = state.chats.map((chat) => chat.jid);

      if (agentFolders.length === 0 || chatJids.length === 0) {
        return json(
          { error: 'Task storm requires at least one agent and one chat' },
          400,
        );
      }

      for (let i = 0; i < 30; i++) {
        const status = statuses[i % 3];
        const type = types[i % 3];
        state.createTask({
          id: `storm-task-${i}`,
          group_folder: agentFolders[i % agentFolders.length],
          chat_jid: chatJids[i % chatJids.length],
          prompt: `Storm task ${i}: ${['Check logs', 'Run tests', 'Deploy staging', 'Sync data', 'Generate report'][i % 5]}`,
          schedule_type: type,
          schedule_value:
            type === 'cron'
              ? `*/${(i % 30) + 1} * * * *`
              : type === 'interval'
                ? `${(i + 1) * 60000}`
                : new Date(Date.now() + i * 3600_000).toISOString(),
          context_mode: i % 2 === 0 ? 'group' : 'isolated',
          next_run:
            status === 'completed'
              ? null
              : new Date(Date.now() + i * 60_000).toISOString(),
          status,
          created_at: new Date(Date.now() - i * 86400_000).toISOString(),
        });
      }
      broadcast(webServer, 'task_update', { scenario: 'task-storm' });
      return json({ ok: true, scenario: 'task-storm', tasksAdded: 30 });
    }

    case 'error-cascade': {
      // Simulate IPC errors and failed task runs
      const errorKinds: Array<[IpcEventKind, string]> = [
        ['ipc_error', 'JSON parse error in message file'],
        ['message_blocked', 'Rate limit exceeded for sim:general'],
        ['task_error', 'Container OOM killed after 4096MB'],
        ['ipc_error', 'Path traversal attempt blocked: ../../etc/passwd'],
        ['message_suppressed', 'Duplicate message suppressed (dedup window)'],
      ];
      for (const [kind, summary] of errorKinds) {
        state.addIpcEvent(kind, 'main', summary, { severity: 'critical' });
      }
      // Add failed task runs
      for (const task of state.tasks.filter((t) => t.status === 'active')) {
        state.addTaskRunLog(task.id, {
          run_at: new Date().toISOString(),
          duration_ms: 30000,
          status: 'error',
          result: null,
          error: 'Container crashed: exit code 137 (OOM killed)',
        });
        task.last_run = new Date().toISOString();
        task.last_result = 'ERROR: OOM killed';
      }
      state.queueDetails = state.queueDetails.map((d) => ({
        ...d,
        retryCount: 3,
      }));
      broadcast(webServer, 'agent_status', { scenario: 'error-cascade' });
      broadcast(webServer, 'task_update', { scenario: 'error-cascade' });
      return json({ ok: true, scenario: 'error-cascade' });
    }

    case 'idle-fleet': {
      // All containers idle, no active work
      state.setQueueStats({
        activeContainers: 0,
        idleContainers: 4,
        maxActive: 10,
        maxIdle: 5,
      });
      state.queueDetails = Object.keys(state.agents).map((folder) => ({
        folderKey: folder,
        messageLane: {
          active: false,
          idle: true,
          pendingCount: 0,
          containerName: `omniclaw-${folder}-idle`,
        },
        taskLane: {
          active: false,
          pendingCount: 0,
          containerName: null,
          activeTask: null,
        },
        retryCount: 0,
      }));
      broadcast(webServer, 'agent_status', { scenario: 'idle-fleet' });
      return json({ ok: true, scenario: 'idle-fleet' });
    }

    case 'multi-peer-transitions': {
      if (!discovery) {
        return json({ error: 'Remote peer simulation unavailable' }, 404);
      }

      discovery.addRemotePeer({
        instanceId: 'peer-remote-2',
        name: 'Build Farm East',
        host: 'east-sim.local',
        address: '192.168.1.81',
        channelFolder: 'east',
        logMessages: ['East worker accepted a queued build'],
      });
      discovery.addRemotePeer({
        instanceId: 'peer-remote-3',
        name: 'Build Farm West',
        host: 'west-sim.local',
        address: '192.168.1.82',
        channelFolder: 'west',
        logMessages: ['West worker drained its queue'],
      });
      discovery.setPeerOnline('peer-remote-3', false);

      broadcast(webServer, 'agent_status', {
        scenario: 'multi-peer-transitions',
      });
      return json({
        ok: true,
        scenario: 'multi-peer-transitions',
        remotePeers: discovery.listRemotePeers(),
      });
    }

    case 'empty': {
      // Completely empty state — tests empty-state rendering
      state.agents = {};
      state.subscriptions = {};
      state.tasks = [];
      state.messages = [];
      state.chats = [];
      state.ipcEvents = [];
      state.taskRunLogs = {};
      state.queueStats = {
        activeContainers: 0,
        idleContainers: 0,
        maxActive: 10,
        maxIdle: 5,
      };
      state.queueDetails = [];
      broadcast(webServer, 'agent_status', { scenario: 'empty' });
      broadcast(webServer, 'task_update', { scenario: 'empty' });
      return json({ ok: true, scenario: 'empty' });
    }

    default:
      return json(
        {
          error: `Unknown scenario: ${name}`,
          available: [
            'agent-overload',
            'task-storm',
            'error-cascade',
            'idle-fleet',
            'multi-peer-transitions',
            'empty',
          ],
        },
        404,
      );
  }
}

// ---- Helpers ----

function broadcast(
  webServer: WebServerHandle,
  type: WsEventType,
  data: unknown,
): void {
  webServer.broadcast({ type, data, timestamp: new Date().toISOString() });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const VALID_IPC_EVENT_KINDS = [
  'message_sent',
  'message_blocked',
  'message_suppressed',
  'task_created',
  'task_edited',
  'task_cancelled',
  'task_error',
  'group_registered',
  'ipc_error',
] as const satisfies readonly IpcEventKind[];

function isInvalidJsonError(err: unknown): boolean {
  return (
    err instanceof SyntaxError ||
    (err instanceof Error && /json/i.test(err.message))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeScheduleType(value: unknown): 'cron' | 'interval' | 'once' {
  if (value === 'cron' || value === 'interval' || value === 'once') {
    return value;
  }
  return 'interval';
}

function normalizeTaskStatus(
  value: unknown,
): 'active' | 'paused' | 'completed' {
  if (value === 'active' || value === 'paused' || value === 'completed') {
    return value;
  }
  return 'active';
}

function isIpcEventKind(value: unknown): value is IpcEventKind {
  return (
    typeof value === 'string' &&
    VALID_IPC_EVENT_KINDS.includes(value as IpcEventKind)
  );
}
