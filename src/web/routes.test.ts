import { afterEach, describe, expect, it } from 'bun:test';

import { handleRequest } from './routes.js';
import type { WebStateProvider } from './types.js';
import type { Agent } from '../types.js';

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

function makeState(agent: Agent): WebStateProvider {
  return {
    getAgents: () => ({ [agent.id]: agent }),
    getChannelSubscriptions: () => ({}),
    getTasks: () => [],
    getTaskById: () => undefined,
    getMessages: () => [],
    getChats: () => [],
    getQueueStats: () => ({
      activeContainers: 0,
      idleContainers: 0,
      maxActive: 0,
      maxIdle: 0,
    }),
    getQueueDetails: () => [],
    getIpcEvents: () => [],
    createTask: () => {},
    updateTask: () => {},
    deleteTask: () => {},
    calculateNextRun: () => null,
    readContextFile: () => null,
    writeContextFile: () => {},
    updateAgentAvatar: () => {},
  };
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('handleRequest avatar image proxy', () => {
  it('proxies remote avatar bytes for an agent', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      expect(String(input)).toBe('https://example.test/avatar.png');
      return new Response('avatar-bytes', {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    }) as typeof fetch;

    const res = await handleRequest(
      new Request('http://localhost/api/agents/test-agent/avatar/image'),
      makeState(
        makeAgent({
          avatarUrl: 'https://example.test/avatar.png',
          avatarSource: 'telegram',
        }),
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect(await res.text()).toBe('avatar-bytes');
  });
});
