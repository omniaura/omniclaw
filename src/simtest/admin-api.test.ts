import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { WebServerHandle } from '../web/server.js';
import type { WsEvent } from '../web/types.js';
import { startAdminApi, type AdminApiHandle } from './admin-api.js';
import { createSimDiscoveryEnvironment } from './discovery-sim.js';
import { FakeState } from './fake-state.js';

function makeMockWebServer(): WebServerHandle & { events: WsEvent[] } {
  const events: WsEvent[] = [];
  return {
    port: 0,
    events,
    broadcast(event) {
      events.push(event);
    },
    async stop() {},
    get clientCount() {
      return 0;
    },
    setNetworkPageState() {},
  };
}

describe('startAdminApi', () => {
  let state: FakeState;
  let webServer: ReturnType<typeof makeMockWebServer>;
  let handle: AdminApiHandle | null;

  beforeEach(() => {
    state = new FakeState();
    webServer = makeMockWebServer();
    handle = null;
  });

  afterEach(() => {
    handle?.stop();
    handle = null;
  });

  function baseUrl(path: string): string {
    return `http://127.0.0.1:${handle!.port}${path}`;
  }

  async function requestJson(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    return fetch(baseUrl(path), init);
  }

  it('serves seeded state snapshots and remote peers', async () => {
    const discovery = createSimDiscoveryEnvironment(state);
    handle = startAdminApi({ port: 0 }, state, webServer, discovery);

    const response = await requestJson('/state');
    const body = (await response.json()) as {
      agents: Record<string, unknown>;
      tasks: unknown[];
      remotePeers: Array<{ instanceId: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.agents.main).toBeDefined();
    expect(body.tasks).toHaveLength(4);
    expect(body.remotePeers).toHaveLength(1);
    expect(body.remotePeers[0]?.instanceId).toBe('peer-remote-1');
  });

  it('supports CORS preflight and returns JSON parse errors as 400', async () => {
    handle = startAdminApi({ port: 0 }, state, webServer);

    const options = await requestJson('/tasks', { method: 'OPTIONS' });
    expect(options.status).toBe(204);
    expect(options.headers.get('Access-Control-Allow-Origin')).toBe('*');

    const invalidJson = await requestJson('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    const errorBody = (await invalidJson.json()) as { error: string };

    expect(invalidJson.status).toBe(400);
    expect(errorBody.error.toLowerCase()).toContain('json');
  });

  it('creates tasks with normalized defaults and broadcasts updates', async () => {
    handle = startAdminApi({ port: 0 }, state, webServer);

    const response = await requestJson('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'task-admin-created',
        schedule_type: 'not-real',
        schedule_value: '60000',
        status: 'completed',
      }),
    });
    const body = (await response.json()) as { ok: boolean; id: string };
    const task = state.getTaskById('task-admin-created');

    expect(response.status).toBe(201);
    expect(body).toEqual({ ok: true, id: 'task-admin-created' });
    expect(task).toMatchObject({
      schedule_type: 'interval',
      schedule_value: '60000',
      status: 'completed',
      next_run: null,
      group_folder: 'main',
      chat_jid: 'sim:general',
      context_mode: 'isolated',
    });
    expect(webServer.events.at(-1)).toMatchObject({
      type: 'task_update',
      data: { created: 'task-admin-created' },
    });
  });

  it('patches tasks, validates bad schedule values, and deletes tasks', async () => {
    handle = startAdminApi({ port: 0 }, state, webServer);

    const patchResponse = await requestJson('/tasks/task-heartbeat', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Updated heartbeat prompt',
        status: 'completed',
      }),
    });
    const patched = (await patchResponse.json()) as {
      prompt: string;
      status: string;
      next_run: string | null;
    };

    expect(patchResponse.status).toBe(200);
    expect(patched).toMatchObject({
      prompt: 'Updated heartbeat prompt',
      status: 'completed',
      next_run: null,
    });

    const invalidPatch = await requestJson('/tasks/task-heartbeat', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule_value: 123 }),
    });
    expect(invalidPatch.status).toBe(400);
    expect(await invalidPatch.json()).toEqual({
      error: '"schedule_value" must be a string',
    });

    const deleteResponse = await requestJson('/tasks/task-heartbeat', {
      method: 'DELETE',
    });

    expect(deleteResponse.status).toBe(200);
    expect(state.getTaskById('task-heartbeat')).toBeUndefined();
    expect(webServer.events.at(-1)).toMatchObject({
      type: 'task_update',
      data: { deleted: 'task-heartbeat' },
    });
  });

  it('validates IPC event payloads before broadcasting them', async () => {
    handle = startAdminApi({ port: 0 }, state, webServer);

    const invalid = await requestJson('/ipc-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'ipc_error',
        sourceGroup: 'main',
        summary: 'bad payload',
        details: ['not', 'an', 'object'],
      }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: '"details" must be an object when provided',
    });

    const valid = await requestJson('/ipc-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'task_error',
        sourceGroup: 'main',
        summary: 'Container timed out',
        details: { attempt: 2 },
      }),
    });
    const event = (await valid.json()) as { kind: string; summary: string };

    expect(valid.status).toBe(201);
    expect(event).toMatchObject({
      kind: 'task_error',
      summary: 'Container timed out',
    });
    expect(webServer.events.at(-1)).toMatchObject({
      type: 'ipc_event',
      data: { kind: 'task_error', summary: 'Container timed out' },
    });
  });

  it('manages remote peer logs and scenario mutations', async () => {
    const discovery = createSimDiscoveryEnvironment(state);
    handle = startAdminApi({ port: 0 }, state, webServer, discovery);

    const peersBeforeLog = await requestJson('/remote-peers');
    const peerBefore = (
      (await peersBeforeLog.json()) as Array<{
        instanceId: string;
        logs: number;
      }>
    ).find((peer) => peer.instanceId === 'peer-remote-1');

    const logResponse = await requestJson('/remote-peers/peer-remote-1/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'warn', msg: 'build queue backed up' }),
    });
    expect(logResponse.status).toBe(201);

    const peersAfterLog = await requestJson('/remote-peers');
    const peerSummaries = (await peersAfterLog.json()) as Array<{
      instanceId: string;
      logs: number;
    }>;
    const updatedPeer = peerSummaries.find(
      (peer) => peer.instanceId === 'peer-remote-1',
    );
    expect(updatedPeer?.logs).toBe((peerBefore?.logs ?? 0) + 1);

    const scenarioResponse = await requestJson('/scenario/task-storm', {
      method: 'POST',
    });
    const scenario = (await scenarioResponse.json()) as {
      ok: boolean;
      scenario: string;
      tasksAdded: number;
    };

    expect(scenarioResponse.status).toBe(200);
    expect(scenario).toEqual({
      ok: true,
      scenario: 'task-storm',
      tasksAdded: 30,
    });
    expect(state.getTasks()).toHaveLength(34);
    expect(webServer.events.at(-1)).toMatchObject({
      type: 'task_update',
      data: { scenario: 'task-storm' },
    });
  });
});
