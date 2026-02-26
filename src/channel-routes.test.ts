import { describe, it, expect } from 'bun:test';

import {
  resolveAgentForChannel,
  getChannelJidsForAgent,
  buildAgentToChannelsMap,
} from './channel-routes.js';
import type { ChannelRoute } from './types.js';

// --- Test Data ---

function makeRoute(channelJid: string, agentId: string): ChannelRoute {
  return {
    channelJid,
    agentId,
    trigger: '@Omni',
    requiresTrigger: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const sampleRoutes: Record<string, ChannelRoute> = {
  '123@g.us': makeRoute('123@g.us', 'agent-main'),
  'dc:456': makeRoute('dc:456', 'agent-discord'),
  'tg:-1001234': makeRoute('tg:-1001234', 'agent-main'),
  '789@g.us': makeRoute('789@g.us', 'agent-dev'),
};

// --- resolveAgentForChannel ---

describe('resolveAgentForChannel', () => {
  it('resolves a WhatsApp group JID to the correct agent', () => {
    expect(resolveAgentForChannel('123@g.us', sampleRoutes)).toBe('agent-main');
  });

  it('resolves a Discord channel JID to the correct agent', () => {
    expect(resolveAgentForChannel('dc:456', sampleRoutes)).toBe(
      'agent-discord',
    );
  });

  it('resolves a Telegram channel JID to the correct agent', () => {
    expect(resolveAgentForChannel('tg:-1001234', sampleRoutes)).toBe(
      'agent-main',
    );
  });

  it('returns undefined for unknown JID', () => {
    expect(resolveAgentForChannel('unknown:999', sampleRoutes)).toBeUndefined();
  });

  it('returns undefined for empty routes', () => {
    expect(resolveAgentForChannel('123@g.us', {})).toBeUndefined();
  });

  it('returns undefined for empty string JID', () => {
    expect(resolveAgentForChannel('', sampleRoutes)).toBeUndefined();
  });
});

// --- getChannelJidsForAgent ---

describe('getChannelJidsForAgent', () => {
  it('returns all channels for an agent with multiple routes', () => {
    const jids = getChannelJidsForAgent('agent-main', sampleRoutes);
    expect(jids).toHaveLength(2);
    expect(jids).toContain('123@g.us');
    expect(jids).toContain('tg:-1001234');
  });

  it('returns single channel for agent with one route', () => {
    const jids = getChannelJidsForAgent('agent-discord', sampleRoutes);
    expect(jids).toEqual(['dc:456']);
  });

  it('returns empty array for unknown agent', () => {
    const jids = getChannelJidsForAgent('nonexistent', sampleRoutes);
    expect(jids).toEqual([]);
  });

  it('returns empty array for empty routes', () => {
    const jids = getChannelJidsForAgent('agent-main', {});
    expect(jids).toEqual([]);
  });
});

// --- buildAgentToChannelsMap ---

describe('buildAgentToChannelsMap', () => {
  it('groups channels by agent', () => {
    const map = buildAgentToChannelsMap(sampleRoutes);

    expect(map.size).toBe(3); // agent-main, agent-discord, agent-dev
    expect(map.get('agent-main')).toHaveLength(2);
    expect(map.get('agent-main')).toContain('123@g.us');
    expect(map.get('agent-main')).toContain('tg:-1001234');
    expect(map.get('agent-discord')).toEqual(['dc:456']);
    expect(map.get('agent-dev')).toEqual(['789@g.us']);
  });

  it('returns empty map for empty routes', () => {
    const map = buildAgentToChannelsMap({});
    expect(map.size).toBe(0);
  });

  it('handles single agent with single channel', () => {
    const routes: Record<string, ChannelRoute> = {
      'solo@g.us': makeRoute('solo@g.us', 'agent-solo'),
    };
    const map = buildAgentToChannelsMap(routes);
    expect(map.size).toBe(1);
    expect(map.get('agent-solo')).toEqual(['solo@g.us']);
  });

  it('handles all channels routing to same agent', () => {
    const routes: Record<string, ChannelRoute> = {
      'a@g.us': makeRoute('a@g.us', 'single-agent'),
      'dc:b': makeRoute('dc:b', 'single-agent'),
      'tg:c': makeRoute('tg:c', 'single-agent'),
    };
    const map = buildAgentToChannelsMap(routes);
    expect(map.size).toBe(1);
    expect(map.get('single-agent')).toHaveLength(3);
  });
});
