import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';

import {
  buildAvatarCandidates,
  detectDominantPlatform,
  syncAvatars,
} from './avatar-sync.js';
import * as db from './db.js';
import { logger } from './logger.js';
import { buildTelegramFileDescriptor } from './telegram-avatar.js';
import type { Channel } from './types.js';
import type { Agent } from './types.js';

let updateAgentAvatarSpy: ReturnType<
  typeof spyOn<typeof db, 'updateAgentAvatar'>
>;
let loggerInfoSpy: ReturnType<typeof spyOn<typeof logger, 'info'>>;
let loggerWarnSpy: ReturnType<typeof spyOn<typeof logger, 'warn'>>;

function makeChannel(
  name: Channel['name'],
  botId?: string,
  getAvatarUrl: NonNullable<Channel['getAvatarUrl']> = async () =>
    `https://example.test/${name}/${botId || 'default'}.png`,
): Channel & { getAvatarUrl: NonNullable<Channel['getAvatarUrl']> } {
  return {
    name,
    botId,
    connect: async () => {},
    sendMessage: async () => {},
    isConnected: () => true,
    ownsJid: () => true,
    disconnect: async () => {},
    getAvatarUrl,
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: overrides.id || 'agent-1',
    name: overrides.name || 'Agent One',
    folder: overrides.folder || overrides.id || 'agent-1',
    backend: overrides.backend || 'apple-container',
    agentRuntime: overrides.agentRuntime || 'claude-agent-sdk',
    isAdmin: overrides.isAdmin || false,
    createdAt: overrides.createdAt || '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  updateAgentAvatarSpy = spyOn(db, 'updateAgentAvatar').mockImplementation(
    () => {},
  );
  loggerInfoSpy = spyOn(logger, 'info').mockImplementation(() => {});
  loggerWarnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  updateAgentAvatarSpy.mockRestore();
  loggerInfoSpy.mockRestore();
  loggerWarnSpy.mockRestore();
});

describe('detectDominantPlatform', () => {
  it('ignores unknown channel prefixes and returns undefined when none match', () => {
    expect(
      detectDominantPlatform([
        { channelJid: 'email:test@example.com' },
        { channelJid: 'matrix:abc' },
      ]),
    ).toBeUndefined();
  });
});

describe('buildAvatarCandidates', () => {
  it('prefers the matching Discord bot for an agent', () => {
    const candidates = buildAvatarCandidates(
      [
        { channelJid: 'dc:123', discordBotId: 'OCPEYTON' },
        { channelJid: 'dc:456', discordBotId: 'OCPEYTON' },
      ],
      [makeChannel('discord', 'PRIMARY'), makeChannel('discord', 'OCPEYTON')],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.platform).toBe('discord');
    expect(candidates[0]?.identity).toBe('OCPEYTON');
    expect(candidates[0]?.channel.botId).toBe('OCPEYTON');
  });

  it('ranks telegram ahead of slack and discord when it has more subscriptions', () => {
    const candidates = buildAvatarCandidates(
      [
        { channelJid: 'slack:C123' },
        { channelJid: 'slack:D456' },
        { channelJid: 'tg:bot-1:-100' },
        { channelJid: 'tg:bot-1:12345' },
        { channelJid: 'tg:-999' },
      ],
      [makeChannel('slack'), makeChannel('telegram', 'bot-1')],
    );

    expect(candidates[0]?.platform).toBe('telegram');
    expect(candidates[0]?.identity).toBe('bot-1');
    expect(candidates[1]?.platform).toBe('slack');
  });
});

