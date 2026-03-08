import { describe, it, expect, afterEach } from 'bun:test';

import { startWebServer, type WebServerHandle } from './server.js';
import type { WebStateProvider, QueueStats } from './types.js';
import type { Agent, ChannelSubscription, ScheduledTask } from '../types.js';

// ---- Test fixtures ----

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    folder: 'test-agent',
    backend: 'apple-container',
    agentRuntime: 'claude-agent-sdk',
    isAdmin: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-001',
    group_folder: 'test-agent',
    chat_jid: 'dc:123',
    prompt: 'Run the daily check',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    next_run: '2026-03-02T09:00:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const defaultStats: QueueStats = {
  activeContainers: 2,
  idleContainers: 1,
  maxActive: 8,
  maxIdle: 4,
};

/** In-memory task store for mutation tests. */
function makeTaskStore(
  initial: ScheduledTask[] = [
    makeTask(),
    makeTask({ id: 'task-002', status: 'paused' }),
  ],
) {
  const tasks = new Map<string, ScheduledTask>(initial.map((t) => [t.id, t]));
  return {
    tasks,
    getAll: () => [...tasks.values()],
    getById: (id: string) => tasks.get(id),
    create: (task: Omit<ScheduledTask, 'last_run' | 'last_result'>) => {
      const full: ScheduledTask = {
        ...task,
        last_run: null,
        last_result: null,
      };
      tasks.set(task.id, full);
    },
    update: (
      id: string,
      updates: Partial<
        Pick<
          ScheduledTask,
          'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
        >
      >,
    ) => {
      const existing = tasks.get(id);
      if (!existing) throw new Error('Task not found');
      tasks.set(id, { ...existing, ...updates });
    },
    delete: (id: string) => {
      tasks.delete(id);
    },
  };
}

function makeState(
  overrides: Partial<WebStateProvider> = {},
): WebStateProvider {
  const store = makeTaskStore();
  return {
    getAgents: () => ({
      'test-agent': makeAgent(),
      main: makeAgent({
        id: 'main',
        name: 'Main',
        isAdmin: true,
        folder: 'main',
      }),
    }),
    getChannelSubscriptions: () => ({
      'dc:123': [
        {
          channelJid: 'dc:123',
          agentId: 'test-agent',
          trigger: '@Test',
          requiresTrigger: true,
          priority: 100,
          isPrimary: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ] as ChannelSubscription[],
    }),
    getTasks: () => store.getAll(),
    getTaskById: (id) => store.getById(id),
    getMessages: () => [
      {
        id: 'msg-1',
        chat_jid: 'dc:123',
        sender: 'user1',
        sender_name: 'User One',
        content: 'Hello world',
        timestamp: '2026-03-01T12:00:00.000Z',
      },
    ],
    getChats: () => [
      {
        jid: 'dc:123',
        name: 'test-channel',
        last_message_time: '2026-03-01T12:00:00.000Z',
      },
    ],
    getQueueStats: () => defaultStats,
    getQueueDetails: () => [],
    getIpcEvents: () => [],
    createTask: (task) => store.create(task),
    updateTask: (id, updates) => store.update(id, updates),
    deleteTask: (id) => store.delete(id),
    calculateNextRun: (type, value) => {
      // Simplified for tests — return a fixed future time for valid inputs
      if (type === 'cron') return '2026-03-03T09:00:00.000Z';
      if (type === 'interval')
        return new Date(Date.now() + parseInt(value, 10)).toISOString();
      if (type === 'once') return value; // trust the ISO string
      return null;
    },
    readContextFile: () => null,
    writeContextFile: () => {},
    ...overrides,
  };
}

// ---- Test suite ----

let handle: WebServerHandle | null = null;

// Use port 0 to let the OS assign an ephemeral port — avoids collisions in parallel test runs
function randomPort(): number {
  return 0;
}

afterEach(async () => {
  if (handle) {
    await handle.stop();
    handle = null;
  }
});

function url(path: string): string {
  return `http://localhost:${handle!.port}${path}`;
}

interface StreamReadResult {
  done: boolean;
  value?: Uint8Array;
}

interface StreamReader {
  read(): Promise<StreamReadResult>;
}

interface CancellableReader extends StreamReader {
  cancel(): Promise<void>;
}

async function readUntilContains(
  reader: StreamReader,
  needle: string,
  timeoutMs = 2000,
): Promise<string> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let output = '';

  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('Timed out reading stream')),
          remainingMs,
        );
      }),
    ]).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });

    if (chunk.done) break;
    output += decoder.decode(chunk.value, { stream: true });
    if (output.includes(needle)) return output;
  }

  throw new Error(`Did not find expected token in stream: ${needle}`);
}

