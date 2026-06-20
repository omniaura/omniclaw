import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { WebServerHandle } from '../web/server.js';
import type { WsEvent } from '../web/types.js';
import { startAdminApi, type AdminApiHandle } from './admin-api.js';
import { createSimDiscoveryEnvironment } from './discovery-sim.js';
import { FakeState } from './fake-state.js';

function makeWebServer(events: WsEvent[]): WebServerHandle {
  return {
    port: 0,
    broadcast(event: WsEvent): void {
      events.push(event);
    },
    async stop(): Promise<void> {},
    get clientCount(): number {
      return 0;
    },
    setNetworkPageState(): void {},
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('startAdminApi', () => {
  let state: FakeState;
  let events: WsEvent[];
  let api: AdminApiHandle;
  let baseUrl: string;

  beforeEach(() => {
    state = new FakeState();
    events = [];
    api = startAdminApi({ port: 0 }, state, makeWebServer(events));
    baseUrl = `http://127.0.0.1:${api.port}`;
  });

  afterEach(() => {
    api.stop();
  });

  it('serves help, CORS preflight, and state snapshots', async () => {
    const options = await fetch(`${baseUrl}/state`, { method: 'OPTIONS' });
    expect(options.status).toBe(204);
    expect(options.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(options.headers.get('Access-Control-Allow-Methods')).toContain(
      'POST',
    );

    const help = await fetch(`${baseUrl}/help`);
    expect(help.status).toBe(200);
    expect(help.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await readJson(help)).toMatchObject({
      simtest: 'OmniClaw Web UI Simulation Test Harness',
    });

    const snapshot = await fetch(`${baseUrl}/state`);
    expect(snapshot.status).toBe(200);
    expect(await readJson(snapshot)).toMatchObject({
      messages: 7,
      ipcEvents: 5,
      remotePeers: [],
    });
  });

  it('validates agent and subscription mutations before broadcasting changes', async () => {
    const invalidAgent = await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      body: JSON.stringify({ name: 'No ID' }),
    });
    expect(invalidAgent.status).toBe(400);
    expect(await readJson(invalidAgent)).toEqual({ error: '"id" is required' });
    expect(events).toHaveLength(0);

    const agent = await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      body: JSON.stringify({ id: 'ops-bot', name: 'Ops Bot', isAdmin: true }),
    });
    expect(agent.status).toBe(201);
    expect(await readJson(agent)).toMatchObject({
      id: 'ops-bot',
      name: 'Ops Bot',
      isAdmin: true,
    });
    expect(state.agents['ops-bot']).toMatchObject({ name: 'Ops Bot' });
    expect(events.at(-1)).toMatchObject({
      type: 'agent_status',
      data: { added: 'ops-bot' },
    });

    const subscription = await fetch(`${baseUrl}/subscriptions`, {
      method: 'POST',
      body: JSON.stringify({
        channelJid: 'sim:ops',
        agentId: 'ops-bot',
        trigger: '@Ops',
        priority: 7,
      }),
    });
    expect(subscription.status).toBe(201);
    expect(state.subscriptions['sim:ops']?.[0]).toMatchObject({
      agentId: 'ops-bot',
      trigger: '@Ops',
      priority: 7,
    });

    const deleted = await fetch(`${baseUrl}/agents/ops-bot`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    expect(state.agents['ops-bot']).toBeUndefined();
    expect(state.subscriptions['sim:ops']).toBeUndefined();
  });

  it('creates, patches, completes, and deletes scheduled tasks deterministically', async () => {
    const invalidSchedule = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        id: 'bad-task',
        schedule_type: 'once',
        schedule_value: 'not-a-date',
      }),
    });
    expect(invalidSchedule.status).toBe(400);
    expect(await readJson(invalidSchedule)).toEqual({
      error: 'Invalid schedule: could not calculate next run time',
    });

    const completed = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        id: 'completed-task',
        status: 'completed',
        schedule_type: 'once',
        schedule_value: 'not-a-date',
      }),
    });
    expect(completed.status).toBe(201);
    expect(state.getTaskById('completed-task')).toMatchObject({
      status: 'completed',
      next_run: null,
      context_mode: 'isolated',
    });

    const created = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        id: 'interval-task',
        group_folder: 'main',
        chat_jid: 'sim:general',
        prompt: 'Poll queue',
        schedule_type: 'interval',
        schedule_value: '60000',
        context_mode: 'group',
      }),
    });
    expect(created.status).toBe(201);
    const intervalTask = state.getTaskById('interval-task');
    expect(intervalTask).toMatchObject({
      prompt: 'Poll queue',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'group',
      status: 'active',
    });
    expect(intervalTask?.next_run).toEqual(expect.any(String));

    const invalidPatch = await fetch(`${baseUrl}/tasks/interval-task`, {
      method: 'PATCH',
      body: JSON.stringify({ schedule_value: 123 }),
    });
    expect(invalidPatch.status).toBe(400);
    expect(await readJson(invalidPatch)).toEqual({
      error: '"schedule_value" must be a string',
    });

    const patched = await fetch(`${baseUrl}/tasks/interval-task`, {
      method: 'PATCH',
      body: JSON.stringify({
        prompt: 'Poll queue slowly',
        schedule_type: 'cron',
        schedule_value: '*/15 * * * *',
        status: 'paused',
      }),
    });
    expect(patched.status).toBe(200);
    expect(state.getTaskById('interval-task')).toMatchObject({
      prompt: 'Poll queue slowly',
      schedule_type: 'cron',
      schedule_value: '*/15 * * * *',
      status: 'paused',
    });

    const removed = await fetch(`${baseUrl}/tasks/interval-task`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);
    expect(state.getTaskById('interval-task')).toBeUndefined();
    expect(events.filter((event) => event.type === 'task_update')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ data: { created: 'completed-task' } }),
        expect.objectContaining({ data: { created: 'interval-task' } }),
        expect.objectContaining({ data: { updated: 'interval-task' } }),
        expect.objectContaining({ data: { deleted: 'interval-task' } }),
      ]),
    );
  });

  it('validates IPC events and broadcasts accepted events', async () => {
    const missingFields = await fetch(`${baseUrl}/ipc-events`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ipc_error' }),
    });
    expect(missingFields.status).toBe(400);

    const invalidKind = await fetch(`${baseUrl}/ipc-events`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'not-real',
        sourceGroup: 'main',
        summary: 'Bad kind',
      }),
    });
    expect(invalidKind.status).toBe(400);

    const invalidDetails = await fetch(`${baseUrl}/ipc-events`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'ipc_error',
        sourceGroup: 'main',
        summary: 'Bad details',
        details: ['not', 'an', 'object'],
      }),
    });
    expect(invalidDetails.status).toBe(400);

    const accepted = await fetch(`${baseUrl}/ipc-events`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'ipc_error',
        sourceGroup: 'main',
        summary: 'Parse failed',
        details: { file: 'message.json' },
      }),
    });
    expect(accepted.status).toBe(201);
    const event = await readJson(accepted);
    expect(event).toMatchObject({
      kind: 'ipc_error',
      sourceGroup: 'main',
      summary: 'Parse failed',
      details: { file: 'message.json' },
    });
    expect(events.at(-1)).toMatchObject({ type: 'ipc_event', data: event });
  });

  it('mutates chats, messages, task runs, and queue controls', async () => {
    const invalidChat = await fetch(`${baseUrl}/chats`, {
      method: 'POST',
      body: JSON.stringify({ jid: 'sim:missing-name' }),
    });
    expect(invalidChat.status).toBe(400);

    const chat = await fetch(`${baseUrl}/chats`, {
      method: 'POST',
      body: JSON.stringify({ jid: 'sim:ops', name: 'Operations' }),
    });
    expect(chat.status).toBe(201);
    expect(state.chats.some((entry) => entry.jid === 'sim:ops')).toBe(true);

    const invalidMessage = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      body: JSON.stringify({ chatJid: 'sim:ops', sender: 'agent:ops-bot' }),
    });
    expect(invalidMessage.status).toBe(400);

    const message = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        chatJid: 'sim:ops',
        sender: 'agent:ops-bot',
        content: 'Queue drained',
      }),
    });
    expect(message.status).toBe(201);
    expect(await readJson(message)).toMatchObject({
      chat_jid: 'sim:ops',
      sender: 'agent:ops-bot',
      sender_name: 'agent:ops-bot',
      content: 'Queue drained',
    });

    const missingTaskRun = await fetch(`${baseUrl}/task-runs`, {
      method: 'POST',
      body: JSON.stringify({ durationMs: 2000 }),
    });
    expect(missingTaskRun.status).toBe(400);

    const taskRun = await fetch(`${baseUrl}/task-runs`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-heartbeat',
        durationMs: 2500,
        status: 'error',
        error: 'simulated failure',
      }),
    });
    expect(taskRun.status).toBe(201);
    expect(state.getTaskRunLogs('task-heartbeat', 1)[0]).toMatchObject({
      duration_ms: 2500,
      status: 'error',
      error: 'simulated failure',
    });
    expect(state.getTaskById('task-heartbeat')).toMatchObject({
      last_result: 'simulated failure',
    });

    const queueStats = await fetch(`${baseUrl}/queue-stats`, {
      method: 'POST',
      body: JSON.stringify({ activeContainers: 8, idleContainers: 2 }),
    });
    expect(queueStats.status).toBe(200);
    expect(state.queueStats).toMatchObject({
      activeContainers: 8,
      idleContainers: 2,
    });

    const invalidQueueDetails = await fetch(`${baseUrl}/queue-details`, {
      method: 'POST',
      body: JSON.stringify({ not: 'an array' }),
    });
    expect(invalidQueueDetails.status).toBe(400);

    const queueDetails = await fetch(`${baseUrl}/queue-details`, {
      method: 'POST',
      body: JSON.stringify([]),
    });
    expect(queueDetails.status).toBe(200);
    expect(state.queueDetails).toEqual([]);
  });

  it('handles reset, arbitrary broadcasts, malformed JSON, and missing routes', async () => {
    state.addAgent({ id: 'temp-agent' });
    state.queueDetails = [];

    const reset = await fetch(`${baseUrl}/reset`, { method: 'POST' });
    expect(reset.status).toBe(200);
    expect(state.agents['temp-agent']).toBeUndefined();
    expect(state.queueDetails.length).toBeGreaterThan(0);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent_status',
          data: { reset: true },
        }),
        expect.objectContaining({ type: 'task_update', data: { reset: true } }),
      ]),
    );

    const missingBroadcastType = await fetch(`${baseUrl}/broadcast`, {
      method: 'POST',
      body: JSON.stringify({ data: { ok: true } }),
    });
    expect(missingBroadcastType.status).toBe(400);

    const broadcast = await fetch(`${baseUrl}/broadcast`, {
      method: 'POST',
      body: JSON.stringify({ type: 'agent_status', data: { manual: true } }),
    });
    expect(broadcast.status).toBe(200);
    expect(events.at(-1)).toMatchObject({
      type: 'agent_status',
      data: { manual: true },
    });

    const malformed = await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      body: '{',
    });
    expect(malformed.status).toBe(400);
    expect(await readJson(malformed)).toMatchObject({
      error: expect.stringContaining('JSON'),
    });

    const oversized = await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      body: JSON.stringify({
        id: 'too-large',
        padding: 'x'.repeat(1024 * 1024),
      }),
    });
    expect(oversized.status).toBe(413);
    expect(await readJson(oversized)).toMatchObject({
      error: expect.stringContaining('Request body exceeded'),
    });

    const missing = await fetch(`${baseUrl}/does-not-exist`);
    expect(missing.status).toBe(404);
    expect(await readJson(missing)).toEqual({ error: 'Not found' });
  });

  it('runs predefined scenarios and reports unavailable remote peer simulation', async () => {
    const taskStorm = await fetch(`${baseUrl}/scenario/task-storm`, {
      method: 'POST',
    });
    expect(taskStorm.status).toBe(200);
    expect(await readJson(taskStorm)).toMatchObject({
      ok: true,
      scenario: 'task-storm',
      tasksAdded: 30,
    });
    expect(state.tasks).toHaveLength(34);

    const idleFleet = await fetch(`${baseUrl}/scenario/idle-fleet`, {
      method: 'POST',
    });
    expect(idleFleet.status).toBe(200);
    expect(state.queueStats).toMatchObject({
      activeContainers: 0,
      idleContainers: 4,
    });
    expect(state.queueDetails.every((detail) => detail.messageLane.idle)).toBe(
      true,
    );

    const remoteScenario = await fetch(
      `${baseUrl}/scenario/multi-peer-transitions`,
      { method: 'POST' },
    );
    expect(remoteScenario.status).toBe(404);
    expect(await readJson(remoteScenario)).toEqual({
      error: 'Remote peer simulation unavailable',
    });

    const missingRemoteLogs = await fetch(`${baseUrl}/remote-peers/peer/logs`, {
      method: 'POST',
      body: JSON.stringify({ level: 'info', msg: 'hello' }),
    });
    expect(missingRemoteLogs.status).toBe(404);
    expect(await readJson(missingRemoteLogs)).toEqual({
      error: 'Remote peer simulation unavailable',
    });

    const unknown = await fetch(`${baseUrl}/scenario/missing`, {
      method: 'POST',
    });
    expect(unknown.status).toBe(404);
    expect(await readJson(unknown)).toMatchObject({
      error: 'Unknown scenario: missing',
    });
  });

  it('manages discovery-backed remote peers and transition scenarios', async () => {
    api.stop();
    events = [];
    const discovery = createSimDiscoveryEnvironment(state);
    api = startAdminApi({ port: 0 }, state, makeWebServer(events), discovery);
    baseUrl = `http://127.0.0.1:${api.port}`;

    const stateSnapshot = await fetch(`${baseUrl}/state`);
    const snapshot = await readJson(stateSnapshot);
    expect(snapshot.remotePeers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instanceId: 'peer-remote-1' }),
      ]),
    );

    const invalidLog = await fetch(
      `${baseUrl}/remote-peers/peer-remote-1/logs`,
      {
        method: 'POST',
        body: JSON.stringify({ level: 'info' }),
      },
    );
    expect(invalidLog.status).toBe(400);

    const logResponse = await fetch(
      `${baseUrl}/remote-peers/peer-remote-1/logs`,
      {
        method: 'POST',
        body: JSON.stringify({ level: 'warn', msg: 'build queue backed up' }),
      },
    );
    expect(logResponse.status).toBe(201);
    expect(await readJson(logResponse)).toEqual({
      ok: true,
      instanceId: 'peer-remote-1',
    });

    const peersAfterLog = (await (
      await fetch(`${baseUrl}/remote-peers`)
    ).json()) as Array<{ instanceId: string; logs: number }>;
    const updatedPeer = peersAfterLog.find(
      (peer) => peer.instanceId === 'peer-remote-1',
    );
    expect(updatedPeer?.logs).toBeGreaterThan(0);

    const scenarioResponse = await fetch(
      `${baseUrl}/scenario/multi-peer-transitions`,
      { method: 'POST' },
    );
    expect(scenarioResponse.status).toBe(200);
    const scenario = await readJson(scenarioResponse);
    expect(scenario).toMatchObject({
      ok: true,
      scenario: 'multi-peer-transitions',
    });
    expect(scenario.remotePeers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instanceId: 'peer-remote-2' }),
        expect.objectContaining({ instanceId: 'peer-remote-3', online: false }),
      ]),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'agent_status',
      data: { scenario: 'multi-peer-transitions' },
    });
  });
});
