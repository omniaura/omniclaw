import { describe, it, expect } from 'bun:test';

import {
  registeredGroupToAgent,
  registeredGroupToRoute,
  type RegisteredGroup,
  type Agent,
  type ChannelRoute,
} from './types.js';

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@test',
    added_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('types.ts conversion functions', () => {
  describe('registeredGroupToAgent', () => {
    it('converts a basic registered group to an agent', () => {
      const group = makeGroup();
      const agent = registeredGroupToAgent('jid@g.us', group);

      expect(agent.id).toBe('test-group');
      expect(agent.name).toBe('Test Group');
      expect(agent.folder).toBe('test-group');
      expect(agent.backend).toBe('apple-container');
      expect(agent.isAdmin).toBe(false);
      expect(agent.isLocal).toBe(true);
      expect(agent.createdAt).toBe('2025-01-01T00:00:00.000Z');
    });

    it('sets isAdmin=true for main group', () => {
      const group = makeGroup({ folder: 'main' });
      const agent = registeredGroupToAgent('jid@g.us', group);
      expect(agent.isAdmin).toBe(true);
    });

    it('sets isAdmin=false for non-main groups', () => {
      const group = makeGroup({ folder: 'dev-chat' });
      const agent = registeredGroupToAgent('jid@g.us', group);
      expect(agent.isAdmin).toBe(false);
    });

    it('uses apple-container as default backend', () => {
      const group = makeGroup({ backend: undefined });
      const agent = registeredGroupToAgent('jid@g.us', group);
      expect(agent.backend).toBe('apple-container');
    });

    it('preserves specified backend', () => {
      const group = makeGroup({ backend: 'docker' });
      const agent = registeredGroupToAgent('jid@g.us', group);
      expect(agent.backend).toBe('docker');
      expect(agent.isLocal).toBe(true);
    });

    it('marks docker as local', () => {
      const group = makeGroup({ backend: 'docker' });
      const agent = registeredGroupToAgent('jid@g.us', group);
      expect(agent.isLocal).toBe(true);
    });

    it('preserves containerConfig', () => {
      const config = { timeout: 60000, memory: 2048 };
      const group = makeGroup({ containerConfig: config });
      const agent = registeredGroupToAgent('jid@g.us', group);
      expect(agent.containerConfig).toEqual(config);
    });

    it('preserves heartbeat config', () => {
      const heartbeat = { enabled: true, interval: '*/5 * * * *', scheduleType: 'cron' as const };
      const group = makeGroup({ heartbeat });
      const agent = registeredGroupToAgent('jid@g.us', group);
      expect(agent.heartbeat).toEqual(heartbeat);
    });

    it('preserves serverFolder', () => {
      const group = makeGroup({ serverFolder: 'servers/discord' });
      const agent = registeredGroupToAgent('jid@g.us', group);
      expect(agent.serverFolder).toBe('servers/discord');
    });

    it('preserves description', () => {
      const group = makeGroup({ description: 'A test agent' });
      const agent = registeredGroupToAgent('jid@g.us', group);
      expect(agent.description).toBe('A test agent');
    });
  });

  describe('registeredGroupToRoute', () => {
    it('converts a basic group to a channel route', () => {
      const group = makeGroup({ trigger: '@bot' });
      const route = registeredGroupToRoute('dc:123', group);

      expect(route.channelJid).toBe('dc:123');
      expect(route.agentId).toBe('test-group');
      expect(route.trigger).toBe('@bot');
      expect(route.requiresTrigger).toBe(true);
      expect(route.createdAt).toBe('2025-01-01T00:00:00.000Z');
    });

    it('defaults requiresTrigger to true when undefined', () => {
      const group = makeGroup({ requiresTrigger: undefined });
      const route = registeredGroupToRoute('dc:123', group);
      expect(route.requiresTrigger).toBe(true);
    });

    it('respects requiresTrigger=false', () => {
      const group = makeGroup({ requiresTrigger: false });
      const route = registeredGroupToRoute('dc:123', group);
      expect(route.requiresTrigger).toBe(false);
    });

    it('respects requiresTrigger=true', () => {
      const group = makeGroup({ requiresTrigger: true });
      const route = registeredGroupToRoute('dc:123', group);
      expect(route.requiresTrigger).toBe(true);
    });

    it('preserves discordGuildId', () => {
      const group = makeGroup({ discordGuildId: 'guild-123' });
      const route = registeredGroupToRoute('dc:456', group);
      expect(route.discordGuildId).toBe('guild-123');
    });

    it('handles WhatsApp JIDs', () => {
      const group = makeGroup();
      const route = registeredGroupToRoute('120363@g.us', group);
      expect(route.channelJid).toBe('120363@g.us');
    });

    it('handles Telegram JIDs', () => {
      const group = makeGroup();
      const route = registeredGroupToRoute('tg:-1001234567890', group);
      expect(route.channelJid).toBe('tg:-1001234567890');
    });
  });
});