// ---- Server startup ----

describe('startWebServer', () => {
  it('starts and serves on an available port', async () => {
    handle = startWebServer({ port: 0 }, makeState());
    expect(handle.port).toBeGreaterThan(0);
    const res = await fetch(url('/'));
    expect(res.status).toBe(200);
  });

  it('serves the dashboard at /', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('OmniClaw');
    expect(html).toContain('test-agent');
  });

  it('returns 404 for unknown paths', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/nonexistent'));
    expect(res.status).toBe(404);
  });
});

// ---- Basic auth ----

describe('basic auth', () => {
  it('rejects unauthenticated requests when auth is configured', async () => {
    handle = startWebServer(
      { port: randomPort(), auth: { username: 'admin', password: 'secret' } },
      makeState(),
    );
    const res = await fetch(url('/'));
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Basic');
  });

  it('accepts valid credentials', async () => {
    handle = startWebServer(
      { port: randomPort(), auth: { username: 'admin', password: 'secret' } },
      makeState(),
    );
    const creds = btoa('admin:secret');
    const res = await fetch(url('/'), {
      headers: { Authorization: `Basic ${creds}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects wrong password', async () => {
    handle = startWebServer(
      { port: randomPort(), auth: { username: 'admin', password: 'secret' } },
      makeState(),
    );
    const creds = btoa('admin:wrong');
    const res = await fetch(url('/'), {
      headers: { Authorization: `Basic ${creds}` },
    });
    expect(res.status).toBe(401);
  });

  it('allows unauthenticated requests when auth is not configured', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/'));
    expect(res.status).toBe(200);
  });
});

// ---- API: /api/agents ----

describe('GET /api/agents', () => {
  it('returns agents with channel info', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/agents'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<Agent & { channels: string[] }>;
    expect(data.length).toBe(2);
    const testAgent = data.find((a) => a.id === 'test-agent');
    expect(testAgent).toBeDefined();
    expect(testAgent!.channels).toContain('dc:123');
  });
});

// ---- API: GET /api/tasks ----

describe('GET /api/tasks', () => {
  it('returns all tasks', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as ScheduledTask[];
    expect(data.length).toBe(2);
  });

  it('filters by status', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks?status=active'));
    const data = (await res.json()) as ScheduledTask[];
    expect(data.length).toBe(1);
    expect(data[0].status).toBe('active');
  });
});

// ---- API: GET /api/tasks/:id ----

describe('GET /api/tasks/:id', () => {
  it('returns a single task by ID', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks/task-001'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as ScheduledTask;
    expect(data.id).toBe('task-001');
    expect(data.prompt).toBe('Run the daily check');
  });

  it('returns 404 for unknown task', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks/nonexistent'));
    expect(res.status).toBe(404);
  });
});

// ---- API: POST /api/tasks ----

describe('POST /api/tasks', () => {
  it('creates a task with valid payload', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group_folder: 'test-agent',
        chat_jid: 'dc:123',
        prompt: 'New scheduled task',
        schedule_type: 'cron',
        schedule_value: '0 12 * * *',
        context_mode: 'isolated',
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as ScheduledTask;
    expect(data.id).toStartWith('task-');
    expect(data.prompt).toBe('New scheduled task');
    expect(data.status).toBe('active');
    expect(data.next_run).toBeTruthy();
  });

  it('creates a task with interval schedule', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group_folder: 'test-agent',
        chat_jid: 'dc:123',
        prompt: 'Interval task',
        schedule_type: 'interval',
        schedule_value: '3600000',
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as ScheduledTask;
    expect(data.schedule_type).toBe('interval');
    expect(data.context_mode).toBe('isolated'); // default
  });

  it('defaults context_mode to isolated', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group_folder: 'test-agent',
        chat_jid: 'dc:123',
        prompt: 'Test',
        schedule_type: 'once',
        schedule_value: '2026-12-31T23:59:00.000Z',
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as ScheduledTask;
    expect(data.context_mode).toBe('isolated');
  });

  it('rejects missing prompt', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group_folder: 'test-agent',
        chat_jid: 'dc:123',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
      }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('prompt');
  });

  it('rejects invalid schedule_type', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group_folder: 'test-agent',
        chat_jid: 'dc:123',
        prompt: 'Test',
        schedule_type: 'weekly',
        schedule_value: '0 9 * * *',
      }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('schedule_type');
  });

  it('rejects missing group_folder', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_jid: 'dc:123',
        prompt: 'Test',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
      }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('group_folder');
  });

  it('rejects missing chat_jid', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group_folder: 'test-agent',
        prompt: 'Test',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
      }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('chat_jid');
  });

  it('rejects invalid JSON body', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('Invalid JSON');
  });

  it('rejects when calculateNextRun returns null', async () => {
    const state = makeState({
      calculateNextRun: () => null,
    });
    handle = startWebServer({ port: randomPort() }, state);
    const res = await fetch(url('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group_folder: 'test-agent',
        chat_jid: 'dc:123',
        prompt: 'Test',
        schedule_type: 'cron',
        schedule_value: 'invalid-cron',
      }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('Invalid schedule');
  });

  it('task is retrievable after creation', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const createRes = await fetch(url('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group_folder: 'test-agent',
        chat_jid: 'dc:123',
        prompt: 'Persistent task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
      }),
    });
    const created = (await createRes.json()) as ScheduledTask;

    // Fetch all tasks and verify the new one is included
    const listRes = await fetch(url('/api/tasks'));
    const tasks = (await listRes.json()) as ScheduledTask[];
    expect(tasks.some((t) => t.id === created.id)).toBe(true);
  });
});

// ---- API: PATCH /api/tasks/:id ----

describe('PATCH /api/tasks/:id', () => {
  it('updates task status to paused', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks/task-001'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as ScheduledTask;
    expect(data.status).toBe('paused');
  });

  it('resumes a paused task', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks/task-002'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as ScheduledTask;
    expect(data.status).toBe('active');
  });

  it('updates task prompt', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks/task-001'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Updated prompt text' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as ScheduledTask;
    expect(data.prompt).toBe('Updated prompt text');
  });

  it('updates schedule type and value', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks/task-001'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schedule_type: 'interval',
        schedule_value: '7200000',
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as ScheduledTask;
    expect(data.schedule_type).toBe('interval');
    expect(data.schedule_value).toBe('7200000');
  });

  it('returns 404 for unknown task', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks/nonexistent'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects invalid status value', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks/task-001'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'deleted' }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('status');
  });

  it('rejects invalid schedule_type', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks/task-001'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule_type: 'weekly' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects empty update body', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks/task-001'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('No valid fields');
  });

  it('rejects invalid JSON body', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks/task-001'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects empty prompt string', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks/task-001'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '' }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('prompt');
  });
});

// ---- API: DELETE /api/tasks/:id ----

describe('DELETE /api/tasks/:id', () => {
  it('deletes an existing task', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks/task-001'), {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { deleted: boolean; id: string };
    expect(data.deleted).toBe(true);
    expect(data.id).toBe('task-001');

    // Verify task is gone
    const checkRes = await fetch(url('/api/tasks/task-001'));
    expect(checkRes.status).toBe(404);
  });

  it('returns 404 for unknown task', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks/nonexistent'), {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });

  it('task count decreases after deletion', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());

    // Get initial count
    const beforeRes = await fetch(url('/api/tasks'));
    const before = (await beforeRes.json()) as ScheduledTask[];
    const initialCount = before.length;

    // Delete a task
    await fetch(url('/api/tasks/task-001'), { method: 'DELETE' });

    // Get updated count
    const afterRes = await fetch(url('/api/tasks'));
    const after = (await afterRes.json()) as ScheduledTask[];
    expect(after.length).toBe(initialCount - 1);
  });
});

// ---- API: Method not allowed ----

describe('method not allowed', () => {
  it('returns 405 for PUT on /api/tasks', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(405);
  });

  it('returns 405 for POST on /api/tasks/:id', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks/task-001'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(405);
  });

  it('returns 405 for POST on /api/events', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/events'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(405);
  });
});

// ---- API: /api/chats ----

describe('GET /api/chats', () => {
  it('returns chat list', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/chats'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<{ jid: string; name: string }>;
    expect(data.length).toBe(1);
    expect(data[0].jid).toBe('dc:123');
  });
});

// ---- API: /api/messages ----

describe('GET /api/messages/:chatJid', () => {
  it('returns messages for a chat', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/messages/dc:123'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<{ id: string; content: string }>;
    expect(data.length).toBe(1);
    expect(data[0].content).toBe('Hello world');
  });

  it('passes since and limit params', async () => {
    let capturedSince = '';
    let capturedLimit = 0;
    const state = makeState({
      getMessages: (jid, since, limit) => {
        capturedSince = since;
        capturedLimit = limit!;
        return [];
      },
    });
    handle = startWebServer({ port: randomPort() }, state);
    await fetch(
      url('/api/messages/dc:123?since=2026-01-01T00:00:00.000Z&limit=25'),
    );
    expect(capturedSince).toBe('2026-01-01T00:00:00.000Z');
    expect(capturedLimit).toBe(25);
  });

  it('caps limit at 500', async () => {
    let capturedLimit = 0;
    const state = makeState({
      getMessages: (_jid, _since, limit) => {
        capturedLimit = limit!;
        return [];
      },
    });
    handle = startWebServer({ port: randomPort() }, state);
    await fetch(url('/api/messages/dc:123?limit=9999'));
    expect(capturedLimit).toBe(500);
  });
});

// ---- API: /api/stats ----

describe('GET /api/stats', () => {
  it('returns aggregate stats', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/stats'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, number>;
    expect(data.agents).toBe(2);
    expect(data.activeTasks).toBe(1);
    expect(data.pausedTasks).toBe(1);
    expect(data.activeContainers).toBe(2);
    expect(data.idleContainers).toBe(1);
    expect(data.maxActive).toBe(8);
  });
});

// ---- WebSocket deprecation ----

describe('WebSocket', () => {
  it('returns 410 for deprecated /ws endpoint', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/ws'));
    expect(res.status).toBe(410);
  });
});

// ---- SSE ----

describe('SSE', () => {
  it('connects and receives broadcast events', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());

    const res = await fetch(
      url('/api/events?channels=logs,tasks,stats,agents'),
      {
        headers: { Accept: 'text/event-stream' },
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    expect(res.body).toBeTruthy();

    const reader = res.body!.getReader();
    handle.broadcast({
      type: 'log',
      data: { level: 'info', msg: 'sse log', ts: Date.now() },
      timestamp: new Date().toISOString(),
    });

    const payload = await readUntilContains(reader, 'sse log');
    expect(payload).toContain('selector #log-container');
    expect(payload).toContain('sse log');
    reader.releaseLock();
  });

  it('only sends events matching subscribed channels', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());

    const res = await fetch(url('/api/events?channels=stats'), {
      headers: { Accept: 'text/event-stream' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();

    const reader = res.body!.getReader();

    handle.broadcast({
      type: 'log',
      data: { level: 'info', msg: 'should not arrive', ts: Date.now() },
      timestamp: new Date().toISOString(),
    });
    handle.broadcast({
      type: 'agent_status',
      data: {
        activeContainers: 2,
        idleContainers: 1,
        maxActive: 8,
        maxIdle: 4,
      },
      timestamp: new Date().toISOString(),
    });

    const payload = await readUntilContains(reader, 'id="stat-active"');
    expect(payload).not.toContain('should not arrive');
    reader.releaseLock();
  });

  it('rejects SSE when auth is configured and no credentials given', async () => {
    handle = startWebServer(
      { port: randomPort(), auth: { username: 'admin', password: 'secret' } },
      makeState(),
    );

    const res = await fetch(url('/api/events'));
    expect(res.status).toBe(401);
  });

  it('enforces the MAX_SSE_CLIENTS connection limit', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());

    const readers: CancellableReader[] = [];
    for (let i = 0; i < 100; i++) {
      const res = await fetch(url('/api/events?channels=logs'), {
        headers: { Accept: 'text/event-stream' },
      });
      expect(res.status).toBe(200);
      expect(res.body).toBeTruthy();
      readers.push(res.body!.getReader() as unknown as CancellableReader);
    }

    const overflow = await fetch(url('/api/events?channels=logs'), {
      headers: { Accept: 'text/event-stream' },
    });
    expect(overflow.status).toBe(429);

    await Promise.all(readers.map(async (reader) => reader.cancel()));
  });
});

// ---- CORS ----

describe('CORS', () => {
  it('returns CORS headers on OPTIONS', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/agents'), { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('includes CORS headers on API responses', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/stats'));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('CORS allows POST, PATCH, DELETE methods', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/api/tasks'), { method: 'OPTIONS' });
    const methods = res.headers.get('Access-Control-Allow-Methods') || '';
    expect(methods).toContain('POST');
    expect(methods).toContain('PATCH');
    expect(methods).toContain('DELETE');
  });
});

// ---- Shutdown ----

describe('server shutdown', () => {
  it('stops accepting connections after stop()', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const assignedPort = handle.port;

    // Verify it works
    const res = await fetch(url('/'));
    expect(res.status).toBe(200);

    await handle.stop();
    handle = null; // Prevent double-stop in afterEach

    // After stop, server should no longer serve successful responses
    let stopped = false;
    try {
      const resAfterStop = await fetch(`http://localhost:${assignedPort}/`);
      stopped = !resAfterStop.ok;
    } catch {
      stopped = true; // connection refused/reset is expected
    }
    expect(stopped).toBe(true);
  });
});

// ---- Dashboard content ----

describe('dashboard', () => {
  it('includes create task button in sidebar', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/'));
    const html = await res.text();
    expect(html).toContain('btn-create-task');
    expect(html).toContain('+ new task');
  });

  it('includes sidebar tasks panel', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/'));
    const html = await res.text();
    expect(html).toContain('sidebar-tasks');
    expect(html).toContain('panel-tasks');
  });

  it('includes create task modal', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/'));
    const html = await res.text();
    expect(html).toContain('create-task-modal');
    expect(html).toContain('create-task-form');
  });

  it('includes datastar stream endpoint in dashboard markup', async () => {
    handle = startWebServer({ port: randomPort() }, makeState());
    const res = await fetch(url('/'));
    const html = await res.text();
    expect(html).toContain('/api/events?channels=logs,stats,agents,tasks');
    expect(html).toContain('bundles/datastar.js');
  });
});