describe('syncAvatars', () => {
  it('sanitizes Telegram avatar URLs before persisting them', async () => {
    const agent = makeAgent({ id: 'agent-telegram' });
    const telegramUrl =
      'https://api.telegram.org/file/bot12345:secret/photos/avatar.png';

    await syncAvatars(
      { [agent.id]: agent },
      [makeChannel('telegram', '12345', async () => telegramUrl)],
      () => [{ channelJid: 'tg:12345:-100' }],
    );

    const expected = buildTelegramFileDescriptor('12345', 'photos/avatar.png');
    expect(updateAgentAvatarSpy).toHaveBeenCalledTimes(1);
    expect(updateAgentAvatarSpy).toHaveBeenCalledWith(
      'agent-telegram',
      expected,
      'telegram',
    );
    expect(agent.avatarUrl).toBe(expected);
    expect(agent.avatarSource).toBe('telegram');
    expect(loggerInfoSpy).toHaveBeenCalledTimes(1);
  });

  it('skips custom avatars and unchanged avatar URLs', async () => {
    const customAvatarFetch = mock(
      async () => 'https://example.test/discord/custom.png',
    );
    const sameAvatarFetch = mock(
      async () => 'https://example.test/discord/existing.png',
    );
    const customAgent = makeAgent({
      id: 'custom-agent',
      avatarSource: 'custom',
      avatarUrl: 'https://example.test/custom.png',
    });
    const unchangedAgent = makeAgent({
      id: 'unchanged-agent',
      avatarUrl: 'https://example.test/discord/existing.png',
      avatarSource: 'discord',
    });

    await syncAvatars(
      {
        [customAgent.id]: customAgent,
        [unchangedAgent.id]: unchangedAgent,
      },
      [
        makeChannel('discord', 'CUSTOM', customAvatarFetch),
        makeChannel('discord', 'UNCHANGED', sameAvatarFetch),
      ],
      (agentId) =>
        agentId === 'custom-agent'
          ? [{ channelJid: 'dc:1', discordBotId: 'CUSTOM' }]
          : [{ channelJid: 'dc:2', discordBotId: 'UNCHANGED' }],
    );

    expect(customAvatarFetch).not.toHaveBeenCalled();
    expect(sameAvatarFetch).toHaveBeenCalledTimes(1);
    expect(updateAgentAvatarSpy).not.toHaveBeenCalled();
    expect(loggerInfoSpy).not.toHaveBeenCalled();
  });

  it('falls back to a unique candidate when the top identity is shared', async () => {
    const agentWithFallback = makeAgent({ id: 'fallback-agent' });
    const agentWithOnlySharedAvatar = makeAgent({ id: 'shared-only-agent' });

    await syncAvatars(
      {
        [agentWithFallback.id]: agentWithFallback,
        [agentWithOnlySharedAvatar.id]: agentWithOnlySharedAvatar,
      },
      [
        makeChannel(
          'discord',
          'SHARED',
          async () => 'https://example.test/discord/shared.png',
        ),
        makeChannel(
          'slack',
          undefined,
          async () => 'https://example.test/slack/workspace.png',
        ),
      ],
      (agentId) =>
        agentId === 'fallback-agent'
          ? [
              { channelJid: 'dc:1', discordBotId: 'SHARED' },
              { channelJid: 'slack:C123' },
            ]
          : [{ channelJid: 'dc:2', discordBotId: 'SHARED' }],
    );

    expect(updateAgentAvatarSpy).toHaveBeenCalledTimes(1);
    expect(updateAgentAvatarSpy).toHaveBeenCalledWith(
      'fallback-agent',
      'https://example.test/slack/workspace.png',
      'slack',
    );
    expect(agentWithFallback.avatarSource).toBe('slack');
    expect(agentWithOnlySharedAvatar.avatarSource).toBeUndefined();
  });

  it('logs channel failures and continues syncing other agents', async () => {
    const brokenAgent = makeAgent({ id: 'broken-agent' });
    const healthyAgent = makeAgent({ id: 'healthy-agent' });
    const failure = new Error('avatar lookup failed');

    await syncAvatars(
      {
        [brokenAgent.id]: brokenAgent,
        [healthyAgent.id]: healthyAgent,
      },
      [
        makeChannel('discord', 'BROKEN', async () => {
          throw failure;
        }),
        makeChannel(
          'discord',
          'HEALTHY',
          async () => 'https://example.test/discord/healthy.png',
        ),
      ],
      (agentId) =>
        agentId === 'broken-agent'
          ? [{ channelJid: 'dc:broken', discordBotId: 'BROKEN' }]
          : [{ channelJid: 'dc:healthy', discordBotId: 'HEALTHY' }],
    );

    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    expect(updateAgentAvatarSpy).toHaveBeenCalledTimes(1);
    expect(updateAgentAvatarSpy).toHaveBeenCalledWith(
      'healthy-agent',
      'https://example.test/discord/healthy.png',
      'discord',
    );
    expect(healthyAgent.avatarSource).toBe('discord');
  });
});
