import { describe, expect, it } from 'bun:test';

import type { RemotePeerAgents } from '../discovery/types.js';
import type { Agent, ChannelSubscription } from '../types.js';
import {
  renderContextViewer,
  renderContextViewerContent,
  renderContextViewerWithRemote,
} from './context-viewer.js';
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
    searchMessages: () => [],
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

describe('renderContextViewerContent', () => {
  it('renders local and remote agent groups with context selection metadata', () => {
    const state = makeState({
      agents: [
        makeAgent({
          serverFolder: 'servers/local',
          agentContextFolder: 'agents/local',
        }),
      ],
      subscriptions: {
        'dc:123': [
          makeSubscription({
            channelFolder: 'servers/local/channels/general',
            categoryFolder: 'servers/local/categories/engineering',
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
        instanceId: 'remote-1',
        instanceName: 'orangepi5',
        online: true,
        host: '10.0.0.15',
        port: 7777,
        agents: [
          {
            id: 'zest',
            name: 'Zest <Remote>',
            folder: 'agents/zest',
            backend: 'docker',
            agentRuntime: 'opencode',
            channels: [
              {
                jid: 'dc:remote',
                displayName: 'Remote Spec',
                channelFolder: 'servers/remote/channels/spec',
                categoryFolder: 'servers/remote/categories/infra',
              },
            ],
          },
        ],
      },
    ];

    const html = renderContextViewerContent(state, remotePeers);

    expect(html).toContain("window.__initPage && window.__initPage('context')");
    expect(html).toContain('agents &amp; channels');
    expect(html).toContain('remote agents');
    expect(html).toContain('General');
    expect(html).toContain('data-select-channel');
    expect(html).toContain(
      'data-channel-folder="servers/local/channels/general"',
    );
    expect(html).toContain(
      'data-category-folder="servers/local/categories/engineering"',
    );
    expect(html).toContain('data-agent-context-folder="agents/local"');
    expect(html).toContain('data-remote-instance-id="remote-1"');
    expect(html).toContain('remote:orangepi5');
    expect(html).toContain('Zest &lt;Remote&gt;');
    expect(html).toContain('Select a channel to view its context layers');
    expect(html).toContain('data-layer="agent"');
    expect(html).toContain('data-view="preview"');
    expect(html).toContain('id="btn-save" disabled');
  });

  it('shows the remote empty state when there are no trusted peers', () => {
    const html = renderContextViewerContent(makeState(), []);

    expect(html).toContain('Trusted remote agents will appear here.');
  });
});

describe('renderContextViewer shells', () => {
  it('renders the local-only shell', () => {
    const html = renderContextViewer(makeState());

    expect(html).toContain('<title id="page-title">OmniClaw — Context</title>');
    expect(html).toContain('href="/context"');
  });

  it('renders the remote-aware shell', () => {
    const html = renderContextViewerWithRemote(makeState(), []);

    expect(html).toContain('<title id="page-title">OmniClaw — Context</title>');
    expect(html).toContain('id="remote-agent-groups"');
  });
});
