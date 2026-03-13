import { describe, expect, it } from 'bun:test';

import type { Agent, ChannelSubscription } from '../types.js';
import { buildAgentChannelData, renderAgentGroups } from './agent-channels.js';
import type { WebStateProvider } from './types.js';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Agent One',
    folder: 'agent-one',
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
    agentId: 'agent-1',
    trigger: '@Omni',
    requiresTrigger: true,
    priority: 1,
    isPrimary: true,
    createdAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeState(options?: {
  agents?: Agent[];
  subscriptions?: Record<string, ChannelSubscription[]>;
  chats?: Array<{ jid: string; name: string; last_message_time: string }>;
}): WebStateProvider {
  const agents = options?.agents ?? [makeAgent()];
  const agentMap = Object.fromEntries(agents.map((agent) => [agent.id, agent]));

  return {
    getAgents: () => agentMap,
    getChannelSubscriptions: () => options?.subscriptions ?? {},
    getTasks: () => [],
    getTaskById: () => undefined,
    getMessages: () => [],
    getChats: () => options?.chats ?? [],
    getQueueStats: () => ({
      activeContainers: 0,
      idleContainers: 0,
      maxActive: 1,
      maxIdle: 1,
    }),
    getQueueDetails: () => [],
    getIpcEvents: () => [],
    getTaskRunLogs: () => [],
    createTask: () => {},
    updateTask: () => {},
    deleteTask: () => {},
    calculateNextRun: () => null,
    readContextFile: () => null,
    writeContextFile: () => {},
    updateAgentAvatar: () => {},
    resolveChatImage: async () => null,
    resolveDiscordGuildImage: async () => null,
  };
}

describe('buildAgentChannelData', () => {
  it('includes remote peers in the unified agent list', () => {
    const state = makeState({
      agents: [
        makeAgent({
          id: 'local',
          name: 'Local Agent',
          folder: 'groups/local',
          backend: 'docker',
          agentRuntime: 'opencode',
          createdAt: '',
        }),
      ],
      subscriptions: {
        'dc:1': [
          makeSubscription({
            channelJid: 'dc:1',
            agentId: 'local',
            trigger: '@omni',
            channelFolder: 'servers/acme/spec',
            categoryFolder: 'servers/acme',
            createdAt: '',
          }),
        ],
      },
      chats: [{ jid: 'dc:1', name: 'spec', last_message_time: '' }],
    });

    const result = buildAgentChannelData(state, [
      {
        instanceId: 'remote-1',
        instanceName: 'orangepi5',
        online: true,
        host: '10.0.0.118',
        port: 7777,
        agents: [
          {
            id: 'zest',
            name: 'Zest',
            folder: 'agents/zest',
            backend: 'docker',
            agentRuntime: 'claude-agent-sdk',
            channels: [
              {
                jid: 'dc:remote',
                displayName: 'remote-spec',
                channelFolder: 'servers/remote/spec',
              },
            ],
          },
        ],
      },
    ]);

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      id: 'remote-1:zest',
      remoteInstanceId: 'remote-1',
      remoteInstanceName: 'orangepi5',
    });
    expect(result[1].channels[0]).toMatchObject({
      jid: 'dc:remote',
      displayName: 'remote-spec',
    });
  });

  it('enriches channels with chat names, fallback folders, and platform icons', () => {
    const state = makeState({
      agents: [
        makeAgent({
          id: 'agent-1',
          agentContextFolder: 'agents/agent-one',
          serverFolder: 'servers/alpha',
          avatarUrl: '/avatars/agent-1.png',
        }),
      ],
      subscriptions: {
        'dc:123': [
          makeSubscription({
            channelJid: 'dc:123',
            discordGuildId: 'guild-1',
            discordBotId: 'bot-1',
            channelFolder: 'servers/alpha/channels/general',
          }),
        ],
        'tg:-1001': [
          makeSubscription({
            channelJid: 'tg:-1001',
            channelFolder: 'servers/alpha/channels/alerts',
            categoryFolder: 'servers/alpha',
          }),
        ],
        'wa:999': [
          makeSubscription({
            channelJid: 'wa:999',
            channelFolder: undefined,
          }),
        ],
      },
      chats: [
        {
          jid: 'dc:123',
          name: 'General Chat',
          last_message_time: '2026-03-01T00:00:00.000Z',
        },
      ],
    });

    const result = buildAgentChannelData(state);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'agent-1',
      serverFolder: 'servers/alpha',
      agentContextFolder: 'agents/agent-one',
      avatarUrl: '/avatars/agent-1.png',
      serverIconUrl: '/api/discord/guilds/guild-1/icon?botId=bot-1',
    });
    expect(result[0]?.channels).toEqual([
      {
        jid: 'dc:123',
        displayName: 'General Chat',
        channelFolder: 'servers/alpha/channels/general',
        categoryFolder: undefined,
        iconUrl: undefined,
        discordGuildId: 'guild-1',
        discordBotId: 'bot-1',
      },
      {
        jid: 'tg:-1001',
        displayName: '#alerts',
        channelFolder: 'servers/alpha/channels/alerts',
        categoryFolder: 'servers/alpha',
        iconUrl: '/api/chats/tg%3A-1001/icon',
        discordGuildId: undefined,
        discordBotId: undefined,
      },
      {
        jid: 'wa:999',
        displayName: 'wa:999',
        channelFolder: undefined,
        categoryFolder: undefined,
        iconUrl: undefined,
        discordGuildId: undefined,
        discordBotId: undefined,
      },
    ]);
  });

  it('only includes subscriptions for the matching agent', () => {
    const state = makeState({
      agents: [makeAgent({ id: 'agent-1' }), makeAgent({ id: 'agent-2' })],
      subscriptions: {
        'dc:123': [makeSubscription({ agentId: 'agent-2' })],
      },
    });

    const result = buildAgentChannelData(state);

    expect(result.find((agent) => agent.id === 'agent-1')?.channels).toEqual(
      [],
    );
    expect(
      result.find((agent) => agent.id === 'agent-2')?.channels,
    ).toHaveLength(1);
  });
});

