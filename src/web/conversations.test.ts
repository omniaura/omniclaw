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

const testMessages = [
  {
    id: 'msg-1',
    chat_jid: 'dc:123',
    sender: 'user1',
    sender_name: 'Alice',
    content: 'Hello from Alice',
    timestamp: '2026-03-01T12:00:00.000Z',
  },
  {
    id: 'msg-2',
    chat_jid: 'dc:123',
    sender: 'bot',
    sender_name: 'OmniClaw',
    content: 'Hello from the bot',
    timestamp: '2026-03-01T12:01:00.000Z',
  },
  {
    id: 'msg-3',
    chat_jid: 'dc:456',
    sender: 'user2',
    sender_name: 'Bob',
    content: 'Message in another chat',
    timestamp: '2026-03-01T12:02:00.000Z',
  },
];

const testChats = [
  {
    jid: 'dc:123',
    name: 'general',
    last_message_time: '2026-03-01T12:01:00.000Z',
  },
  {
    jid: 'dc:456',
    name: 'dev-chat',
    last_message_time: '2026-03-01T12:02:00.000Z',
  },
];

function makeState(
  overrides: Partial<WebStateProvider> = {},
): WebStateProvider {
  return {
    getAgents: () => ({
      'test-agent': makeAgent(),
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
    getTasks: () => [makeTask()],
    getTaskById: (id) => (id === 'task-001' ? makeTask() : undefined),
    getMessages: (chatJid, _since, limit) => {
      const filtered = testMessages.filter((m) => m.chat_jid === chatJid);
      return limit ? filtered.slice(0, limit) : filtered;
    },
    getChats: () => testChats,
    getQueueStats: () => defaultStats,
    getQueueDetails: () => [],
    getIpcEvents: () => [],
    getTaskRunLogs: () => [],
    createTask: () => {},
    updateTask: () => {},
    deleteTask: () => {},
    calculateNextRun: () => '2026-03-03T09:00:00.000Z',
    readContextFile: () => null,
    writeContextFile: () => {},
    updateAgentAvatar: () => {},
    ...overrides,
  };
}

// ---- Test suite ----

const testAuth = { username: 'admin', password: 'secret' };
const authHeader = `Basic ${btoa(`${testAuth.username}:${testAuth.password}`)}`;

let handle: WebServerHandle | null = null;

afterEach(async () => {
  if (handle) {
    await handle.stop();
    handle = null;
  }
});

function url(path: string): string {
  return `http://localhost:${handle!.port}${path}`;
}

function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has('Authorization')) headers.set('Authorization', authHeader);
  return fetch(url(path), { ...init, headers });
}

function testConfig(
  overrides: Partial<import('./types.js').WebServerConfig> = {},
) {
  return { port: 0, auth: testAuth, ...overrides };
}

describe('conversations page', () => {
  it('serves conversations HTML at /conversations', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/conversations');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('OmniClaw');
    expect(html).toContain('Conversations');
  });

  it('renders chat list from state', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/conversations');
    const html = await res.text();
    expect(html).toContain('general');
    expect(html).toContain('dev-chat');
    expect(html).toContain('dc:123');
    expect(html).toContain('dc:456');
  });

  it('shows chat count', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/conversations');
    const html = await res.text();
    expect(html).toContain('2 chats');
  });

  it('shows singular count for 1 chat', async () => {
    const state = makeState({
      getChats: () => [testChats[0]],
    });
    handle = startWebServer(testConfig(), state);
    const res = await authedFetch('/conversations');
    const html = await res.text();
    expect(html).toContain('1 chat');
    // Should not contain "1 chats"
    expect(html).not.toContain('1 chats');
  });

  it('handles empty chat list', async () => {
    const state = makeState({ getChats: () => [] });
    handle = startWebServer(testConfig(), state);
    const res = await authedFetch('/conversations');
    const html = await res.text();
    expect(html).toContain('0 chats');
    expect(html).toContain('No chats found');
  });

  it('escapes HTML in chat names', async () => {
    const state = makeState({
      getChats: () => [
        {
          jid: 'dc:xss',
          name: '<script>alert("xss")</script>',
          last_message_time: '2026-03-01T12:00:00.000Z',
        },
      ],
    });
    handle = startWebServer(testConfig(), state);
    const res = await authedFetch('/conversations');
    const html = await res.text();
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('includes navigation links', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/conversations');
    const html = await res.text();
    // Has link back to dashboard
    expect(html).toContain('href="/"');
    expect(html).toContain('Dashboard');
    // Has active conversations link
    expect(html).toContain('href="/conversations"');
  });
});

describe('dashboard navigation', () => {
  it('includes link to conversations from dashboard', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/');
    const html = await res.text();
    expect(html).toContain('href="/conversations"');
    expect(html).toContain('Conversations');
  });
});

describe('messages API for conversations', () => {
  it('returns messages for a specific chat', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/api/messages/dc:123');
    expect(res.status).toBe(200);
    const messages = (await res.json()) as Array<{ sender_name: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[1].sender_name).toBe('OmniClaw');
  });

  it('returns messages for a different chat', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/api/messages/dc:456');
    expect(res.status).toBe(200);
    const messages = (await res.json()) as Array<{ sender_name: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].sender_name).toBe('Bob');
  });

  it('returns empty array for unknown chat', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/api/messages/dc:unknown');
    expect(res.status).toBe(200);
    const messages = (await res.json()) as Array<unknown>;
    expect(messages).toHaveLength(0);
  });

  it('respects limit parameter', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/api/messages/dc:123?limit=1');
    expect(res.status).toBe(200);
    const messages = (await res.json()) as Array<unknown>;
    expect(messages).toHaveLength(1);
  });

  it('chats endpoint returns all chats', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/api/chats');
    expect(res.status).toBe(200);
    const chats = (await res.json()) as Array<{ name: string }>;
    expect(chats).toHaveLength(2);
    expect(chats[0].name).toBe('general');
    expect(chats[1].name).toBe('dev-chat');
  });
});
