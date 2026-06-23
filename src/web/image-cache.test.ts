import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import http from 'node:http';
import path from 'path';

import { describe, expect, it } from 'bun:test';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  describeImageUrl,
  fetchWithPinnedDns,
  readStreamWithCap,
  type RemoteImageFetch,
  resolveAndValidateRemoteImageUrl,
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
  it('serves a fresh safe cached image without resolving or fetching', async () => {
    const testImageCacheDir = path.join(
      DATA_DIR,
      'image-cache-image-cache-test',
      randomUUID(),
    );

    clearTestImageCache(testImageCacheDir);

    try {
      const cacheHash = createHash('sha256')
        .update('fresh-cache-key')
        .digest('hex');

      fs.mkdirSync(testImageCacheDir, { recursive: true });
      fs.writeFileSync(
        path.join(testImageCacheDir, `${cacheHash}.bin`),
        new Uint8Array([1, 2, 3]),
      );
      fs.writeFileSync(
        path.join(testImageCacheDir, `${cacheHash}.json`),
        JSON.stringify({
          contentType: 'image/png; charset=binary',
          fetchedAt: Date.now(),
        }),
      );

      const response = await serveCachedRemoteImage(
        'fresh-cache-key',
        async () => {
          throw new Error('fresh cache entry should not resolve upstream URL');
        },
        { cacheDir: testImageCacheDir },
      );

      expect(response).not.toBeNull();
      expect(response!.headers.get('content-type')).toBe('image/png');
      expect(response!.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await response!.arrayBuffer()).toEqual(
        new Uint8Array([1, 2, 3]).buffer,
      );
    } finally {
      clearTestImageCache(testImageCacheDir);
    }
  });

  it('refreshes stale cached images from upstream', async () => {
    const testImageCacheDir = path.join(
      DATA_DIR,
      'image-cache-image-cache-test',
      randomUUID(),
    );

    clearTestImageCache(testImageCacheDir);

    try {
      const cacheHash = createHash('sha256')
        .update('stale-cache-key')
        .digest('hex');

      fs.mkdirSync(testImageCacheDir, { recursive: true });
      fs.writeFileSync(path.join(testImageCacheDir, `${cacheHash}.bin`), 'old');
      fs.writeFileSync(
        path.join(testImageCacheDir, `${cacheHash}.json`),
        JSON.stringify({
          contentType: 'image/png',
          fetchedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
        }),
      );

      const response = await serveCachedRemoteImage(
        'stale-cache-key',
        async () => 'https://93.184.216.34/avatar.png',
        {
          cacheDir: testImageCacheDir,
          fetchImpl: (async () =>
            new Response(new Uint8Array([9, 8, 7]), {
              headers: { 'content-type': 'image/webp' },
            })) as RemoteImageFetch,
        },
      );

      expect(response).not.toBeNull();
      expect(response!.headers.get('content-type')).toBe('image/webp');
      expect(new Uint8Array(await response!.arrayBuffer())).toEqual(
        new Uint8Array([9, 8, 7]),
      );
    } finally {
      clearTestImageCache(testImageCacheDir);
    }
  });

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

  it('does not follow direct-IP redirects to unvalidated targets', async () => {
    const testImageCacheDir = path.join(
      DATA_DIR,
      'image-cache-image-cache-test',
      randomUUID(),
    );
    const fetchCalls: RequestInit[] = [];

    clearTestImageCache(testImageCacheDir);

    try {
      const response = await serveCachedRemoteImage(
        'redirect-cache-key',
        async () => 'http://93.184.216.34/avatar.png',
        {
          cacheDir: testImageCacheDir,
          fetchImpl: (async (_input, init) => {
            fetchCalls.push(init ?? {});
            return new Response(null, {
              status: 302,
              headers: {
                location: 'http://127.0.0.1:8080/private.png',
              },
            });
          }) as RemoteImageFetch,
        },
      );

      expect(response).toBeNull();
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].redirect).toBe('manual');
      expect(fs.readdirSync(testImageCacheDir)).toEqual([]);
    } finally {
      clearTestImageCache(testImageCacheDir);
    }
  });

  it('rejects active content types from upstream responses', async () => {
    const testImageCacheDir = path.join(
      DATA_DIR,
      'image-cache-image-cache-test',
      randomUUID(),
    );

    clearTestImageCache(testImageCacheDir);

    try {
      const response = await serveCachedRemoteImage(
        'active-content-key',
        async () => 'https://93.184.216.34/avatar.html',
        {
          cacheDir: testImageCacheDir,
          fetchImpl: (async () =>
            new Response('<script>alert(1)</script>', {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            })) as RemoteImageFetch,
        },
      );

      expect(response).toBeNull();
      expect(fs.readdirSync(testImageCacheDir)).toEqual([]);
    } finally {
      clearTestImageCache(testImageCacheDir);
    }
  });

  it('rejects svg images because they can contain active script content', async () => {
    const testImageCacheDir = path.join(
      DATA_DIR,
      'image-cache-image-cache-test',
      randomUUID(),
    );

    clearTestImageCache(testImageCacheDir);

    try {
      const response = await serveCachedRemoteImage(
        'svg-content-key',
        async () => 'https://93.184.216.34/avatar.svg',
        {
          cacheDir: testImageCacheDir,
          fetchImpl: (async () =>
            new Response('<svg><script>alert(1)</script></svg>', {
              status: 200,
              headers: { 'content-type': 'image/svg+xml' },
            })) as RemoteImageFetch,
        },
      );

      expect(response).toBeNull();
      expect(fs.readdirSync(testImageCacheDir)).toEqual([]);
    } finally {
      clearTestImageCache(testImageCacheDir);
    }
  });

  it('does not replay cached entries with unsafe content types', async () => {
    const testImageCacheDir = path.join(
      DATA_DIR,
      'image-cache-image-cache-test',
      randomUUID(),
    );

    clearTestImageCache(testImageCacheDir);

    try {
      const cacheHash = createHash('sha256')
        .update('unsafe-cache-key')
        .digest('hex');

      fs.mkdirSync(testImageCacheDir, { recursive: true });
      fs.writeFileSync(
        path.join(testImageCacheDir, `${cacheHash}.bin`),
        '<script>alert(1)</script>',
      );
      fs.writeFileSync(
        path.join(testImageCacheDir, `${cacheHash}.json`),
        JSON.stringify({
          contentType: 'text/html',
          fetchedAt: Date.now(),
        }),
      );

      const response = await serveCachedRemoteImage(
        'unsafe-cache-key',
        async () => null,
        { cacheDir: testImageCacheDir },
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
        async () => 'https://93.184.216.34/avatar.png?token=secret',
        {
          cacheDir: testImageCacheDir,
          fetchImpl: (async () => {
            throw new Error(
              'request to https://93.184.216.34/avatar.png?token=secret failed',
            );
          }) as RemoteImageFetch,
        },
      );

      expect(response).toBeNull();
      expect(records).toHaveLength(1);
      expect(records[0].imageUrl).toBe('https://93.184.216.34/avatar.png');
      expect(records[0].errorMessage).toBe(
        'request to https://93.184.216.34/avatar.png failed',
      );
    } finally {
      clearTestImageCache(testImageCacheDir);
      logger.warn = originalWarn;
    }
  });
});

