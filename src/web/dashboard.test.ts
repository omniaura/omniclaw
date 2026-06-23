import { createHash } from 'crypto';

import { describe, expect, it } from 'bun:test';

import type { RemotePeerAgents } from '../discovery/types.js';
import type { GroupQueueDetail } from '../group-queue.js';
import type { Agent, ChannelSubscription, ScheduledTask } from '../types.js';
import {
  renderDashboardContent,
  renderDashboardWithRemote,
} from './dashboard.js';
import type { WebStateProvider } from './types.js';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'local-agent',
    name: 'Local Agent',
    folder: 'groups/local-agent',
    backend: 'apple-container',
    agentRuntime: 'claude-agent-sdk',
    isAdmin: false,
    createdAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSubscription(
  overrides: Partial<ChannelSubscription> = {},
): ChannelSubscription {
  return {
    channelJid: 'dc:123',
    agentId: 'local-agent',
    trigger: '@Omni',
    requiresTrigger: true,
    priority: 1,
    isPrimary: true,
    createdAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    group_folder: 'groups/local-agent',
    chat_jid: 'dc:123',
    prompt: 'Do the thing',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    next_run: '2026-03-02T09:00:00.000Z',
    last_run: null,
    last_result: null,
    executing_since: null,
    status: 'active',
    created_at: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeState(options?: {
  agents?: Agent[];
  subscriptions?: Record<string, ChannelSubscription[]>;
  chats?: Array<{ jid: string; name: string; last_message_time: string }>;
  tasks?: ScheduledTask[];
  queueStats?: ReturnType<WebStateProvider['getQueueStats']>;
  queueDetails?: GroupQueueDetail[];
}): WebStateProvider {
  const agents = options?.agents ?? [makeAgent()];
  const agentMap = Object.fromEntries(agents.map((agent) => [agent.id, agent]));

  return {
    getAgents: () => agentMap,
    getChannelSubscriptions: () => options?.subscriptions ?? {},
    getTasks: () => options?.tasks ?? [],
    getTaskById: () => undefined,
    getMessages: () => [],
    getChats: () => options?.chats ?? [],
    getQueueStats: () =>
      options?.queueStats ?? {
        activeContainers: 0,
        idleContainers: 0,
        maxActive: 1,
        maxIdle: 1,
      },
    getQueueDetails: () => options?.queueDetails ?? [],
    getIpcEvents: () => [],
    getTaskRunLogs: () => [],
    getTaskRunPhaseEvents: () => [],
    searchMessages: () => [],
    createTask: () => {
      throw new Error('Unexpected createTask during render');
    },
    updateTask: () => {
      throw new Error('Unexpected updateTask during render');
    },
    deleteTask: () => {
      throw new Error('Unexpected deleteTask during render');
    },
    calculateNextRun: () => null,
    readContextFile: () => null,
    writeContextFile: () => {
      throw new Error('Unexpected writeContextFile during render');
    },
    updateAgentAvatar: () => {
      throw new Error('Unexpected updateAgentAvatar during render');
    },
    setAgentEnabled: () => {
      throw new Error('Unexpected setAgentEnabled during render');
    },
    setAgentModel: () => {
      throw new Error('Unexpected setAgentModel during render');
    },
    resolveChatImage: async () => null,
    resolveDiscordGuildImage: async () => null,
  };
}

function makeMessageRunningDetail(
  overrides: { folderKey?: string; runningMs?: number } = {},
): GroupQueueDetail {
  return {
    folderKey: overrides.folderKey ?? 'groups/local-agent',
    messageLane: {
      active: true,
      idle: false,
      pendingCount: 0,
      containerName: null,
      runningMs: overrides.runningMs ?? 1500,
    },
    taskLane: {
      active: false,
      pendingCount: 0,
      containerName: null,
      activeTask: null,
    },
    retryCount: 0,
  };
}

function makeTaskRunningDetail(
  overrides: { folderKey?: string; taskId?: string; runningMs?: number } = {},
): GroupQueueDetail {
  return {
    folderKey: overrides.folderKey ?? 'groups/other-agent',
    messageLane: {
      active: false,
      idle: false,
      pendingCount: 0,
      containerName: null,
    },
    taskLane: {
      active: true,
      pendingCount: 0,
      containerName: null,
      activeTask: {
        taskId: overrides.taskId ?? 'task-active',
        promptPreview: '',
        startedAt: 1_700_000_000_000,
        runningMs: overrides.runningMs ?? 1000,
      },
    },
    retryCount: 0,
  };
}

function makeIdleDetail(folderKey: string): GroupQueueDetail {
  return {
    folderKey,
    messageLane: {
      active: false,
      idle: true,
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
  };
}

function extractTopoData(html: string): Array<Record<string, unknown>> {
  const match = html.match(
    /<script type="application\/json" id="topo-data">([\s\S]*?)<\/script>/,
  );
  if (!match) {
    throw new Error('topo-data script tag not found');
  }
  return JSON.parse(match[1]);
}

describe('renderDashboardContent', () => {
  it('renders queue and task stats with a floor at zero active containers', () => {
    const html = renderDashboardContent(
      makeState({
        agents: [makeAgent()],
        queueStats: {
          activeContainers: 1,
          idleContainers: 3,
          maxActive: 7,
          maxIdle: 4,
        },
        tasks: [
          makeTask({ id: 'task-active', status: 'active' }),
          makeTask({ id: 'task-paused', status: 'paused' }),
          makeTask({ id: 'task-complete', status: 'completed' }),
        ],
      }),
    );

    expect(html).toContain('id="stat-agents">1</div>');
    expect(html).toContain('id="stat-active">0/7</div>');
    expect(html).toContain('id="stat-idle">3/4</div>');
    expect(html).toContain('id="stat-tasks">1</div>');
  });

  it('annotates active tasks card with running count when tasks are in flight', () => {
    const html = renderDashboardContent(
      makeState({
        tasks: [
          makeTask({ id: 'task-a', status: 'active' }),
          makeTask({ id: 'task-b', status: 'active' }),
          makeTask({ id: 'task-c', status: 'active' }),
        ],
        queueDetails: [
          makeTaskRunningDetail({ folderKey: 'g1', taskId: 'task-a' }),
          makeTaskRunningDetail({ folderKey: 'g2', taskId: 'task-b' }),
        ],
      }),
    );

    expect(html).toContain('id="stat-tasks">3 (2 running)</div>');
  });

  it('omits the running annotation when no task lane is active', () => {
    const html = renderDashboardContent(
      makeState({
        tasks: [makeTask({ status: 'active' })],
        queueDetails: [makeIdleDetail('g1')],
      }),
    );

    expect(html).toContain('id="stat-tasks">1</div>');
    expect(html).not.toContain('running)');
  });

  it('annotates agents card with working count when any lane is in flight', () => {
    const html = renderDashboardContent(
      makeState({
        agents: [
          makeAgent({ id: 'a1', folder: 'groups/a1' }),
          makeAgent({ id: 'a2', folder: 'groups/a2' }),
          makeAgent({ id: 'a3', folder: 'groups/a3' }),
        ],
        queueDetails: [
          makeMessageRunningDetail({ folderKey: 'groups/a1' }),
          makeTaskRunningDetail({ folderKey: 'groups/a2' }),
          makeIdleDetail('groups/a3'),
        ],
      }),
    );

    expect(html).toContain('id="stat-agents">3 (2 working)</div>');
  });

  it('omits the working annotation when no agent lane is active', () => {
    const html = renderDashboardContent(
      makeState({
        agents: [
          makeAgent({ id: 'a1', folder: 'groups/a1' }),
          makeAgent({ id: 'a2', folder: 'groups/a2' }),
        ],
        queueDetails: [
          makeIdleDetail('groups/a1'),
          makeIdleDetail('groups/a2'),
        ],
      }),
    );

    expect(html).toContain('id="stat-agents">2</div>');
    expect(html).not.toContain('working)');
  });

  it('does not count idle-waiting message lanes as working', () => {
    // A lane with active=true but idle=true is a warm container in cooldown,
    // not actively processing — it should not be counted as working.
    const html = renderDashboardContent(
      makeState({
        agents: [makeAgent({ id: 'a1', folder: 'groups/a1' })],
        queueDetails: [
          {
            folderKey: 'groups/a1',
            messageLane: {
              active: true,
              idle: true,
              pendingCount: 0,
              containerName: 'omni-a1',
            },
            taskLane: {
              active: false,
              pendingCount: 0,
              containerName: null,
              activeTask: null,
            },
            retryCount: 0,
          },
        ],
      }),
    );

    expect(html).toContain('id="stat-agents">1</div>');
    expect(html).not.toContain('working)');
  });

  it('serializes local and remote topology data with stable avatar cache-busting hashes', () => {
    const state = makeState({
      agents: [
        makeAgent({
          id: 'local-agent',
          name: 'Local Agent',
          avatarUrl: 'https://example.test/local.png',
          serverFolder: 'servers/local',
        }),
      ],
      subscriptions: {
        'dc:123': [
          makeSubscription({
            channelJid: 'dc:123',
            channelFolder: 'servers/local/channels/general',
            categoryFolder: 'servers/local',
          }),
        ],
      },
      chats: [
        {
          jid: 'dc:123',
          name: 'General',
          last_message_time: '2026-03-01T00:00:00.000Z',
        },
      ],
    });
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

    const html = renderDashboardContent(state, remotePeers);
    const topoData = extractTopoData(html);

    expect(topoData).toHaveLength(2);
    expect(topoData[0]).toMatchObject({
      id: 'local-agent',
      name: 'Local Agent',
      remoteInstanceId: null,
      server: 'servers/local',
    });
    expect(topoData[0]?.avatarUrl).toBe(
      `/api/agents/local-agent/avatar/image?rev=${createHash('sha256').update('https://example.test/local.png').digest('hex').slice(0, 12)}`,
    );
    expect(topoData[1]).toMatchObject({
      id: 'peer-1:remote:agent',
      name: 'Remote Agent',
      remoteInstanceId: 'peer-1',
      remoteInstanceName: 'orangepi5',
    });
    expect(topoData[1]?.avatarUrl).toBe(
      `/api/discovery/peers/peer-1/agents/remote%3Aagent/avatar/image?rev=${createHash('sha256').update('https://example.test/remote.png').digest('hex').slice(0, 12)}`,
    );
  });

  it('escapes topology JSON so script tag sentinels cannot break out', () => {
    const payload = '</script><script>alert("xss")</script>&\u2028\u2029';
    const html = renderDashboardContent(
      makeState({
        agents: [
          makeAgent({
            id: 'local-agent',
            name: payload,
            serverFolder: payload,
          }),
        ],
        subscriptions: {
          'dc:123': [makeSubscription({ channelFolder: payload })],
        },
        chats: [
          {
            jid: 'dc:123',
            name: payload,
            last_message_time: '2026-03-01T00:00:00.000Z',
          },
        ],
      }),
    );

    expect(html).not.toContain('</script><script>');
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain('\\u003c/script\\u003e');

    const topoData = extractTopoData(html);
    expect(topoData[0]?.name).toBe(payload);
    expect(topoData[0]?.server).toBe(payload);
    expect(
      (topoData[0]?.channels as Array<Record<string, unknown>>)[0]?.name,
    ).toBe(payload);
  });

  it('only offers local agents in the task modal and escapes labels safely', () => {
    const html = renderDashboardContent(
      makeState({
        agents: [
          makeAgent({
            id: 'local-agent',
            name: 'Local <Agent>',
            folder: 'groups/local&agent',
          }),
        ],
        subscriptions: {
          'dc:123': [
            makeSubscription({
              channelJid: 'dc:123',
              channelFolder: 'servers/root/general',
            }),
          ],
        },
        chats: [
          {
            jid: 'dc:123',
            name: 'General & Stuff',
            last_message_time: '2026-03-01T00:00:00.000Z',
          },
        ],
      }),
      [
        {
          instanceId: 'peer-1',
          instanceName: 'orangepi5',
          online: true,
          host: '10.0.0.12',
          port: 7777,
          agents: [
            {
              id: 'remote-agent',
              name: 'Remote Agent',
              folder: 'agents/remote',
              backend: 'docker',
              agentRuntime: 'opencode',
              channels: [{ jid: 'dc:999', displayName: 'Remote Room' }],
            },
          ],
        },
      ],
    );

    expect(html).toContain(
      '<option value="groups/local&amp;agent|dc:123">Local &lt;Agent&gt; — General &amp; Stuff</option>',
    );
    expect(html).not.toContain('Remote Agent — Remote Room');
  });
});

describe('renderDashboardWithRemote', () => {
  it('wraps the dashboard in the shared SPA shell', () => {
    const html = renderDashboardWithRemote(makeState(), []);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain(
      '<title id="page-title">OmniClaw — Dashboard</title>',
    );
    expect(html).toContain(
      "window.__initPage && window.__initPage('dashboard')",
    );
    expect(html).toContain('class="nav-link active">Dashboard</a>');
  });
});
