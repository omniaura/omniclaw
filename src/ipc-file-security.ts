/**
 * IPC File Security Hardening
 *
 * Provides secure file reading for IPC JSON files with defense-in-depth:
 * - Symlink rejection (lstat + O_NOFOLLOW)
 * - File size limits (1 MiB hard cap)
 * - TOCTOU protection (post-open fstat validation)
 * - Quarantine for malformed/unsafe files
 * - Directory listing filtered to regular files only
 *
 * Inspired by upstream qwibitai/nanoclaw PR #364 (lawyered0).
 * Adapted for omniaura/omniclaw fork's multi-backend architecture.
 *
 * NOTE: Uses node:fs for low-level POSIX operations (lstatSync, openSync with
 * O_NOFOLLOW, fstatSync, readSync, closeSync) because Bun.file() does not expose
 * the fd lifecycle control, open flags, or lstat semantics needed for symlink
 * rejection and TOCTOU defense. Bun's node:fs polyfill fully supports these APIs
 * including platform-adapted fsConstants.O_NOFOLLOW.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import path from 'path';
import { logger } from './logger.js';

/** Maximum IPC file size: 1 MiB */
const MAX_IPC_FILE_SIZE = 1024 * 1024;

/** Chunk size for reading: 64 KiB */
const READ_CHUNK_SIZE = 64 * 1024;

/**
 * Result of attempting to read an IPC JSON file securely.
 */
export type IpcReadResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; reason: string };

/**
 * Securely read and parse a JSON file from the IPC directory.
 *
 * Defense layers:
 * 1. lstatSync() - reject symlinks before opening
 * 2. O_NOFOLLOW open flag - OS-level symlink prevention (platform-dependent)
 * 3. fstatSync(fd) - post-open validation that fd is a regular file (TOCTOU defense)
 * 4. Size check - reject files exceeding MAX_IPC_FILE_SIZE
 * 5. Chunked reads with running byte total - catches growth-during-read attacks
 */
export function readIpcJsonFile<T = unknown>(
  filePath: string,
): IpcReadResult<T> {
  // Layer 1: Pre-open symlink check via lstat
  let lstat: Stats;
  try {
    lstat = lstatSync(filePath);
  } catch (err) {
    return { ok: false, reason: `lstat failed: ${(err as Error).message}` };
  }

  if (lstat.isSymbolicLink()) {
    return { ok: false, reason: 'symlink rejected' };
  }

  if (!lstat.isFile()) {
    return { ok: false, reason: `not a regular file (mode: ${lstat.mode})` };
  }

  // Layer 2 & 3: Open with O_NOFOLLOW (where supported) + post-open fstat
  let fd: number;
  try {
    // O_NOFOLLOW prevents the kernel from following symlinks during open.
    // Bun's node:fs polyfill provides platform-adapted fsConstants.O_NOFOLLOW.
    try {
      fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (e) {
      // Only fall back for platforms that don't support O_NOFOLLOW
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') {
        throw e; // Re-throw non-platform errors (EACCES, ENOENT, ELOOP, etc.)
      }
      fd = openSync(filePath, fsConstants.O_RDONLY);
    }
  } catch (err) {
    return { ok: false, reason: `open failed: ${(err as Error).message}` };
  }

  try {
    // Layer 3: Post-open fstat to guard against TOCTOU race
    const fstat = fstatSync(fd);
    if (!fstat.isFile()) {
      return {
        ok: false,
        reason: 'fd is not a regular file after open (TOCTOU)',
      };
    }

    // Layer 4: Size check
    if (fstat.size > MAX_IPC_FILE_SIZE) {
      return {
        ok: false,
        reason: `file too large: ${fstat.size} bytes (limit: ${MAX_IPC_FILE_SIZE})`,
      };
    }

    // Layer 5: Chunked read with running byte total
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const buf = Buffer.alloc(READ_CHUNK_SIZE);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const bytesRead = readSync(fd, buf, 0, READ_CHUNK_SIZE, null);
      if (bytesRead === 0) break;

      totalBytes += bytesRead;
      if (totalBytes > MAX_IPC_FILE_SIZE) {
        return {
          ok: false,
          reason: `file grew during read: ${totalBytes} bytes exceeds limit`,
        };
      }

      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
    }

    const content = Buffer.concat(chunks).toString('utf-8');

    // Layer 6: JSON parse
    let data: T;
    try {
      data = JSON.parse(content) as T;
    } catch (err) {
      return { ok: false, reason: `invalid JSON: ${(err as Error).message}` };
    }

    return { ok: true, data };
  } finally {
    closeSync(fd);
  }
}

/**
 * List JSON files in a directory, filtering to regular files only.
 * Rejects symlinks and non-regular entries at the directory listing level.
 */
export function listIpcJsonFiles(dirPath: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name);
}

/**
 * Move a problematic IPC file to a quarantine directory.
 * Falls back to unlinkSync if rename fails (cross-device, permissions).
 */
export function quarantineIpcFile(
  filePath: string,
  ipcBaseDir: string,
  reason: string,
  sourceGroup: string,
): void {
  const quarantineDir = path.join(ipcBaseDir, 'errors');
  const fileName = path.basename(filePath);

  try {
    mkdirSync(quarantineDir, { recursive: true });
    const timestamp = Date.now();
    const destPath = path.join(
      quarantineDir,
      `${sourceGroup}-${timestamp}-${fileName}`,
    );
    renameSync(filePath, destPath);
    logger.warn(
      { file: fileName, sourceGroup, reason, quarantined: destPath },
      'IPC file quarantined',
    );
  } catch (renameErr) {
    // Fallback: delete the file if quarantine fails
    try {
      unlinkSync(filePath);
      logger.warn(
        { file: fileName, sourceGroup, reason, error: renameErr },
        'IPC file deleted (quarantine rename failed)',
      );
    } catch (unlinkErr) {
      logger.error(
        { file: fileName, sourceGroup, reason, renameErr, unlinkErr },
        'Failed to quarantine or delete IPC file',
      );
    }
  }
}
