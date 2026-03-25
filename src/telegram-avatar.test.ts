import { describe, expect, it } from 'bun:test';

import {
  buildTelegramApiFileUrl,
  buildTelegramFileDescriptor,
  parseTelegramApiFileUrl,
  parseTelegramFileDescriptor,
  redactTelegramBotTokenFromUrl,
  sanitizeTelegramAvatarUrl,
} from './telegram-avatar.js';

describe('telegram avatar helpers', () => {
  it('round-trips file descriptors with encoded bot ids and file paths', () => {
    const descriptor = buildTelegramFileDescriptor(
      'bot:id',
      'photos/avatar 1.png',
    );

    expect(parseTelegramFileDescriptor(descriptor)).toEqual({
      botId: 'bot:id',
      filePath: 'photos/avatar 1.png',
    });
  });

  it('rejects malformed file descriptors', () => {
    expect(parseTelegramFileDescriptor('not-telegram')).toBeNull();
    expect(parseTelegramFileDescriptor('tg-file:no-separator')).toBeNull();
    expect(
      parseTelegramFileDescriptor('tg-file:%E0%A4%A:avatar.png'),
    ).toBeNull();
    expect(parseTelegramFileDescriptor('tg-file:bot-id:')).toBeNull();
    expect(parseTelegramFileDescriptor('tg-file:%20:avatar.png')).toBeNull();
    expect(parseTelegramFileDescriptor('tg-file:bot-id:%20')).toBeNull();
  });

  it('extracts bot token, bot id, and file path from Telegram API file urls', () => {
    expect(
      parseTelegramApiFileUrl(
        'https://api.telegram.org/file/bot123456:token/photos/avatar.png',
      ),
    ).toEqual({
      botToken: '123456:token',
      botId: '123456',
      filePath: 'photos/avatar.png',
    });
  });

  it('rejects malformed Telegram API file urls', () => {
    expect(
      parseTelegramApiFileUrl('https://example.com/avatar.png'),
    ).toBeNull();
    expect(
      parseTelegramApiFileUrl(
        'https://api.telegram.org/file/bot/photos/avatar.png',
      ),
    ).toBeNull();
    expect(
      parseTelegramApiFileUrl(
        'https://api.telegram.org/file/bot:token/photos/avatar.png',
      ),
    ).toBeNull();
  });

  it('sanitizes Telegram avatar urls only for Telegram sources', () => {
    const url = buildTelegramApiFileUrl('123456:token', 'photos/avatar.png');

    expect(sanitizeTelegramAvatarUrl(url, 'telegram')).toBe(
      buildTelegramFileDescriptor('123456', 'photos/avatar.png'),
    );
    expect(sanitizeTelegramAvatarUrl(url, 'discord')).toBe(url);
    expect(sanitizeTelegramAvatarUrl(url, 'slack')).toBe(url);
    expect(sanitizeTelegramAvatarUrl(undefined, 'telegram')).toBeUndefined();
  });

  it('redacts Telegram bot tokens from matching urls', () => {
    const url = buildTelegramApiFileUrl(
      '123456:super-secret',
      'photos/avatar.png',
    );

    expect(redactTelegramBotTokenFromUrl(url)).toBe(
      buildTelegramFileDescriptor('123456', 'photos/avatar.png'),
    );
    expect(
      redactTelegramBotTokenFromUrl('https://example.com/avatar.png'),
    ).toBe('https://example.com/avatar.png');
    expect(redactTelegramBotTokenFromUrl(undefined)).toBeUndefined();
  });
});