describe('renderAgentGroups', () => {
  it('renders backend/runtime badges and escaped channel content', () => {
    const html = renderAgentGroups([
      {
        id: 'agent-1',
        name: 'Agent <One>',
        folder: 'agent-one',
        backend: 'docker',
        agentRuntime: 'opencode',
        isAdmin: true,
        channels: [
          {
            jid: 'dc:<123>',
            displayName: 'General & Stuff',
          },
        ],
      },
    ]);

    expect(html).toContain('badge-docker');
    expect(html).toContain('badge-admin');
    expect(html).toContain('opencode');
    expect(html).toContain('Agent &lt;One&gt;');
    expect(html).toContain('General &amp; Stuff');
    expect(html).toContain('dc:&lt;123&gt;');
    expect(html).not.toContain('Agent <One>');
  });

  it('adds context selection attributes only when requested', () => {
    const agentData = [
      {
        id: 'agent-1',
        name: 'Agent One',
        folder: 'agent-one',
        backend: 'apple-container',
        agentRuntime: 'claude-agent-sdk',
        isAdmin: false,
        serverFolder: 'servers/root',
        agentContextFolder: 'agents/agent-one',
        channels: [
          {
            jid: 'dc:123',
            displayName: 'General',
            channelFolder: 'servers/root/general',
            categoryFolder: 'servers/root',
          },
        ],
      },
    ];

    const plainHtml = renderAgentGroups(agentData);
    const contextHtml = renderAgentGroups(agentData, {
      includeContextAttrs: true,
    });

    expect(plainHtml).not.toContain('data-select-channel');
    expect(contextHtml).toContain('data-select-channel');
    expect(contextHtml).toContain('data-folder="agent-one"');
    expect(contextHtml).toContain('data-server-folder="servers/root"');
    expect(contextHtml).toContain(
      'data-agent-context-folder="agents/agent-one"',
    );
    expect(contextHtml).toContain('data-channel-folder="servers/root/general"');
    expect(contextHtml).toContain('data-category-folder="servers/root"');
  });
});
