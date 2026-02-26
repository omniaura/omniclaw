import { describe, it, expect } from 'bun:test';

import { jidToChannelId, channelIdToJid } from './slack.js';

// --- jidToChannelId ---

describe('Slack jidToChannelId', () => {
  it('extracts channel ID from slack: JID', () => {
    expect(jidToChannelId('slack:C12345678')).toBe('C12345678');
  });

  it('extracts DM channel ID from slack: JID', () => {
    expect(jidToChannelId('slack:D98765432')).toBe('D98765432');
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

// --- ownsJid pattern ---

describe('Slack ownsJid pattern', () => {
  it('matches slack: prefixed JIDs', () => {
    expect('slack:C123'.startsWith('slack:')).toBe(true);
    expect('slack:D456'.startsWith('slack:')).toBe(true);
  });

  it('does not match non-Slack JIDs', () => {
    expect('dc:123'.startsWith('slack:')).toBe(false);
    expect('tg:456'.startsWith('slack:')).toBe(false);
    expect('main@g.us'.startsWith('slack:')).toBe(false);
  });
});
