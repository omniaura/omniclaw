import { describe, it, expect } from 'bun:test';

import { agentToRegisteredGroup } from './agents.js';
import type { Agent, RegisteredGroup } from './types.js';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    folder: 'test-folder',
    backend: 'apple-container',
    isAdmin: false,
    isLocal: true,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('agents.ts', () => {
  describe('agentToRegisteredGroup', () => {
    it('converts a basic agent to a registered group', () => {
      const agent = makeAgent();
      const group = agentToRegisteredGroup(agent, 'jid@g.us');

      expect(group.name).toBe('Test Agent');
      expect(group.folder).toBe('test-folder');
      expect(group.trigger).toBe('');
      expect(group.added_at).toBe('2025-01-01T00:00:00.000Z');
    });

    it('sets trigger to empty string (trigger lives on ChannelRoute)', () => {
      const agent = makeAgent();
      const group = agentToRegisteredGroup(agent, 'jid@g.us');
      expect(group.trigger).toBe('');
    });

    it('sets requiresTrigger to undefined', () => {
      const agent = makeAgent();
      const group = agentToRegisteredGroup(agent, 'jid@g.us');
      expect(group.requiresTrigger).toBeUndefined();
    });

    it('sets discordGuildId to undefined (guild ID lives on ChannelRoute)', () => {
      const agent = makeAgent();
      const group = agentToRegisteredGroup(agent, 'dc:123');
      expect(group.discordGuildId).toBeUndefined();
    });

    it('preserves containerConfig', () => {
      const config = { timeout: 120000, memory: 8192 };
      const agent = makeAgent({ containerConfig: config });
      const group = agentToRegisteredGroup(agent, 'jid@g.us');
      expect(group.containerConfig).toEqual(config);
    });

    it('preserves heartbeat config', () => {
      const heartbeat = { enabled: true, interval: '300000', scheduleType: 'interval' as const };
      const agent = makeAgent({ heartbeat });
      const group = agentToRegisteredGroup(agent, 'jid@g.us');
      expect(group.heartbeat).toEqual(heartbeat);
    });

    it('preserves serverFolder', () => {
      const agent = makeAgent({ serverFolder: 'servers/omniaura-discord' });
      const group = agentToRegisteredGroup(agent, 'dc:456');
      expect(group.serverFolder).toBe('servers/omniaura-discord');
    });

    it('preserves backend type', () => {
      const agent = makeAgent({ backend: 'sprites' });
      const group = agentToRegisteredGroup(agent, 'jid@g.us');
      expect(group.backend).toBe('sprites');
    });

    it('preserves description', () => {
      const agent = makeAgent({ description: 'Handles Discord messages' });
      const group = agentToRegisteredGroup(agent, 'dc:789');
      expect(group.description).toBe('Handles Discord messages');
    });

    it('handles agent without optional fields', () => {
      const agent = makeAgent({
        containerConfig: undefined,
        heartbeat: undefined,
        serverFolder: undefined,
        description: undefined,
      });
      const group = agentToRegisteredGroup(agent, 'jid@g.us');
      expect(group.containerConfig).toBeUndefined();
      expect(group.heartbeat).toBeUndefined();
      expect(group.serverFolder).toBeUndefined();
      expect(group.description).toBeUndefined();
    });
  });
});
