import { spawnSync } from 'child_process';
import path from 'path';

import { GROUPS_DIR, TASK_WORKFLOWS_DIR } from './config.js';
import { logger } from './logger.js';
import { assertPathWithin, rejectTraversalSegments } from './path-security.js';
import type { ScheduledTask } from './types.js';

export type TaskPreprocessDecision =
  | { action: 'run'; prompt?: string; promptPrefix?: string }
  | { action: 'skip'; reason?: string };

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
  now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function resolveWorkflowPath(scriptPath: string, workflowsDir: string): string {
  rejectTraversalSegments(scriptPath, 'task preprocess_script');
  const resolved = path.resolve(workflowsDir, scriptPath);
  assertPathWithin(resolved, workflowsDir, 'task preprocess_script');
  if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(resolved)) {
    throw new Error('preprocess_script must point to a JS or TypeScript file');
  }
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
  const trimmed = stdout.trim();
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

  throw new Error('preprocessor action must be "run" or "skip"');
}

export function runTaskPreprocessor(
  task: ScheduledTask,
  options: TaskPreprocessorOptions = {},
): TaskPreprocessResult {
  if (!task.preprocess_script) {
    return { action: 'run', prompt: task.prompt };
  }

  const workflowsDir = path.resolve(
    options.workflowsDir ?? defaultWorkflowsDir(task),
  );
  let workflowPath: string;
  try {
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

  const child = spawnSync(process.execPath, ['run', workflowPath], {
    cwd: process.cwd(),
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      OMNICLAW_TASK_PREPROCESSOR: '1',
      OMNICLAW_TASK_ID: task.id,
    },
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  if (child.error) {
    return { action: 'error', error: child.error.message };
  }
  if (child.status !== 0) {
    return {
      action: 'error',
      error:
        child.stderr?.trim() ||
        `preprocessor exited with status ${child.status ?? 'unknown'}`,
    };
  }

  try {
    const decision = parseDecision(child.stdout ?? '');
    if (decision.action === 'skip') {
      return { action: 'skip', reason: decision.reason ?? 'no work' };
    }
    const prompt = decision.prompt ?? task.prompt;
    return {
      action: 'run',
      prompt: decision.promptPrefix
        ? `${decision.promptPrefix.trim()}\n\n${prompt}`
        : prompt,
    };
  } catch (err) {
    logger.warn(
      { taskId: task.id, preprocessScript: task.preprocess_script, err },
      'Invalid task preprocessor output',
    );
    return {
      action: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
