import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { runTaskPreprocessor } from './task-preprocessor.js';
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

it('rejects workflow paths outside the workflows directory', () => {
  const result = runTaskPreprocessor(task({ preprocess_script: '../x.ts' }), {
    workflowsDir,
  });

  expect(result.action).toBe('error');
  if (result.action !== 'error') throw new Error('expected error result');
  expect(result.error).toContain('Path traversal detected');
});

it('does nothing when no preprocessor is configured', () => {
  expect(
    runTaskPreprocessor(task({ preprocess_script: null }), { workflowsDir }),
  ).toEqual({
    action: 'run',
    prompt: 'sync connector packages',
  });
});
