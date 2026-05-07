/**
 * Shared media attachment pipeline.
 *
 * Channel-agnostic helpers for downloading, storing, and cleaning up media
 * attachments. Channel adapters call these instead of rolling their own
 * download/store logic, so every channel behaves consistently.
 */

import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { assertPathWithin } from './path-security.js';
import type { MediaAttachment, MediaAttachmentType } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Supported image file extensions (used for MIME-type fallback detection). */
export const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
]);

/** Text-based file extensions eligible for inline content embedding. */
export const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.json',
  '.csv',
  '.log',
  '.xml',
  '.yaml',
  '.yml',
  '.toml',
  '.py',
  '.js',
  '.ts',
  '.html',
  '.css',
  '.sh',
  '.cfg',
  '.ini',
  '.sql',
  '.env.example',
]);

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15_000;

/** Default max binary download size (10 MiB) — matches Discord's existing cap. */
export const MAX_BINARY_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/** Default max text download size (100 KiB). */
export const MAX_TEXT_DOWNLOAD_BYTES = 100 * 1024;

/** Media files older than this are eligible for cleanup. */
export const MEDIA_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Stream download with byte limit
// ---------------------------------------------------------------------------

/**
 * Read a `ReadableStream` into a `Buffer`, aborting if the byte limit is
 * exceeded. The stream is cancelled on overflow so the connection is not held
 * open.
 */
export async function readStreamWithByteLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0);

  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel('Download exceeded byte limit');
        } catch {
          // Ignore cancellation failures; the limit error below is the primary signal.
        }
        throw new Error(`Download exceeded ${maxBytes} bytes`);
      }

      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a URL with a default timeout. Channel adapters may supply their own
 * timeout via `options.timeoutMs`.
 */
export async function fetchWithTimeout(
  url: string,
  options?: { timeoutMs?: number },
): Promise<Response> {
  return fetch(url, {
    signal: AbortSignal.timeout(
      options?.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
    ),
  });
}

/**
 * Download a binary attachment (image, video, audio) and return its bytes.
 * Enforces `maxBytes` (default: 10 MiB).
 */
export async function downloadBinaryAttachment(
  url: string,
  options?: { maxBytes?: number; timeoutMs?: number },
): Promise<Buffer> {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}`);
  }
  return readStreamWithByteLimit(
    response.body,
    options?.maxBytes ?? MAX_BINARY_DOWNLOAD_BYTES,
  );
}

/**
 * Download a text attachment and return its decoded content.
 * Enforces `maxBytes` (default: 100 KiB).
 */
export async function downloadTextAttachment(
  url: string,
  options?: { maxBytes?: number; timeoutMs?: number },
): Promise<string> {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}`);
  }
  const bytes = await readStreamWithByteLimit(
    response.body,
    options?.maxBytes ?? MAX_TEXT_DOWNLOAD_BYTES,
  );
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// Media directory helpers
// ---------------------------------------------------------------------------

export interface WorkspaceGroup {
  folder: string;
  channelFolder?: string;
}

/**
 * Resolve the workspace folder for a group, preferring `channelFolder` when
 * set. Returns the relative folder name (not an absolute path).
 */
export function resolveWorkspaceFolder(group: WorkspaceGroup): string {
  const preferredFolder = group.channelFolder?.trim();
  return preferredFolder ? preferredFolder : group.folder;
}

/**
 * Get the absolute media directory for a group, creating it if it doesn't
 * exist. The returned path is validated against `GROUPS_DIR`.
 */
export function getMediaDir(group: WorkspaceGroup): string {
  const workspaceFolder = resolveWorkspaceFolder(group);
  const mediaDir = path.join(GROUPS_DIR, workspaceFolder, 'media');
  assertPathWithin(mediaDir, GROUPS_DIR, 'media directory');
  return mediaDir;
}

/**
 * Ensure the media directory exists and return its absolute path.
 */
export function ensureMediaDir(group: WorkspaceGroup): string {
  const mediaDir = getMediaDir(group);
  fs.mkdirSync(mediaDir, { recursive: true });
  return mediaDir;
}

// ---------------------------------------------------------------------------
// Store attachment
// ---------------------------------------------------------------------------

