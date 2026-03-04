import { describe, it, expect } from 'bun:test';

import {
  isTelegramReactionEmoji,
  VALID_TELEGRAM_REACTIONS,
  TelegramChannel,
} from './telegram.js';

// --- isTelegramReactionEmoji ---

describe('isTelegramReactionEmoji', () => {
  describe('valid emojis', () => {
    it('accepts thumbs up', () => {
      expect(isTelegramReactionEmoji('👍')).toBe(true);
    });

    it('accepts thumbs down', () => {
      expect(isTelegramReactionEmoji('👎')).toBe(true);
    });

    it('accepts heart', () => {
      expect(isTelegramReactionEmoji('❤')).toBe(true);
    });

    it('accepts fire', () => {
      expect(isTelegramReactionEmoji('🔥')).toBe(true);
    });

    it('accepts party popper', () => {
      expect(isTelegramReactionEmoji('🎉')).toBe(true);
    });

    it('accepts 100', () => {
      expect(isTelegramReactionEmoji('💯')).toBe(true);
    });

    it('accepts thinking face', () => {
      expect(isTelegramReactionEmoji('🤔')).toBe(true);
    });

    it('accepts clown', () => {
      expect(isTelegramReactionEmoji('🤡')).toBe(true);
    });

    it('accepts poop', () => {
      expect(isTelegramReactionEmoji('💩')).toBe(true);
    });

    it('accepts eyes', () => {
      expect(isTelegramReactionEmoji('👀')).toBe(true);
    });

    it('accepts combined emoji (heart on fire)', () => {
      expect(isTelegramReactionEmoji('❤‍🔥')).toBe(true);
    });

    it('accepts combined emoji (programmer)', () => {
      expect(isTelegramReactionEmoji('👨‍💻')).toBe(true);
    });

    it('accepts shrug variants', () => {
      expect(isTelegramReactionEmoji('🤷‍♂')).toBe(true);
      expect(isTelegramReactionEmoji('🤷')).toBe(true);
      expect(isTelegramReactionEmoji('🤷‍♀')).toBe(true);
    });
  });

  describe('invalid emojis', () => {
    it('rejects taco emoji (not in Telegram list)', () => {
      expect(isTelegramReactionEmoji('🌮')).toBe(false);
    });

    it('rejects pizza emoji', () => {
      expect(isTelegramReactionEmoji('🍕')).toBe(false);
    });

    it('rejects soccer ball', () => {
      expect(isTelegramReactionEmoji('⚽')).toBe(false);
    });

    it('rejects flag emoji', () => {
      expect(isTelegramReactionEmoji('🇺🇸')).toBe(false);
    });

    it('rejects non-emoji strings', () => {
      expect(isTelegramReactionEmoji('hello')).toBe(false);
      expect(isTelegramReactionEmoji('thumbsup')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isTelegramReactionEmoji('')).toBe(false);
    });

    it('rejects whitespace', () => {
      expect(isTelegramReactionEmoji(' ')).toBe(false);
      expect(isTelegramReactionEmoji('\n')).toBe(false);
    });

    it('rejects emoji shortcodes', () => {
      expect(isTelegramReactionEmoji(':thumbsup:')).toBe(false);
      expect(isTelegramReactionEmoji(':heart:')).toBe(false);
    });

    it('rejects numbers and special characters', () => {
      expect(isTelegramReactionEmoji('1')).toBe(false);
      expect(isTelegramReactionEmoji('!')).toBe(false);
      expect(isTelegramReactionEmoji('#')).toBe(false);
    });
  });

  describe('boundary cases', () => {
    it('rejects emoji with trailing space', () => {
      expect(isTelegramReactionEmoji('👍 ')).toBe(false);
    });

    it('rejects emoji with leading space', () => {
      expect(isTelegramReactionEmoji(' 👍')).toBe(false);
    });

    it('rejects multiple valid emojis combined', () => {
      expect(isTelegramReactionEmoji('👍👎')).toBe(false);
    });
  });
});

// --- VALID_TELEGRAM_REACTIONS ---

describe('VALID_TELEGRAM_REACTIONS', () => {
  it('contains exactly 73 entries', () => {
    expect(VALID_TELEGRAM_REACTIONS.length).toBe(73);
  });

  it('contains common reaction emojis', () => {
    const commonEmojis = ['👍', '👎', '❤', '🔥', '🎉', '💯', '🤔'] as const;
    for (const emoji of commonEmojis) {
      expect(VALID_TELEGRAM_REACTIONS).toContain(emoji);
    }
  });

  it('has no duplicates', () => {
    const unique = new Set(VALID_TELEGRAM_REACTIONS);
    expect(unique.size).toBe(VALID_TELEGRAM_REACTIONS.length);
  });

  it('every entry passes isTelegramReactionEmoji', () => {
    for (const emoji of VALID_TELEGRAM_REACTIONS) {
      expect(isTelegramReactionEmoji(emoji)).toBe(true);
    }
  });

  it('is an array (readonly at type level)', () => {
    // The array is declared as `readonly` via `as const` — a compile-time guarantee.
    // At runtime we can only verify it's an array.
    expect(Array.isArray(VALID_TELEGRAM_REACTIONS)).toBe(true);
  });
});

// --- TelegramChannel.ownsJid ---

describe('TelegramChannel.ownsJid', () => {
  const ownsJid = (jid: string) =>
    TelegramChannel.prototype.ownsJid.call({} as TelegramChannel, jid);

  it('matches tg: prefixed JIDs', () => {
    expect(ownsJid('tg:12345')).toBe(true);
    expect(ownsJid('tg:-100123456789')).toBe(true);
  });

  it('does not match non-Telegram JIDs', () => {
    expect(ownsJid('dc:123')).toBe(false);
    expect(ownsJid('slack:C123')).toBe(false);
    expect(ownsJid('main@g.us')).toBe(false);
  });
});
