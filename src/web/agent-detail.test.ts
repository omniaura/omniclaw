import { describe, it, expect, afterEach } from 'bun:test';

import { startWebServer, type WebServerHandle } from './server.js';
import type { WebStateProvider, QueueStats } from './types.js';
import type { Agent, ChannelSubscription, ScheduledTask } from '../types.js';
import type { RemotePeerAgents } from '../discovery/types.js';
import {
  buildAgentDetailData,
  renderAgentDetailContent,
} from './agent-detail.js';

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
    executing_since: null,
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

const remotePeers: RemotePeerAgents[] = [
  {
    instanceId: 'peer-1',
    instanceName: 'orangepi5',
    online: true,
    host: '10.0.0.12',
    port: 7777,
    agents: [
      {
        id: 'remote:agent',
        name: 'Remote Agent',
        folder: 'agents/remote',
        backend: 'docker',
        agentRuntime: 'opencode',
        avatarUrl: 'https://example.test/remote.png',
        channels: [
          {
            jid: 'dc:999',
            displayName: 'Remote Channel',
            channelFolder: 'servers/remote/spec',
            categoryFolder: 'servers/remote',
          },
        ],
      },
    ],
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
    getMessages: () => [],
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
    resolveChatImage: async () => null,
    resolveDiscordGuildImage: async () => null,
    ...overrides,
  };
}

// ---- Unit tests for buildAgentDetailData ----

describe('buildAgentDetailData', () => {
  it('returns null for unknown agent', () => {
    const state = makeState();
    expect(buildAgentDetailData('nonexistent', state)).toBeNull();
  });

  it('returns agent data for valid ID', () => {
    const state = makeState();
    const data = buildAgentDetailData('test-agent', state);
    expect(data).not.toBeNull();
    expect(data!.id).toBe('test-agent');
    expect(data!.name).toBe('Test Agent');
    expect(data!.backend).toBe('apple-container');
    expect(data!.agentRuntime).toBe('claude-agent-sdk');
    expect(data!.isAdmin).toBe(false);
  });

  it('includes subscribed channels', () => {
    const state = makeState();
    const data = buildAgentDetailData('test-agent', state);
    expect(data!.channels).toHaveLength(1);
    expect(data!.channels[0].jid).toBe('dc:123');
    expect(data!.channels[0].displayName).toBe('general');
  });

  it('includes tasks matching agent folder', () => {
    const state = makeState();
    const data = buildAgentDetailData('test-agent', state);
    expect(data!.tasks).toHaveLength(1);
    expect(data!.tasks[0].id).toBe('task-001');
    expect(data!.tasks[0].prompt).toBe('Run the daily check');
  });

  it('excludes tasks for other agents', () => {
    const state = makeState({
      getTasks: () => [
        makeTask(),
        makeTask({ id: 'task-002', group_folder: 'other-agent' }),
      ],
    });
    const data = buildAgentDetailData('test-agent', state);
    expect(data!.tasks).toHaveLength(1);
    expect(data!.tasks[0].id).toBe('task-001');
  });

  it('includes recent chats for subscribed channels', () => {
    const state = makeState();
    const data = buildAgentDetailData('test-agent', state);
    // Agent is subscribed to dc:123 (general), not dc:456 (dev-chat)
    expect(data!.recentChats).toHaveLength(1);
    expect(data!.recentChats[0].jid).toBe('dc:123');
    expect(data!.recentChats[0].name).toBe('general');
  });

  it('includes admin agent details', () => {
    const state = makeState({
      getAgents: () => ({
        'test-agent': makeAgent({
          isAdmin: true,
          description: 'Main admin bot',
          serverFolder: 'servers/test-server',
          agentContextFolder: 'agents/test',
        }),
      }),
    });
    const data = buildAgentDetailData('test-agent', state);
    expect(data!.isAdmin).toBe(true);
    expect(data!.description).toBe('Main admin bot');
    expect(data!.serverFolder).toBe('servers/test-server');
    expect(data!.agentContextFolder).toBe('agents/test');
  });

  it('returns remote agent data when the ID matches a trusted peer agent', () => {
    const data = buildAgentDetailData(
      'peer-1:remote:agent',
      makeState(),
      remotePeers,
    );
    expect(data).not.toBeNull();
    expect(data!.id).toBe('peer-1:remote:agent');
    expect(data!.name).toBe('Remote Agent');
    expect(data!.remoteInstanceId).toBe('peer-1');
    expect(data!.remoteInstanceName).toBe('orangepi5');
    expect(data!.channels).toHaveLength(1);
    expect(data!.tasks).toHaveLength(0);
  });
});

// ---- Unit tests for renderAgentDetailContent ----

