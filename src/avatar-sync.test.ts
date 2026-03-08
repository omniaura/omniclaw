import { describe, expect, it } from 'bun:test';

import { buildAvatarCandidates } from './avatar-sync.js';
import type { Channel } from './types.js';

function makeChannel(
  name: Channel['name'],
  botId?: string,
): Channel & { getAvatarUrl: NonNullable<Channel['getAvatarUrl']> } {
  return {
    name,
    botId,
    connect: async () => {},
    sendMessage: async () => {},
    isConnected: () => true,
    ownsJid: () => true,
    disconnect: async () => {},
    getAvatarUrl: async () => `https://example.test/${name}/${botId || 'default'}.png`,
  };
}

describe('buildAvatarCandidates', () => {
  it('prefers the matching Discord bot for an agent', () => {
    const candidates = buildAvatarCandidates(
      [
        { channelJid: 'dc:123', discordBotId: 'OCPEYTON' },
        { channelJid: 'dc:456', discordBotId: 'OCPEYTON' },
      ],
      [
        makeChannel('discord', 'PRIMARY'),
        makeChannel('discord', 'OCPEYTON'),
      ],
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
