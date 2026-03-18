import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'bun:test';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  describeImageUrl,
  type RemoteImageFetch,
  serveCachedRemoteImage,
  validateRemoteImageUrl,
} from './image-cache.js';

function clearTestImageCache(cacheDir: string): void {
  fs.rmSync(cacheDir, {
    recursive: true,
    force: true,
  });
}

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
  it('rejects loopback image urls before fetching', async () => {
    const testImageCacheDir = path.join(
      DATA_DIR,
      'image-cache-image-cache-test',
      randomUUID(),
    );

    clearTestImageCache(testImageCacheDir);

    try {
      const response = await serveCachedRemoteImage(
        'cache-key',
        async () => 'http://127.0.0.1:8080/private.png',
        {
          cacheDir: testImageCacheDir,
          fetchImpl: (async () => {
            throw new Error('should not fetch blocked url');
          }) as RemoteImageFetch,
        },
      );

      expect(response).toBeNull();
    } finally {
      clearTestImageCache(testImageCacheDir);
    }
  });

  it('sanitizes embedded urls in fetch error messages', async () => {
    const originalWarn = logger.warn;
    const records: Array<Record<string, unknown>> = [];
    const testImageCacheDir = path.join(
      DATA_DIR,
      'image-cache-image-cache-test',
      randomUUID(),
    );

    clearTestImageCache(testImageCacheDir);
    logger.warn = ((fieldsOrMsg: Record<string, unknown> | string) => {
      if (typeof fieldsOrMsg !== 'string') {
        records.push(fieldsOrMsg);
      }
    }) as unknown as typeof logger.warn;

    try {
      const response = await serveCachedRemoteImage(
        'cache-key',
        async () => 'https://example.test/avatar.png?token=secret',
        {
          cacheDir: testImageCacheDir,
          fetchImpl: (async () => {
            throw new Error(
              'request to https://example.test/avatar.png?token=secret failed',
            );
          }) as RemoteImageFetch,
        },
      );

      expect(response).toBeNull();
      expect(records).toHaveLength(1);
      expect(records[0].imageUrl).toBe('https://example.test/avatar.png');
      expect(records[0].errorMessage).toBe(
        'request to https://example.test/avatar.png failed',
      );
    } finally {
      clearTestImageCache(testImageCacheDir);
      logger.warn = originalWarn;
    }
  });
});

describe('validateRemoteImageUrl', () => {
  it('rejects localhost hosts', async () => {
    await expect(
      validateRemoteImageUrl('http://localhost:3000/avatar.png'),
    ).resolves.toBe('loopback host is not allowed');
  });

  it('rejects private ip ranges', async () => {
    await expect(
      validateRemoteImageUrl('http://169.254.169.254/latest/meta-data'),
    ).resolves.toBe('private address is not allowed');
  });
});