/** Build a fake fetch that returns a streamed body of the given size. */
function makeFakeStreamFetch(
  bodySize: number,
  chunkSize = 1024,
): RemoteImageFetch {
  return async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let sent = 0;
        while (sent < bodySize) {
          const size = Math.min(chunkSize, bodySize - sent);
          controller.enqueue(new Uint8Array(size));
          sent += size;
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
  };
}

describe('readStreamWithCap', () => {
  it('reads a stream within the byte limit', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });

    const result = await readStreamWithCap(stream, 100);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(5);
  });

  it('returns null when stream exceeds the byte limit', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
        controller.close();
      },
    });

    const result = await readStreamWithCap(stream, 1000);
    expect(result).toBeNull();
  });

  it('handles exact boundary (equal to limit is allowed)', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(100));
        controller.close();
      },
    });

    const result = await readStreamWithCap(stream, 100);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(100);
  });

  it('rejects stream that exceeds limit by one byte', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(101));
        controller.close();
      },
    });

    const result = await readStreamWithCap(stream, 100);
    expect(result).toBeNull();
  });

  it('handles multi-chunk streams within limit', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(30));
        controller.enqueue(new Uint8Array(30));
        controller.enqueue(new Uint8Array(30));
        controller.close();
      },
    });

    const result = await readStreamWithCap(stream, 100);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(90);
  });
});

