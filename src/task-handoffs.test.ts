import { beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  formatScheduledRunHandoffsForPrompt,
  readScheduledRunHandoffs,
  type ScheduledRunHandoff,
  writeScheduledRunHandoff,
} from './task-handoffs.js';

describe('writeScheduledRunHandoff', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclaw-handoffs-'));
  });

  function makeHandoff(
    overrides: Partial<ScheduledRunHandoff> = {},
  ): ScheduledRunHandoff {
    return {
      task_id: 'task-1',
      chat_jid: 'dc:123',
      group_folder: 'main',
      context_mode: 'group',
      run_at: '2026-03-27T01:23:45.000Z',
      status: 'success',
      duration_ms: 2500,
      next_run: '2026-03-27T02:23:45.000Z',
      result: 'Completed work',
      error: null,
      ...overrides,
    };
  }

  it('writes a JSON handoff under the scheduled-runs directory', () => {
    const handoff = makeHandoff();

    const filePath = writeScheduledRunHandoff(handoff, { baseDir: tempDir });

    expect(filePath).toContain(path.join('main', 'context', 'scheduled-runs'));
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(stored).toEqual(handoff);
  });

  it('retains only the newest configured handoff files', () => {
    for (let i = 0; i < 3; i++) {
      writeScheduledRunHandoff(
        makeHandoff({
          task_id: `task-${i}`,
          run_at: `2026-03-27T01:23:4${i}.000Z`,
        }),
        {
          baseDir: tempDir,
          maxFiles: 2,
        },
      );
    }

    const handoffDir = path.join(tempDir, 'main', 'context', 'scheduled-runs');
    const files = fs.readdirSync(handoffDir).sort();

    expect(files).toHaveLength(2);
    expect(files[0]).toContain('2026-03-27T01-23-41.000Z-task-1.json');
    expect(files[1]).toContain('2026-03-27T01-23-42.000Z-task-2.json');
  });

  it('reads the newest handoffs first with a bounded limit', () => {
    for (let i = 0; i < 4; i++) {
      writeScheduledRunHandoff(
        makeHandoff({
          task_id: `task-${i}`,
          run_at: `2026-03-27T01:23:4${i}.000Z`,
        }),
        { baseDir: tempDir },
      );
    }

    const handoffs = readScheduledRunHandoffs('main', {
      baseDir: tempDir,
      limit: 3,
    });

    expect(handoffs.map((handoff) => handoff.task_id)).toEqual([
      'task-3',
      'task-2',
      'task-1',
    ]);
  });

  it('formats a compact prompt block for recent handoffs', () => {
    const prompt = formatScheduledRunHandoffsForPrompt([
      makeHandoff({
        task_id: 'task-a',
        run_at: '2026-03-27T01:23:45.000Z',
        result: 'x'.repeat(220),
      }),
      makeHandoff({
        task_id: 'task-b',
        status: 'error',
        error: 'disk full',
        result: null,
      }),
    ]);

    expect(prompt).toContain('[Recent Scheduled Runs]');
    expect(prompt).toContain('task=task-a');
    expect(prompt).toContain('task=task-b');
    expect(prompt).toContain('disk full');
    expect(prompt).toContain(`${'x'.repeat(200)}...`);
  });

  it('skips invalid handoff files and reports them through onError', () => {
    const handoffDir = path.join(tempDir, 'main', 'context', 'scheduled-runs');
    fs.mkdirSync(handoffDir, { recursive: true });
    fs.writeFileSync(path.join(handoffDir, 'invalid.json'), '{oops');
    writeScheduledRunHandoff(makeHandoff({ task_id: 'task-ok' }), {
      baseDir: tempDir,
    });
    const seen: string[] = [];

    const handoffs = readScheduledRunHandoffs('main', {
      baseDir: tempDir,
      onError: (_error, filePath) => seen.push(path.basename(filePath)),
    });

    expect(handoffs.map((handoff) => handoff.task_id)).toEqual(['task-ok']);
    expect(seen).toEqual(['invalid.json']);
  });
});
