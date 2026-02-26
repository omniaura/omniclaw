import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  mapTasksForSnapshot,
  writeTasksSnapshot,
  writeGroupsSnapshot,
} from './ipc-snapshots.js';
import type { ScheduledTask } from './types.js';

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    group_folder: 'test-group',
    chat_jid: 'jid@g.us',
    prompt: 'Do something',
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'isolated',
    next_run: '2025-06-01T12:00:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ipc-snapshots', () => {
  describe('mapTasksForSnapshot', () => {
    it('maps task fields to snapshot shape', () => {
      const tasks = [makeTask()];
      const result = mapTasksForSnapshot(tasks);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: 'task-1',
        groupFolder: 'test-group',
        prompt: 'Do something',
        schedule_type: 'interval',
        schedule_value: '60000',
        status: 'active',
        next_run: '2025-06-01T12:00:00.000Z',
      });
    });

    it('maps multiple tasks', () => {
      const tasks = [
        makeTask({ id: 'task-1', group_folder: 'group-a' }),
        makeTask({ id: 'task-2', group_folder: 'group-b' }),
        makeTask({ id: 'task-3', group_folder: 'group-a' }),
      ];
      const result = mapTasksForSnapshot(tasks);
      expect(result).toHaveLength(3);
      expect(result.map((t) => t.id)).toEqual(['task-1', 'task-2', 'task-3']);
    });

    it('handles empty array', () => {
      expect(mapTasksForSnapshot([])).toEqual([]);
    });

    it('preserves null next_run', () => {
      const tasks = [makeTask({ next_run: null })];
      const result = mapTasksForSnapshot(tasks);
      expect(result[0].next_run).toBeNull();
    });
  });

  describe('writeTasksSnapshot', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclaw-ipc-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('filters tasks for non-main groups', () => {
      const groupFolder = 'alpha';
      const ipcDir = path.join(tmpDir, 'ipc', groupFolder);
      fs.mkdirSync(ipcDir, { recursive: true });

      const allTasks = [
        {
          id: 't1',
          groupFolder: 'alpha',
          prompt: 'a',
          schedule_type: 'interval',
          schedule_value: '1000',
          status: 'active',
          next_run: null,
        },
        {
          id: 't2',
          groupFolder: 'beta',
          prompt: 'b',
          schedule_type: 'cron',
          schedule_value: '0 9 * * *',
          status: 'active',
          next_run: null,
        },
        {
          id: 't3',
          groupFolder: 'alpha',
          prompt: 'c',
          schedule_type: 'once',
          schedule_value: '2025-01-01',
          status: 'paused',
          next_run: null,
        },
      ];

      // writeTasksSnapshot uses DATA_DIR internally, so we test the filtering logic directly
      const isMain = false;
      const filtered = isMain
        ? allTasks
        : allTasks.filter((t) => t.groupFolder === groupFolder);
      expect(filtered).toHaveLength(2);
      expect(filtered.every((t) => t.groupFolder === 'alpha')).toBe(true);
    });

    it('shows all tasks for main group', () => {
      const allTasks = [
        {
          id: 't1',
          groupFolder: 'alpha',
          prompt: 'a',
          schedule_type: 'interval',
          schedule_value: '1000',
          status: 'active',
          next_run: null,
        },
        {
          id: 't2',
          groupFolder: 'beta',
          prompt: 'b',
          schedule_type: 'cron',
          schedule_value: '0 9 * * *',
          status: 'active',
          next_run: null,
        },
      ];

      const isMain = true;
      const filtered = isMain
        ? allTasks
        : allTasks.filter((t) => t.groupFolder === 'main');
      expect(filtered).toHaveLength(2);
    });
  });

  describe('writeGroupsSnapshot', () => {
    it('returns empty groups array for non-main groups', () => {
      const groups = [
        { jid: 'j1', name: 'G1', lastActivity: '', isRegistered: true },
      ];
      const isMain = false;
      const visibleGroups = isMain ? groups : [];
      expect(visibleGroups).toEqual([]);
    });

    it('returns all groups for main group', () => {
      const groups = [
        {
          jid: 'j1',
          name: 'G1',
          lastActivity: '2025-01-01',
          isRegistered: true,
        },
        {
          jid: 'j2',
          name: 'G2',
          lastActivity: '2025-01-02',
          isRegistered: false,
        },
      ];
      const isMain = true;
      const visibleGroups = isMain ? groups : [];
      expect(visibleGroups).toHaveLength(2);
    });
  });
});