describe('serveCachedRemoteImage byte cap', () => {
  it('rejects images that exceed the byte limit', async () => {
    const testImageCacheDir = path.join(
      DATA_DIR,
      'image-cache-image-cache-test',
      randomUUID(),
    );

    clearTestImageCache(testImageCacheDir);

    const originalWarn = logger.warn;
    const records: Array<Record<string, unknown>> = [];
    logger.warn = ((fieldsOrMsg: Record<string, unknown> | string) => {
      if (typeof fieldsOrMsg !== 'string') {
        records.push(fieldsOrMsg);
      }
    }) as unknown as typeof logger.warn;

    try {
      const response = await serveCachedRemoteImage(
        'oversized-key',
        async () => 'https://93.184.216.34/huge-avatar.png',
        {
          cacheDir: testImageCacheDir,
          fetchImpl: makeFakeStreamFetch(2000),
          maxBytes: 1000,
        },
      );

      expect(response).toBeNull();
      expect(records.some((r) => r.maxBytes === 1000)).toBe(true);
    } finally {
      clearTestImageCache(testImageCacheDir);
      logger.warn = originalWarn;
    }
  });

  it('accepts images within the byte limit', async () => {
    const testImageCacheDir = path.join(
      DATA_DIR,
      'image-cache-image-cache-test',
      randomUUID(),
    );

    clearTestImageCache(testImageCacheDir);

    try {
      const response = await serveCachedRemoteImage(
        'small-key',
        async () => 'https://93.184.216.34/small-avatar.png',
        {
          cacheDir: testImageCacheDir,
          fetchImpl: makeFakeStreamFetch(500),
          maxBytes: 1000,
        },
      );

      expect(response).not.toBeNull();
      expect(response!.headers.get('content-type')).toBe('image/png');
    } finally {
      clearTestImageCache(testImageCacheDir);
    }
  });

  it('does not write to disk when byte limit is exceeded', async () => {
    const testImageCacheDir = path.join(
      DATA_DIR,
      'image-cache-image-cache-test',
      randomUUID(),
    );

    clearTestImageCache(testImageCacheDir);

    const originalWarn = logger.warn;
    logger.warn = (() => {}) as unknown as typeof logger.warn;

    try {
      await serveCachedRemoteImage(
        'no-disk-key',
        async () => 'https://93.184.216.34/huge.png',
        {
          cacheDir: testImageCacheDir,
          fetchImpl: makeFakeStreamFetch(5000),
          maxBytes: 1000,
        },
      );

      // Only the directory should exist, no .bin or .json files
      const files = fs.existsSync(testImageCacheDir)
        ? fs.readdirSync(testImageCacheDir)
        : [];
      expect(files.length).toBe(0);
    } finally {
      clearTestImageCache(testImageCacheDir);
      logger.warn = originalWarn;
    }
  });

  it('uses default 5 MiB limit when maxBytes is not specified', async () => {
    const testImageCacheDir = path.join(
      DATA_DIR,
      'image-cache-image-cache-test',
      randomUUID(),
    );

    clearTestImageCache(testImageCacheDir);

    const originalWarn = logger.warn;
    const records: Array<Record<string, unknown>> = [];
    logger.warn = ((fieldsOrMsg: Record<string, unknown> | string) => {
      if (typeof fieldsOrMsg !== 'string') {
        records.push(fieldsOrMsg);
      }
    }) as unknown as typeof logger.warn;

    try {
      // 6 MiB body — exceeds the default 5 MiB limit
      const response = await serveCachedRemoteImage(
        'default-limit-key',
        async () => 'https://93.184.216.34/massive.png',
        {
          cacheDir: testImageCacheDir,
          fetchImpl: makeFakeStreamFetch(6 * 1024 * 1024, 64 * 1024),
        },
      );

      expect(response).toBeNull();
      expect(records.some((r) => r.maxBytes === 5 * 1024 * 1024)).toBe(true);
    } finally {
      clearTestImageCache(testImageCacheDir);
      logger.warn = originalWarn;
    }
  });
});

