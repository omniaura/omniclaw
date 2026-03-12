import { describe, expect, it } from 'bun:test';

import { parseScopedSlackJid } from './slack-jid.js';

describe('parseScopedSlackJid', () => {
  it('parses scoped Slack JIDs into bot and channel ids', () => {
    expect(parseScopedSlackJid('slack:PRIMARY:C123456')).toEqual({
      botId: 'PRIMARY',
      channelId: 'C123456',
    });
  });

  it('allows channel ids with separators after the second segment', () => {
    expect(
      parseScopedSlackJid('slack:OPS:thread-abc:1700000000.000100'),
    ).toEqual({
      botId: 'OPS',
      channelId: 'thread-abc:1700000000.000100',
    });
  });

  it('rejects unscoped or malformed JIDs', () => {
    expect(parseScopedSlackJid('slack:C123456')).toBeNull();
    expect(parseScopedSlackJid('discord:PRIMARY:C123456')).toBeNull();
    expect(parseScopedSlackJid('slack:PRIMARY:channel with spaces')).toBeNull();
  });
});
