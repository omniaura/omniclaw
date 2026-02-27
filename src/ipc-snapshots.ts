/**
 * IPC Snapshot Utilities
 *
 * Functions for writing task and group snapshots to the per-group IPC directories.
 * These snapshots are read by containers to provide current task/group state.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { assertPathWithin } from './path-security.js';
import type { ScheduledTask } from './types.js';

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/** Map ScheduledTask rows to the lightweight shape used in task snapshots. */
export function mapTasksForSnapshot(tasks: ScheduledTask[]) {
  return tasks.map((t) => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run,
  }));
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const ipcBase = path.join(DATA_DIR, 'ipc');
  const groupIpcDir = path.join(ipcBase, groupFolder);
  assertPathWithin(groupIpcDir, ipcBase, 'writeTasksSnapshot');
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const ipcBase = path.join(DATA_DIR, 'ipc');
  const groupIpcDir = path.join(ipcBase, groupFolder);
  assertPathWithin(groupIpcDir, ipcBase, 'writeGroupsSnapshot');
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
