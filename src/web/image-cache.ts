import { createHash } from 'crypto';
import { lookup } from 'dns/promises';
import fs from 'fs';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'net';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

const IMAGE_CACHE_DIR = path.join(DATA_DIR, 'image-cache');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const BROWSER_CACHE_CONTROL = 'private, max-age=86400';
const REMOTE_IMAGE_FETCH_TIMEOUT_MS = 10_000;
const ALLOWED_REMOTE_IMAGE_CONTENT_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

/** Default maximum bytes to buffer from a remote image fetch (5 MiB). */
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface CacheMetadata {
  contentType: string;
  fetchedAt: number;
}

export type RemoteImageFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type PinnedRemoteImageFetch = (
  url: string,
  pinnedAddress: string,
  timeoutMs: number,
) => Promise<Response>;

export interface RemoteImageCacheOptions {
  cacheDir?: string;
  fetchImpl?: RemoteImageFetch;
  /** Override pinned DNS fetch (primarily for tests). */
  fetchWithPinnedDnsImpl?: PinnedRemoteImageFetch;
  /** Maximum bytes to read from the upstream response. Defaults to 5 MiB. */
  maxBytes?: number;
  /** Override DNS resolution (primarily for tests). */
  lookupHostAddresses?: (hostname: string) => Promise<string[]>;
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

export interface RemoteImageUrlValidationResult {
  error: string | null;
  /** Pre-resolved IP addresses. Empty for direct-IP URLs. */
  resolvedAddresses: string[];
}

/**
 * Validate a remote image URL and resolve its hostname to IP addresses.
 * Returns both the validation result and the resolved addresses so callers
 * can pin DNS for the subsequent fetch (preventing DNS rebinding).
 */
export async function resolveAndValidateRemoteImageUrl(
  url: string,
  options: RemoteImageUrlValidationOptions = {},
): Promise<RemoteImageUrlValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: 'invalid url', resolvedAddresses: [] };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: 'unsupported protocol', resolvedAddresses: [] };
  }

  if (parsed.username || parsed.password) {
    return {
      error: 'embedded credentials are not allowed',
      resolvedAddresses: [],
    };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { error: 'loopback host is not allowed', resolvedAddresses: [] };
  }

  if (isIP(hostname) && isBlockedPrivateAddress(hostname)) {
    return { error: 'private address is not allowed', resolvedAddresses: [] };
  }

  if (isIP(hostname)) return { error: null, resolvedAddresses: [] };

  const resolveHostAddresses =
    options.lookupHostAddresses ?? lookupHostAddresses;

  try {
    const addresses = await resolveHostAddresses(hostname);
    if (addresses.length === 0) {
      return { error: 'no addresses resolved', resolvedAddresses: [] };
    }
    if (addresses.some((address) => isBlockedPrivateAddress(address))) {
      return {
        error: 'resolved private address is not allowed',
        resolvedAddresses: [],
      };
    }
    return { error: null, resolvedAddresses: addresses };
  } catch {
    return {
      error: 'dns lookup failed - cannot verify host safety',
      resolvedAddresses: [],
    };
  }
}

/**
 * Validate a remote image URL. Returns an error string or null if valid.
 * Backward-compatible wrapper around resolveAndValidateRemoteImageUrl.
 */
export async function validateRemoteImageUrl(
  url: string,
  options: RemoteImageUrlValidationOptions = {},
): Promise<string | null> {
  const result = await resolveAndValidateRemoteImageUrl(url, options);
  return result.error;
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

function normalizeAllowedImageContentType(
  contentType: string | null,
): string | null {
  if (!contentType) return null;
  const mimeType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (!mimeType || !ALLOWED_REMOTE_IMAGE_CONTENT_TYPES.has(mimeType)) {
    return null;
  }
  return mimeType;
}

function buildCachedResponse(dataPath: string, contentType: string): Response {
  // Read eagerly so the response body remains valid even if later test cleanup
  // removes the cache directory before the body stream is consumed.
  return new Response(fs.readFileSync(dataPath), {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': BROWSER_CACHE_CONTROL,
      'X-Content-Type-Options': 'nosniff',
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

/**
 * Read from a ReadableStream into a Buffer, aborting once `maxBytes` is
 * exceeded. Returns null when the stream exceeds the budget.
 */
export async function readStreamWithCap(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Buffer | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

/**
 * Fetch a URL with DNS pinned to a pre-resolved address, preventing DNS
 * rebinding. Uses Node's http/https modules with a custom `lookup` that
 * always returns the validated address instead of re-resolving.
 */
export async function fetchWithPinnedDns(
  url: string,
  pinnedAddress: string,
  timeoutMs: number,
): Promise<Response> {
  const parsed = new URL(url);
  const isSecure = parsed.protocol === 'https:';
  const requestFn = isSecure ? https.request : http.request;
  const defaultPort = isSecure ? 443 : 80;
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : defaultPort;
  const family = pinnedAddress.includes(':') ? 6 : 4;

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const timer = setTimeout(() => {
      req.destroy();
      settle(() =>
        reject(new Error(`Image fetch timed out after ${timeoutMs}ms`)),
      );
    }, timeoutMs);

    const req = requestFn(
      {
        method: 'GET',
        hostname: parsed.hostname,
        port,
        path: `${parsed.pathname}${parsed.search}`,
        // Pin DNS: always return the pre-validated address.
        // Bun's http client calls lookup with { all: true } and expects
        // an array result; Node.js uses the simple (err, address, family) form.
        lookup: (_hostname: string, _opts: unknown, cb?: Function) => {
          const callback = typeof _opts === 'function' ? _opts : cb!;
          const opts =
            typeof _opts === 'object' && _opts !== null
              ? (_opts as Record<string, unknown>)
              : {};
          if (opts.all) {
            callback(null, [{ address: pinnedAddress, family }]);
          } else {
            callback(null, pinnedAddress, family);
          }
        },
        ...(isSecure
          ? { servername: parsed.hostname, rejectUnauthorized: true }
          : {}),
      },
      (res: http.IncomingMessage) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on('data', (chunk: Buffer) => {
              controller.enqueue(new Uint8Array(chunk));
            });
            res.on('end', () => {
              clearTimeout(timer);
              controller.close();
            });
            res.on('error', (err) => {
              clearTimeout(timer);
              controller.error(err);
            });
          },
          cancel() {
            res.destroy();
          },
        });

        const headers = new Headers();
        for (const [key, val] of Object.entries(res.headers)) {
          if (val === undefined) continue;
          const values = Array.isArray(val) ? val : [val];
          for (const v of values) headers.append(key, v);
        }

        settle(() =>
          resolve(
            new Response(body, {
              status: res.statusCode ?? 200,
              statusText: res.statusMessage ?? '',
              headers,
            }),
          ),
        );
      },
    );

    req.on('error', (err: Error) => {
      clearTimeout(timer);
      settle(() => reject(err));
    });

    req.end();
  });
}

