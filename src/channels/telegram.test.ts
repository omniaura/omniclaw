import { describe, it, expect } from 'bun:test';

import {
  buildTelegramFileDescriptor,
  parseTelegramApiFileUrl,
  parseTelegramFileDescriptor,
  redactTelegramBotTokenFromUrl,
  sanitizeTelegramAvatarUrl,
} from '../telegram-avatar.js';
import {
  TelegramChannel,
  isTelegramReactionEmoji,
  VALID_TELEGRAM_REACTIONS,
  safeErrorMessage,
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
  const makeChannel = (token = '123456:token', allowLegacyJidRouting = true) =>
    new TelegramChannel(token, {
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
      allowLegacyJidRouting,
    });

  it('matches scoped tg:<botId>:<chatId> JIDs for the same bot', () => {
    const channel = makeChannel('123456:token');
    expect(channel.ownsJid('tg:123456:12345')).toBe(true);
    expect(channel.ownsJid('tg:123456:-100123456789')).toBe(true);
  });

  it('does not match scoped JIDs for other bots', () => {
    const channel = makeChannel('123456:token');
    expect(channel.ownsJid('tg:999999:12345')).toBe(false);
  });

  it('supports legacy tg:<chatId> JIDs when legacy routing is enabled', () => {
    const channel = makeChannel('123456:token', true);
    expect(channel.ownsJid('tg:12345')).toBe(true);
    expect(channel.ownsJid('tg:-100123456789')).toBe(true);
  });

  it('rejects legacy tg:<chatId> JIDs when legacy routing is disabled', () => {
    const channel = makeChannel('123456:token', false);
    expect(channel.ownsJid('tg:12345')).toBe(false);
  });

  it('does not match non-Telegram JIDs', () => {
    const channel = makeChannel('123456:token');
    expect(channel.ownsJid('dc:123')).toBe(false);
    expect(channel.ownsJid('slack:C123')).toBe(false);
    expect(channel.ownsJid('main@g.us')).toBe(false);
  });
});

describe('TelegramChannel bot identity', () => {
  it('derives botId from token prefix', () => {
    const channel = new TelegramChannel('123456:abc-token', {
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    });

    expect(channel.botId).toBe('123456');
  });

  it('uses non-secret fallback for unexpected token format', () => {
    const channel = new TelegramChannel('not-a-standard-token', {
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    });

    expect(channel.botId).toBe('telegram-bot');
  });
});

describe('telegram avatar descriptors', () => {
  it('round-trips safe Telegram avatar descriptors', () => {
    const descriptor = buildTelegramFileDescriptor(
      '123456',
      'photos/file_42.jpg',
    );

    expect(parseTelegramFileDescriptor(descriptor)).toEqual({
      botId: '123456',
      filePath: 'photos/file_42.jpg',
    });
  });

  it('sanitizes Telegram file URLs into token-free descriptors', () => {
    const sanitized = sanitizeTelegramAvatarUrl(
      'https://api.telegram.org/file/bot123456:secret-token/photos/file_42.jpg',
      'telegram',
    );

    expect(sanitized).toBe('tg-file:123456:photos%2Ffile_42.jpg');
    expect(sanitized).not.toContain('secret-token');
  });

  it('does not rewrite custom avatar URLs even if they look like Telegram file URLs', () => {
    const original =
      'https://api.telegram.org/file/bot123456:secret-token/photos/file_42.jpg';

    expect(sanitizeTelegramAvatarUrl(original, 'custom')).toBe(original);
  });

  it('can still redact unknown-source Telegram file URLs when needed', () => {
    expect(
      redactTelegramBotTokenFromUrl(
        'https://api.telegram.org/file/bot123456:secret-token/photos/file_42.jpg',
      ),
    ).toBe('tg-file:123456:photos%2Ffile_42.jpg');
  });

  it('parses Telegram file URLs into token, botId, and path', () => {
    expect(
      parseTelegramApiFileUrl(
        'https://api.telegram.org/file/bot123456:secret-token/photos/file_42.jpg',
      ),
    ).toEqual({
      botToken: '123456:secret-token',
      botId: '123456',
      filePath: 'photos/file_42.jpg',
    });
  });

  it('resolves stored descriptors back into fetchable Telegram file URLs', async () => {
    const channel = new TelegramChannel('123456:secret-token', {
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    });

    await expect(
      channel.resolveStoredAvatarUrl?.('tg-file:123456:photos%2Ffile_42.jpg'),
    ).resolves.toBe(
      'https://api.telegram.org/file/bot123456:secret-token/photos/file_42.jpg',
    );
  });
});

// --- safeErrorMessage (token redaction) ---

describe('safeErrorMessage', () => {
  it('redacts Telegram bot API URLs from Error messages', () => {
    const err = new Error(
      'Request failed: https://api.telegram.org/bot123456:ABCdefGHIjklMNOpqrSTUvwxYZ/sendMessage 403 Forbidden',
    );
    const msg = safeErrorMessage(err);
    expect(msg).not.toContain('123456:ABCdefGHIjklMNOpqrSTUvwxYZ');
    expect(msg).toContain('https://api.telegram.org/bot[REDACTED]');
    expect(msg).toContain('403 Forbidden');
  });

  it('redacts multiple bot URLs in a single message', () => {
    const err = new Error(
      'Tried https://api.telegram.org/bot111:aaa/getMe then https://api.telegram.org/bot222:bbb/sendMessage',
    );
    const msg = safeErrorMessage(err);
    expect(msg).not.toContain('111:aaa');
    expect(msg).not.toContain('222:bbb');
    expect(msg).toContain('https://api.telegram.org/bot[REDACTED]');
  });

  it('handles non-Error values (strings)', () => {
    const msg = safeErrorMessage(
      'network error at https://api.telegram.org/bot999:xyz/getUpdates',
    );
    expect(msg).not.toContain('999:xyz');
    expect(msg).toContain('https://api.telegram.org/bot[REDACTED]');
  });

  it('passes through safe messages unchanged', () => {
    const err = new Error('Connection timed out');
    expect(safeErrorMessage(err)).toBe('Connection timed out');
  });
});
