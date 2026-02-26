import fs from 'fs';
import path from 'path';

import {
  GROUPS_DIR,
  LOG_CLEANUP_INTERVAL,
  LOG_MAX_TOTAL_SIZE,
} from './config.js';
import { logger } from './logger.js';

interface LogFile {
  path: string;
  size: number;
  mtimeMs: number;
  /** Main process logs are truncated (launchd holds fd), not deleted. */
  truncateOnly: boolean;
}

const MAIN_LOG_NAMES = new Set([
  'omniclaw.log',
  'omniclaw.stdout.log',
  'omniclaw.error.log',
]);

/**
 * Collect all log files from the three log streams:
 * 1. Main process logs in logsDir
 * 2. Per-group container logs in groups/{name}/logs/
 * 3. Thought logs in groups/global/thoughts/{folder}/*.md
 */
export function collectLogFiles(logsDir: string): LogFile[] {
  const files: LogFile[] = [];

  // 1. Main process logs
  try {
    for (const entry of fs.readdirSync(logsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const filePath = path.join(logsDir, entry.name);
      try {
        const stat = fs.statSync(filePath);
        files.push({
          path: filePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          truncateOnly: MAIN_LOG_NAMES.has(entry.name),
        });
      } catch {
        // vanished between readdir and stat
      }
    }
  } catch {
    // logs dir doesn't exist
  }

  // 2. Per-group container logs
  try {
    for (const groupEntry of fs.readdirSync(GROUPS_DIR, { withFileTypes: true })) {
      if (!groupEntry.isDirectory()) continue;
      const groupLogsDir = path.join(GROUPS_DIR, groupEntry.name, 'logs');
      try {
        for (const entry of fs.readdirSync(groupLogsDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.startsWith('container-')) continue;
          const filePath = path.join(groupLogsDir, entry.name);
          try {
            const stat = fs.statSync(filePath);
            files.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, truncateOnly: false });
          } catch { /* vanished */ }
        }
      } catch { /* dir doesn't exist */ }
    }
  } catch {
    // groups dir doesn't exist
  }

  // 3. Thought logs
  const thoughtsDir = path.join(GROUPS_DIR, 'global', 'thoughts');
  try {
    for (const subdir of fs.readdirSync(thoughtsDir, { withFileTypes: true })) {
      if (!subdir.isDirectory()) continue;
      const subdirPath = path.join(thoughtsDir, subdir.name);
      try {
        for (const entry of fs.readdirSync(subdirPath, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
          const filePath = path.join(subdirPath, entry.name);
          try {
            const stat = fs.statSync(filePath);
            files.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, truncateOnly: false });
          } catch { /* vanished */ }
        }
      } catch { /* vanished */ }
    }
  } catch {
    // thoughts dir doesn't exist
  }

  return files;
}

/**
 * Remove empty thought subdirectories.
 */
function cleanEmptyThoughtDirs(): void {
  const thoughtsDir = path.join(GROUPS_DIR, 'global', 'thoughts');
  try {
    for (const subdir of fs.readdirSync(thoughtsDir, { withFileTypes: true })) {
      if (!subdir.isDirectory()) continue;
      const subdirPath = path.join(thoughtsDir, subdir.name);
      try {
        if (fs.readdirSync(subdirPath).length === 0) {
          fs.rmdirSync(subdirPath);
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/**
 * Delete oldest log files until total size is under the budget.
 * Main process logs are truncated to 0 (launchd holds the fd) instead of deleted.
 * Returns the number of files cleaned up.
 */
export function evictOldest(files: LogFile[], maxTotalSize = LOG_MAX_TOTAL_SIZE): number {
  let totalSize = files.reduce((sum, f) => sum + f.size, 0);
  if (totalSize <= maxTotalSize) return 0;

  // Sort oldest first
  const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);
  let cleaned = 0;

  for (const file of sorted) {
    if (totalSize <= maxTotalSize) break;

    try {
      if (file.truncateOnly) {
        fs.truncateSync(file.path, 0);
      } else {
        fs.unlinkSync(file.path);
      }
      totalSize -= file.size;
      cleaned++;
    } catch {
      // file vanished, still subtract from total
      totalSize -= file.size;
    }
  }

  return cleaned;
}

/**
 * Run cleanup: collect all log files, evict oldest if over budget.
 */
export function runCleanup(logsDir: string): void {
  const files = collectLogFiles(logsDir);
  const cleaned = evictOldest(files);

  if (cleaned > 0) {
    cleanEmptyThoughtDirs();
    logger.info({ cleaned }, 'Log cleanup: evicted oldest files');
  }
}

/**
 * Start the log cleanup loop. Runs immediately, then every LOG_CLEANUP_INTERVAL.
 * Returns the interval handle for cleanup in tests.
 */
export function startLogCleanupLoop(
  logsDir: string,
): ReturnType<typeof setInterval> {
  runCleanup(logsDir);
  return setInterval(() => runCleanup(logsDir), LOG_CLEANUP_INTERVAL);
}