export async function serveCachedRemoteImage(
  cacheKey: string,
  resolveUrl: () => Promise<string | null>,
  options: RemoteImageCacheOptions = {},
): Promise<Response | null> {
  const cacheDir = options.cacheDir ?? IMAGE_CACHE_DIR;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  fs.mkdirSync(cacheDir, { recursive: true });
  const { dataPath, metaPath } = getCachePaths(cacheDir, cacheKey);
  const meta = readMeta(metaPath);

  if (
    meta &&
    fs.existsSync(dataPath) &&
    Date.now() - meta.fetchedAt < ONE_DAY_MS
  ) {
    const cachedContentType = normalizeAllowedImageContentType(
      meta.contentType,
    );
    if (cachedContentType) {
      return buildCachedResponse(dataPath, cachedContentType);
    }

    logger.warn(
      { cacheKey, contentType: meta.contentType },
      'Ignoring cached remote image with unsafe content type',
    );
  }

  const url = await resolveUrl();
  if (!url) return null;

  const validation = await resolveAndValidateRemoteImageUrl(url, {
    lookupHostAddresses: options.lookupHostAddresses,
  });
  if (validation.error) {
    logger.warn(
      {
        cacheKey,
        imageUrl: describeImageUrl(url),
        blockReason: validation.error,
      },
      'Blocked remote image fetch',
    );
    return null;
  }

  try {
    let upstream: Response;
    if (validation.resolvedAddresses.length > 0) {
      // Hostname URL: connect to the pre-validated IP, preventing DNS
      // rebinding between validation and fetch.
      const pinnedFetch = options.fetchWithPinnedDnsImpl ?? fetchWithPinnedDns;
      upstream = await pinnedFetch(
        url,
        validation.resolvedAddresses[0],
        REMOTE_IMAGE_FETCH_TIMEOUT_MS,
      );
    } else if (options.fetchImpl) {
      // Caller-provided fetch is only safe for direct-IP URLs, where there is
      // no hostname to re-resolve after validation. Keep redirects disabled so
      // a validated public IP cannot bounce the fetch into private networks.
      upstream = await options.fetchImpl(url, {
        signal: AbortSignal.timeout(REMOTE_IMAGE_FETCH_TIMEOUT_MS),
        redirect: 'manual',
      });
    } else {
      // Direct-IP URL: already validated above, safe to fetch directly as long
      // as redirects cannot bypass validation.
      upstream = await fetch(url, {
        signal: AbortSignal.timeout(REMOTE_IMAGE_FETCH_TIMEOUT_MS),
        redirect: 'manual',
      });
    }

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

    const contentType = normalizeAllowedImageContentType(
      upstream.headers.get('content-type'),
    );
    if (!contentType) {
      logger.warn(
        {
          cacheKey,
          imageUrl: describeImageUrl(url),
          contentType: upstream.headers.get('content-type') || '',
        },
        'Rejected remote image with unsafe content type',
      );
      return null;
    }

    if (!upstream.body) {
      logger.warn(
        { cacheKey, imageUrl: describeImageUrl(url) },
        'Remote image response has no body',
      );
      return null;
    }

    const bytes = await readStreamWithCap(upstream.body, maxBytes);
    if (!bytes) {
      logger.warn(
        {
          cacheKey,
          imageUrl: describeImageUrl(url),
          maxBytes,
        },
        'Remote image exceeded byte limit',
      );
      return null;
    }

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
