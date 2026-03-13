import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

const IMAGE_CACHE_DIR = path.join(DATA_DIR, 'image-cache');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const BROWSER_CACHE_CONTROL = 'private, max-age=86400';

interface CacheMetadata {
  contentType: string;
  fetchedAt: number;
}

export function describeImageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function getCachePaths(cacheKey: string): {
  dataPath: string;
  metaPath: string;
} {
  const hash = createHash('sha256').update(cacheKey).digest('hex');
  return {
    dataPath: path.join(IMAGE_CACHE_DIR, `${hash}.bin`),
    metaPath: path.join(IMAGE_CACHE_DIR, `${hash}.json`),
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
  return new Response(Bun.file(dataPath), {
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

  return {
    errorName: err.name || 'Error',
    errorMessage: describeImageUrl(err.message),
  };
}

export async function serveCachedRemoteImage(
  cacheKey: string,
  resolveUrl: () => Promise<string | null>,
): Promise<Response | null> {
  fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true });
  const { dataPath, metaPath } = getCachePaths(cacheKey);
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

  try {
    const upstream = await fetch(url);
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
