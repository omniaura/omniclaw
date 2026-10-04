import { describe, expect, it } from 'bun:test';

import type { Agent, ChannelSubscription, ScheduledTask } from '../types.js';
import type { GroupQueueDetail } from '../group-queue.js';
import { handleRequest } from './routes.js';
import {
  buildAgentRowsHtml,
  countWorkingAgents,
  deriveAgentStatus,
  getAgentExecReason,
  getAgentExecStatus,
  getAgentQueueDepth,
  getAgentRunningMs,
  renderAgentRow,
  renderExecStatusBadge,
  renderRuntimeCell,
  renderAgentsContent,
  renderAgentsPage,
  renderAgentsPageWithRemote,
  shortenModelLabel,
} from './agents-page.js';
import type { WebStateProvider } from './types.js';
import type { AgentChannelData } from './agent-channels.js';

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
    executing_since: null,
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
    getTaskRunPhaseEvents: () => [],
    searchMessages: () => [],
    createTask: () => {},
    updateTask: () => {},
    deleteTask: () => {},
    calculateNextRun: () => '2026-03-03T09:00:00.000Z',
    readContextFile: () => null,
    writeContextFile: () => {},
    updateAgentAvatar: () => {},
    setAgentEnabled: () => true,
    setAgentModel: () => true,
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
      channels: [{ jid: 'dc:123', displayName: 'general' }],
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

  it('annotates local count with disabled rollup when an agent is disabled', () => {
    const agents = {
      'agent-1': makeAgent(),
      'agent-2': makeAgent({
        id: 'agent-2',
        name: 'Agent 2',
        folder: 'agent-2',
        enabled: false,
      }),
      'agent-3': makeAgent({
        id: 'agent-3',
        name: 'Agent 3',
        folder: 'agent-3',
        enabled: false,
      }),
    };

    const html = renderAgentsContent(makeState(agents));

    expect(html).toContain('3 local (2 disabled)');
    expect(html).toContain('3 total');
  });

  it('omits the disabled rollup when no local agent is disabled', () => {
    const agents = {
      'agent-1': makeAgent(),
      'agent-2': makeAgent({
        id: 'agent-2',
        name: 'Agent 2',
        folder: 'agent-2',
      }),
    };

    const html = renderAgentsContent(makeState(agents));

    expect(html).toContain('2 local</span>');
    expect(html).not.toContain('disabled)');
  });

  it('excludes remote agents from the disabled rollup even when their enabled flag is false', () => {
    const agents = {
      'agent-1': makeAgent({ enabled: false }),
    };
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

    const html = renderAgentsContent(makeState(agents), remotePeers);

    expect(html).toContain('1 local (1 disabled)');
    expect(html).toContain('1 remote');
  });

  it('annotates the total count with a working rollup when agents are live', () => {
    const state = makeState();
    state.getQueueDetails = () => [
      makeQueueDetail({
        messageLane: {
          active: true,
          idle: false,
          pendingCount: 0,
          containerName: 'ctr-1',
        },
      }),
    ];

    const html = renderAgentsContent(state);

    expect(html).toContain('1 total (1 working)');
  });

  it('omits the working rollup when no agent is actively working', () => {
    const html = renderAgentsContent(makeState());

    expect(html).toContain('1 total</span>');
    expect(html).not.toContain('working)');
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

// --- Execution status ---

function makeQueueDetail(
  overrides: Partial<GroupQueueDetail> = {},
): GroupQueueDetail {
  return {
    folderKey: 'test-agent',
    messageLane: {
      active: false,
      idle: false,
      pendingCount: 0,
      containerName: null,
    },
    taskLane: {
      active: false,
      pendingCount: 0,
      containerName: null,
      activeTask: null,
    },
    retryCount: 0,
    ...overrides,
  };
}

describe('getAgentExecStatus', () => {
  it('returns "offline" when agent has no queue entry', () => {
    expect(getAgentExecStatus('test-agent', [])).toBe('offline');
  });

  it('returns "executing" when message lane is active and not idle', () => {
    const details = [
      makeQueueDetail({
        messageLane: {
          active: true,
          idle: false,
          pendingCount: 0,
          containerName: 'ctr-1',
        },
      }),
    ];
    expect(getAgentExecStatus('test-agent', details)).toBe('executing');
  });

  it('returns "running-task" when task lane is active', () => {
    const details = [
      makeQueueDetail({
        taskLane: {
          active: true,
          pendingCount: 0,
          containerName: 'ctr-1',
          activeTask: {
            taskId: 'task-1',
            promptPreview: 'Run check',
            startedAt: Date.now(),
            runningMs: 1000,
          },
        },
      }),
    ];
    expect(getAgentExecStatus('test-agent', details)).toBe('running-task');
  });

  it('returns "idle" when message lane is idle-waiting', () => {
    const details = [
      makeQueueDetail({
        messageLane: {
          active: true,
          idle: true,
          pendingCount: 0,
          containerName: 'ctr-1',
        },
      }),
    ];
    expect(getAgentExecStatus('test-agent', details)).toBe('idle');
  });

  it('returns "queued" when messages are pending', () => {
    const details = [
      makeQueueDetail({
        messageLane: {
          active: false,
          idle: false,
          pendingCount: 3,
          containerName: null,
        },
      }),
    ];
    expect(getAgentExecStatus('test-agent', details)).toBe('queued');
  });

  it('returns "queued" when tasks are pending', () => {
    const details = [
      makeQueueDetail({
        taskLane: {
          active: false,
          pendingCount: 2,
          containerName: null,
          activeTask: null,
        },
      }),
    ];
    expect(getAgentExecStatus('test-agent', details)).toBe('queued');
  });

  it('returns "offline" when queue entry exists but nothing active or pending', () => {
    const details = [makeQueueDetail()];
    expect(getAgentExecStatus('test-agent', details)).toBe('offline');
  });

  it('executing takes priority over running-task', () => {
    const details = [
      makeQueueDetail({
        messageLane: {
          active: true,
          idle: false,
          pendingCount: 0,
          containerName: 'ctr-1',
        },
        taskLane: {
          active: true,
          pendingCount: 0,
          containerName: 'ctr-2',
          activeTask: {
            taskId: 'task-1',
            promptPreview: 'Run check',
            startedAt: Date.now(),
            runningMs: 500,
          },
        },
      }),
    ];
    expect(getAgentExecStatus('test-agent', details)).toBe('executing');
  });

  it('matches by folder key', () => {
    const details = [
      makeQueueDetail({
        folderKey: 'other-agent',
        messageLane: {
          active: true,
          idle: false,
          pendingCount: 0,
          containerName: 'ctr-1',
        },
      }),
    ];
    expect(getAgentExecStatus('test-agent', details)).toBe('offline');
    expect(getAgentExecStatus('other-agent', details)).toBe('executing');
  });
});

function makeChannelData(
  overrides: Partial<AgentChannelData> = {},
): AgentChannelData {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    folder: 'test-agent',
    backend: 'apple-container',
    agentRuntime: 'claude-agent-sdk',
    isAdmin: false,
    channels: [],
    ...overrides,
  };
}

describe('deriveAgentStatus', () => {
  it('reads remote agents as offline regardless of queue', () => {
    const details = [
      makeQueueDetail({
        messageLane: {
          active: true,
          idle: false,
          pendingCount: 0,
          containerName: 'ctr-1',
        },
      }),
    ];
    const agent = makeChannelData({ remoteInstanceId: 'peer-1' });
    expect(deriveAgentStatus(agent, {}, details)).toBe('offline');
  });

  it('reads operator-disabled local agents as disabled', () => {
    const agent = makeChannelData();
    const agents = { 'agent-1': makeAgent({ enabled: false }) };
    expect(deriveAgentStatus(agent, agents, [])).toBe('disabled');
  });

  it('falls back to the live queue status for enabled local agents', () => {
    const details = [
      makeQueueDetail({
        taskLane: {
          active: true,
          pendingCount: 0,
          containerName: 'ctr-1',
          activeTask: {
            taskId: 'task-1',
            promptPreview: 'Run check',
            startedAt: 1_000,
            runningMs: 1_000,
          },
        },
      }),
    ];
    const agent = makeChannelData();
    expect(deriveAgentStatus(agent, {}, details)).toBe('running-task');
  });
});

describe('countWorkingAgents', () => {
  it('returns zero when nothing is active', () => {
    expect(countWorkingAgents([makeChannelData()], {}, [])).toBe(0);
  });

  it('counts both executing and running-task agents', () => {
    const agents = [
      makeChannelData({ id: 'a1', folder: 'a1' }),
      makeChannelData({ id: 'a2', folder: 'a2' }),
    ];
    const details = [
      makeQueueDetail({
        folderKey: 'a1',
        messageLane: {
          active: true,
          idle: false,
          pendingCount: 0,
          containerName: 'ctr-1',
        },
      }),
      makeQueueDetail({
        folderKey: 'a2',
        taskLane: {
          active: true,
          pendingCount: 0,
          containerName: 'ctr-2',
          activeTask: {
            taskId: 'task-1',
            promptPreview: 'Run check',
            startedAt: 1_000,
            runningMs: 1_000,
          },
        },
      }),
    ];
    expect(countWorkingAgents(agents, {}, details)).toBe(2);
  });

  it('excludes idle, queued, disabled, and remote agents', () => {
    const agents = [
      makeChannelData({ id: 'idle', folder: 'idle' }),
      makeChannelData({ id: 'agent-1', folder: 'disabled-folder' }),
      makeChannelData({
        id: 'remote',
        folder: 'remote',
        remoteInstanceId: 'p1',
      }),
    ];
    const details = [
      makeQueueDetail({
        folderKey: 'idle',
        messageLane: {
          active: true,
          idle: true,
          pendingCount: 0,
          containerName: 'ctr-1',
        },
      }),
      // Remote agent's folder has an active lane, but remote reads as offline.
      makeQueueDetail({
        folderKey: 'remote',
        messageLane: {
          active: true,
          idle: false,
          pendingCount: 0,
          containerName: 'ctr-2',
        },
      }),
    ];
    const localAgents = { 'agent-1': makeAgent({ enabled: false }) };
    expect(countWorkingAgents(agents, localAgents, details)).toBe(0);
  });
});

describe('renderExecStatusBadge', () => {
  it('renders executing badge with correct CSS class', () => {
    const html = renderExecStatusBadge('executing');
    expect(html).toContain('exec-executing');
    expect(html).toContain('executing');
  });

  it('renders running-task badge', () => {
    const html = renderExecStatusBadge('running-task');
    expect(html).toContain('exec-task');
    expect(html).toContain('task');
  });

  it('renders idle badge', () => {
    const html = renderExecStatusBadge('idle');
    expect(html).toContain('exec-idle');
    expect(html).toContain('idle');
  });

  it('renders queued badge', () => {
    const html = renderExecStatusBadge('queued');
    expect(html).toContain('exec-queued');
    expect(html).toContain('queued');
  });

  it('renders offline badge', () => {
    const html = renderExecStatusBadge('offline');
    expect(html).toContain('exec-offline');
    expect(html).toContain('offline');
  });

  it('appends lane-reason badge when reason is provided for idle status', () => {
    const html = renderExecStatusBadge('idle', 'cooling-down');
    expect(html).toContain('exec-idle');
    expect(html).toContain('lane-reason reason-cooling-down');
    expect(html).toContain('data-exec-reason="cooling-down"');
    expect(html).toContain('>cooling-down<');
  });

  it('appends lane-reason badge for offline + no-work', () => {
    const html = renderExecStatusBadge('offline', 'no-work');
    expect(html).toContain('exec-offline');
    expect(html).toContain('lane-reason reason-no-work');
  });

  it('appends lane-reason badge for queued + back-pressure', () => {
    const html = renderExecStatusBadge('queued', 'back-pressure');
    expect(html).toContain('exec-queued');
    expect(html).toContain('lane-reason reason-back-pressure');
  });

  it('appends lane-reason badge for offline + retrying', () => {
    const html = renderExecStatusBadge('offline', 'retrying');
    expect(html).toContain('lane-reason reason-retrying');
  });

  it('omits lane-reason badge when status is executing (label already conveys it)', () => {
    const html = renderExecStatusBadge('executing', 'running');
    expect(html).toContain('exec-executing');
    expect(html).not.toContain('lane-reason');
  });

  it('omits lane-reason badge when status is running-task', () => {
    const html = renderExecStatusBadge('running-task', 'running');
    expect(html).not.toContain('lane-reason');
  });

  it('omits lane-reason badge when status is disabled', () => {
    const html = renderExecStatusBadge('disabled', 'no-work');
    expect(html).toContain('exec-disabled');
    expect(html).not.toContain('lane-reason');
  });

  it('omits lane-reason badge when reason is null', () => {
    const html = renderExecStatusBadge('offline', null);
    expect(html).toContain('exec-offline');
    expect(html).not.toContain('lane-reason');
  });

  it('ignores unknown reason codes (defensive)', () => {
    // Cast through unknown to simulate a corrupt/stale fixture passing an
    // unrecognized reason. Should silently omit the badge rather than emit
    // an unstyled span.
    const html = renderExecStatusBadge(
      'offline',
      'mystery' as unknown as 'no-work',
    );
    expect(html).not.toContain('lane-reason');
  });
});

describe('getAgentExecReason', () => {
  it('returns null when there is no queue detail for the folder', () => {
    expect(getAgentExecReason('test-agent', [])).toBeNull();
  });

  it('returns "running" when message lane is actively processing', () => {
    const details = [
      makeQueueDetail({
        messageLane: {
          active: true,
          idle: false,
          pendingCount: 0,
          containerName: 'ctr-1',
        },
      }),
    ];
    expect(getAgentExecReason('test-agent', details)).toBe('running');
  });

  it('returns "cooling-down" when message lane is idle-waiting', () => {
    const details = [
      makeQueueDetail({
        messageLane: {
          active: true,
          idle: true,
          pendingCount: 0,
          containerName: 'ctr-1',
        },
      }),
    ];
    expect(getAgentExecReason('test-agent', details)).toBe('cooling-down');
  });

  it('returns "back-pressure" when messages are pending but lane is idle', () => {
    const details = [
      makeQueueDetail({
        messageLane: {
          active: false,
          idle: false,
          pendingCount: 4,
          containerName: null,
        },
      }),
    ];
    expect(getAgentExecReason('test-agent', details)).toBe('back-pressure');
  });

  it('returns "retrying" when retryCount > 0 and lane is idle', () => {
    const details = [
      makeQueueDetail({
        messageLane: {
          active: false,
          idle: false,
          pendingCount: 0,
          containerName: null,
        },
        retryCount: 2,
      }),
    ];
    expect(getAgentExecReason('test-agent', details)).toBe('retrying');
  });

  it('returns "no-work" when nothing is pending or running', () => {
    const details = [makeQueueDetail()];
    expect(getAgentExecReason('test-agent', details)).toBe('no-work');
  });

  it('honors an explicit reason on the detail when present', () => {
    const details = [
      makeQueueDetail({
        messageLane: {
          active: false,
          idle: false,
          pendingCount: 0,
          containerName: null,
          reason: 'retrying',
        },
      }),
    ];
    expect(getAgentExecReason('test-agent', details)).toBe('retrying');
  });

  it('matches by folder key', () => {
    const details = [
      makeQueueDetail({
        folderKey: 'other-agent',
        messageLane: {
          active: true,
          idle: false,
          pendingCount: 0,
          containerName: 'ctr-1',
        },
      }),
    ];
    expect(getAgentExecReason('test-agent', details)).toBeNull();
    expect(getAgentExecReason('other-agent', details)).toBe('running');
  });
});

describe('renderAgentRow with status', () => {
  it('renders execution status badge when status is provided', () => {
    const agentData = {
      id: 'agent-1',
      name: 'Test Agent',
      folder: 'test-agent',
      backend: 'apple-container',
      agentRuntime: 'claude-agent-sdk',
      isAdmin: false,
      channels: [],
    };

    const html = renderAgentRow(agentData, 0, 'executing');
    expect(html).toContain('exec-executing');
  });

  it('defaults to offline status when no status provided', () => {
    const agentData = {
      id: 'agent-1',
      name: 'Test Agent',
      folder: 'test-agent',
      backend: 'apple-container',
      agentRuntime: 'claude-agent-sdk',
      isAdmin: false,
      channels: [],
    };

    const html = renderAgentRow(agentData, 0);
    expect(html).toContain('exec-offline');
  });

  it('renders the lane-reason badge when a reason is passed alongside an idle status', () => {
    const agentData = {
      id: 'agent-1',
      name: 'Test Agent',
      folder: 'test-agent',
      backend: 'apple-container',
      agentRuntime: 'claude-agent-sdk',
      isAdmin: false,
      channels: [],
    };

    const html = renderAgentRow(agentData, 0, 'idle', 'cooling-down');
    expect(html).toContain('exec-idle');
    expect(html).toContain('lane-reason reason-cooling-down');
  });

  it('omits the lane-reason badge for executing rows even when a reason is passed', () => {
    const agentData = {
      id: 'agent-1',
      name: 'Test Agent',
      folder: 'test-agent',
      backend: 'apple-container',
      agentRuntime: 'claude-agent-sdk',
      isAdmin: false,
      channels: [],
    };

    const html = renderAgentRow(agentData, 0, 'executing', 'running');
    expect(html).toContain('exec-executing');
    expect(html).not.toContain('lane-reason');
  });
});

describe('renderAgentsContent with execution status', () => {
  it('includes status column header', () => {
    const html = renderAgentsContent(makeState());
    expect(html).toContain('>status<');
  });

  it('renders executing status when queue shows active message lane', () => {
    const state = makeState();
    const origGetQueueDetails = state.getQueueDetails;
    state.getQueueDetails = () => [
      makeQueueDetail({
        messageLane: {
          active: true,
          idle: false,
          pendingCount: 0,
          containerName: 'ctr-1',
        },
      }),
    ];

    const html = renderAgentsContent(state);
    expect(html).toContain('exec-executing');

    state.getQueueDetails = origGetQueueDetails;
  });

  it('surfaces the underlying lane reason for idle local agents', () => {
    const state = makeState();
    const origGetQueueDetails = state.getQueueDetails;
    state.getQueueDetails = () => [
      makeQueueDetail({
        messageLane: {
          active: true,
          idle: true,
          pendingCount: 0,
          containerName: 'ctr-1',
        },
      }),
    ];

    const html = renderAgentsContent(state);
    expect(html).toContain('exec-idle');
    expect(html).toContain('lane-reason reason-cooling-down');

    state.getQueueDetails = origGetQueueDetails;
  });

  it('surfaces the underlying lane reason for offline-with-retries local agents', () => {
    const state = makeState();
    const origGetQueueDetails = state.getQueueDetails;
    state.getQueueDetails = () => [
      makeQueueDetail({
        messageLane: {
          active: false,
          idle: false,
          pendingCount: 0,
          containerName: null,
        },
        retryCount: 3,
      }),
    ];

    const html = renderAgentsContent(state);
    expect(html).toContain('exec-offline');
    expect(html).toContain('lane-reason reason-retrying');

    state.getQueueDetails = origGetQueueDetails;
  });

  it('does not render a lane-reason badge when no queue detail exists for the agent', () => {
    const state = makeState();
    const origGetQueueDetails = state.getQueueDetails;
    state.getQueueDetails = () => [];

    const html = renderAgentsContent(state);
    expect(html).toContain('exec-offline');
    expect(html).not.toContain('lane-reason');

    state.getQueueDetails = origGetQueueDetails;
  });

  it('renders offline status for remote agents regardless of queue', () => {
    const remotePeers = [
      {
        instanceId: 'peer-1',
        instanceName: 'macbook',
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
    // Remote agents should show offline, not use queue details
    expect(html).toContain('exec-offline');
  });

  it('renders the disabled badge and an enable button for disabled local agents', () => {
    const html = renderAgentsContent(
      makeState({
        'agent-1': makeAgent({ enabled: false }),
      }),
    );
    expect(html).toContain('exec-disabled');
    expect(html).toContain('data-disabled="true"');
    expect(html).toContain('data-agent-toggle="true"');
    expect(html).toContain('>enable<');
  });

  it('renders a disable button for enabled local agents', () => {
    const html = renderAgentsContent(makeState());
    expect(html).toContain('data-agent-toggle="false"');
    expect(html).toContain('>disable<');
  });

  it('omits the toggle button for remote agents', () => {
    const remotePeers = [
      {
        instanceId: 'peer-2',
        instanceName: 'orangepi',
        online: true,
        host: '10.0.0.20',
        port: 7777,
        agents: [
          {
            id: 'remote-only',
            name: 'Remote Only',
            folder: 'remote-only',
            backend: 'docker' as const,
            agentRuntime: 'opencode' as const,
            channels: [],
          },
        ],
      },
    ];
    const html = renderAgentsContent(makeState({}), remotePeers);
    // Remote row exists but no toggle (order-agnostic).
    expect(html).toContain('Remote Only');
    expect(html).toContain('data-agent-id="peer-2:remote-only"');
    expect(html).not.toMatch(
      /data-agent-id="peer-2:remote-only"[^>]*data-agent-toggle=/,
    );
    expect(html).not.toMatch(
      /data-agent-toggle=[^>]*data-agent-id="peer-2:remote-only"/,
    );
  });
});

describe('getAgentQueueDepth', () => {
  it('returns zero depth when agent has no queue entry', () => {
    expect(getAgentQueueDepth('test-agent', [])).toEqual({
      messages: 0,
      tasks: 0,
      total: 0,
    });
  });

  it('returns message and task pending counts when present', () => {
    const details = [
      makeQueueDetail({
        messageLane: {
          active: false,
          idle: false,
          pendingCount: 3,
          containerName: null,
        },
        taskLane: {
          active: false,
          pendingCount: 2,
          containerName: null,
          activeTask: null,
        },
      }),
    ];
    expect(getAgentQueueDepth('test-agent', details)).toEqual({
      messages: 3,
      tasks: 2,
      total: 5,
    });
  });

  it('matches by folder key when multiple agents are reported', () => {
    const details = [
      makeQueueDetail({
        folderKey: 'other-agent',
        messageLane: {
          active: false,
          idle: false,
          pendingCount: 7,
          containerName: null,
        },
      }),
    ];
    expect(getAgentQueueDepth('test-agent', details)).toEqual({
      messages: 0,
      tasks: 0,
      total: 0,
    });
    expect(getAgentQueueDepth('other-agent', details).messages).toBe(7);
  });
});

describe('renderAgentRow queue depth cell', () => {
  const agentData = {
    id: 'agent-1',
    name: 'Test Agent',
    folder: 'test-agent',
    backend: 'apple-container',
    agentRuntime: 'claude-agent-sdk',
    isAdmin: false,
    channels: [],
  };

  it('renders a zero placeholder when depth is zero', () => {
    const html = renderAgentRow(agentData, 0);
    expect(html).toContain('td-queue-depth');
    expect(html).toContain('data-queue-total="0"');
    expect(html).toContain('qd-zero');
  });

  it('renders message-pending count with m suffix', () => {
    const html = renderAgentRow(agentData, 0, 'queued', null, {
      messages: 4,
      tasks: 0,
      total: 4,
    });
    expect(html).toContain('data-queue-total="4"');
    expect(html).toContain('data-queue-messages="4"');
    expect(html).toContain('qd-msgs');
    expect(html).toContain('>4m<');
    expect(html).not.toContain('qd-tasks');
  });

  it('renders task-pending count with t suffix', () => {
    const html = renderAgentRow(agentData, 0, 'queued', null, {
      messages: 0,
      tasks: 2,
      total: 2,
    });
    expect(html).toContain('data-queue-tasks="2"');
    expect(html).toContain('qd-tasks');
    expect(html).toContain('>2t<');
    expect(html).not.toContain('qd-msgs');
  });

  it('renders both message and task counts when both nonzero', () => {
    const html = renderAgentRow(agentData, 0, 'queued', null, {
      messages: 3,
      tasks: 1,
      total: 4,
    });
    expect(html).toContain('qd-nonzero');
    expect(html).toContain('>3m<');
    expect(html).toContain('>1t<');
  });
});

describe('renderAgentsContent queue depth column', () => {
  it('includes the queued column header', () => {
    const html = renderAgentsContent(makeState());
    expect(html).toContain('>queued<');
  });

  it('surfaces nonzero pending message count from queue details', () => {
    const state = makeState();
    const origGetQueueDetails = state.getQueueDetails;
    state.getQueueDetails = () => [
      makeQueueDetail({
        messageLane: {
          active: false,
          idle: false,
          pendingCount: 5,
          containerName: null,
        },
      }),
    ];

    const html = renderAgentsContent(state);
    expect(html).toContain('data-queue-total="5"');
    expect(html).toContain('data-queue-messages="5"');
    expect(html).toContain('>5m<');

    state.getQueueDetails = origGetQueueDetails;
  });

  it('renders zero queue depth for agents with no queue entry', () => {
    const state = makeState();
    const origGetQueueDetails = state.getQueueDetails;
    state.getQueueDetails = () => [];

    const html = renderAgentsContent(state);
    expect(html).toContain('data-queue-total="0"');
    expect(html).toContain('qd-zero');

    state.getQueueDetails = origGetQueueDetails;
  });

  it('shows zero queue depth for remote agents (toggled on their own host)', () => {
    const remotePeers = [
      {
        instanceId: 'peer-1',
        instanceName: 'macbook',
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
    const html = renderAgentsContent(makeState({}), remotePeers);
    // Remote agent row should have queue cell rendered but as zero (depth
    // for remote agents lives on the peer's own host).
    expect(html).toContain('data-agent-id="peer-1:remote-agent"');
    expect(html).toContain('qd-zero');
  });
});

describe('getAgentRunningMs', () => {
  it('returns null when there is no queue detail for the folder', () => {
    expect(getAgentRunningMs('test-agent', [])).toBeNull();
  });

  it('returns null when the agent is idle (lane active but cooldown)', () => {
    const details = [
      makeQueueDetail({
        messageLane: {
          active: true,
          idle: true,
          pendingCount: 0,
          containerName: 'ctr-1',
          runningMs: null,
        },
      }),
    ];
    expect(getAgentRunningMs('test-agent', details)).toBeNull();
  });

  it('returns null when nothing is pending or running', () => {
    expect(getAgentRunningMs('test-agent', [makeQueueDetail()])).toBeNull();
  });

  it('returns the message-lane runningMs when actively processing a message', () => {
    const details = [
      makeQueueDetail({
        messageLane: {
          active: true,
          idle: false,
          pendingCount: 0,
          containerName: 'ctr-1',
          runningMs: 4250,
        },
      }),
    ];
    expect(getAgentRunningMs('test-agent', details)).toBe(4250);
  });

  it('returns the task activeTask.runningMs when running a scheduled task', () => {
    const details = [
      makeQueueDetail({
        taskLane: {
          active: true,
          pendingCount: 0,
          containerName: 'ctr-1',
          activeTask: {
            taskId: 'task-1',
            promptPreview: 'p',
            startedAt: Date.now(),
            runningMs: 12_000,
          },
        },
      }),
    ];
    expect(getAgentRunningMs('test-agent', details)).toBe(12_000);
  });

  it('prefers the message lane when both lanes are active (matches status priority)', () => {
    const details = [
      makeQueueDetail({
        messageLane: {
          active: true,
          idle: false,
          pendingCount: 0,
          containerName: 'ctr-1',
          runningMs: 800,
        },
        taskLane: {
          active: true,
          pendingCount: 0,
          containerName: 'ctr-2',
          activeTask: {
            taskId: 'task-1',
            promptPreview: 'p',
            startedAt: Date.now(),
            runningMs: 99_999,
          },
        },
      }),
    ];
    expect(getAgentRunningMs('test-agent', details)).toBe(800);
  });

  it('returns null when message lane is active but runningMs is missing or negative', () => {
    const detailsMissing = [
      makeQueueDetail({
        messageLane: {
          active: true,
          idle: false,
          pendingCount: 0,
          containerName: 'ctr-1',
        },
      }),
    ];
    expect(getAgentRunningMs('test-agent', detailsMissing)).toBeNull();

    const detailsNegative = [
      makeQueueDetail({
        messageLane: {
          active: true,
          idle: false,
          pendingCount: 0,
          containerName: 'ctr-1',
          runningMs: -1,
        },
      }),
    ];
    expect(getAgentRunningMs('test-agent', detailsNegative)).toBeNull();
  });

  it('matches by folder key', () => {
    const details = [
      makeQueueDetail({
        folderKey: 'other-agent',
        messageLane: {
          active: true,
          idle: false,
          pendingCount: 0,
          containerName: 'ctr-1',
          runningMs: 2000,
        },
      }),
    ];
    expect(getAgentRunningMs('test-agent', details)).toBeNull();
    expect(getAgentRunningMs('other-agent', details)).toBe(2000);
  });
});

describe('renderExecStatusBadge running age', () => {
  it('renders a lane-age badge for executing rows when runningMs is provided', () => {
    const html = renderExecStatusBadge('executing', null, 4250);
    expect(html).toContain('lane-age');
    expect(html).toContain('data-exec-running-ms="4250"');
    expect(html).toContain('4.3s');
  });

  it('renders a lane-age badge for running-task rows', () => {
    const html = renderExecStatusBadge('running-task', null, 75_000);
    expect(html).toContain('lane-age');
    expect(html).toContain('data-exec-running-ms="75000"');
    expect(html).toContain('1.3m');
  });

  it('formats sub-second ages as ms', () => {
    const html = renderExecStatusBadge('executing', null, 250);
    expect(html).toContain('>250ms<');
  });

  it('formats multi-hour ages with an h suffix', () => {
    const html = renderExecStatusBadge('executing', null, 7_200_000);
    expect(html).toContain('>2.0h<');
  });

  it('omits the lane-age badge for non-active statuses', () => {
    expect(renderExecStatusBadge('idle', 'cooling-down', 5000)).not.toContain(
      'lane-age',
    );
    expect(
      renderExecStatusBadge('queued', 'back-pressure', 5000),
    ).not.toContain('lane-age');
    expect(renderExecStatusBadge('offline', 'no-work', 5000)).not.toContain(
      'lane-age',
    );
    expect(renderExecStatusBadge('disabled', null, 5000)).not.toContain(
      'lane-age',
    );
  });

  it('omits the lane-age badge when runningMs is null or negative', () => {
    expect(renderExecStatusBadge('executing', null, null)).not.toContain(
      'lane-age',
    );
    expect(renderExecStatusBadge('executing', null, -1)).not.toContain(
      'lane-age',
    );
  });

  it('renders the age alongside the reason chip when both apply (defensive — UI prioritises reason for non-active)', () => {
    // reason chips are suppressed on executing rows, so the age stands alone.
    const html = renderExecStatusBadge('executing', 'running', 1500);
    expect(html).toContain('lane-age');
    expect(html).not.toContain('lane-reason');
  });
});

describe('renderAgentsContent running age column', () => {
  it('renders a lane-age badge when the message lane is actively processing', () => {
    const state = makeState();
    const origGetQueueDetails = state.getQueueDetails;
    state.getQueueDetails = () => [
      makeQueueDetail({
        messageLane: {
          active: true,
          idle: false,
          pendingCount: 0,
          containerName: 'ctr-1',
          runningMs: 3500,
        },
      }),
    ];

    const html = renderAgentsContent(state);
    expect(html).toContain('exec-executing');
    expect(html).toContain('lane-age');
    expect(html).toContain('data-exec-running-ms="3500"');

    state.getQueueDetails = origGetQueueDetails;
  });

  it('renders a lane-age badge when a scheduled task is running', () => {
    const state = makeState();
    const origGetQueueDetails = state.getQueueDetails;
    state.getQueueDetails = () => [
      makeQueueDetail({
        taskLane: {
          active: true,
          pendingCount: 0,
          containerName: 'ctr-1',
          activeTask: {
            taskId: 'task-1',
            promptPreview: 'p',
            startedAt: Date.now(),
            runningMs: 45_000,
          },
        },
      }),
    ];

    const html = renderAgentsContent(state);
    expect(html).toContain('exec-task');
    expect(html).toContain('lane-age');
    expect(html).toContain('data-exec-running-ms="45000"');

    state.getQueueDetails = origGetQueueDetails;
  });

  it('does not render a lane-age badge for idle agents', () => {
    const state = makeState();
    const origGetQueueDetails = state.getQueueDetails;
    state.getQueueDetails = () => [
      makeQueueDetail({
        messageLane: {
          active: true,
          idle: true,
          pendingCount: 0,
          containerName: 'ctr-1',
          runningMs: null,
        },
      }),
    ];

    const html = renderAgentsContent(state);
    expect(html).toContain('exec-idle');
    expect(html).not.toContain('lane-age');

    state.getQueueDetails = origGetQueueDetails;
  });

  it('does not render a lane-age badge for remote agents', () => {
    const remotePeers = [
      {
        instanceId: 'peer-1',
        instanceName: 'macbook',
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

    const html = renderAgentsContent(makeState({}), remotePeers);
    expect(html).not.toContain('lane-age');
  });
});

describe('buildAgentRowsHtml (SSE patch path)', () => {
  it('threads runningMs into the patched rows so the chip survives live updates', () => {
    const state = makeState();
    state.getQueueDetails = () => [
      makeQueueDetail({
        messageLane: {
          active: true,
          idle: false,
          pendingCount: 0,
          containerName: 'ctr-1',
          runningMs: 8500,
        },
      }),
    ];
    const html = buildAgentRowsHtml(state);
    expect(html).toContain('exec-executing');
    expect(html).toContain('lane-age');
    expect(html).toContain('data-exec-running-ms="8500"');
  });

  it('threads queueDepth into the patched rows so pending counts stay live', () => {
    const state = makeState();
    state.getQueueDetails = () => [
      makeQueueDetail({
        messageLane: {
          active: false,
          idle: false,
          pendingCount: 3,
          containerName: null,
        },
      }),
    ];
    const html = buildAgentRowsHtml(state);
    expect(html).toContain('exec-queued');
    expect(html).toContain('data-queue-total="3"');
    expect(html).toContain('data-queue-messages="3"');
  });

  it('reflects disabled state in the patched rows', () => {
    const state = makeState({
      'agent-1': makeAgent({ enabled: false }),
    });
    const html = buildAgentRowsHtml(state);
    expect(html).toContain('exec-disabled');
  });

  it('emits no lane-age chip for remote agents', () => {
    const remotePeers = [
      {
        instanceId: 'peer-1',
        instanceName: 'macbook',
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
    const html = buildAgentRowsHtml(makeState({}), remotePeers);
    expect(html).not.toContain('lane-age');
  });
});

describe('shortenModelLabel', () => {
  it('strips the claude- prefix from bare model ids', () => {
    expect(shortenModelLabel('claude-opus-4-7')).toBe('opus-4-7');
    expect(shortenModelLabel('claude-sonnet-4-6')).toBe('sonnet-4-6');
    expect(shortenModelLabel('claude-haiku-4-5-20251001')).toBe(
      'haiku-4-5-20251001',
    );
  });

  it('keeps only the segment after the last slash for provider-prefixed ids', () => {
    expect(shortenModelLabel('anthropic/claude-sonnet-4-5')).toBe('sonnet-4-5');
    expect(shortenModelLabel('openai/gpt-5-codex-mini')).toBe(
      'gpt-5-codex-mini',
    );
  });

  it('returns the raw id when no known prefix matches', () => {
    expect(shortenModelLabel('custom-model')).toBe('custom-model');
  });

  it('trims surrounding whitespace and returns "" for blank input', () => {
    expect(shortenModelLabel('  claude-opus-4-7  ')).toBe('opus-4-7');
    expect(shortenModelLabel('')).toBe('');
    expect(shortenModelLabel('   ')).toBe('');
  });

  it('does not strip the prefix when nothing follows it', () => {
    // Avoid producing an empty chip; fall back to the full label.
    expect(shortenModelLabel('claude-')).toBe('claude-');
  });
});

describe('renderRuntimeCell', () => {
  it('renders only the runtime badge when no model override is set', () => {
    const html = renderRuntimeCell('claude-agent-sdk', undefined);
    expect(html).toContain('>claude-agent-sdk<');
    expect(html).not.toContain('badge-model');
    expect(html).not.toContain('data-agent-model');
  });

  it('renders only the runtime badge when model is an empty string', () => {
    expect(renderRuntimeCell('opencode', '')).not.toContain('badge-model');
  });

  it('renders only the runtime badge when model is whitespace only', () => {
    expect(renderRuntimeCell('opencode', '   ')).not.toContain('badge-model');
  });

  it('renders a model chip with the shortened label when the override is set', () => {
    const html = renderRuntimeCell('claude-agent-sdk', 'claude-opus-4-7');
    expect(html).toContain('badge-model');
    expect(html).toContain('>opus-4-7<');
    expect(html).toContain('data-agent-model="claude-opus-4-7"');
    expect(html).toContain('title="claude-opus-4-7"');
  });

  it('keeps the full model id on hover even when shortened', () => {
    const html = renderRuntimeCell('opencode', 'anthropic/claude-sonnet-4-5');
    expect(html).toContain('title="anthropic/claude-sonnet-4-5"');
    expect(html).toContain('>sonnet-4-5<');
  });

  it('escapes HTML in the model override', () => {
    const html = renderRuntimeCell(
      'claude-agent-sdk',
      '<script>alert(1)</script>',
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('emits the model chip after the runtime badge so the runtime stays primary', () => {
    const html = renderRuntimeCell('claude-agent-sdk', 'claude-opus-4-7');
    const runtimeIdx = html.indexOf('claude-agent-sdk');
    const modelIdx = html.indexOf('badge-model');
    expect(runtimeIdx).toBeGreaterThanOrEqual(0);
    expect(modelIdx).toBeGreaterThan(runtimeIdx);
  });
});

describe('renderAgentRow model badge', () => {
  it('renders a model chip when the AgentChannelData carries a model', () => {
    const agentData = {
      id: 'agent-1',
      name: 'With Model',
      folder: 'with-model',
      backend: 'apple-container',
      agentRuntime: 'claude-agent-sdk',
      isAdmin: false,
      model: 'claude-opus-4-7',
      channels: [],
    };

    const html = renderAgentRow(agentData, 0);

    expect(html).toContain('badge-model');
    expect(html).toContain('>opus-4-7<');
    expect(html).toContain('data-agent-model="claude-opus-4-7"');
  });

  it('does not render a model chip when no model override is set', () => {
    const agentData = {
      id: 'agent-1',
      name: 'No Model',
      folder: 'no-model',
      backend: 'apple-container',
      agentRuntime: 'claude-agent-sdk',
      isAdmin: false,
      channels: [],
    };

    const html = renderAgentRow(agentData, 0);

    expect(html).not.toContain('badge-model');
    expect(html).not.toContain('data-agent-model');
  });
});

describe('renderAgentsContent surfaces per-agent model override', () => {
  it('renders a model chip on rows for local agents with a model override set', () => {
    const agents = {
      'agent-1': makeAgent({ model: 'claude-opus-4-7' }),
    };
    const html = renderAgentsContent(makeState(agents));

    expect(html).toContain('badge-model');
    expect(html).toContain('>opus-4-7<');
    expect(html).toContain('data-agent-model="claude-opus-4-7"');
  });

  it('omits the model chip when the local agent has no override', () => {
    const html = renderAgentsContent(makeState());
    expect(html).not.toContain('badge-model');
  });

  it('does not project a model chip onto remote agent rows', () => {
    // Remote agents carry no model override in their discovery payload; the
    // badge must only surface for local rows where the value is authoritative.
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

    const html = renderAgentsContent(makeState({}), remotePeers);

    expect(html).toContain('data-agent-id="peer-1:remote-agent"');
    expect(html).not.toContain('badge-model');
  });
});
