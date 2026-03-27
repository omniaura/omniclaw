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
  /** Explicit agent outcome state (done/blocked/abandoned). */
  outcome_state?: string;
  /** Why the task ended in this state. */
  outcome_reason?: string;
  /** For blocked: what input does the agent need? */
  outcome_question?: string;
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

interface ReadScheduledRunHandoffsOptions {
  baseDir?: string;
  limit?: number;
  onError?: (error: unknown, filePath: string) => void;
}

const HANDOFFS_SUBDIR = path.join('context', 'scheduled-runs');
const DEFAULT_MAX_HANDOFF_FILES = 50;
const DEFAULT_HANDOFF_READ_LIMIT = 3;
const MAX_PROMPT_VALUE_CHARS = 200;

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

export function readScheduledRunHandoffs(
  groupFolder: string,
  options: ReadScheduledRunHandoffsOptions = {},
): ScheduledRunHandoff[] {
  const baseDir = options.baseDir ?? GROUPS_DIR;
  const limit = options.limit ?? DEFAULT_HANDOFF_READ_LIMIT;
  const onError = options.onError;
  const handoffDir = getHandoffDir(baseDir, groupFolder);

  if (!fs.existsSync(handoffDir)) {
    return [];
  }

  return fs
    .readdirSync(handoffDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, limit)
    .flatMap((entry) => {
      const filePath = path.join(handoffDir, entry.name);
      try {
        assertPathWithin(filePath, handoffDir, 'scheduled run handoff file');
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return parsed ? [parsed as ScheduledRunHandoff] : [];
      } catch (error) {
        onError?.(error, filePath);
        return [];
      }
    });
}

function truncatePromptValue(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= MAX_PROMPT_VALUE_CHARS) return value;
  return `${value.slice(0, MAX_PROMPT_VALUE_CHARS)}...`;
}

export function formatScheduledRunHandoffsForPrompt(
  handoffs: ScheduledRunHandoff[],
): string {
  if (handoffs.length === 0) return '';

  const lines = handoffs.map((handoff) => {
    const detail =
      truncatePromptValue(handoff.error ?? handoff.result) ?? 'No details';
    return `- ${handoff.run_at} | ${handoff.status} | task=${handoff.task_id} | ${detail}`;
  });

  return `[Recent Scheduled Runs]\n${lines.join('\n')}`;
}
