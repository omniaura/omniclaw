import { spawnSync } from 'child_process';
import path from 'path';

import {
  GROUPS_DIR,
  TASK_PREPROCESS_TIMEOUT_MS,
  TASK_WORKFLOWS_DIR,
} from './config.js';
import { logger } from './logger.js';
import { assertPathWithin, rejectTraversalSegments } from './path-security.js';
import type { ScheduledTask } from './types.js';

export type TaskPreprocessDecision =
  | { action: 'run'; prompt?: string; promptPrefix?: string }
  | { action: 'skip'; reason?: string }
  | { action: 'error'; message?: string };

export type TaskPreprocessResult =
  | { action: 'run'; prompt: string }
  | { action: 'skip'; reason: string }
  | { action: 'error'; error: string };

export interface TaskPreprocessInput {
  task: Pick<
    ScheduledTask,
    | 'id'
    | 'group_folder'
    | 'chat_jid'
    | 'prompt'
    | 'schedule_type'
    | 'schedule_value'
    | 'context_mode'
    | 'last_run'
    | 'last_result'
    | 'last_outcome_state'
    | 'last_outcome_reason'
  >;
  repoRoot: string;
  workflowsDir: string;
  now: string;
}

export interface TaskPreprocessorOptions {
  workflowsDir?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxPromptFragmentChars?: number;
  now?: () => Date;
}

export const TASK_PREPROCESS_RESULT_PREFIX =
  'OMNICLAW_TASK_PREPROCESSOR_RESULT=';

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_PROMPT_FRAGMENT_CHARS = 8_000;
const MAX_ERROR_CHARS = 512;
const ALLOWED_WORKFLOW_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
]);

export function normalizePreprocessScriptPath(
  value: unknown,
): { ok: true; path: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, path: null };
  if (typeof value !== 'string') {
    return { ok: false, error: 'preprocess_script must be a string or null' };
  }
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, path: null };
  try {
    rejectTraversalSegments(trimmed, 'task preprocess_script');
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!ALLOWED_WORKFLOW_EXTENSIONS.has(path.extname(trimmed))) {
    return {
      ok: false,
      error: 'preprocess_script must point to a JS or TypeScript file',
    };
  }
  return { ok: true, path: trimmed };
}

function sanitizePreprocessorMessage(value: string): string {
  const stripped = value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > MAX_ERROR_CHARS
    ? `${stripped.slice(0, MAX_ERROR_CHARS - 1)}…`
    : stripped;
}

function resolveWorkflowPath(scriptPath: string, workflowsDir: string): string {
  const normalized = normalizePreprocessScriptPath(scriptPath);
  if (!normalized.ok) {
    throw new Error(normalized.error);
  }
  if (!normalized.path) {
    throw new Error('preprocess_script must be a non-empty path');
  }
  const resolved = path.resolve(workflowsDir, scriptPath);
  assertPathWithin(resolved, workflowsDir, 'task preprocess_script');
  return resolved;
}

function defaultWorkflowsDir(task: ScheduledTask): string {
  if (path.isAbsolute(TASK_WORKFLOWS_DIR)) {
    return TASK_WORKFLOWS_DIR;
  }

  const groupDir = path.resolve(GROUPS_DIR, task.group_folder);
  assertPathWithin(groupDir, GROUPS_DIR, 'task workflow group folder');
  return path.resolve(groupDir, TASK_WORKFLOWS_DIR);
}

function parseDecision(stdout: string): TaskPreprocessDecision {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const sentinelLine = lines
    .filter((line) => line.startsWith(TASK_PREPROCESS_RESULT_PREFIX))
    .at(-1);
  const trimmed = sentinelLine
    ? sentinelLine.slice(TASK_PREPROCESS_RESULT_PREFIX.length).trim()
    : (lines.at(-1) ?? '');
  if (!trimmed) return { action: 'run' };
  const parsed = JSON.parse(trimmed) as unknown;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('preprocessor output must be a JSON object');
  }

  const decision = parsed as Record<string, unknown>;
  if (decision.action === 'skip') {
    return {
      action: 'skip',
      reason:
        typeof decision.reason === 'string' && decision.reason.trim()
          ? decision.reason.trim()
          : undefined,
    };
  }
  if (decision.action === 'error') {
    return {
      action: 'error',
      message:
        typeof decision.message === 'string' && decision.message.trim()
          ? decision.message.trim()
          : undefined,
    };
  }
  if (decision.action === undefined || decision.action === 'run') {
    return {
      action: 'run',
      prompt: typeof decision.prompt === 'string' ? decision.prompt : undefined,
      promptPrefix:
        typeof decision.promptPrefix === 'string'
          ? decision.promptPrefix
          : undefined,
    };
  }

  throw new Error('preprocessor action must be "run", "skip", or "error"');
}

