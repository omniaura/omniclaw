import { describe, it, expect } from 'bun:test';

import { jidToChannelId, DiscordChannel } from './discord.js';
import type { RegisteredGroup } from '../types.js';

// --- jidToChannelId ---

describe('Discord jidToChannelId', () => {
  it('extracts channel ID from guild channel JID', () => {
    expect(jidToChannelId('dc:1234567890')).toBe('1234567890');
  });

  it('returns null for DM JIDs (dc:dm: prefix)', () => {
    expect(jidToChannelId('dc:dm:9876543210')).toBeNull();
  });

  it('returns null for non-Discord JIDs', () => {
    expect(jidToChannelId('slack:C12345')).toBeNull();
    expect(jidToChannelId('tg:12345')).toBeNull();
    expect(jidToChannelId('main@g.us')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(jidToChannelId('')).toBeNull();
  });

  it('handles JID with just the dc: prefix', () => {
    expect(jidToChannelId('dc:')).toBe('');
  });

  it('handles JID with extra colons', () => {
    // dc:some:thing — starts with dc: but not dc:dm:, so slices after "dc:"
    expect(jidToChannelId('dc:some:thing')).toBe('some:thing');
  });
});

// --- DiscordChannel.ownsJid ---

describe('DiscordChannel.ownsJid', () => {
  const channel = new DiscordChannel({ token: 'test-token-not-used', botId: 'test-bot-id' });

  it('matches dc: prefixed JIDs', () => {
    expect(channel.ownsJid('dc:123456')).toBe(true);
  });

  it('matches dc:dm: prefixed JIDs', () => {
    expect(channel.ownsJid('dc:dm:user123')).toBe(true);
  });

  it('does not match non-Discord JIDs', () => {
    expect(channel.ownsJid('slack:C123')).toBe(false);
    expect(channel.ownsJid('tg:123')).toBe(false);
    expect(channel.ownsJid('main@g.us')).toBe(false);
  });
});

// --- shouldAutoRespond ---

describe('Discord shouldAutoRespond', () => {
  // shouldAutoRespond is an instance method, but we need a DiscordChannel instance.
  // Since the constructor requires a token, we create a minimal instance with a dummy token.
  // The method only uses `content` and `group` parameters — no actual Discord connection needed.
  const channel = new DiscordChannel({ token: 'test-token-not-used', botId: 'test-bot-id' });

  function makeGroup(
    overrides: Partial<RegisteredGroup> = {},
  ): RegisteredGroup {
    return {
      name: 'Test',
      folder: 'test',
      trigger: '@Bot',
      added_at: '2025-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  describe('question detection (autoRespondToQuestions)', () => {
    it('responds to messages ending with ?', () => {
      const group = makeGroup({ autoRespondToQuestions: true });
      expect(channel.shouldAutoRespond('What time is it?', group)).toBe(true);
    });

    it('trims content before checking for trailing ?', () => {
      const group = makeGroup({ autoRespondToQuestions: true });
      // content.trim().endsWith('?') — trailing whitespace is trimmed first
      expect(channel.shouldAutoRespond('What time is it?  ', group)).toBe(true);
      expect(channel.shouldAutoRespond('  What time is it?  ', group)).toBe(
        true,
      );
    });

    it('does not respond to questions when autoRespondToQuestions is false', () => {
      const group = makeGroup({ autoRespondToQuestions: false });
      expect(channel.shouldAutoRespond('What time is it?', group)).toBe(false);
    });

    it('does not respond to questions when autoRespondToQuestions is undefined', () => {
      const group = makeGroup();
      expect(channel.shouldAutoRespond('What time is it?', group)).toBe(false);
    });

    it('does not respond to non-question messages', () => {
      const group = makeGroup({ autoRespondToQuestions: true });
      expect(channel.shouldAutoRespond('Hello world', group)).toBe(false);
    });

    it('does not respond to empty content', () => {
      const group = makeGroup({ autoRespondToQuestions: true });
      expect(channel.shouldAutoRespond('', group)).toBe(false);
    });

    it('responds to multi-line messages ending with ?', () => {
      const group = makeGroup({ autoRespondToQuestions: true });
      expect(
        channel.shouldAutoRespond('Line one\nLine two\nQuestion?', group),
      ).toBe(true);
    });
  });

  describe('keyword matching (autoRespondKeywords)', () => {
    it('matches keyword with word boundary (case-insensitive)', () => {
      const group = makeGroup({ autoRespondKeywords: ['help'] });
      expect(channel.shouldAutoRespond('I need help with this', group)).toBe(
        true,
      );
    });

    it('is case-insensitive', () => {
      const group = makeGroup({ autoRespondKeywords: ['help'] });
      expect(channel.shouldAutoRespond('HELP me please', group)).toBe(true);
      expect(channel.shouldAutoRespond('Help Me', group)).toBe(true);
    });

    it('does not match partial words (word boundary)', () => {
      const group = makeGroup({ autoRespondKeywords: ['help'] });
      expect(channel.shouldAutoRespond('That was helpful', group)).toBe(false);
      expect(channel.shouldAutoRespond('The helper arrived', group)).toBe(
        false,
      );
    });

    it('matches when keyword is the entire message', () => {
      const group = makeGroup({ autoRespondKeywords: ['status'] });
      expect(channel.shouldAutoRespond('status', group)).toBe(true);
    });

    it('matches multiple keywords (any match)', () => {
      const group = makeGroup({
        autoRespondKeywords: ['hello', 'help', 'status'],
      });
      expect(channel.shouldAutoRespond('Can you help', group)).toBe(true);
      expect(channel.shouldAutoRespond('Check the status', group)).toBe(true);
      expect(channel.shouldAutoRespond('Say hello', group)).toBe(true);
    });

    it('does not match when no keywords match', () => {
      const group = makeGroup({ autoRespondKeywords: ['help', 'status'] });
      expect(channel.shouldAutoRespond('Just chatting here', group)).toBe(
        false,
      );
    });

    it('escapes special regex characters in keywords', () => {
      // The regex escapes special chars, but \b after non-word chars like '+'
      // has a known edge case: \b between non-word chars doesn't always trigger.
      // Test with a keyword containing a dot (also special but works with \b).
      const group = makeGroup({ autoRespondKeywords: ['file.txt'] });
      expect(channel.shouldAutoRespond('Open file.txt now', group)).toBe(true);
      // Dot is escaped — should not match "fileXtxt"
      expect(channel.shouldAutoRespond('Open fileXtxt now', group)).toBe(false);
    });

    it('handles keyword with dots', () => {
      const group = makeGroup({ autoRespondKeywords: ['v2.0'] });
      expect(channel.shouldAutoRespond('Released v2.0 today', group)).toBe(
        true,
      );
      // Dot is escaped — should not match "v2X0"
      expect(channel.shouldAutoRespond('Released v2X0 today', group)).toBe(
        false,
      );
    });

    it('returns false when autoRespondKeywords is undefined', () => {
      const group = makeGroup();
      expect(channel.shouldAutoRespond('help me', group)).toBe(false);
    });

    it('returns false when autoRespondKeywords is empty', () => {
      const group = makeGroup({ autoRespondKeywords: [] });
      expect(channel.shouldAutoRespond('help me', group)).toBe(false);
    });
  });

  describe('combined behavior', () => {
    it('question detection takes priority over keywords', () => {
      const group = makeGroup({
        autoRespondToQuestions: true,
        autoRespondKeywords: ['help'],
      });
      // Question without keyword — still matches via question detection
      expect(channel.shouldAutoRespond('How are you?', group)).toBe(true);
    });

    it('falls back to keyword matching when not a question', () => {
      const group = makeGroup({
        autoRespondToQuestions: true,
        autoRespondKeywords: ['help'],
      });
      expect(channel.shouldAutoRespond('I need help', group)).toBe(true);
    });

    it('returns false when neither condition matches', () => {
      const group = makeGroup({
        autoRespondToQuestions: true,
        autoRespondKeywords: ['help'],
      });
      expect(channel.shouldAutoRespond('Just chatting', group)).toBe(false);
    });
  });
});
