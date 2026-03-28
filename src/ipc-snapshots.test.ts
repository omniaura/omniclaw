import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';

import { DATA_DIR } from './config.js';
import {
  mapTasksForSnapshot,
  writeGroupsSnapshot,
  writeRostersSnapshot,
  writeTasksSnapshot,
} from './ipc-snapshots.js';
import type { ScheduledTask } from './types.js';
import type { GuildInfo, GuildRosterMember } from './db.js';

const RealDate = Date;

function installFixedDate(iso: string) {
  const fixed = new RealDate(iso);

  class FixedDate extends RealDate {
    constructor(value?: string | number | Date) {
      super(value ?? fixed.getTime());
    }

    static override now(): number {
      return fixed.getTime();
    }
  }

  globalThis.Date = FixedDate as unknown as DateConstructor;
}

function uniqueFolder(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

afterEach(() => {
  globalThis.Date = RealDate;
});

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
    executing_since: null,
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
        last_outcome_state: null,
        last_outcome_reason: null,
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

    it('includes outcome state and reason when present', () => {
      const tasks = [
        makeTask({
          last_outcome_state: 'blocked',
          last_outcome_reason: 'Need user input',
        }),
      ];
      const result = mapTasksForSnapshot(tasks);
      expect(result[0].last_outcome_state).toBe('blocked');
      expect(result[0].last_outcome_reason).toBe('Need user input');
    });

    it('returns null outcome fields when task has no outcome', () => {
      const tasks = [makeTask()];
      const result = mapTasksForSnapshot(tasks);
      expect(result[0].last_outcome_state).toBeNull();
      expect(result[0].last_outcome_reason).toBeNull();
    });
  });

  describe('task visibility filtering', () => {
    it('writes only matching tasks for non-main groups', () => {
      const groupFolder = uniqueFolder('ipc-snapshot-tasks');
      const tasksFile = path.join(DATA_DIR, 'ipc', groupFolder, 'current_tasks.json');
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

      try {
        writeTasksSnapshot(groupFolder, false, allTasks, 'alpha');

        expect(readJson(tasksFile)).toEqual([
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
            id: 't3',
            groupFolder: 'alpha',
            prompt: 'c',
            schedule_type: 'once',
            schedule_value: '2025-01-01',
            status: 'paused',
            next_run: null,
          },
        ]);
      } finally {
        fs.rmSync(path.join(DATA_DIR, 'ipc', groupFolder), {
          recursive: true,
          force: true,
        });
      }
    });

    it('writes all tasks for the main group', () => {
      const groupFolder = uniqueFolder('ipc-snapshot-tasks-main');
      const tasksFile = path.join(DATA_DIR, 'ipc', groupFolder, 'current_tasks.json');
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

      try {
        writeTasksSnapshot(groupFolder, true, allTasks);
        expect(readJson(tasksFile)).toEqual(allTasks);
      } finally {
        fs.rmSync(path.join(DATA_DIR, 'ipc', groupFolder), {
          recursive: true,
          force: true,
        });
      }
    });
  });

  describe('group visibility filtering', () => {
    it('writes empty groups for non-main agents without subscriptions', () => {
      installFixedDate('2026-03-28T10:11:12.000Z');
      const groupFolder = uniqueFolder('ipc-snapshot-groups-empty');
      const groupsFile = path.join(
        DATA_DIR,
        'ipc',
        groupFolder,
        'available_groups.json',
      );
      const groups = [
        { jid: 'j1', name: 'G1', lastActivity: '', isRegistered: true },
      ];

      try {
        writeGroupsSnapshot(groupFolder, false, groups, new Set(), new Set());
        expect(readJson(groupsFile)).toEqual({
          groups: [],
          lastSync: '2026-03-28T10:11:12.000Z',
        });
      } finally {
        fs.rmSync(path.join(DATA_DIR, 'ipc', groupFolder), {
          recursive: true,
          force: true,
        });
      }
    });

    it('writes all groups for the main group', () => {
      installFixedDate('2026-03-28T11:22:33.000Z');
      const groupFolder = uniqueFolder('ipc-snapshot-groups-main');
      const groupsFile = path.join(
        DATA_DIR,
        'ipc',
        groupFolder,
        'available_groups.json',
      );
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

      try {
        writeGroupsSnapshot(groupFolder, true, groups, new Set(['j1', 'j2']));
        expect(readJson(groupsFile)).toEqual({
          groups,
          lastSync: '2026-03-28T11:22:33.000Z',
        });
      } finally {
        fs.rmSync(path.join(DATA_DIR, 'ipc', groupFolder), {
          recursive: true,
          force: true,
        });
      }
    });

    it('writes only subscribed groups for non-main agents', () => {
      installFixedDate('2026-03-28T12:34:56.000Z');
      const groupFolder = uniqueFolder('ipc-snapshot-groups-filtered');
      const groupsFile = path.join(
        DATA_DIR,
        'ipc',
        groupFolder,
        'available_groups.json',
      );
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
          isRegistered: true,
        },
        {
          jid: 'j3',
          name: 'G3',
          lastActivity: '2025-01-03',
          isRegistered: false,
        },
      ];
      const subscribedJids = new Set(['j1', 'j3']);

      try {
        writeGroupsSnapshot(groupFolder, false, groups, new Set(), subscribedJids);
        expect(readJson(groupsFile)).toEqual({
          groups: [groups[0], groups[2]],
          lastSync: '2026-03-28T12:34:56.000Z',
        });
      } finally {
        fs.rmSync(path.join(DATA_DIR, 'ipc', groupFolder), {
          recursive: true,
          force: true,
        });
      }
    });
  });

  describe('writeRostersSnapshot', () => {
    it('writes guild rosters and a deterministic lastSync timestamp', () => {
      installFixedDate('2026-03-28T15:00:00.000Z');
      const groupFolder = uniqueFolder('ipc-snapshot-rosters');
      const rostersFile = path.join(DATA_DIR, 'ipc', groupFolder, 'guild_rosters.json');
      const rosters: Array<{ guild: GuildInfo; members: GuildRosterMember[] }> = [
        {
          guild: {
            id: 'guild-1',
            name: 'OmniAura',
            ownerId: 'user-1',
            memberCount: 2,
            lastSynced: '2026-03-28T14:59:00.000Z',
          },
          members: [
            {
              userId: 'user-1',
              username: 'peyton',
              displayName: 'Peyton',
              isBot: false,
              roles: ['admin'],
            },
            {
              userId: 'bot-1',
              username: 'ocpeyton',
              displayName: 'OCPeyton',
              isBot: true,
              roles: ['agent'],
            },
          ],
        },
      ];

      try {
        writeRostersSnapshot(groupFolder, rosters);
        expect(readJson(rostersFile)).toEqual({
          rosters,
          lastSync: '2026-03-28T15:00:00.000Z',
        });
      } finally {
        fs.rmSync(path.join(DATA_DIR, 'ipc', groupFolder), {
          recursive: true,
          force: true,
        });
      }
    });
  });
});