function capPromptFragment(
  value: string,
  label: string,
  maxChars: number,
): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[${label} truncated to ${maxChars} characters]`;
}

function buildPreprocessorEnv(): NodeJS.ProcessEnv {
  const allowedKeys = [
    'PATH',
    'HOME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'TZ',
    'LANG',
    'LC_ALL',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export function runTaskPreprocessor(
  task: ScheduledTask,
  options: TaskPreprocessorOptions = {},
): TaskPreprocessResult {
  if (!task.preprocess_script) {
    return { action: 'run', prompt: task.prompt };
  }

  let workflowsDir: string;
  let workflowPath: string;
  try {
    workflowsDir = path.resolve(
      options.workflowsDir ?? defaultWorkflowsDir(task),
    );
    workflowPath = resolveWorkflowPath(task.preprocess_script, workflowsDir);
  } catch (err) {
    return {
      action: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const input: TaskPreprocessInput = {
    task: {
      id: task.id,
      group_folder: task.group_folder,
      chat_jid: task.chat_jid,
      prompt: task.prompt,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      context_mode: task.context_mode,
      last_run: task.last_run,
      last_result: task.last_result,
      last_outcome_state: task.last_outcome_state ?? null,
      last_outcome_reason: task.last_outcome_reason ?? null,
    },
    repoRoot: process.cwd(),
    workflowsDir,
    now: (options.now ?? (() => new Date()))().toISOString(),
  };

  const timeoutMs = options.timeoutMs ?? TASK_PREPROCESS_TIMEOUT_MS;
  const child = spawnSync('bun', ['run', workflowPath], {
    cwd: process.cwd(),
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...buildPreprocessorEnv(),
      OMNICLAW_TASK_PREPROCESSOR: '1',
      OMNICLAW_TASK_ID: task.id,
    },
    timeout: timeoutMs,
    maxBuffer: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  });

  if (child.error) {
    const errorWithCode = child.error as Error & { code?: string };
    return {
      action: 'error',
      error: sanitizePreprocessorMessage(
        errorWithCode.code === 'ETIMEDOUT'
          ? `preprocessor timed out after ${timeoutMs}ms`
          : child.error.message,
      ),
    };
  }
  if (child.status !== 0) {
    return {
      action: 'error',
      error: sanitizePreprocessorMessage(
        child.stderr?.trim() ||
          `preprocessor exited with status ${child.status ?? 'unknown'}`,
      ),
    };
  }

  try {
    const decision = parseDecision(child.stdout ?? '');
    if (decision.action === 'skip') {
      return {
        action: 'skip',
        reason: sanitizePreprocessorMessage(decision.reason ?? 'no work'),
      };
    }
    if (decision.action === 'error') {
      return {
        action: 'error',
        error: sanitizePreprocessorMessage(
          decision.message ?? 'workflow error',
        ),
      };
    }
    const maxFragmentChars =
      options.maxPromptFragmentChars ?? DEFAULT_MAX_PROMPT_FRAGMENT_CHARS;
    const prompt = decision.prompt
      ? capPromptFragment(
          decision.prompt,
          'preprocessor prompt',
          maxFragmentChars,
        )
      : task.prompt;
    return {
      action: 'run',
      prompt: decision.promptPrefix
        ? `${capPromptFragment(
            decision.promptPrefix.trim(),
            'preprocessor promptPrefix',
            maxFragmentChars,
          )}\n\n${prompt}`
        : prompt,
    };
  } catch (err) {
    logger.warn(
      { taskId: task.id, preprocessScript: task.preprocess_script, err },
      'Invalid task preprocessor output',
    );
    return {
      action: 'error',
      error: sanitizePreprocessorMessage(
        err instanceof Error ? err.message : String(err),
      ),
    };
  }
}