describe('validateRemoteImageUrl', () => {
  it.each([
    ['http://0.0.0.0/avatar.png', 'private address is not allowed'],
    ['http://172.16.0.1/avatar.png', 'private address is not allowed'],
    ['http://100.64.0.1/avatar.png', 'private address is not allowed'],
    ['http://240.0.0.1/avatar.png', 'private address is not allowed'],
    ['http://[fc00::1]/avatar.png', 'private address is not allowed'],
    ['http://[fe80::1]/avatar.png', 'private address is not allowed'],
    ['http://[ff02::1]/avatar.png', 'private address is not allowed'],
    ['http://cdn.localhost/avatar.png', 'loopback host is not allowed'],
  ])('rejects blocked local address %s', async (url, expected) => {
    await expect(validateRemoteImageUrl(url)).resolves.toBe(expected);
  });

  it('rejects localhost hosts', async () => {
    await expect(
      validateRemoteImageUrl('http://localhost:3000/avatar.png'),
    ).resolves.toBe('loopback host is not allowed');
  });

  it('rejects IPv6 loopback hosts', async () => {
    await expect(
      validateRemoteImageUrl('http://[::1]/avatar.png'),
    ).resolves.toBe('private address is not allowed');
  });

  it('rejects IPv6-mapped IPv4 hosts written in hex', async () => {
    await expect(
      validateRemoteImageUrl('http://[::ffff:7f00:1]/avatar.png'),
    ).resolves.toBe('private address is not allowed');
  });

  it('rejects private ip ranges', async () => {
    await expect(
      validateRemoteImageUrl('http://169.254.169.254/latest/meta-data'),
    ).resolves.toBe('private address is not allowed');
  });

  it('rejects RFC1918 10/8 addresses', async () => {
    await expect(
      validateRemoteImageUrl('http://10.0.0.1/avatar.png'),
    ).resolves.toBe('private address is not allowed');
  });

  it('rejects embedded credentials', async () => {
    await expect(
      validateRemoteImageUrl('http://user:pass@example.com/avatar.png'),
    ).resolves.toBe('embedded credentials are not allowed');
  });

  it('rejects unsupported protocols', async () => {
    await expect(validateRemoteImageUrl('file:///etc/passwd')).resolves.toBe(
      'unsupported protocol',
    );
  });

  it('fails closed when DNS lookup cannot verify the host', async () => {
    await expect(
      validateRemoteImageUrl('https://cdn.example.com/avatar.png', {
        lookupHostAddresses: async () => {
          throw new Error('dns down');
        },
      }),
    ).resolves.toBe('dns lookup failed - cannot verify host safety');
  });

  it('rejects hostnames that resolve to private addresses', async () => {
    await expect(
      validateRemoteImageUrl('https://cdn.example.com/avatar.png', {
        lookupHostAddresses: async () => ['::ffff:7f00:1'],
      }),
    ).resolves.toBe('resolved private address is not allowed');
  });

  it('accepts public https urls', async () => {
    await expect(
      validateRemoteImageUrl('https://cdn.example.com/avatar.png', {
        lookupHostAddresses: async () => ['93.184.216.34'],
      }),
    ).resolves.toBeNull();
  });

  it('rejects hostnames that resolve no addresses', async () => {
    await expect(
      validateRemoteImageUrl('https://cdn.example.com/avatar.png', {
        lookupHostAddresses: async () => [],
      }),
    ).resolves.toBe('no addresses resolved');
  });
});

describe('resolveAndValidateRemoteImageUrl', () => {
  it('returns resolved addresses for hostname-based urls', async () => {
    const result = await resolveAndValidateRemoteImageUrl(
      'https://cdn.example.com/avatar.png',
      {
        lookupHostAddresses: async () => [
          '93.184.216.34',
          '2606:2800:220:1:248:1893:25c8:1946',
        ],
      },
    );
    expect(result.error).toBeNull();
    expect(result.resolvedAddresses).toEqual([
      '93.184.216.34',
      '2606:2800:220:1:248:1893:25c8:1946',
    ]);
  });

  it('returns empty addresses for direct-IP urls', async () => {
    const result = await resolveAndValidateRemoteImageUrl(
      'https://93.184.216.34/avatar.png',
    );
    expect(result.error).toBeNull();
    expect(result.resolvedAddresses).toEqual([]);
  });

  it('returns error and empty addresses for blocked urls', async () => {
    const result = await resolveAndValidateRemoteImageUrl(
      'http://127.0.0.1/avatar.png',
    );
    expect(result.error).toBe('private address is not allowed');
    expect(result.resolvedAddresses).toEqual([]);
  });

  it('returns error when hostname resolves to private address', async () => {
    const result = await resolveAndValidateRemoteImageUrl(
      'https://evil.test/avatar.png',
      { lookupHostAddresses: async () => ['10.0.0.1'] },
    );
    expect(result.error).toBe('resolved private address is not allowed');
    expect(result.resolvedAddresses).toEqual([]);
  });
});

