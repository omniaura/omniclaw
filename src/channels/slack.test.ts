import { describe, it, expect } from 'bun:test';

import {
  jidToChannelId,
  channelIdToJid,
  parseScopedSlackJid,
  SlackChannel,
} from './slack.js';

// --- jidToChannelId ---

describe('Slack jidToChannelId', () => {
  it('extracts channel ID from slack: JID', () => {
    expect(jidToChannelId('slack:C12345678')).toBe('C12345678');
  });

  it('extracts DM channel ID from slack: JID', () => {
    expect(jidToChannelId('slack:D98765432')).toBe('D98765432');
  });

  it('extracts channel ID from scoped slack JID', () => {
    expect(jidToChannelId('slack:OPS:C12345678')).toBe('C12345678');
  });

  it('returns null for non-Slack JIDs', () => {
    expect(jidToChannelId('dc:123456')).toBeNull();
    expect(jidToChannelId('tg:123456')).toBeNull();
    expect(jidToChannelId('main@g.us')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(jidToChannelId('')).toBeNull();
  });

  it('handles JID with just the slack: prefix', () => {
    expect(jidToChannelId('slack:')).toBe('');
  });

  it('preserves special characters in channel ID', () => {
    expect(jidToChannelId('slack:C_ABC-123')).toBe('C_ABC-123');
  });
});

// --- channelIdToJid ---

describe('Slack channelIdToJid', () => {
  it('creates a slack: JID from channel ID', () => {
    expect(channelIdToJid('C12345678')).toBe('slack:C12345678');
  });

  it('creates a slack: JID from DM channel ID', () => {
    expect(channelIdToJid('D98765432')).toBe('slack:D98765432');
  });

  it('handles empty channel ID', () => {
    expect(channelIdToJid('')).toBe('slack:');
  });

  it('creates a scoped slack JID when bot ID is provided', () => {
    expect(channelIdToJid('C12345678', 'OPS')).toBe('slack:OPS:C12345678');
  });
});

describe('parseScopedSlackJid', () => {
  it('parses scoped Slack JIDs', () => {
    expect(parseScopedSlackJid('slack:OPS:C12345678')).toEqual({
      botId: 'OPS',
      channelId: 'C12345678',
    });
  });

  it('returns null for legacy Slack JIDs', () => {
    expect(parseScopedSlackJid('slack:C12345678')).toBeNull();
  });

  it('returns null for non-Slack JIDs', () => {
    expect(parseScopedSlackJid('dc:123')).toBeNull();
  });
});

// --- Roundtrip ---

describe('Slack JID roundtrip', () => {
  it('jidToChannelId and channelIdToJid are inverses', () => {
    const channelId = 'C12345678';
    const jid = channelIdToJid(channelId);
    expect(jidToChannelId(jid)).toBe(channelId);
  });

  it('roundtrips DM channel IDs', () => {
    const channelId = 'D98765432';
    expect(jidToChannelId(channelIdToJid(channelId))).toBe(channelId);
  });

  it('roundtrips various channel types', () => {
    for (const id of ['C001', 'D002', 'G003']) {
      expect(jidToChannelId(channelIdToJid(id))).toBe(id);
    }
  });
});

// --- SlackChannel.ownsJid ---

describe('SlackChannel.ownsJid', () => {
  const ownsJid = (jid: string, botId = 'OPS', allowLegacy = true) =>
    SlackChannel.prototype.ownsJid.call(
      { botId, allowLegacyJidRouting: allowLegacy } as unknown as SlackChannel,
      jid,
    );

  it('matches slack: prefixed JIDs', () => {
    expect(ownsJid('slack:C123')).toBe(true);
    expect(ownsJid('slack:D456')).toBe(true);
  });

  it('matches scoped JIDs for the same bot', () => {
    expect(ownsJid('slack:OPS:C123', 'OPS')).toBe(true);
  });

  it('does not match scoped JIDs for a different bot', () => {
    expect(ownsJid('slack:SUPPORT:C123', 'OPS')).toBe(false);
  });

  it('can disable legacy JID ownership in multi-bot mode', () => {
    expect(ownsJid('slack:C123', 'OPS', false)).toBe(false);
  });

  it('does not match non-Slack JIDs', () => {
    expect(ownsJid('dc:123')).toBe(false);
    expect(ownsJid('tg:456')).toBe(false);
    expect(ownsJid('main@g.us')).toBe(false);
  });
});
