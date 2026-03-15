import { describe, expect, it } from 'bun:test';

import type { Agent, ChannelSubscription, ScheduledTask } from '../types.js';
import { handleRequest } from './routes.js';
import {
  renderAgentRow,
  renderAgentsContent,
  renderAgentsPage,
  renderAgentsPageWithRemote,
} from './agents-page.js';
import type { WebStateProvider } from './types.js';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
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
    prompt: 'Run scheduled check',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    next_run: null,
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeState(
  agents: Record<string, Agent> = { 'agent-1': makeAgent() },
  tasks: ScheduledTask[] = [],
): WebStateProvider {
  return {
    getAgents: () => agents,
    getChannelSubscriptions: () => ({
      'dc:123': [
        {
          channelJid: 'dc:123',
          agentId: 'agent-1',
          trigger: '@Test',
          requiresTrigger: true,
          priority: 100,
          isPrimary: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ] as ChannelSubscription[],
    }),
    getTasks: () => tasks,
    getTaskById: (id) => tasks.find((t) => t.id === id),
    getMessages: () => [],
    getChats: () => [
      {
        jid: 'dc:123',
        name: 'general',
        last_message_time: '2026-03-01T12:00:00.000Z',
      },
    ],
    getQueueStats: () => ({
      activeContainers: 1,
      idleContainers: 0,
      maxActive: 8,
      maxIdle: 4,
    }),
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
  };
}

describe('renderAgentRow', () => {
  it('renders agent name, backend badge, and detail link', () => {
    const agentData = {
      id: 'agent-1',
      name: 'Test Agent',
      folder: 'test-agent',
      backend: 'apple-container',
      agentRuntime: 'claude-agent-sdk',
      isAdmin: false,
      channels: [
        { jid: 'dc:123', displayName: 'general' },
      ],
    };

    const html = renderAgentRow(agentData, 2);

    expect(html).toContain('Test Agent');
    expect(html).toContain('apple-container');
    expect(html).toContain('badge-apple-container');
    expect(html).toContain('claude-agent-sdk');
    expect(html).toContain('data-agent-id="agent-1"');
    expect(html).toContain('>detail<');
    expect(html).toContain('>messages<');
  });

  it('renders admin badge when isAdmin is true', () => {
    const agentData = {
      id: 'admin-1',
      name: 'Admin Agent',
      folder: 'admin',
      backend: 'apple-container',
      agentRuntime: 'claude-agent-sdk',
      isAdmin: true,
      channels: [],
    };

    const html = renderAgentRow(agentData, 0);

    expect(html).toContain('badge-admin');
    expect(html).toContain('data-admin="true"');
  });

  it('renders remote badge for remote agents', () => {
    const agentData = {
      id: 'remote:agent-1',
      name: 'Remote Agent',
      folder: 'remote-agent',
      backend: 'docker',
      agentRuntime: 'opencode',
      isAdmin: false,
      remoteInstanceId: 'peer-abc',
      remoteInstanceName: 'macbook',
      channels: [],
    };

    const html = renderAgentRow(agentData, 0);

    expect(html).toContain('badge-remote');
    expect(html).toContain('macbook');
    expect(html).toContain('data-remote="true"');
    expect(html).toContain('badge-docker');
  });

  it('escapes HTML in agent name', () => {
    const agentData = {
      id: 'xss-1',
      name: '<script>alert("xss")</script>',
      folder: 'xss-agent',
      backend: 'apple-container',
      agentRuntime: 'claude-agent-sdk',
      isAdmin: false,
      channels: [],
    };

    const html = renderAgentRow(agentData, 0);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('omits messages link when agent has no channels', () => {
    const agentData = {
      id: 'agent-1',
      name: 'No Channels',
      folder: 'no-channels',
      backend: 'apple-container',
      agentRuntime: 'claude-agent-sdk',
      isAdmin: false,
      channels: [],
    };

    const html = renderAgentRow(agentData, 0);

    expect(html).toContain('>detail<');
    expect(html).not.toContain('>messages<');
  });

  it('renders avatar placeholder when no avatar URL', () => {
    const agentData = {
      id: 'agent-1',
      name: 'Test',
      folder: 'test',
      backend: 'apple-container',
      agentRuntime: 'claude-agent-sdk',
      isAdmin: false,
      channels: [],
    };

    const html = renderAgentRow(agentData, 0);

    expect(html).toContain('ap-avatar-ph');
    expect(html).toContain('>T<');
  });

  it('renders avatar image when avatar URL is present', () => {
    const agentData = {
      id: 'agent-1',
      name: 'Test',
      folder: 'test',
      backend: 'apple-container',
      agentRuntime: 'claude-agent-sdk',
      isAdmin: false,
      avatarUrl: 'https://example.com/avatar.png',
      channels: [],
    };

    const html = renderAgentRow(agentData, 0);

    expect(html).toContain('ap-avatar');
    expect(html).toContain('/api/agents/agent-1/avatar/image');
  });
});

describe('renderAgentsContent', () => {
  it('renders agents header with correct counts', () => {
    const agents = {
      'agent-1': makeAgent(),
      'agent-2': makeAgent({
        id: 'agent-2',
        name: 'Agent 2',
        folder: 'agent-2',
        backend: 'docker',
      }),
    };
    const state = makeState(agents);

    const html = renderAgentsContent(state);

    expect(html).toContain('Agents');
    expect(html).toContain('2 total');
    expect(html).toContain('2 local');
  });

  it('renders search input and filter dropdowns', () => {
    const html = renderAgentsContent(makeState());

    expect(html).toContain('id="ap-search"');
    expect(html).toContain('id="ap-filter-backend"');
    expect(html).toContain('id="ap-filter-runtime"');
    expect(html).toContain('All backends');
    expect(html).toContain('All runtimes');
  });

  it('renders backend options in filter dropdown', () => {
    const agents = {
      'agent-1': makeAgent({ backend: 'apple-container' }),
      'agent-2': makeAgent({
        id: 'agent-2',
        folder: 'agent-2',
        backend: 'docker',
      }),
    };

    const html = renderAgentsContent(makeState(agents));

    expect(html).toContain('<option value="apple-container">');
    expect(html).toContain('<option value="docker">');
  });

  it('renders empty state when no agents', () => {
    const html = renderAgentsContent(makeState({}));

    expect(html).toContain('No agents registered.');
  });

  it('renders remote agent count when remote peers present', () => {
    const remotePeers = [
      {
        instanceId: 'peer-1',
        instanceName: 'remote-mac',
        online: true,
        host: '192.168.1.10',
        port: 4444,
        agents: [
          {
            id: 'remote-agent',
            name: 'Remote',
            folder: 'remote',
            backend: 'docker' as const,
            agentRuntime: 'opencode' as const,
            channels: [],
          },
        ],
      },
    ];

    const html = renderAgentsContent(makeState(), remotePeers);

    expect(html).toContain('1 remote');
    expect(html).toContain('Remote');
  });

  it('renders task counts per agent', () => {
    const tasks = [
      makeTask({ id: 'task-1', group_folder: 'test-agent' }),
      makeTask({ id: 'task-2', group_folder: 'test-agent' }),
    ];
    const state = makeState({ 'agent-1': makeAgent() }, tasks);

    const html = renderAgentsContent(state);

    // The agent row should show task count of 2
    expect(html).toContain('>2<');
  });

  it('includes table headers', () => {
    const html = renderAgentsContent(makeState());

    expect(html).toContain('>agent<');
    expect(html).toContain('>backend<');
    expect(html).toContain('>runtime<');
    expect(html).toContain('>channels<');
    expect(html).toContain('>tasks<');
    expect(html).toContain('>flags<');
    expect(html).toContain('>actions<');
  });
});

describe('renderAgentsPage', () => {
  it('wraps content in the shared shell with correct title', () => {
    const html = renderAgentsPage(makeState());

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title id="page-title">OmniClaw — Agents</title>');
    expect(html).toContain('class="nav-link active">Agents</a>');
  });
});

describe('renderAgentsPageWithRemote', () => {
  it('includes remote peers in the rendered page', () => {
    const remotePeers = [
      {
        instanceId: 'peer-1',
        instanceName: 'office-mac',
        online: true,
        host: '192.168.1.5',
        port: 4444,
        agents: [
          {
            id: 'remote-a',
            name: 'Office Agent',
            folder: 'office',
            backend: 'apple-container' as const,
            agentRuntime: 'claude-agent-sdk' as const,
            channels: [],
          },
        ],
      },
    ];

    const html = renderAgentsPageWithRemote(makeState(), remotePeers);

    expect(html).toContain('Office Agent');
    expect(html).toContain('office-mac');
  });
});

describe('GET /agents-list', () => {
  it('returns the agents page HTML', async () => {
    const response = await handleRequest(
      new Request('http://localhost/agents-list'),
      makeState(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    );
    const body = await response.text();
    expect(body).toContain('Agents');
    expect(body).toContain('Test Agent');
  });
});

describe('GET /api/page/agents', () => {
  it('returns JSON with HTML content for SPA navigation', async () => {
    // The /api/page/agents route is served by server.ts, but we can test
    // the underlying content renderer that it calls
    const html = renderAgentsContent(makeState());

    expect(html).toContain('agents-page');
    expect(html).toContain('ap-table');
    expect(html).toContain('Test Agent');
  });
});

describe('navigation', () => {
  it('agents link appears in navigation bar', () => {
    const html = renderAgentsPage(makeState());

    expect(html).toContain('href="/agents-list"');
    expect(html).toContain('data-page="agents"');
    expect(html).toContain('>Agents<');
  });
});