/**
 * Sanitise a filename by stripping directory components (path traversal
 * defense layer 1), then validate the resulting path stays within the media
 * directory (layer 2).
 */
export function buildSafeMediaPath(
  mediaDir: string,
  messageId: string,
  rawFilename: string,
  prefix?: string,
): string {
  const safeName = path.basename(rawFilename);
  const filename = prefix
    ? `${messageId}-${prefix}-${safeName}`
    : `${messageId}-${safeName}`;
  const filePath = path.join(mediaDir, filename);
  assertPathWithin(filePath, mediaDir, 'media attachment');
  return filePath;
}

/**
 * Download a binary file from `url`, store it in the group's media directory,
 * and return a `MediaAttachment` descriptor.
 */
export async function storeMediaAttachment(opts: {
  url: string;
  group: WorkspaceGroup;
  messageId: string;
  rawFilename: string;
  type: MediaAttachmentType;
  mimeType?: string | null;
  filenamePrefix?: string;
  maxBytes?: number;
}): Promise<MediaAttachment> {
  const mediaDir = ensureMediaDir(opts.group);
  const filePath = buildSafeMediaPath(
    mediaDir,
    opts.messageId,
    opts.rawFilename,
    opts.filenamePrefix,
  );
  const bytes = await downloadBinaryAttachment(opts.url, {
    maxBytes: opts.maxBytes,
  });
  fs.writeFileSync(filePath, bytes);

  return {
    type: opts.type,
    mimeType: opts.mimeType ?? null,
    localPath: filePath,
    originalUrl: opts.url,
    filename: path.basename(filePath),
  };
}

// ---------------------------------------------------------------------------
// Attachment markers (text format consumed by agent-runner)
// ---------------------------------------------------------------------------

/** Format an image attachment marker for the agent runtime. */
export function formatImageMarker(filename: string): string {
  return `[attachment:image file=${filename}]`;
}

/** Format an inline text file attachment for the agent runtime. */
export function formatTextFileMarker(
  filename: string,
  content: string,
): string {
  return `[attachment:file name=${filename}]\n${content}\n[/attachment:file]`;
}

/**
 * Format a binary file attachment marker for the agent runtime.
 *
 * Emits a path the agent can open with the Read tool. The path is relative
 * to the agent's cwd (`/workspace/group`), so a downloaded media file at
 * `<group>/media/<file>` becomes `media/<file>`.
 *
 * Use this for binary documents (PDFs, archives, etc.) that aren't images
 * and aren't small enough to inline as text.
 */
export function formatBinaryFileMarker(
  filename: string,
  originalName?: string,
): string {
  const safe = path.basename(filename);
  const display = originalName ? path.basename(originalName) : safe;
  return `[attachment:file path=media/${safe} name=${display}]`;
}

/** Format a placeholder for unsupported or failed media types. */
export function formatPlaceholder(
  type: 'video' | 'audio' | 'file',
  filename?: string,
): string {
  if (type === 'video') return '[Video]';
  if (type === 'audio') return '[Audio]';
  return filename ? `[File: ${filename}]` : '[File]';
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether an attachment is an image based on MIME type and/or
 * filename extension. Works across channels — not Discord-specific.
 */
export function isImageByTypeOrExtension(
  contentType: string | null | undefined,
  filename: string | null | undefined,
): boolean {
  if (contentType?.startsWith('image/')) return true;
  if (contentType) return false; // Known non-image type
  const ext = path.extname(filename || '').toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Determine whether a filename has a text-based extension eligible for inline
 * content embedding.
 */
export function isTextByExtension(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Remove media files older than `maxAgeMs` from a group's media directory.
 * Non-critical — errors are logged and swallowed.
 */
export function cleanupExpiredMedia(
  group: WorkspaceGroup,
  maxAgeMs: number = MEDIA_MAX_AGE_MS,
): void {
  try {
    const mediaDir = getMediaDir(group);
    if (!fs.existsSync(mediaDir)) return;
    const now = Date.now();
    for (const file of fs.readdirSync(mediaDir)) {
      const filePath = path.join(mediaDir, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Media cleanup failed (non-critical)');
  }
}
