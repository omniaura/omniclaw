/**
 * Utility to scan the groups directory for all CLAUDE.md context files.
 * Extracted to avoid circular dependencies between web/routes and discovery/routes.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { assertPathWithin } from '../path-security.js';
import type { ContextFileEntry } from '../discovery/types.js';

/** Scan GROUPS_DIR for all CLAUDE.md files and return their path, hash, size, mtime. */
export function listLocalContextFiles(): ContextFileEntry[] {
  const files: ContextFileEntry[] = [];

  function scanDir(dir: string, relPrefix: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden dirs and node_modules
        if (entry.name.startsWith('.') || entry.name === 'node_modules')
          continue;
        scanDir(
          fullPath,
          relPrefix ? `${relPrefix}/${entry.name}` : entry.name,
        );
      } else if (entry.name === 'CLAUDE.md') {
        try {
          assertPathWithin(fullPath, GROUPS_DIR, 'listContextFiles');
          const stat = fs.statSync(fullPath);
          const content = fs.readFileSync(fullPath, 'utf-8');
          const hash = crypto
            .createHash('sha256')
            .update(content)
            .digest('hex');
          files.push({
            path: relPrefix,
            hash,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
          });
        } catch {
          // Skip files we can't read
        }
      }
    }
  }

  if (fs.existsSync(GROUPS_DIR)) {
    scanDir(GROUPS_DIR, '');
  }

  return files;
}
