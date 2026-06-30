import { describe, expect, it } from 'bun:test';

import {
  channelIdToSlackJid,
  parseSlackJid,
  parseScopedSlackJid,
  slackThreadIdToJid,
} from './slack-jid.js';

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

  it('does not parse explicit thread JIDs as scoped channel JIDs', () => {
    expect(
      parseScopedSlackJid('slack:OPS:C123456:thread:1700000000.000100'),
    ).toBeNull();
  });

  it('rejects unscoped or malformed JIDs', () => {
    expect(parseScopedSlackJid('slack:C123456')).toBeNull();
    expect(parseScopedSlackJid('discord:PRIMARY:C123456')).toBeNull();
    expect(parseScopedSlackJid('slack:PRIMARY:channel with spaces')).toBeNull();
  });
});

describe('parseSlackJid', () => {
  it('parses legacy channel JIDs', () => {
    expect(parseSlackJid('slack:C123456')).toEqual({
      channelId: 'C123456',
      parentJid: 'slack:C123456',
      legacyParentJid: 'slack:C123456',
    });
  });

  it('parses scoped channel JIDs', () => {
    expect(parseSlackJid('slack:PRIMARY:C123456')).toEqual({
      botId: 'PRIMARY',
      channelId: 'C123456',
      parentJid: 'slack:PRIMARY:C123456',
      legacyParentJid: 'slack:C123456',
    });
  });

  it('parses scoped thread JIDs with parent fallbacks', () => {
    expect(parseSlackJid('slack:OPS:C123456:thread:1700000000.000100')).toEqual(
      {
        botId: 'OPS',
        channelId: 'C123456',
        threadTs: '1700000000.000100',
        parentJid: 'slack:OPS:C123456',
        legacyParentJid: 'slack:C123456',
      },
    );
  });

  it('rejects malformed thread JIDs', () => {
    expect(parseSlackJid('slack:OPS:C123456:thread:not-a-ts')).toBeNull();
  });
});

describe('Slack JID formatters', () => {
  it('formats scoped and legacy channel JIDs', () => {
    expect(channelIdToSlackJid('C123')).toBe('slack:C123');
    expect(channelIdToSlackJid('C123', 'OPS')).toBe('slack:OPS:C123');
  });

  it('formats scoped thread JIDs', () => {
    expect(slackThreadIdToJid('C123', '1700000000.000100', 'OPS')).toBe(
      'slack:OPS:C123:thread:1700000000.000100',
    );
  });
});
