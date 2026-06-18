import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { GROUPS_DIR, TASK_WORKFLOWS_DIR } from './config.js';
import {
  normalizePreprocessScriptPath,
  runTaskPreprocessor,
} from './task-preprocessor.js';
import type { ScheduledTask } from './types.js';

let workflowsDir: string;
let cleanupPaths: string[];

beforeEach(() => {
  workflowsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclaw-pre-'));
  cleanupPaths = [];
});

afterEach(() => {
  fs.rmSync(workflowsDir, { recursive: true, force: true });
  for (const cleanupPath of cleanupPaths) {
    fs.rmSync(cleanupPath, { recursive: true, force: true });
  }
});

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    group_folder: 'main',
    chat_jid: 'main@g.us',
    prompt: 'sync connector packages',
    preprocess_script: 'workflow.ts',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    next_run: '2026-05-18T09:00:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-05-17T00:00:00.000Z',
    executing_since: null,
    ...overrides,
  };
}

it('runs a workflow script and prefixes deterministic triage output', () => {
  fs.writeFileSync(
    path.join(workflowsDir, 'workflow.ts'),
    `
const input = JSON.parse(await Bun.stdin.text());
console.log(JSON.stringify({
  action: "run",
  promptPrefix: "Changed package: " + input.task.id
}));
`,
  );

  const result = runTaskPreprocessor(task(), { workflowsDir });

  expect(result).toEqual({
    action: 'run',
    prompt: 'Changed package: task-1\n\nsync connector packages',
  });
});

it('lets a workflow skip no-op scheduled task runs', () => {
  fs.writeFileSync(
    path.join(workflowsDir, 'workflow.ts'),
    'console.log(JSON.stringify({ action: "skip", reason: "no MCP diff" }));',
  );

  expect(runTaskPreprocessor(task(), { workflowsDir })).toEqual({
    action: 'skip',
    reason: 'no MCP diff',
  });
});

it('parses the last JSON line when workflow stdout has log noise', () => {
  fs.writeFileSync(
    path.join(workflowsDir, 'workflow.ts'),
    `
console.log("checking git diff...");
console.log(JSON.stringify({ action: "skip", reason: "no package diff" }));
`,
  );

  expect(runTaskPreprocessor(task(), { workflowsDir })).toEqual({
    action: 'skip',
    reason: 'no package diff',
  });
});

it('parses sentinel-prefixed JSON even when later stdout has log noise', () => {
  fs.writeFileSync(
    path.join(workflowsDir, 'workflow.ts'),
    `
console.log('OMNICLAW_TASK_PREPROCESSOR_RESULT=' + JSON.stringify({
  action: "run",
  prompt: "deterministic prompt"
}));
console.log("done");
`,
  );

  expect(runTaskPreprocessor(task(), { workflowsDir })).toEqual({
    action: 'run',
    prompt: 'deterministic prompt',
  });
});

it('does not leak host secrets into workflow environment', () => {
  const original = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'secret-token';
  fs.writeFileSync(
    path.join(workflowsDir, 'workflow.ts'),
    `
console.log(JSON.stringify({
  action: "run",
  promptPrefix: process.env.GITHUB_TOKEN ? "leaked" : "missing"
}));
`,
  );

  try {
    expect(runTaskPreprocessor(task(), { workflowsDir })).toEqual({
      action: 'run',
      prompt: 'missing\n\nsync connector packages',
    });
  } finally {
    if (original === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = original;
    }
  }
});

it('returns a sanitized error when workflow times out', () => {
  fs.writeFileSync(
    path.join(workflowsDir, 'workflow.ts'),
    'await Bun.sleep(1000);',
  );

  const result = runTaskPreprocessor(task(), {
    workflowsDir,
    timeoutMs: 10,
  });

  expect(result.action).toBe('error');
  if (result.action !== 'error') throw new Error('expected error result');
  expect(result.error).toContain('timed out');
  expect(result.error.length).toBeLessThanOrEqual(512);
});

it('returns a sanitized error when workflow output exceeds maxBuffer', () => {
  fs.writeFileSync(
    path.join(workflowsDir, 'workflow.ts'),
    'console.log("x".repeat(1000));',
  );

  const result = runTaskPreprocessor(task(), {
    workflowsDir,
    maxOutputBytes: 16,
  });

  expect(result.action).toBe('error');
  if (result.action !== 'error') throw new Error('expected error result');
  expect(result.error.length).toBeLessThanOrEqual(512);
});

it('caps promptPrefix length before augmenting the prompt', () => {
  fs.writeFileSync(
    path.join(workflowsDir, 'workflow.ts'),
    `
console.log(JSON.stringify({
  action: "run",
  promptPrefix: "a".repeat(20)
}));
`,
  );

  const result = runTaskPreprocessor(task(), {
    workflowsDir,
    maxPromptFragmentChars: 5,
  });

  expect(result).toEqual({
    action: 'run',
    prompt:
      'aaaaa\n\n[preprocessor promptPrefix truncated to 5 characters]\n\nsync connector packages',
  });
});

