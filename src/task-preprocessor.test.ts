import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  normalizePreprocessScriptPath,
  runTaskPreprocessor,
} from './task-preprocessor.js';
import type { ScheduledTask } from './types.js';

let workflowsDir: string;

beforeEach(() => {
  workflowsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclaw-pre-'));
});

afterEach(() => {
  fs.rmSync(workflowsDir, { recursive: true, force: true });
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

it('defaults to running the original prompt when workflow stdout is empty', () => {
  fs.writeFileSync(path.join(workflowsDir, 'workflow.ts'), '');

  expect(runTaskPreprocessor(task(), { workflowsDir })).toEqual({
    action: 'run',
    prompt: 'sync connector packages',
  });
});

it('defaults to running the original prompt when JSON has no action', () => {
  fs.writeFileSync(
    path.join(workflowsDir, 'workflow.ts'),
    'console.log(JSON.stringify({ note: "only metadata" }));',
  );

  expect(runTaskPreprocessor(task(), { workflowsDir })).toEqual({
    action: 'run',
    prompt: 'sync connector packages',
  });
});

it('caps replacement prompt length before returning it', () => {
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
    runTaskPreprocessor(task(), { workflowsDir, maxPromptFragmentChars: 6 }),
  ).toEqual({
    action: 'run',
    prompt: 'bbbbbb\n\n[preprocessor prompt truncated to 6 characters]',
  });
});

it('sanitizes multiline workflow skip reasons', () => {
  fs.writeFileSync(
    path.join(workflowsDir, 'workflow.ts'),
    `
console.log(JSON.stringify({
  action: "skip",
  reason: "\\u001b[31mno changes\\u001b[0m\\n\\n  after scan"
}));
`,
  );

  expect(runTaskPreprocessor(task(), { workflowsDir })).toEqual({
    action: 'skip',
    reason: 'no changes after scan',
  });
});

it('reports malformed JSON output as a sanitized preprocessor error', () => {
  fs.writeFileSync(path.join(workflowsDir, 'workflow.ts'), 'console.log("{");');

  const result = runTaskPreprocessor(task(), { workflowsDir });

  expect(result.action).toBe('error');
  if (result.action !== 'error') throw new Error('expected error result');
  expect(result.error.length).toBeLessThanOrEqual(512);
  expect(result.error).toContain('JSON');
});

it('reports invalid workflow actions as preprocessor errors', () => {
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

it('rejects non-string preprocess_script values before spawning', () => {
  const result = runTaskPreprocessor(
    task({ preprocess_script: 42 as unknown as string }),
    { workflowsDir },
  );

  expect(result).toEqual({
    action: 'error',
    error: 'preprocess_script must be a string or null',
  });
});

it('rejects empty preprocess_script paths after normalization', () => {
  const result = runTaskPreprocessor(task({ preprocess_script: '   ' }), {
    workflowsDir,
  });

  expect(result).toEqual({
    action: 'error',
    error: 'preprocess_script must be a non-empty path',
  });
});

it('rejects preprocess_script paths with unsupported extensions', () => {
  const result = runTaskPreprocessor(
    task({ preprocess_script: 'workflow.sh' }),
    {
      workflowsDir,
    },
  );

  expect(result).toEqual({
    action: 'error',
    error: 'preprocess_script must point to a JS or TypeScript file',
  });
});

it('does nothing when no preprocessor is configured', () => {
  expect(
    runTaskPreprocessor(task({ preprocess_script: null }), { workflowsDir }),
  ).toEqual({
    action: 'run',
    prompt: 'sync connector packages',
  });
});

describe('normalizePreprocessScriptPath', () => {
  it('normalizes missing and blank script paths to null', () => {
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
  });

  it('accepts supported JavaScript and TypeScript workflow extensions', () => {
    for (const scriptPath of [
      'workflow.ts',
      'workflow.tsx',
      'workflow.js',
      'workflow.mjs',
      'workflow.cjs',
    ]) {
      expect(normalizePreprocessScriptPath(scriptPath)).toEqual({
        ok: true,
        path: scriptPath,
      });
    }
  });
});
