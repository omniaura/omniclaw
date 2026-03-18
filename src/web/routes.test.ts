import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import type {
  Agent,
  ChannelSubscription,
  ScheduledTask,
  TaskRunLog,
} from '../types.js';
import { handleRequest, resetDiscoveryContextForTests } from './routes.js';
import type { WebStateProvider } from './types.js';

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
    group_folder: 'agent-one',
    chat_jid: 'dc:123',
    prompt: 'Run check',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    next_run: '2026-03-05T09:00:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeState(
  agentOrOverrides: Agent | Partial<WebStateProvider> = {},
): WebStateProvider {
  const isAgentLike =
    'id' in agentOrOverrides &&
    'folder' in agentOrOverrides &&
    'backend' in agentOrOverrides;
  const agent = isAgentLike
    ? (agentOrOverrides as Agent)
    : makeAgent({ id: 'agent-1', name: 'Agent One', folder: 'agent-one' });
  const overrides = isAgentLike
    ? {}
    : (agentOrOverrides as Partial<WebStateProvider>);
  const tasks = new Map<string, ScheduledTask>([
    ['task-001', makeTask()],
    ['task-paused', makeTask({ id: 'task-paused', status: 'paused' })],
  ]);

  return {
    getAgents: () => ({ [agent.id]: agent }),
    getChannelSubscriptions: () => ({
      'dc:123': [
        {
          channelJid: 'dc:123',
          agentId: 'agent-1',
          trigger: '@Agent',
          requiresTrigger: true,
          priority: 100,
          isPrimary: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ] as ChannelSubscription[],
    }),
    getTasks: () => [...tasks.values()],
    getTaskById: (id) => tasks.get(id),
    getMessages: () => [],
    getChats: () => [],
    getQueueStats: () => ({
      activeContainers: 1,
      idleContainers: 0,
      maxActive: 3,
      maxIdle: 2,
    }),
    getQueueDetails: () => [],
    getIpcEvents: () => [],
    createTask: (task) => {
      tasks.set(task.id, { ...task, last_run: null, last_result: null });
    },
    updateTask: (id, updates) => {
      const existing = tasks.get(id);
      if (!existing) {
        throw new Error('Task not found');
      }
      tasks.set(id, { ...existing, ...updates });
    },
    deleteTask: (id) => {
      tasks.delete(id);
    },
    getTaskRunLogs: () => [],
    calculateNextRun: () => '2026-03-06T09:00:00.000Z',
    readContextFile: () => null,
    writeContextFile: () => {},
    updateAgentAvatar: () => {},
    resolveChatImage: async () => null,
    resolveDiscordGuildImage: async () => null,
    ...overrides,
  };
}

const originalDateCtor = Date;
const originalRandom = Math.random;

function clearImageCache(dir: string): void {
  fs.rmSync(dir, {
    recursive: true,
    force: true,
  });
}

async function assertOkImageResponse(
  response: Response,
  expectedBody: string,
  expectedCacheControl = 'private, max-age=86400',
): Promise<void> {
  const body = await response.text();
  const cacheControl = response.headers.get('cache-control');
  if (response.status !== 200 || cacheControl !== expectedCacheControl) {
    throw new Error(
      `Expected 200 image response with ${expectedCacheControl}, got ${response.status} with ${cacheControl}: ${body}`,
    );
  }
  expect(body).toBe(expectedBody);
}

async function jsonBody(response: Response): Promise<unknown> {
  return response.json();
}

async function handle(
  req: Request,
  state: WebStateProvider,
): Promise<Response> {
  return Promise.resolve(handleRequest(req, state));
}

beforeEach(() => {
  resetDiscoveryContextForTests();
});

afterEach(() => {
  globalThis.Date = originalDateCtor;
  Math.random = originalRandom;
  resetDiscoveryContextForTests();
});

describe('handleRequest avatar image proxy', () => {
  it('proxies remote avatar bytes for an agent', async () => {
    const testImageCacheDir = path.join(
      DATA_DIR,
      'image-cache-routes-test',
      randomUUID(),
    );
    clearImageCache(testImageCacheDir);

    try {
      const res = await handleRequest(
        new Request('http://localhost/api/agents/test-agent/avatar/image'),
        makeState({
          remoteImageCacheDir: testImageCacheDir,
          fetchRemoteImage: async (input: string | URL | Request) => {
            expect(String(input)).toBe('https://example.test/avatar.png');
            return new Response('avatar-bytes', {
              status: 200,
              headers: { 'Content-Type': 'image/png' },
            });
          },
          getAgents: () => ({
            'test-agent': makeAgent({
              avatarUrl: 'https://example.test/avatar.png',
              avatarSource: 'telegram',
            }),
          }),
        }),
      );

      expect(res.headers.get('content-type')).toContain('image/png');
      await assertOkImageResponse(res, 'avatar-bytes');
    } finally {
      clearImageCache(testImageCacheDir);
    }
  });

  it('redacts Telegram bot tokens from avatar metadata responses', async () => {
    const res = await handleRequest(
      new Request('http://localhost/api/agents/test-agent/avatar'),
      makeState({
        getAgents: () => ({
          'test-agent': makeAgent({
            avatarUrl:
              'https://api.telegram.org/file/bot123456:secret-token/photos/file_42.jpg',
            avatarSource: 'telegram',
          }),
        }),
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      avatarUrl: 'tg-file:123456:photos%2Ffile_42.jpg',
      avatarSource: 'telegram',
    });
  });

  it('resolves Telegram avatar descriptors server-side before fetching', async () => {
    const testImageCacheDir = path.join(
      DATA_DIR,
      'image-cache-routes-test',
      randomUUID(),
    );
    clearImageCache(testImageCacheDir);

    try {
      const res = await handleRequest(
        new Request('http://localhost/api/agents/test-agent/avatar/image'),
        makeState({
          remoteImageCacheDir: testImageCacheDir,
          fetchRemoteImage: async (input: string | URL | Request) => {
            expect(String(input)).toBe('https://example.test/tg-avatar.png');
            return new Response('telegram-avatar', {
              status: 200,
              headers: { 'Content-Type': 'image/png' },
            });
          },
          resolveAgentAvatarUrl: async (agentId, avatarUrl, avatarSource) => {
            expect(agentId).toBe('test-agent');
            expect(avatarSource).toBe('telegram');
            expect(avatarUrl).toBe('tg-file:123456:photos%2Ffile_42.jpg');
            return 'https://example.test/tg-avatar.png';
          },
          getAgents: () => ({
            'test-agent': makeAgent({
              avatarUrl: 'tg-file:123456:photos%2Ffile_42.jpg',
              avatarSource: 'telegram',
            }),
          }),
        }),
      );

      await assertOkImageResponse(res, 'telegram-avatar');
    } finally {
      clearImageCache(testImageCacheDir);
    }
  });

  it('proxies telegram DM icons through the chat icon route', async () => {
    const testImageCacheDir = path.join(
      DATA_DIR,
      'image-cache-routes-test',
      randomUUID(),
    );
    clearImageCache(testImageCacheDir);

    try {
      const res = await handleRequest(
        new Request(
          'http://localhost/api/chats/tg%3A8401921193%3A1991174535/icon',
        ),
        {
          ...makeState(makeAgent()),
          remoteImageCacheDir: testImageCacheDir,
          fetchRemoteImage: async (input: string | URL | Request) => {
            expect(String(input)).toBe('https://example.test/tg-user.png');
            return new Response('tg-user', {
              status: 200,
              headers: { 'Content-Type': 'image/png' },
            });
          },
          resolveChatImage: async (jid) => {
            expect(jid).toBe('tg:8401921193:1991174535');
            return 'https://example.test/tg-user.png';
          },
        },
      );

      await assertOkImageResponse(res, 'tg-user');
    } finally {
      clearImageCache(testImageCacheDir);
    }
  });

  it('proxies discord guild icons through the guild icon route', async () => {
    const testImageCacheDir = path.join(
      DATA_DIR,
      'image-cache-routes-test',
      randomUUID(),
    );
    clearImageCache(testImageCacheDir);

    try {
      const res = await handleRequest(
        new Request(
          'http://localhost/api/discord/guilds/753336633083953213/icon?botId=OCPEYTON',
        ),
        {
          ...makeState(makeAgent()),
          remoteImageCacheDir: testImageCacheDir,
          fetchRemoteImage: async (input: string | URL | Request) => {
            expect(String(input)).toBe(
              'https://example.test/discord-guild.png',
            );
            return new Response('guild-icon', {
              status: 200,
              headers: { 'Content-Type': 'image/png' },
            });
          },
          resolveDiscordGuildImage: async (guildId, botId) => {
            expect(guildId).toBe('753336633083953213');
            expect(botId).toBe('OCPEYTON');
            return 'https://example.test/discord-guild.png';
          },
        },
      );

      await assertOkImageResponse(res, 'guild-icon');
    } finally {
      clearImageCache(testImageCacheDir);
    }
  });
});

describe('web routes unit tests', () => {
  it('rejects invalid encoded task IDs', async () => {
    const res = await handle(
      new Request('http://localhost/api/tasks/%E0%A4%A', { method: 'GET' }),
      makeState(),
    );

    expect(res.status).toBe(400);
    const body = (await jsonBody(res)) as { error: string };
    expect(body.error).toContain('Invalid task ID encoding');
  });

  it('rejects invalid encoded chat IDs', async () => {
    const res = await handle(
      new Request('http://localhost/api/messages/%E0%A4%A', { method: 'GET' }),
      makeState(),
    );

    expect(res.status).toBe(400);
    const body = (await jsonBody(res)) as { error: string };
    expect(body.error).toContain('Invalid chatJid encoding');
  });

  it('creates deterministic task IDs with monkey-patched time and randomness', async () => {
    const fixedTime = 1710000000000;
    class MockDate extends Date {
      constructor(value?: string | number | Date) {
        super(value ?? fixedTime);
      }

      static now(): number {
        return fixedTime;
      }
    }

    globalThis.Date = MockDate as unknown as DateConstructor;
    Math.random = () => 0.123456789;

    const state = makeState();
    const res = await handle(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group_folder: 'agent-one',
          chat_jid: 'dc:123',
          prompt: 'Deterministic task',
          schedule_type: 'cron',
          schedule_value: '*/10 * * * *',
          context_mode: 'group',
        }),
      }),
      state,
    );

    expect(res.status).toBe(201);
    const body = (await jsonBody(res)) as ScheduledTask;
    expect(body.id).toBe('task-1710000000000-4fzzzx');
    expect(body.created_at).toBe('2024-03-09T16:00:00.000Z');
    expect(body.context_mode).toBe('group');
    expect(state.getTaskById(body.id)).toBeDefined();
  });

  it('defaults invalid context_mode to isolated on task creation', async () => {
    const res = await handle(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group_folder: 'agent-one',
          chat_jid: 'dc:123',
          prompt: 'Context mode fallback',
          schedule_type: 'interval',
          schedule_value: '60000',
          context_mode: 'invalid',
        }),
      }),
      makeState(),
    );

    expect(res.status).toBe(201);
    const body = (await jsonBody(res)) as ScheduledTask;
    expect(body.context_mode).toBe('isolated');
  });

  it('keeps once tasks next_run unchanged when resumed', async () => {
    let calculateCalls = 0;
    const state = makeState({
      getTaskById: (id) => {
        if (id !== 'task-paused') return undefined;
        return makeTask({
          id: 'task-paused',
          status: 'paused',
          schedule_type: 'once',
          schedule_value: '2026-12-31T00:00:00.000Z',
          next_run: '2026-12-31T00:00:00.000Z',
        });
      },
      calculateNextRun: () => {
        calculateCalls++;
        return '2099-01-01T00:00:00.000Z';
      },
    });

    const res = await handle(
      new Request('http://localhost/api/tasks/task-paused', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      }),
      state,
    );

    expect(res.status).toBe(200);
    const body = (await jsonBody(res)) as ScheduledTask;
    expect(body.next_run).toBe('2026-12-31T00:00:00.000Z');
    expect(calculateCalls).toBe(0);
  });

  it('validates schedule when schedule fields change even if task remains paused', async () => {
    const res = await handle(
      new Request('http://localhost/api/tasks/task-paused', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schedule_type: 'cron',
          schedule_value: 'not-a-cron',
        }),
      }),
      makeState({
        calculateNextRun: () => null,
      }),
    );

    expect(res.status).toBe(400);
    const body = (await jsonBody(res)) as { error: string };
    expect(body.error).toContain('Invalid schedule');
  });

  it('returns 500 when createTask throws', async () => {
    const res = await handle(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group_folder: 'agent-one',
          chat_jid: 'dc:123',
          prompt: 'will fail',
          schedule_type: 'cron',
          schedule_value: '0 9 * * *',
        }),
      }),
      makeState({
        createTask: () => {
          throw new Error('db write failed');
        },
      }),
    );

    expect(res.status).toBe(500);
    const body = (await jsonBody(res)) as { error: string };
    expect(body.error).toContain('db write failed');
  });

  it('returns context layers with fallback path resolution and existence flags', async () => {
    const readCalls: string[] = [];
    const contents: Record<string, string> = {
      'channels/dev/CLAUDE.md': '# channel',
      'server/global/CLAUDE.md': '# server',
    };

    const state = makeState({
      readContextFile: (filePath) => {
        readCalls.push(filePath);
        return contents[filePath] ?? null;
      },
    });

    const res = await handle(
      new Request(
        'http://localhost/api/context/layers?folder=channels/dev/CLAUDE.md&server_folder=server/global/CLAUDE.md',
        { method: 'GET' },
      ),
      state,
    );

    expect(res.status).toBe(200);
    const body = (await jsonBody(res)) as Record<
      string,
      { path: string | null; content: string | null; exists: boolean }
    >;

    expect(body.channel.path).toBe('channels/dev/CLAUDE.md');
    expect(body.channel.exists).toBe(true);
    expect(body.agent.path).toBe(null);
    expect(body.category.path).toBe(null);
    expect(body.server.exists).toBe(true);
    expect(readCalls).toContain('channels/dev/CLAUDE.md');
    expect(readCalls).toContain('server/global/CLAUDE.md');
  });

  it('rejects context file writes with path traversal', async () => {
    const res = await handle(
      new Request('http://localhost/api/context/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '../secrets', content: 'x' }),
      }),
      makeState(),
    );

    expect(res.status).toBe(400);
    const body = (await jsonBody(res)) as { error: string };
    expect(body.error).toContain('Invalid path');
  });

  it('writes context files via state provider', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const res = await handle(
      new Request('http://localhost/api/context/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'groups/main', content: '# updated' }),
      }),
      makeState({
        writeContextFile: (filePath, content) => {
          writes.push({ path: filePath, content });
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(writes).toEqual([{ path: 'groups/main', content: '# updated' }]);
  });

  it('rejects unsupported methods for context writes', async () => {
    const res = await handle(
      new Request('http://localhost/api/context/file', { method: 'GET' }),
      makeState(),
    );

    expect(res.status).toBe(405);
  });
});