describe('fetchWithPinnedDns', () => {
  it('connects to the pinned address instead of resolving DNS', async () => {
    const body = 'pinned-response-body';
    let receivedHost: string | undefined;

    const server = http.createServer((req, res) => {
      receivedHost = req.headers.host;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(body);
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as { port: number }).port;

    try {
      // Fetch a URL with hostname "cdn.example.com" but pin to 127.0.0.1.
      // Without pinning, this would attempt real DNS resolution for cdn.example.com.
      const response = await fetchWithPinnedDns(
        `http://cdn.example.com:${port}/avatar.png`,
        '127.0.0.1',
        5000,
      );

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toBe(body);
      // The Host header should carry the original hostname.
      expect(receivedHost).toBe(`cdn.example.com:${port}`);
    } finally {
      server.close();
    }
  });

  it('rejects after timeout', async () => {
    // Start a server that never responds
    const server = http.createServer(() => {
      // intentionally hang
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as { port: number }).port;

    try {
      await expect(
        fetchWithPinnedDns(
          `http://cdn.example.com:${port}/slow.png`,
          '127.0.0.1',
          100,
        ),
      ).rejects.toThrow(/timed out/i);
    } finally {
      server.close();
    }
  });
});

describe('serveCachedRemoteImage DNS rebinding prevention', () => {
  it('uses pinned DNS for hostname URLs even when fetchImpl is provided', async () => {
    const testImageCacheDir = path.join(
      DATA_DIR,
      'image-cache-rebinding-test',
      randomUUID(),
    );

    clearTestImageCache(testImageCacheDir);

    // Start a local HTTP server that serves an image.
    const body = Buffer.from('fake-png-data');
    let receivedHost: string | undefined;
    const server = http.createServer((req, res) => {
      receivedHost = req.headers.host;
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(body);
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as { port: number }).port;

    try {
      const response = await serveCachedRemoteImage(
        'pinned-hostname-key',
        async () => `http://cdn.example.com:${port}/avatar.png`,
        {
          cacheDir: testImageCacheDir,
          lookupHostAddresses: async () => ['93.184.216.34'],
          fetchImpl: (async () => {
            throw new Error('fetchImpl must not be used for hostname URLs');
          }) as RemoteImageFetch,
          fetchWithPinnedDnsImpl: (url, pinnedAddress, timeoutMs) => {
            expect(pinnedAddress).toBe('93.184.216.34');
            return fetchWithPinnedDns(url, '127.0.0.1', timeoutMs);
          },
        },
      );

      expect(response).not.toBeNull();
      expect(response!.status).toBe(200);
      // Verify the Host header carries the original hostname, not the pinned IP.
      expect(receivedHost).toBe(`cdn.example.com:${port}`);
    } finally {
      server.close();
      clearTestImageCache(testImageCacheDir);
    }
  });

  it('blocks fetch when DNS resolves to a private address', async () => {
    const testImageCacheDir = path.join(
      DATA_DIR,
      'image-cache-rebinding-test',
      randomUUID(),
    );

    clearTestImageCache(testImageCacheDir);

    const originalWarn = logger.warn;
    const records: Array<Record<string, unknown>> = [];
    logger.warn = ((fieldsOrMsg: Record<string, unknown> | string) => {
      if (typeof fieldsOrMsg !== 'string') {
        records.push(fieldsOrMsg);
      }
    }) as unknown as typeof logger.warn;

    try {
      // DNS resolver returns a private address — should be blocked at
      // validation time, never reaching any fetch.
      const response = await serveCachedRemoteImage(
        'rebind-key',
        async () => 'http://evil.test/avatar.png',
        {
          cacheDir: testImageCacheDir,
          lookupHostAddresses: async () => ['10.0.0.1'],
        },
      );

      expect(response).toBeNull();
      expect(
        records.some(
          (r) => r.blockReason === 'resolved private address is not allowed',
        ),
      ).toBe(true);
    } finally {
      clearTestImageCache(testImageCacheDir);
      logger.warn = originalWarn;
    }
  });

  it('passes lookupHostAddresses through to validation', async () => {
    const testImageCacheDir = path.join(
      DATA_DIR,
      'image-cache-rebinding-test',
      randomUUID(),
    );

    clearTestImageCache(testImageCacheDir);

    const originalWarn = logger.warn;
    logger.warn = (() => {}) as unknown as typeof logger.warn;

    let lookupCalled = false;

    try {
      await serveCachedRemoteImage(
        'lookup-passthrough-key',
        async () => 'http://cdn.example.com/avatar.png',
        {
          cacheDir: testImageCacheDir,
          lookupHostAddresses: async () => {
            lookupCalled = true;
            // Return a private address to trigger block (easiest way to verify
            // that our custom resolver was actually used).
            return ['192.168.1.1'];
          },
        },
      );

      expect(lookupCalled).toBe(true);
    } finally {
      clearTestImageCache(testImageCacheDir);
      logger.warn = originalWarn;
    }
  });
});
