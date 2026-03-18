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

export interface RemoteImageUrlValidationOptions {
  lookupHostAddresses?: (hostname: string) => Promise<string[]>;
}

async function lookupHostAddresses(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function parseIpv4Octets(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets;
}

function extractMappedIpv4(address: string): string | null {
  if (!address.startsWith('::ffff:')) return null;

  const rest = address.slice('::ffff:'.length);
  if (rest.includes('.')) {
    return parseIpv4Octets(rest) ? rest : null;
  }

  const parts = rest.split(':');
  if (parts.length !== 2) return null;
  if (!parts.every((part) => /^[0-9a-f]{1,4}$/i.test(part))) return null;

  const hi = Number.parseInt(parts[0], 16);
  const lo = Number.parseInt(parts[1], 16);

  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isBlockedPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4 = extractMappedIpv4(normalized) ?? normalized;
  const ipv4Octets = parseIpv4Octets(ipv4);

  if (normalized === '::' || normalized === '::1') return true;
  if (ipv4Octets) {
    const [a, b] = ipv4Octets;
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 240) return true;
  }

  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe8')) return true;
  if (normalized.startsWith('fe9')) return true;
  if (normalized.startsWith('fea')) return true;
  if (normalized.startsWith('feb')) return true;
  if (normalized.startsWith('ff')) return true;

  return false;
}

export async function validateRemoteImageUrl(
  url: string,
  options: RemoteImageUrlValidationOptions = {},
): Promise<string | null> {
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

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return 'loopback host is not allowed';
  }

  if (isIP(hostname) && isBlockedPrivateAddress(hostname)) {
    return 'private address is not allowed';
  }

  if (isIP(hostname)) return null;

  const resolveHostAddresses =
    options.lookupHostAddresses ?? lookupHostAddresses;

  try {
    const addresses = await resolveHostAddresses(hostname);
    if (addresses.some((address) => isBlockedPrivateAddress(address))) {
      return 'resolved private address is not allowed';
    }
  } catch {
    return 'dns lookup failed - cannot verify host safety';
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
    // This still has a DNS rebinding/TOCTOU gap because fetch() resolves the
    // hostname again. The write-time validation in routes.ts prevents
    // persistence of malicious custom avatar URLs, and this fetch-time check
    // adds a second guard for stored remote image URLs.
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
