import { describe, it, expect, beforeEach, mock } from 'bun:test';

import {
  _initTestDatabase,
  advanceTaskNextRun,
  createTask,
  deleteTask,
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTaskAfterRun,
} from './db.js';
import { calculateNextRun, validateSchedule } from './schedule-utils.js';
import {
  findGroupByFolder,
  findJidByFolder,
  findMainGroupJid,
  isMainGroup,
} from './group-helpers.js';
import type { RegisteredGroup } from './types.js';

// ============================================================
// schedule-utils: calculateNextRun & validateSchedule
// ============================================================

describe('calculateNextRun', () => {
  // --- cron ---
  it('returns a future ISO date for a valid cron expression', () => {
    const result = calculateNextRun('cron', '0 9 * * *');
    expect(result).toBeTruthy();
    const date = new Date(result!);
    expect(date.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('returns null for an invalid cron expression', () => {
    const result = calculateNextRun('cron', 'not-a-cron');
    expect(result).toBeNull();
  });

  it('parses empty cron string without crashing', () => {
    // cron-parser treats empty string as a default (all wildcards),
    // so it returns a valid next run rather than null.
    const result = calculateNextRun('cron', '');
    // Either null or a valid date — just ensure no crash
    if (result !== null) {
      expect(new Date(result).getTime()).toBeGreaterThan(0);
    }
  });

  // --- interval ---
  it('computes next run from interval in milliseconds', () => {
    const baseTime = new Date('2025-01-01T00:00:00.000Z');
    const result = calculateNextRun('interval', '3600000', baseTime);
    expect(result).toBe('2025-01-01T01:00:00.000Z');
  });

  it('returns null for non-numeric interval', () => {
    expect(calculateNextRun('interval', 'abc')).toBeNull();
  });

  it('returns null for zero interval', () => {
    expect(calculateNextRun('interval', '0')).toBeNull();
  });

  it('returns null for negative interval', () => {
    expect(calculateNextRun('interval', '-5000')).toBeNull();
  });

  // --- once ---
  it('returns the ISO string for a valid once timestamp', () => {
    const result = calculateNextRun('once', '2030-06-15T12:00:00.000Z');
    expect(result).toBe('2030-06-15T12:00:00.000Z');
  });

  it('returns null for an invalid once timestamp', () => {
    expect(calculateNextRun('once', 'not-a-date')).toBeNull();
  });

  // --- unknown schedule type ---
  it('returns null for an unknown schedule type', () => {
    expect(calculateNextRun('weekly' as any, '5')).toBeNull();
  });
});

describe('validateSchedule', () => {
  it('returns true for a valid cron', () => {
    expect(validateSchedule('cron', '*/5 * * * *')).toBe(true);
  });

  it('returns false for an invalid cron', () => {
    expect(validateSchedule('cron', 'bad')).toBe(false);
  });

  it('returns true for a valid interval', () => {
    expect(validateSchedule('interval', '60000')).toBe(true);
  });

  it('returns false for a zero interval', () => {
    expect(validateSchedule('interval', '0')).toBe(false);
  });

  it('returns true for a valid once timestamp', () => {
    expect(validateSchedule('once', '2030-01-01T00:00:00Z')).toBe(true);
  });

  it('returns false for an invalid once timestamp', () => {
    expect(validateSchedule('once', 'garbage')).toBe(false);
  });
});

// ============================================================
// DB task lifecycle: getDueTasks, advanceTaskNextRun, etc.
// ============================================================

describe('DB task lifecycle', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  describe('getDueTasks', () => {
    it('returns tasks whose next_run is in the past', () => {
      createTask({
        id: 'due-task',
        group_folder: 'main',
        chat_jid: 'g@g.us',
        prompt: 'run me',
        schedule_type: 'interval',
        schedule_value: '60000',
        context_mode: 'isolated',
        next_run: '2020-01-01T00:00:00.000Z', // far in the past
        status: 'active',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      const due = getDueTasks();
      expect(due).toHaveLength(1);
      expect(due[0].id).toBe('due-task');
    });

    it('excludes tasks whose next_run is in the future', () => {
      createTask({
        id: 'future-task',
        group_folder: 'main',
        chat_jid: 'g@g.us',
        prompt: 'not yet',
        schedule_type: 'interval',
        schedule_value: '60000',
        context_mode: 'isolated',
        next_run: '2099-01-01T00:00:00.000Z',
        status: 'active',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      expect(getDueTasks()).toHaveLength(0);
    });

    it('excludes paused tasks even if next_run is past', () => {
      createTask({
        id: 'paused-task',
        group_folder: 'main',
        chat_jid: 'g@g.us',
        prompt: 'paused',
        schedule_type: 'interval',
        schedule_value: '60000',
        context_mode: 'isolated',
        next_run: '2020-01-01T00:00:00.000Z',
        status: 'paused',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      expect(getDueTasks()).toHaveLength(0);
    });

    it('excludes tasks with null next_run', () => {
      createTask({
        id: 'null-task',
        group_folder: 'main',
        chat_jid: 'g@g.us',
        prompt: 'null next',
        schedule_type: 'once',
        schedule_value: '2024-01-01T00:00:00.000Z',
        context_mode: 'isolated',
        next_run: null,
        status: 'active',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      expect(getDueTasks()).toHaveLength(0);
    });

    it('returns tasks ordered by next_run ascending', () => {
      createTask({
        id: 'task-b',
        group_folder: 'main',
        chat_jid: 'g@g.us',
        prompt: 'second',
        schedule_type: 'interval',
        schedule_value: '60000',
        context_mode: 'isolated',
        next_run: '2020-01-02T00:00:00.000Z',
        status: 'active',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      createTask({
        id: 'task-a',
        group_folder: 'main',
        chat_jid: 'g@g.us',
        prompt: 'first',
        schedule_type: 'interval',
        schedule_value: '60000',
        context_mode: 'isolated',
        next_run: '2020-01-01T00:00:00.000Z',
        status: 'active',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      const due = getDueTasks();
      expect(due).toHaveLength(2);
      expect(due[0].id).toBe('task-a');
      expect(due[1].id).toBe('task-b');
    });
  });

  describe('advanceTaskNextRun', () => {
    it('updates next_run to a new timestamp', () => {
      createTask({
        id: 'adv-task',
        group_folder: 'main',
        chat_jid: 'g@g.us',
        prompt: 'advance me',
        schedule_type: 'interval',
        schedule_value: '60000',
        context_mode: 'isolated',
        next_run: '2020-01-01T00:00:00.000Z',
        status: 'active',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      advanceTaskNextRun('adv-task', '2025-06-01T00:00:00.000Z');
      const task = getTaskById('adv-task');
      expect(task!.next_run).toBe('2025-06-01T00:00:00.000Z');
      expect(task!.status).toBe('active');
    });

    it('sets status to completed when next_run is null (one-shot task)', () => {
      createTask({
        id: 'once-task',
        group_folder: 'main',
        chat_jid: 'g@g.us',
        prompt: 'one shot',
        schedule_type: 'once',
        schedule_value: '2024-06-01T00:00:00.000Z',
        context_mode: 'isolated',
        next_run: '2024-06-01T00:00:00.000Z',
        status: 'active',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      advanceTaskNextRun('once-task', null);
      const task = getTaskById('once-task');
      expect(task!.next_run).toBeNull();
      expect(task!.status).toBe('completed');
    });
  });

  describe('updateTaskAfterRun', () => {
    it('sets last_run, last_result, and computes next_run', () => {
      createTask({
        id: 'run-task',
        group_folder: 'main',
        chat_jid: 'g@g.us',
        prompt: 'run',
        schedule_type: 'interval',
        schedule_value: '60000',
        context_mode: 'isolated',
        next_run: '2020-01-01T00:00:00.000Z',
        status: 'active',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      updateTaskAfterRun(
        'run-task',
        '2025-06-01T00:00:00.000Z',
        'Success: done',
      );
      const task = getTaskById('run-task');
      expect(task!.next_run).toBe('2025-06-01T00:00:00.000Z');
      expect(task!.last_run).toBeTruthy();
      expect(task!.last_result).toBe('Success: done');
      expect(task!.status).toBe('active');
    });

    it('marks task as completed when next_run is null', () => {
      createTask({
        id: 'complete-task',
        group_folder: 'main',
        chat_jid: 'g@g.us',
        prompt: 'complete',
        schedule_type: 'once',
        schedule_value: '2024-01-01T00:00:00.000Z',
        context_mode: 'isolated',
        next_run: '2024-01-01T00:00:00.000Z',
        status: 'active',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      updateTaskAfterRun('complete-task', null, 'Completed');
      const task = getTaskById('complete-task');
      expect(task!.status).toBe('completed');
      expect(task!.next_run).toBeNull();
    });
  });

  describe('logTaskRun', () => {
    it('records a successful task run', () => {
      createTask({
        id: 'log-task',
        group_folder: 'main',
        chat_jid: 'g@g.us',
        prompt: 'log me',
        schedule_type: 'once',
        schedule_value: '2024-06-01T00:00:00.000Z',
        context_mode: 'isolated',
        next_run: null,
        status: 'active',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      // Should not throw
      logTaskRun({
        task_id: 'log-task',
        run_at: '2024-06-01T00:00:01.000Z',
        duration_ms: 5000,
        status: 'success',
        result: 'done',
        error: null,
      });
    });

    it('records a failed task run with error', () => {
      createTask({
        id: 'err-task',
        group_folder: 'main',
        chat_jid: 'g@g.us',
        prompt: 'fail me',
        schedule_type: 'once',
        schedule_value: '2024-06-01T00:00:00.000Z',
        context_mode: 'isolated',
        next_run: null,
        status: 'active',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      logTaskRun({
        task_id: 'err-task',
        run_at: '2024-06-01T00:00:01.000Z',
        duration_ms: 2000,
        status: 'error',
        result: null,
        error: 'Container crashed',
      });
    });

    it('silently no-ops when task was deleted while running', () => {
      // Simulate: task existed when run started, but was deleted before logTaskRun
      // Should NOT throw SQLITE_CONSTRAINT_FOREIGNKEY
      createTask({
        id: 'deleted-task',
        group_folder: 'main',
        chat_jid: 'g@g.us',
        prompt: 'run me',
        schedule_type: 'once',
        schedule_value: '2024-06-01T00:00:00.000Z',
        context_mode: 'isolated',
        next_run: null,
        status: 'active',
        created_at: '2024-01-01T00:00:00.000Z',
      });
      deleteTask('deleted-task');

      expect(() => {
        logTaskRun({
          task_id: 'deleted-task',
          run_at: '2024-06-01T00:00:01.000Z',
          duration_ms: 3000,
          status: 'success',
          result: 'completed but task gone',
          error: null,
        });
      }).not.toThrow();
    });

    it('deleteTask cleans up associated run logs', () => {
      createTask({
        id: 'cleanup-task',
        group_folder: 'main',
        chat_jid: 'g@g.us',
        prompt: 'cleanup',
        schedule_type: 'once',
        schedule_value: '2024-06-01T00:00:00.000Z',
        context_mode: 'isolated',
        next_run: null,
        status: 'active',
        created_at: '2024-01-01T00:00:00.000Z',
      });

      logTaskRun({
        task_id: 'cleanup-task',
        run_at: '2024-06-01T00:00:01.000Z',
        duration_ms: 1000,
        status: 'success',
        result: 'ok',
        error: null,
      });

      // Should not throw (cascading delete of run logs)
      deleteTask('cleanup-task');
      expect(getTaskById('cleanup-task')).toBeNull();
    });
  });
});

// ============================================================
// group-helpers
// ============================================================

describe('group-helpers', () => {
  const groups: Record<string, RegisteredGroup> = {
    'main@g.us': {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
    },
    'team@g.us': {
      name: 'Team Chat',
      folder: 'team-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    },
    'dev@g.us': {
      name: 'Dev',
      folder: 'dev-channel',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    },
  };

  describe('findJidByFolder', () => {
    it('returns the JID for a known folder', () => {
      expect(findJidByFolder(groups, 'team-chat')).toBe('team@g.us');
    });

    it('returns undefined for an unknown folder', () => {
      expect(findJidByFolder(groups, 'nonexistent')).toBeUndefined();
    });

    it('finds the main group folder', () => {
      expect(findJidByFolder(groups, 'main')).toBe('main@g.us');
    });
  });

  describe('findGroupByFolder', () => {
    it('returns [jid, group] tuple for known folder', () => {
      const result = findGroupByFolder(groups, 'dev-channel');
      expect(result).toBeDefined();
      expect(result![0]).toBe('dev@g.us');
      expect(result![1].name).toBe('Dev');
    });

    it('returns undefined for unknown folder', () => {
      expect(findGroupByFolder(groups, 'nope')).toBeUndefined();
    });
  });

  describe('findMainGroupJid', () => {
    it('returns the main group JID', () => {
      expect(findMainGroupJid(groups)).toBe('main@g.us');
    });

    it('returns undefined when no main group exists', () => {
      const noMain: Record<string, RegisteredGroup> = {
        'team@g.us': groups['team@g.us'],
      };
      expect(findMainGroupJid(noMain)).toBeUndefined();
    });
  });

  describe('isMainGroup', () => {
    it('returns true for "main"', () => {
      expect(isMainGroup('main')).toBe(true);
    });

    it('returns false for other folders', () => {
      expect(isMainGroup('team-chat')).toBe(false);
      expect(isMainGroup('')).toBe(false);
    });
  });
});

// ============================================================
// Deterministic simulation: scheduler loop task lifecycle
// ============================================================

describe('scheduler task lifecycle (deterministic simulation)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('simulates the full lifecycle of a one-shot task', () => {
    // 1. Create a once task due now
    const pastTime = '2020-01-01T00:00:00.000Z';
    createTask({
      id: 'sim-once',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'one-shot task',
      schedule_type: 'once',
      schedule_value: pastTime,
      context_mode: 'isolated',
      next_run: pastTime,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    // 2. Scheduler discovers it as due
    const dueTasks = getDueTasks();
    expect(dueTasks).toHaveLength(1);
    expect(dueTasks[0].id).toBe('sim-once');

    // 3. Scheduler advances next_run before enqueue (prevents re-pick)
    //    For 'once' tasks, next_run becomes null
    advanceTaskNextRun('sim-once', null);

    // 4. Verify it's no longer returned as due
    expect(getDueTasks()).toHaveLength(0);

    // 5. Task is marked completed
    const task = getTaskById('sim-once');
    expect(task!.status).toBe('completed');
    expect(task!.next_run).toBeNull();

    // 6. After run, update with result
    updateTaskAfterRun('sim-once', null, 'Completed successfully');
    const final = getTaskById('sim-once');
    expect(final!.last_result).toBe('Completed successfully');
    expect(final!.last_run).toBeTruthy();

    // 7. Log the run
    logTaskRun({
      task_id: 'sim-once',
      run_at: new Date().toISOString(),
      duration_ms: 3000,
      status: 'success',
      result: 'Completed successfully',
      error: null,
    });
  });

  it('simulates the full lifecycle of a recurring interval task', () => {
    const pastTime = '2020-01-01T00:00:00.000Z';
    createTask({
      id: 'sim-interval',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'recurring task',
      schedule_type: 'interval',
      schedule_value: '3600000', // 1 hour
      context_mode: 'isolated',
      next_run: pastTime,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    // 1. Discovered as due
    expect(getDueTasks()).toHaveLength(1);

    // 2. Advance next_run before enqueue
    const nextRun = calculateNextRun('interval', '3600000');
    expect(nextRun).toBeTruthy();
    advanceTaskNextRun('sim-interval', nextRun);

    // 3. No longer due (next_run is ~1h in the future)
    expect(getDueTasks()).toHaveLength(0);

    // 4. Task remains active (not completed)
    const task = getTaskById('sim-interval');
    expect(task!.status).toBe('active');
    expect(task!.next_run).toBe(nextRun);

    // 5. After run completes, update with result and next run
    const nextNextRun = calculateNextRun('interval', '3600000');
    updateTaskAfterRun('sim-interval', nextNextRun, 'Run 1 done');
    const afterRun = getTaskById('sim-interval');
    expect(afterRun!.status).toBe('active');
    expect(afterRun!.last_result).toBe('Run 1 done');
  });

  it('simulates pausing and resuming a task mid-lifecycle', () => {
    createTask({
      id: 'sim-pausable',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'pausable',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: '2020-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    // Due initially
    expect(getDueTasks()).toHaveLength(1);

    // Pause it (simulating IPC pause_task)
    const { updateTask } = require('./db.js');
    updateTask('sim-pausable', { status: 'paused' });

    // No longer due while paused
    expect(getDueTasks()).toHaveLength(0);

    // Resume it
    updateTask('sim-pausable', { status: 'active' });

    // Due again
    expect(getDueTasks()).toHaveLength(1);
  });
});