describe('handleRequest task run logs', () => {
  const sampleRuns: TaskRunLog[] = [
    {
      task_id: 'task-001',
      run_at: '2026-03-10T12:00:00.000Z',
      duration_ms: 5000,
      status: 'success',
      result: 'Completed successfully',
      error: null,
    },
    {
      task_id: 'task-001',
      run_at: '2026-03-10T11:00:00.000Z',
      duration_ms: 2000,
      status: 'error',
      result: null,
      error: 'Something went wrong',
    },
  ];

  it('returns 404 for unknown task', async () => {
    const res = await handleRequest(
      new Request('http://localhost/api/tasks/nonexistent/runs'),
      makeState(makeAgent()),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Task not found');
  });

  it('returns run logs for existing task', async () => {
    const state: WebStateProvider = {
      ...makeState(makeAgent()),
      getTaskById: (id) =>
        id === 'task-001'
          ? {
              id: 'task-001',
              group_folder: 'test',
              chat_jid: 'dc:123',
              prompt: 'do stuff',
              schedule_type: 'cron',
              schedule_value: '0 * * * *',
              context_mode: 'isolated',
              next_run: '2026-03-10T13:00:00.000Z',
              last_run: '2026-03-10T12:00:00.000Z',
              last_result: 'Completed successfully',
              status: 'active',
              created_at: '2026-03-01T00:00:00.000Z',
            }
          : undefined,
      getTaskRunLogs: (taskId, limit) => {
        if (taskId !== 'task-001') return [];
        return sampleRuns.slice(0, limit ?? 20);
      },
    };

    const res = await handleRequest(
      new Request('http://localhost/api/tasks/task-001/runs'),
      state,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskRunLog[];
    expect(body).toHaveLength(2);
    expect(body[0].status).toBe('success');
    expect(body[1].status).toBe('error');
  });

  it('respects limit query param', async () => {
    const state: WebStateProvider = {
      ...makeState(makeAgent()),
      getTaskById: (id) =>
        id === 'task-001'
          ? {
              id: 'task-001',
              group_folder: 'test',
              chat_jid: 'dc:123',
              prompt: 'do stuff',
              schedule_type: 'cron',
              schedule_value: '0 * * * *',
              context_mode: 'isolated',
              next_run: null,
              last_run: null,
              last_result: null,
              status: 'active',
              created_at: '2026-03-01T00:00:00.000Z',
            }
          : undefined,
      getTaskRunLogs: (_taskId, limit) => sampleRuns.slice(0, limit ?? 20),
    };

    const res = await handleRequest(
      new Request('http://localhost/api/tasks/task-001/runs?limit=1'),
      state,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskRunLog[];
    expect(body).toHaveLength(1);
  });

  it('rejects non-GET methods', async () => {
    const state: WebStateProvider = {
      ...makeState(makeAgent()),
      getTaskById: () => ({
        id: 'task-001',
        group_folder: 'test',
        chat_jid: 'dc:123',
        prompt: 'do stuff',
        schedule_type: 'cron' as const,
        schedule_value: '0 * * * *',
        context_mode: 'isolated' as const,
        next_run: null,
        last_run: null,
        last_result: null,
        status: 'active' as const,
        created_at: '2026-03-01T00:00:00.000Z',
      }),
    };

    const res = await handleRequest(
      new Request('http://localhost/api/tasks/task-001/runs', {
        method: 'POST',
      }),
      state,
    );
    expect(res.status).toBe(405);
  });
});