describe('renderAgentDetailContent', () => {
  it('renders not-found when data is null', () => {
    const html = renderAgentDetailContent(null, 'missing-id');
    expect(html).toContain('Agent not found');
    expect(html).toContain('missing-id');
    expect(html).toContain('Back to Dashboard');
  });

  it('renders agent name and badges', () => {
    const data = buildAgentDetailData('test-agent', makeState())!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('Test Agent');
    expect(html).toContain('apple-container');
    expect(html).toContain('claude-agent-sdk');
  });

  it('renders admin badge when agent is admin', () => {
    const state = makeState({
      getAgents: () => ({
        'test-agent': makeAgent({ isAdmin: true }),
      }),
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('badge-admin');
    expect(html).toContain('admin');
  });

  it('renders channels table', () => {
    const data = buildAgentDetailData('test-agent', makeState())!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('general');
    expect(html).toContain('dc:123');
    expect(html).toContain('messages');
  });

  it('renders tasks table with status badges', () => {
    const data = buildAgentDetailData('test-agent', makeState())!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('Run the daily check');
    expect(html).toContain('status-active');
    expect(html).toContain('cron');
  });

  it('renders recent conversations', () => {
    const data = buildAgentDetailData('test-agent', makeState())!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('conversations');
    expect(html).toContain('general');
  });

  it('renders info grid with agent metadata', () => {
    const data = buildAgentDetailData('test-agent', makeState())!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('test-agent'); // id
    expect(html).toContain('ad-info-grid');
    expect(html).toContain('folder');
  });

  it('renders description when present', () => {
    const state = makeState({
      getAgents: () => ({
        'test-agent': makeAgent({ description: 'A helpful assistant' }),
      }),
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('A helpful assistant');
  });

  it('truncates long prompts in task table display text', () => {
    const longPrompt = 'x'.repeat(100);
    const state = makeState({
      getTasks: () => [makeTask({ prompt: longPrompt })],
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    // Displayed text truncated to 80 chars + ellipsis, full prompt in title attr
    expect(html).toContain('\u2026');
    // The td content should be truncated (80 x's + ellipsis)
    expect(html).toContain('>' + 'x'.repeat(80) + '\u2026<');
  });

  it('shows empty state for channels when none subscribed', () => {
    const state = makeState({
      getChannelSubscriptions: () => ({}),
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('No channels subscribed');
  });

  it('shows empty state for tasks when none exist', () => {
    const state = makeState({
      getTasks: () => [],
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('No scheduled tasks');
  });

  it('shows empty state for conversations when none exist', () => {
    const state = makeState({
      getChannelSubscriptions: () => ({}),
      getChats: () => [],
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('No conversations');
  });

  it('includes back-to-dashboard link', () => {
    const data = buildAgentDetailData('test-agent', makeState())!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('dashboard');
    expect(html).toContain('data-nav');
    expect(html).toContain('data-page="dashboard"');
  });

  it('renders avatar when URL is present', () => {
    const state = makeState({
      getAgents: () => ({
        'test-agent': makeAgent({
          avatarUrl: 'https://example.com/avatar.png',
        }),
      }),
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('ad-avatar');
    expect(html).toContain('/api/agents/test-agent/avatar/image');
  });

  it('renders placeholder when no avatar URL', () => {
    const data = buildAgentDetailData('test-agent', makeState())!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('ad-avatar-placeholder');
    expect(html).toContain('T'); // First letter of "Test Agent"
  });

  it('renders remote avatar and peer badge for remote agents', () => {
    const data = buildAgentDetailData(
      'peer-1:remote:agent',
      makeState(),
      remotePeers,
    )!;
    const html = renderAgentDetailContent(data, 'peer-1:remote:agent');
    expect(html).toContain('badge-remote');
    expect(html).toContain('orangepi5');
    expect(html).toContain(
      '/api/discovery/peers/peer-1/agents/remote%3Aagent/avatar/image',
    );
  });
});

// ---- Integration tests: HTTP routes ----

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

describe('/agents page route', () => {
  it('serves agent detail HTML at /agents?id=test-agent', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/agents?id=test-agent');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('OmniClaw');
    expect(html).toContain('Test Agent');
  });

  it('shows not-found for unknown agent', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/agents?id=nonexistent');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Agent not found');
    expect(html).toContain('nonexistent');
  });

  it('shows not-found when no id param', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/agents');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Agent not found');
  });
});

interface JsonObject {
  [key: string]: unknown;
}

describe('/api/agents/:id/detail endpoint', () => {
  it('returns enriched agent data as JSON', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/api/agents/test-agent/detail');
    expect(res.status).toBe(200);
    const data = (await res.json()) as JsonObject;
    expect(data.id).toBe('test-agent');
    expect(data.name).toBe('Test Agent');
    expect(data.channels).toHaveLength(1);
    expect(data.tasks).toHaveLength(1);
    expect(data.recentChats).toHaveLength(1);
  });

  it('returns 404 for unknown agent', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/api/agents/nonexistent/detail');
    expect(res.status).toBe(404);
    const data = (await res.json()) as JsonObject;
    expect(data.error).toBe('Agent not found');
  });

  it('requires authentication', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await fetch(url('/api/agents/test-agent/detail'));
    expect(res.status).toBe(401);
  });
});

describe('/api/page/agent-detail SPA navigation', () => {
  it('returns a Datastar patch response for known agents', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/api/page/agent-detail?id=test-agent');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Test Agent');
    expect(body).toContain(
      '<title id="page-title">OmniClaw — Test Agent</title>',
    );
  });

  it('returns not-found patch content for unknown agents', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/api/page/agent-detail?id=bad');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Agent not found');
    expect(body).toContain(
      '<title id="page-title">OmniClaw — Agent Not Found</title>',
    );
  });
});
