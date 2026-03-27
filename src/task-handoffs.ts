import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { assertPathWithin } from './path-security.js';

export interface ScheduledRunHandoff {
  task_id: string;
  chat_jid: string;
  group_folder: string;
  context_mode: 'group' | 'isolated';
  run_at: string;
  status: 'success' | 'error';
  duration_ms: number;
  next_run: string | null;
  result: string | null;
  error: string | null;
}

interface TaskHandoffFs {
  mkdirSync: typeof fs.mkdirSync;
  readdirSync: typeof fs.readdirSync;
  unlinkSync: typeof fs.unlinkSync;
  writeFileSync: typeof fs.writeFileSync;
}

interface WriteScheduledRunHandoffOptions {
  baseDir?: string;
  fsImpl?: TaskHandoffFs;
  maxFiles?: number;
}

const HANDOFFS_SUBDIR = path.join('context', 'scheduled-runs');
const DEFAULT_MAX_HANDOFF_FILES = 50;

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function safeTimestampForFilename(isoTimestamp: string): string {
  return sanitizeFilePart(isoTimestamp.replace(/:/g, '-'));
}

function getHandoffDir(baseDir: string, groupFolder: string): string {
  const groupDir = path.join(baseDir, groupFolder);
  assertPathWithin(groupDir, baseDir, 'scheduled run handoff group folder');
  const handoffDir = path.join(groupDir, HANDOFFS_SUBDIR);
  assertPathWithin(handoffDir, groupDir, 'scheduled run handoff directory');
  return handoffDir;
}

function pruneOldHandoffs(
  handoffDir: string,
  fsImpl: TaskHandoffFs,
  maxFiles: number,
): void {
  const entries = fsImpl
    .readdirSync(handoffDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();

  const excessCount = entries.length - maxFiles;
  if (excessCount <= 0) return;

  for (const fileName of entries.slice(0, excessCount)) {
    fsImpl.unlinkSync(path.join(handoffDir, fileName));
  }
}

export function writeScheduledRunHandoff(
  handoff: ScheduledRunHandoff,
  options: WriteScheduledRunHandoffOptions = {},
): string {
  const baseDir = options.baseDir ?? GROUPS_DIR;
  const fsImpl = options.fsImpl ?? fs;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_HANDOFF_FILES;

  const handoffDir = getHandoffDir(baseDir, handoff.group_folder);
  fsImpl.mkdirSync(handoffDir, { recursive: true });

  const fileName = `${safeTimestampForFilename(handoff.run_at)}-${sanitizeFilePart(handoff.task_id)}.json`;
  const filePath = path.join(handoffDir, fileName);
  assertPathWithin(filePath, handoffDir, 'scheduled run handoff file');

  fsImpl.writeFileSync(filePath, JSON.stringify(handoff, null, 2));
  pruneOldHandoffs(handoffDir, fsImpl, maxFiles);
  return filePath;
}
