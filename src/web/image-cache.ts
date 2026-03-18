import { createHash } from 'crypto';
import { lookup } from 'dns/promises';
import fs from 'fs';
import { isIP } from 'net';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

const IMAGE_CACHE_DIR = path.join(DATA_DIR, 'image-cache');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const BROWSER_CACHE_CONTROL = 'private, max-age=86400';
const REMOTE_IMAGE_FETCH_TIMEOUT_MS = 10_000;

interface CacheMetadata {
  contentType: string;
  fetchedAt: number;
}

export type RemoteImageFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface RemoteImageCacheOptions {
  cacheDir?: string;
  fetchImpl?: RemoteImageFetch;
}

async function lookupHostAddresses(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function isBlockedPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  const ipv4 = normalized.startsWith('::ffff:')
    ? normalized.slice('::ffff:'.length)
    : normalized;

  if (normalized === '::' || normalized === '::1') return true;
  if (ipv4 === '0.0.0.0') return true;
  if (ipv4.startsWith('127.')) return true;
  if (ipv4.startsWith('10.')) return true;
  if (ipv4.startsWith('192.168.')) return true;
  if (ipv4.startsWith('169.254.')) return true;

  const match172 = ipv4.match(/^172\.(\d{1,3})\./);
  if (match172) {
    const octet = Number.parseInt(match172[1], 10);
    if (octet >= 16 && octet <= 31) return true;
  }

  const match100 = ipv4.match(/^100\.(\d{1,3})\./);
  if (match100) {
    const octet = Number.parseInt(match100[1], 10);
    if (octet >= 64 && octet <= 127) return true;
  }

  const match198 = ipv4.match(/^198\.(\d{1,3})\./);
  if (match198) {
    const octet = Number.parseInt(match198[1], 10);
    if (octet === 18 || octet === 19) return true;
  }

  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe8')) return true;
  if (normalized.startsWith('fe9')) return true;
  if (normalized.startsWith('fea')) return true;
  if (normalized.startsWith('feb')) return true;

  return false;
}

export async function validateRemoteImageUrl(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid url';
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'unsupported protocol';
  }

  if (parsed.username || parsed.password) {
    return 'embedded credentials are not allowed';
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return 'loopback host is not allowed';
  }

  if (isIP(hostname) && isBlockedPrivateAddress(hostname)) {
    return 'private address is not allowed';
  }

  if (isIP(hostname)) return null;

  try {
    const addresses = await lookupHostAddresses(hostname);
    if (addresses.some((address) => isBlockedPrivateAddress(address))) {
      return 'resolved private address is not allowed';
    }
  } catch {
    // Fall back to fetch-time handling if DNS lookup is unavailable.
  }

  return null;
}

export function describeImageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function getCachePaths(
  cacheDir: string,
  cacheKey: string,
): {
  dataPath: string;
  metaPath: string;
} {
  const hash = createHash('sha256').update(cacheKey).digest('hex');
  return {
    dataPath: path.join(cacheDir, `${hash}.bin`),
    metaPath: path.join(cacheDir, `${hash}.json`),
  };
}

function readMeta(metaPath: string): CacheMetadata | null {
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as CacheMetadata;
  } catch {
    return null;
  }
}

function buildCachedResponse(dataPath: string, contentType: string): Response {
  // Read eagerly so the response body remains valid even if later test cleanup
  // removes the cache directory before the body stream is consumed.
  return new Response(fs.readFileSync(dataPath), {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': BROWSER_CACHE_CONTROL,
    },
  });
}

function describeFetchError(err: unknown): Record<string, string> {
  if (!(err instanceof Error)) {
    return { errorName: 'UnknownError' };
  }

  const errorMessage = err.message.replace(/https?:\/\/\S+/gi, (match) =>
    describeImageUrl(match),
  );

  return {
    errorName: err.name || 'Error',
    errorMessage,
  };
}

export async function serveCachedRemoteImage(
  cacheKey: string,
  resolveUrl: () => Promise<string | null>,
  options: RemoteImageCacheOptions = {},
): Promise<Response | null> {
  const cacheDir = options.cacheDir ?? IMAGE_CACHE_DIR;
  const fetchImpl: RemoteImageFetch =
    options.fetchImpl ?? ((input, init) => fetch(input, init));
  fs.mkdirSync(cacheDir, { recursive: true });
  const { dataPath, metaPath } = getCachePaths(cacheDir, cacheKey);
  const meta = readMeta(metaPath);

  if (
    meta &&
    fs.existsSync(dataPath) &&
    Date.now() - meta.fetchedAt < ONE_DAY_MS
  ) {
    return buildCachedResponse(dataPath, meta.contentType);
  }

  const url = await resolveUrl();
  if (!url) return null;

  const blockReason = await validateRemoteImageUrl(url);
  if (blockReason) {
    logger.warn(
      {
        cacheKey,
        imageUrl: describeImageUrl(url),
        blockReason,
      },
      'Blocked remote image fetch',
    );
    return null;
  }

  try {
    const upstream = await fetchImpl(url, {
      signal: AbortSignal.timeout(REMOTE_IMAGE_FETCH_TIMEOUT_MS),
    });
    if (!upstream.ok) {
      logger.warn(
        {
          cacheKey,
          status: upstream.status,
          imageUrl: describeImageUrl(url),
        },
        'Failed to fetch image',
      );
      return null;
    }

    const contentType =
      upstream.headers.get('content-type') || 'application/octet-stream';
    const bytes = Buffer.from(await upstream.arrayBuffer());
    fs.writeFileSync(dataPath, bytes);
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        contentType,
        fetchedAt: Date.now(),
      } satisfies CacheMetadata),
      'utf-8',
    );

    return buildCachedResponse(dataPath, contentType);
  } catch (err) {
    logger.warn(
      {
        cacheKey,
        imageUrl: describeImageUrl(url),
        ...describeFetchError(err),
      },
      'Failed to fetch image',
    );
    return null;
  }
}
