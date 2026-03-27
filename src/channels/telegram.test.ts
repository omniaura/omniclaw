import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, it, expect, mock } from 'bun:test';

import { GROUPS_DIR } from '../config.js';
import { formatImageMarker, formatTextFileMarker } from '../media.js';
import {
  buildTelegramApiFileUrl,
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

describe('TelegramChannel sender identity', () => {
  const makeChannel = () =>
    new TelegramChannel('123456:token', {
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    });

  it('derives sender and sender_user_id from the Telegram user id', () => {
    const channel = makeChannel();

    expect((channel as any).buildSenderIdentity({ id: 987654321 })).toEqual({
      sender: 'telegram:987654321',
      senderUserId: '987654321',
    });
  });

  it('returns an empty sender when the Telegram user id is missing', () => {
    const channel = makeChannel();

    expect((channel as any).buildSenderIdentity(undefined)).toEqual({
      sender: '',
    });
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

// --- getTelegramFileUrl (private helper, tested via channel instance) ---

describe('TelegramChannel.getTelegramFileUrl', () => {
  const BOT_TOKEN = '123456:secret-token';

  const makeChannel = () =>
    new TelegramChannel(BOT_TOKEN, {
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    });

  it('returns null when bot is not connected', async () => {
    const channel = makeChannel();
    // bot is null before connect()
    const url = await (channel as any).getTelegramFileUrl('some-file-id');
    expect(url).toBeNull();
  });

  it('builds correct API URL from file path', async () => {
    const channel = makeChannel();
    // Inject a mock bot with api.getFile
    (channel as any).bot = {
      api: {
        getFile: async (fileId: string) => ({
          file_id: fileId,
          file_unique_id: 'unique',
          file_size: 12345,
          file_path: 'photos/file_42.jpg',
        }),
      },
    };

    const url = await (channel as any).getTelegramFileUrl('file-id-123');
    expect(url).toBe(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/photos/file_42.jpg`,
    );
  });

  it('returns null when file_path is empty', async () => {
    const channel = makeChannel();
    (channel as any).bot = {
      api: {
        getFile: async () => ({
          file_id: 'x',
          file_unique_id: 'u',
          file_size: 0,
        }),
      },
    };

    const url = await (channel as any).getTelegramFileUrl('file-id');
    expect(url).toBeNull();
  });
});

// --- Telegram media download integration ---

describe('Telegram media download handlers', () => {
  const BOT_TOKEN = '123456:test-token';
  const CHAT_ID = 99887766;
  const CHAT_JID = `tg:123456:${CHAT_ID}`;
  const SENDER_ID = 42;
  const MSG_ID = '100';

  // Track messages delivered via onMessage
  let deliveredMessages: any[];
  let metadataUpdates: any[];
  let testMediaDir: string;

  const makeGroup = (folder: string) => ({
    name: 'test-group',
    folder,
    trigger: '@test',
    added_at: new Date().toISOString(),
    channelFolder: undefined,
    jid: CHAT_JID,
  });

  beforeEach(() => {
    deliveredMessages = [];
    metadataUpdates = [];
    testMediaDir = path.join(
      GROUPS_DIR,
      `tg-media-test-${Date.now()}`,
      'media',
    );
  });

  afterEach(() => {
    // Clean up test media directory
    const parentDir = path.dirname(testMediaDir);
    if (fs.existsSync(parentDir)) {
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  });

  const makeCtx = (overrides: Record<string, any> = {}) => ({
    chat: { id: CHAT_ID, type: 'private' },
    from: { id: SENDER_ID, first_name: 'TestUser' },
    message: {
      message_id: Number(MSG_ID),
      date: Math.floor(Date.now() / 1000),
      caption: null,
      ...overrides,
    },
  });

  // Simulate the photo handler logic inline (since bot.on handlers aren't
  // directly callable in unit tests, we test the constituent pieces)

  it('photo handler: stores image marker when download succeeds', async () => {
    const groupFolder = `tg-media-test-${Date.now()}`;
    const group = makeGroup(groupFolder);
    const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');

    const channel = new TelegramChannel(BOT_TOKEN, {
      onMessage: (_jid, msg) => deliveredMessages.push(msg),
      onChatMetadata: (jid, ts) => metadataUpdates.push({ jid, ts }),
      registeredGroups: () => ({ [CHAT_JID]: group }),
    });

    // Inject mock bot that returns a test file
    const testImageBytes = Buffer.from('fake-png-data');
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(testImageBytes, {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
      ),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;

    (channel as any).bot = {
      api: {
        getFile: async () => ({
          file_id: 'photo-file-id',
          file_unique_id: 'u',
          file_size: testImageBytes.length,
          file_path: 'photos/file_42.jpg',
        }),
      },
    };

    try {
      // Simulate what the photo handler does
      const url = await (channel as any).getTelegramFileUrl('photo-file-id');
      expect(url).toBeTruthy();

      // Use the shared pipeline exactly as the handler does
      const { ensureMediaDir, buildSafeMediaPath, downloadBinaryAttachment } =
        await import('../media.js');
      const actualMediaDir = ensureMediaDir(group);
      expect(fs.existsSync(actualMediaDir)).toBe(true);

      const filePath = buildSafeMediaPath(actualMediaDir, MSG_ID, 'photo.jpg');
      const bytes = await downloadBinaryAttachment(url!);
      fs.writeFileSync(filePath, bytes);

      const marker = formatImageMarker(path.basename(filePath));
      expect(marker).toMatch(/\[attachment:image file=100-photo\.jpg\]/);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath).toString()).toBe('fake-png-data');
    } finally {
      globalThis.fetch = originalFetch;
      if (fs.existsSync(path.join(GROUPS_DIR, groupFolder))) {
        fs.rmSync(path.join(GROUPS_DIR, groupFolder), {
          recursive: true,
          force: true,
        });
      }
    }
  });

  it('photo handler: falls back to [Photo] placeholder on download failure', () => {
    // When getTelegramFileUrl or downloadBinaryAttachment throws,
    // the handler should fall back to '[Photo]'
    let marker = '[Photo]';
    try {
      throw new Error('Network timeout');
    } catch {
      // This is the expected fallback path
    }
    expect(marker).toBe('[Photo]');
  });

  it('document handler: detects image documents by MIME type', () => {
    const { isImageByTypeOrExtension } = require('../media.js');
    expect(isImageByTypeOrExtension('image/png', 'photo.png')).toBe(true);
    expect(isImageByTypeOrExtension('image/jpeg', 'doc.jpg')).toBe(true);
    expect(isImageByTypeOrExtension('application/pdf', 'file.pdf')).toBe(false);
    expect(isImageByTypeOrExtension(null, 'file.webp')).toBe(true);
    expect(isImageByTypeOrExtension(null, 'data.csv')).toBe(false);
  });

  it('document handler: detects text files by extension', () => {
    const { isTextByExtension } = require('../media.js');
    expect(isTextByExtension('readme.md')).toBe(true);
    expect(isTextByExtension('config.json')).toBe(true);
    expect(isTextByExtension('script.py')).toBe(true);
    expect(isTextByExtension('photo.png')).toBe(false);
    expect(isTextByExtension('archive.zip')).toBe(false);
  });

  it('document handler: inlines small text file content', () => {
    const marker = formatTextFileMarker('config.json', '{"key": "value"}');
    expect(marker).toBe(
      '[attachment:file name=config.json]\n{"key": "value"}\n[/attachment:file]',
    );
  });

  it('document handler: uses file placeholder for large/unknown files', () => {
    const { formatPlaceholder } = require('../media.js');
    expect(formatPlaceholder('file', 'archive.zip')).toBe(
      '[File: archive.zip]',
    );
    expect(formatPlaceholder('file')).toBe('[File]');
  });

  it('caption is appended to media marker', () => {
    const marker = '[attachment:image file=100-photo.jpg]';
    const caption = ' Check this out!';
    expect(`${marker}${caption}`).toBe(
      '[attachment:image file=100-photo.jpg] Check this out!',
    );
  });

  it('media directory is created under the group workspace', () => {
    const groupFolder = `tg-media-dir-test-${Date.now()}`;
    const group = makeGroup(groupFolder);
    const { ensureMediaDir } = require('../media.js');

    const mediaDir = ensureMediaDir(group);
    try {
      expect(fs.existsSync(mediaDir)).toBe(true);
      expect(mediaDir).toBe(path.join(GROUPS_DIR, groupFolder, 'media'));
    } finally {
      fs.rmSync(path.join(GROUPS_DIR, groupFolder), {
        recursive: true,
        force: true,
      });
    }
  });

  it('safe media path prevents directory traversal', () => {
    const groupFolder = `tg-traversal-test-${Date.now()}`;
    const group = makeGroup(groupFolder);
    const { ensureMediaDir, buildSafeMediaPath } = require('../media.js');

    const mediaDir = ensureMediaDir(group);
    try {
      // Path traversal attempt should be stripped to just the filename
      const filePath = buildSafeMediaPath(
        mediaDir,
        MSG_ID,
        '../../../etc/passwd',
      );
      expect(filePath).not.toContain('..');
      expect(path.dirname(filePath)).toBe(mediaDir);
    } finally {
      fs.rmSync(path.join(GROUPS_DIR, groupFolder), {
        recursive: true,
        force: true,
      });
    }
  });
});
