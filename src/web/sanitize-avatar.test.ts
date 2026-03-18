import { describe, expect, it } from 'bun:test';

import {
  containsTelegramToken,
  extractTelegramFilePath,
  buildTelegramFileUrl,
  sanitizeAvatarUrl,
} from './sanitize-avatar.js';

describe('containsTelegramToken', () => {
  it('returns true for Telegram file URLs with bot token', () => {
    expect(
      containsTelegramToken(
        'https://api.telegram.org/file/bot123456:ABCDEF/photos/file_42.jpg',
      ),
    ).toBe(true);
  });

  it('returns true for varied token formats', () => {
    expect(
      containsTelegramToken(
        'https://api.telegram.org/file/bot7890123456:AAFx_long-Token123/documents/file_99.pdf',
      ),
    ).toBe(true);
  });

  it('returns false for Discord CDN URLs', () => {
    expect(
      containsTelegramToken(
        'https://cdn.discordapp.com/avatars/123/avatar.png',
      ),
    ).toBe(false);
  });

  it('returns false for local avatar paths', () => {
    expect(containsTelegramToken('/avatars/my-agent/avatar.png')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(containsTelegramToken('')).toBe(false);
  });

  it('is case-insensitive for domain', () => {
    expect(
      containsTelegramToken(
        'HTTPS://API.TELEGRAM.ORG/file/bot123:ABC/photos/file.jpg',
      ),
    ).toBe(true);
  });
});

describe('extractTelegramFilePath', () => {
  it('extracts the file path from a Telegram URL', () => {
    expect(
      extractTelegramFilePath(
        'https://api.telegram.org/file/bot123456:ABCDEF/photos/file_42.jpg',
      ),
    ).toBe('photos/file_42.jpg');
  });

  it('returns null for non-Telegram URLs', () => {
    expect(
      extractTelegramFilePath(
        'https://cdn.discordapp.com/avatars/123/avatar.png',
      ),
    ).toBeNull();
  });

  it('handles nested file paths', () => {
    expect(
      extractTelegramFilePath(
        'https://api.telegram.org/file/bot123:ABC/photos/profile/large.jpg',
      ),
    ).toBe('photos/profile/large.jpg');
  });

  it('returns null for empty string', () => {
    expect(extractTelegramFilePath('')).toBeNull();
  });
});

describe('buildTelegramFileUrl', () => {
  it('reconstructs a full Telegram download URL', () => {
    expect(buildTelegramFileUrl('photos/file_42.jpg', '123456:ABCDEF')).toBe(
      'https://api.telegram.org/file/bot123456:ABCDEF/photos/file_42.jpg',
    );
  });
});

describe('sanitizeAvatarUrl', () => {
  it('returns null for undefined', () => {
    expect(sanitizeAvatarUrl(undefined)).toBeNull();
  });

  it('returns null for Telegram token-bearing URLs', () => {
    expect(
      sanitizeAvatarUrl(
        'https://api.telegram.org/file/bot123456:ABCDEF/photos/file_42.jpg',
      ),
    ).toBeNull();
  });

  it('passes through Discord CDN URLs', () => {
    const url = 'https://cdn.discordapp.com/avatars/123/avatar.png';
    expect(sanitizeAvatarUrl(url)).toBe(url);
  });

  it('passes through local avatar paths', () => {
    const url = '/avatars/my-agent/avatar.png';
    expect(sanitizeAvatarUrl(url)).toBe(url);
  });

  it('passes through generic HTTPS URLs', () => {
    const url = 'https://example.com/avatar.png';
    expect(sanitizeAvatarUrl(url)).toBe(url);
  });

  it('returns null for empty string', () => {
    expect(sanitizeAvatarUrl('')).toBeNull();
  });
});
