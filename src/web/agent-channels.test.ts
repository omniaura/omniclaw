import { describe, expect, it } from 'bun:test';

import { buildAgentChannelData } from './agent-channels.js';
import type { WebStateProvider } from './types.js';

const state: WebStateProvider = {
  getAgents: () => ({
    local: {
      id: 'local',
      name: 'Local Agent',
      folder: 'groups/local',
      backend: 'docker',
      agentRuntime: 'opencode',
      isAdmin: false,
      createdAt: '',
    },
  }),
  getChannelSubscriptions: () => ({
    'dc:1': [
      {
        channelJid: 'dc:1',
        agentId: 'local',
        trigger: '@omni',
        requiresTrigger: true,
        priority: 1,
        isPrimary: true,
        createdAt: '',
        channelFolder: 'servers/acme/spec',
        categoryFolder: 'servers/acme',
      },
    ],
  }),
  getTasks: () => [],
  getTaskById: () => undefined,
  getMessages: () => [],
  getChats: () => [{ jid: 'dc:1', name: 'spec', last_message_time: '' }],
  getQueueStats: () => ({
    activeContainers: 0,
    idleContainers: 0,
    maxActive: 0,
    maxIdle: 0,
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

describe('buildAgentChannelData', () => {
  it('includes remote peers in the unified agent list', () => {
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
});
