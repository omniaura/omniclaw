import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
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
    resolveChatImage: async () => null,
    resolveDiscordGuildImage: async () => null,
  };
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(path.join(DATA_DIR, 'image-cache'), {
    recursive: true,
    force: true,
  });
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
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(await res.text()).toBe('avatar-bytes');
  });

  it('proxies telegram DM icons through the chat icon route', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      expect(String(input)).toBe('https://example.test/tg-user.png');
      return new Response('tg-user', {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    }) as typeof fetch;

    const res = await handleRequest(
      new Request(
        'http://localhost/api/chats/tg%3A8401921193%3A1991174535/icon',
      ),
      {
        ...makeState(makeAgent()),
        resolveChatImage: async (jid) => {
          expect(jid).toBe('tg:8401921193:1991174535');
          return 'https://example.test/tg-user.png';
        },
      },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(await res.text()).toBe('tg-user');
  });

  it('proxies discord guild icons through the guild icon route', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      expect(String(input)).toBe('https://example.test/discord-guild.png');
      return new Response('guild-icon', {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    }) as typeof fetch;

    const res = await handleRequest(
      new Request(
        'http://localhost/api/discord/guilds/753336633083953213/icon?botId=OCPEYTON',
      ),
      {
        ...makeState(makeAgent()),
        resolveDiscordGuildImage: async (guildId, botId) => {
          expect(guildId).toBe('753336633083953213');
          expect(botId).toBe('OCPEYTON');
          return 'https://example.test/discord-guild.png';
        },
      },
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('guild-icon');
  });
});