it('caps replacement prompt length from workflow output', () => {
  fs.writeFileSync(
    path.join(workflowsDir, 'workflow.ts'),
    `
console.log(JSON.stringify({
  action: "run",
  prompt: "b".repeat(20)
}));
`,
  );

  expect(
    runTaskPreprocessor(task(), {
      workflowsDir,
      maxPromptFragmentChars: 5,
    }),
  ).toEqual({
    action: 'run',
    prompt: 'bbbbb\n\n[preprocessor prompt truncated to 5 characters]',
  });
});

it('supports explicit workflow error actions', () => {
  fs.writeFileSync(
    path.join(workflowsDir, 'workflow.ts'),
    'console.log(JSON.stringify({ action: "error", message: "git diff failed" }));',
  );

  expect(runTaskPreprocessor(task(), { workflowsDir })).toEqual({
    action: 'error',
    error: 'git diff failed',
  });
});

it('returns a sanitized error when workflow exits nonzero with stderr', () => {
  fs.writeFileSync(
    path.join(workflowsDir, 'workflow.ts'),
    `
console.error("\u001b[31m" + "x".repeat(600) + "\u0007" + "\u001b[0m");
process.exit(2);
`,
  );

  const result = runTaskPreprocessor(task(), { workflowsDir });

  expect(result.action).toBe('error');
  if (result.action !== 'error') throw new Error('expected error result');
  expect(result.error).not.toContain('\u001b');
  expect(result.error).not.toContain('\u0007');
  expect(result.error.length).toBeLessThanOrEqual(512);
});

it('falls back to exit status when nonzero workflow has no stderr', () => {
  fs.writeFileSync(path.join(workflowsDir, 'workflow.ts'), 'process.exit(7);');

  expect(runTaskPreprocessor(task(), { workflowsDir })).toEqual({
    action: 'error',
    error: 'preprocessor exited with status 7',
  });
});

it('rejects invalid workflow decision actions', () => {
  fs.writeFileSync(
    path.join(workflowsDir, 'workflow.ts'),
    'console.log(JSON.stringify({ action: "pause" }));',
  );

  expect(runTaskPreprocessor(task(), { workflowsDir })).toEqual({
    action: 'error',
    error: 'preprocessor action must be "run", "skip", or "error"',
  });
});

it('rejects workflow paths outside the workflows directory', () => {
  const result = runTaskPreprocessor(task({ preprocess_script: '../x.ts' }), {
    workflowsDir,
  });

  expect(result.action).toBe('error');
  if (result.action !== 'error') throw new Error('expected error result');
  expect(result.error).toContain('Path traversal detected');
});

it('normalizes preprocess_script input validation deterministically', () => {
  expect(normalizePreprocessScriptPath(undefined)).toEqual({
    ok: true,
    path: null,
  });
  expect(normalizePreprocessScriptPath(null)).toEqual({
    ok: true,
    path: null,
  });
  expect(normalizePreprocessScriptPath('   ')).toEqual({
    ok: true,
    path: null,
  });
  expect(normalizePreprocessScriptPath('jobs/check.ts')).toEqual({
    ok: true,
    path: 'jobs/check.ts',
  });

  expect(normalizePreprocessScriptPath(42)).toEqual({
    ok: false,
    error: 'preprocess_script must be a string or null',
  });
  expect(normalizePreprocessScriptPath('jobs/check.sh')).toEqual({
    ok: false,
    error: 'preprocess_script must point to a JS or TypeScript file',
  });
  const traversal = normalizePreprocessScriptPath('../check.ts');
  expect(traversal.ok).toBe(false);
  if (traversal.ok) throw new Error('expected traversal rejection');
  expect(traversal.error).toContain('Path traversal detected');
});

it('does nothing when no preprocessor is configured', () => {
  expect(
    runTaskPreprocessor(task({ preprocess_script: null }), { workflowsDir }),
  ).toEqual({
    action: 'run',
    prompt: 'sync connector packages',
  });
});

it('rejects whitespace-only preprocess_script values at execution time', () => {
  expect(
    runTaskPreprocessor(task({ preprocess_script: '   ' }), { workflowsDir }),
  ).toEqual({
    action: 'error',
    error: 'preprocess_script must be a non-empty path',
  });
});

it('resolves the default group task-workflows directory when no override is provided', () => {
  const groupFolder = `preprocessor-test-${process.pid}`;
  const groupWorkflowsDir = path.isAbsolute(TASK_WORKFLOWS_DIR)
    ? TASK_WORKFLOWS_DIR
    : path.join(GROUPS_DIR, groupFolder, TASK_WORKFLOWS_DIR);
  fs.mkdirSync(groupWorkflowsDir, { recursive: true });
  fs.writeFileSync(
    path.join(groupWorkflowsDir, 'workflow.ts'),
    'console.log(JSON.stringify({ action: "skip", reason: "default dir" }));',
  );

  try {
    expect(runTaskPreprocessor(task({ group_folder: groupFolder }))).toEqual({
      action: 'skip',
      reason: 'default dir',
    });
  } finally {
    fs.rmSync(
      path.isAbsolute(TASK_WORKFLOWS_DIR)
        ? groupWorkflowsDir
        : path.join(GROUPS_DIR, groupFolder),
      {
        recursive: true,
        force: true,
      },
    );
  }
});
