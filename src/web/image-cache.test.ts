import { describe, expect, it } from 'bun:test';

import { logger } from '../logger.js';
import { describeImageUrl, serveCachedRemoteImage } from './image-cache.js';

describe('describeImageUrl', () => {
  it('drops query strings and fragments from absolute urls', () => {
    expect(
      describeImageUrl('https://example.test/avatar.png?token=secret#ignored'),
    ).toBe('https://example.test/avatar.png');
  });

  it('returns the original value for non-url strings', () => {
    expect(describeImageUrl('/avatars/local.png')).toBe('/avatars/local.png');
  });
});

describe('serveCachedRemoteImage', () => {
  it('sanitizes embedded urls in fetch error messages', async () => {
    const originalFetch = globalThis.fetch;
    const originalWarn = logger.warn;
    const records: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async () => {
      throw new Error(
        'request to https://example.test/avatar.png?token=secret failed',
      );
    }) as unknown as typeof fetch;
    logger.warn = ((fieldsOrMsg: Record<string, unknown> | string) => {
      if (typeof fieldsOrMsg !== 'string') {
        records.push(fieldsOrMsg);
      }
    }) as unknown as typeof logger.warn;

    try {
      const response = await serveCachedRemoteImage(
        'cache-key',
        async () => 'https://example.test/avatar.png?token=secret',
      );

      expect(response).toBeNull();
      expect(records).toHaveLength(1);
      expect(records[0].imageUrl).toBe('https://example.test/avatar.png');
      expect(records[0].errorMessage).toBe(
        'request to https://example.test/avatar.png failed',
      );
    } finally {
      globalThis.fetch = originalFetch;
      logger.warn = originalWarn;
    }
  });
});
