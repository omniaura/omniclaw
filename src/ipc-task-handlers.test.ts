import { describe, it, expect, beforeEach } from 'bun:test';

import {
  _initTestDatabase,
  createTask,
  getAllTasks,
  getTaskById,
  setRegisteredGroup,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

// =============================================================================
// Shared test fixtures
// =============================================================================

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const THIRD_GROUP: RegisteredGroup = {
  name: 'Third',
  folder: 'third-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let sentMessages: Array<{ jid: string; text: string }>;
let notifiedGroups: Array<{ jid: string; text: string }>;
let syncCalled: boolean;
let taskSnapshots: Array<{ groupFolder: string; isMain: boolean }>;
let registeredGroups: Array<{ jid: string; group: RegisteredGroup }>;
let updatedGroups: Array<{ jid: string; group: RegisteredGroup }>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };

  sentMessages = [];
  notifiedGroups = [];
  syncCalled = false;
  taskSnapshots = [];
  registeredGroups = [];
  updatedGroups = [];

  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);
  setRegisteredGroup('third@g.us', THIRD_GROUP);

  deps = {
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
      return `sent-${sentMessages.length}`;
    },
    notifyGroup: (jid, text) => {
      notifiedGroups.push({ jid, text });
    },
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      registeredGroups.push({ jid, group });
      setRegisteredGroup(jid, group);
    },
    updateGroup: (jid, group) => {
      groups[jid] = group;
      updatedGroups.push({ jid, group });
      setRegisteredGroup(jid, group);
    },
    syncGroupMetadata: async () => {
      syncCalled = true;
    },
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    writeTasksSnapshot: (groupFolder, isMain) => {
      taskSnapshots.push({ groupFolder, isMain });
    },
  };
});

// =============================================================================
// processTaskIpc: schedule_task — authorization & validation
// =============================================================================

describe('processTaskIpc: schedule_task authorization', () => {
  it('main group can schedule task for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Check health',
        schedule_type: 'interval',
        schedule_value: '3600000',
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].group_folder).toBe('other-group');
    expect(tasks[0].prompt).toBe('Check health');
    expect(tasks[0].schedule_type).toBe('interval');
  });

  it('main group can schedule task for itself', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Self-check',
        schedule_type: 'interval',
        schedule_value: '1800000',
        targetJid: 'main@g.us',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].group_folder).toBe('main');
  });

  it('non-main group can schedule task for itself', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'My task',
        schedule_type: 'interval',
        schedule_value: '600000',
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].group_folder).toBe('other-group');
  });

  it('non-main group cannot schedule task for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Sneaky task',
        schedule_type: 'interval',
        schedule_value: '600000',
        targetJid: 'third@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(0);
  });

  it('rejects schedule_task for unregistered target group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Ghost task',
        schedule_type: 'interval',
        schedule_value: '600000',
        targetJid: 'unregistered@g.us',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(0);
  });
});

describe('processTaskIpc: schedule_task validation', () => {
  it('rejects schedule_task with missing prompt', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        schedule_type: 'interval',
        schedule_value: '600000',
        targetJid: 'main@g.us',
      } as any,
      'main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects schedule_task with missing schedule_type', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Task',
        schedule_value: '600000',
        targetJid: 'main@g.us',
      } as any,
      'main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects schedule_task with missing schedule_value', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Task',
        schedule_type: 'interval',
        targetJid: 'main@g.us',
      } as any,
      'main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects schedule_task with missing targetJid', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Task',
        schedule_type: 'interval',
        schedule_value: '600000',
      } as any,
      'main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('defaults context_mode to isolated when not specified', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Default context task',
        schedule_type: 'interval',
        schedule_value: '600000',
        targetJid: 'main@g.us',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('accepts context_mode=group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Group context task',
        schedule_type: 'interval',
        schedule_value: '600000',
        targetJid: 'main@g.us',
        context_mode: 'group',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].context_mode).toBe('group');
  });

  it('accepts context_mode=isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Isolated task',
        schedule_type: 'interval',
        schedule_value: '600000',
        targetJid: 'main@g.us',
        context_mode: 'isolated',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults invalid context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Bad context mode',
        schedule_type: 'interval',
        schedule_value: '600000',
        targetJid: 'main@g.us',
        context_mode: 'invalid' as any,
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('creates task with cron schedule type', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Cron task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        targetJid: 'main@g.us',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('cron');
    expect(tasks[0].schedule_value).toBe('0 9 * * *');
  });

  it('creates task with once schedule type', async () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Once task',
        schedule_type: 'once',
        schedule_value: futureDate,
        targetJid: 'main@g.us',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('once');
  });

  it('refreshes task snapshot after creating task', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Snapshot task',
        schedule_type: 'interval',
        schedule_value: '600000',
        targetJid: 'main@g.us',
      },
      'main',
      true,
      deps,
    );

    expect(taskSnapshots).toHaveLength(1);
    expect(taskSnapshots[0].groupFolder).toBe('main');
    expect(taskSnapshots[0].isMain).toBe(true);
  });

  it('task ID starts with task- prefix', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'ID check',
        schedule_type: 'interval',
        schedule_value: '600000',
        targetJid: 'main@g.us',
      },
      'main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].id).toMatch(/^task-/);
  });
});

// =============================================================================
// processTaskIpc: register_group — authorization & validation
// =============================================================================

describe('processTaskIpc: register_group authorization', () => {
  it('non-main group cannot register new groups', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Bot',
      },
      'other-group',
      false,
      deps,
    );

    expect(groups['new@g.us']).toBeUndefined();
    expect(registeredGroups).toHaveLength(0);
  });

  it('main group can register new groups', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Bot',
      },
      'main',
      true,
      deps,
    );

    expect(groups['new@g.us']).toBeDefined();
    expect(groups['new@g.us'].name).toBe('New Group');
    expect(groups['new@g.us'].folder).toBe('new-group');
    expect(groups['new@g.us'].trigger).toBe('@Bot');
  });
});

describe('processTaskIpc: register_group validation', () => {
  it('rejects register_group with missing jid', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        name: 'No JID',
        folder: 'no-jid',
        trigger: '@Bot',
      } as any,
      'main',
      true,
      deps,
    );

    expect(registeredGroups).toHaveLength(0);
  });

  it('rejects register_group with missing name', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        folder: 'new-group',
        trigger: '@Bot',
      } as any,
      'main',
      true,
      deps,
    );

    expect(registeredGroups).toHaveLength(0);
  });

  it('rejects register_group with missing folder', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        trigger: '@Bot',
      } as any,
      'main',
      true,
      deps,
    );

    expect(registeredGroups).toHaveLength(0);
  });

  it('rejects register_group with missing trigger', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
      } as any,
      'main',
      true,
      deps,
    );

    expect(registeredGroups).toHaveLength(0);
  });

  it('rejects register_group with invalid folder name (starts with hyphen)', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'Bad Folder',
        folder: '-bad-folder',
        trigger: '@Bot',
      },
      'main',
      true,
      deps,
    );

    expect(groups['new@g.us']).toBeUndefined();
  });

  it('rejects register_group with invalid folder name (contains spaces)', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'Spaces Folder',
        folder: 'has spaces',
        trigger: '@Bot',
      },
      'main',
      true,
      deps,
    );

    expect(groups['new@g.us']).toBeUndefined();
  });

  it('rejects register_group with invalid folder name (path traversal)', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'Traversal',
        folder: '../etc',
        trigger: '@Bot',
      },
      'main',
      true,
      deps,
    );

    expect(groups['new@g.us']).toBeUndefined();
  });

  it('accepts register_group with valid alphanumeric folder', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'valid@g.us',
        name: 'Valid Group',
        folder: 'valid-group-123',
        trigger: '@Bot',
      },
      'main',
      true,
      deps,
    );

    expect(groups['valid@g.us']).toBeDefined();
    expect(groups['valid@g.us'].folder).toBe('valid-group-123');
  });

  it('accepts register_group with underscores in folder', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'under@g.us',
        name: 'Underscore Group',
        folder: 'my_group_name',
        trigger: '@Bot',
      },
      'main',
      true,
      deps,
    );

    expect(groups['under@g.us']).toBeDefined();
  });

  it('sets requiresTrigger when provided', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'solo@g.us',
        name: 'Solo Chat',
        folder: 'solo-chat',
        trigger: '@Bot',
        requiresTrigger: false,
      },
      'main',
      true,
      deps,
    );

    expect(groups['solo@g.us'].requiresTrigger).toBe(false);
  });

  it('sets containerConfig when provided', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'config@g.us',
        name: 'Config Group',
        folder: 'config-group',
        trigger: '@Bot',
        containerConfig: { additionalMounts: [] },
      },
      'main',
      true,
      deps,
    );

    expect(groups['config@g.us'].containerConfig).toBeDefined();
  });

  it('sets added_at timestamp on registration', async () => {
    const before = new Date().toISOString();
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'time@g.us',
        name: 'Timed Group',
        folder: 'timed-group',
        trigger: '@Bot',
      },
      'main',
      true,
      deps,
    );
    const after = new Date().toISOString();

    expect(groups['time@g.us'].added_at).toBeDefined();
    expect(groups['time@g.us'].added_at! >= before).toBe(true);
    expect(groups['time@g.us'].added_at! <= after).toBe(true);
  });
});

// =============================================================================
// processTaskIpc: task lifecycle (pause/resume/cancel) — authorization
// =============================================================================

function createTestTask(id: string, folder: string) {
  createTask({
    id,
    group_folder: folder,
    chat_jid: `${folder}@g.us`,
    prompt: 'test task',
    schedule_type: 'interval',
    schedule_value: '3600000',
    context_mode: 'isolated',
    next_run: new Date(Date.now() + 3600000).toISOString(),
    status: 'active',
    created_at: '2024-01-01T00:00:00.000Z',
  });
}

describe('processTaskIpc: pause_task', () => {
  it('main group can pause any task', async () => {
    createTestTask('task-pause-1', 'other-group');

    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-pause-1' },
      'main',
      true,
      deps,
    );

    const task = getTaskById('task-pause-1');
    expect(task!.status).toBe('paused');
  });

  it('group can pause its own task', async () => {
    createTestTask('task-pause-own', 'other-group');

    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-pause-own' },
      'other-group',
      false,
      deps,
    );

    const task = getTaskById('task-pause-own');
    expect(task!.status).toBe('paused');
  });

  it('non-main group cannot pause another groups task', async () => {
    createTestTask('task-pause-other', 'third-group');

    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-pause-other' },
      'other-group',
      false,
      deps,
    );

    const task = getTaskById('task-pause-other');
    expect(task!.status).toBe('active'); // Unchanged
  });

  it('handles missing taskId gracefully', async () => {
    await processTaskIpc({ type: 'pause_task' } as any, 'main', true, deps);

    // Should not throw
    expect(taskSnapshots).toHaveLength(0);
  });

  it('handles non-existent task gracefully', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'nonexistent-task' },
      'main',
      true,
      deps,
    );

    // Should not throw
    expect(taskSnapshots).toHaveLength(0);
  });

  it('refreshes task snapshot after successful pause', async () => {
    createTestTask('task-pause-snap', 'main');

    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-pause-snap' },
      'main',
      true,
      deps,
    );

    expect(taskSnapshots.length).toBeGreaterThanOrEqual(1);
  });
});

describe('processTaskIpc: resume_task', () => {
  it('main group can resume any paused task', async () => {
    createTestTask('task-resume-1', 'other-group');
    // First pause it
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-resume-1' },
      'main',
      true,
      deps,
    );
    expect(getTaskById('task-resume-1')!.status).toBe('paused');

    // Then resume it
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-resume-1' },
      'main',
      true,
      deps,
    );

    expect(getTaskById('task-resume-1')!.status).toBe('active');
  });

  it('group can resume its own task', async () => {
    createTestTask('task-resume-own', 'other-group');
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-resume-own' },
      'other-group',
      false,
      deps,
    );

    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-resume-own' },
      'other-group',
      false,
      deps,
    );

    expect(getTaskById('task-resume-own')!.status).toBe('active');
  });

  it('non-main group cannot resume another groups task', async () => {
    createTestTask('task-resume-other', 'third-group');
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-resume-other' },
      'main',
      true,
      deps,
    );
    expect(getTaskById('task-resume-other')!.status).toBe('paused');

    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-resume-other' },
      'other-group',
      false,
      deps,
    );

    // Should remain paused — unauthorized
    expect(getTaskById('task-resume-other')!.status).toBe('paused');
  });

  it('handles missing taskId gracefully', async () => {
    await processTaskIpc({ type: 'resume_task' } as any, 'main', true, deps);

    expect(taskSnapshots).toHaveLength(0);
  });

  it('handles non-existent task gracefully', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'ghost-task' },
      'main',
      true,
      deps,
    );

    expect(taskSnapshots).toHaveLength(0);
  });
});

describe('processTaskIpc: cancel_task', () => {
  it('main group can cancel any task', async () => {
    createTestTask('task-cancel-1', 'other-group');

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-cancel-1' },
      'main',
      true,
      deps,
    );

    expect(getTaskById('task-cancel-1')).toBeNull();
  });

  it('group can cancel its own task', async () => {
    createTestTask('task-cancel-own', 'other-group');

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-cancel-own' },
      'other-group',
      false,
      deps,
    );

    expect(getTaskById('task-cancel-own')).toBeNull();
  });

  it('non-main group cannot cancel another groups task', async () => {
    createTestTask('task-cancel-other', 'third-group');

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-cancel-other' },
      'other-group',
      false,
      deps,
    );

    // Task should still exist
    expect(getTaskById('task-cancel-other')).toBeDefined();
  });

  it('handles missing taskId gracefully', async () => {
    await processTaskIpc({ type: 'cancel_task' } as any, 'main', true, deps);

    expect(taskSnapshots).toHaveLength(0);
  });

  it('handles non-existent task gracefully', async () => {
    await processTaskIpc(
      { type: 'cancel_task', taskId: 'already-gone' },
      'main',
      true,
      deps,
    );

    expect(taskSnapshots).toHaveLength(0);
  });

  it('refreshes task snapshot after successful cancel', async () => {
    createTestTask('task-cancel-snap', 'main');

    taskSnapshots = []; // Reset
    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-cancel-snap' },
      'main',
      true,
      deps,
    );

    expect(taskSnapshots.length).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// processTaskIpc: configure_heartbeat — edge cases
// =============================================================================

describe('processTaskIpc: configure_heartbeat edge cases', () => {
  it('non-main group targeting another group via target_group_jid is blocked', async () => {
    await processTaskIpc(
      {
        type: 'configure_heartbeat',
        enabled: true,
        interval: '600000',
        target_group_jid: 'main@g.us',
      },
      'other-group',
      false,
      deps,
    );

    // Main group heartbeat should remain unchanged
    expect(groups['main@g.us'].heartbeat).toBeUndefined();
  });

  it('resolves target from sourceGroup when no target_group_jid for non-main', async () => {
    await processTaskIpc(
      {
        type: 'configure_heartbeat',
        enabled: true,
        interval: '900000',
      },
      'third-group',
      false,
      deps,
    );

    expect(groups['third@g.us'].heartbeat).toBeDefined();
    expect(groups['third@g.us'].heartbeat!.interval).toBe('900000');
  });

  it('main uses target_group_jid when provided', async () => {
    await processTaskIpc(
      {
        type: 'configure_heartbeat',
        enabled: true,
        interval: '7200000',
        target_group_jid: 'third@g.us',
      },
      'main',
      true,
      deps,
    );

    expect(groups['third@g.us'].heartbeat).toBeDefined();
    expect(groups['third@g.us'].heartbeat!.interval).toBe('7200000');
  });

  it('rejects heartbeat for unregistered target_group_jid', async () => {
    await processTaskIpc(
      {
        type: 'configure_heartbeat',
        enabled: true,
        target_group_jid: 'unregistered@g.us',
      },
      'main',
      true,
      deps,
    );

    // No group should have heartbeat set
    expect(updatedGroups).toHaveLength(0);
  });
});

// =============================================================================
// processTaskIpc: writeTasksSnapshot with missing dep
// =============================================================================

describe('processTaskIpc: optional writeTasksSnapshot', () => {
  it('works when writeTasksSnapshot is undefined', async () => {
    const depsNoSnapshot: IpcDeps = {
      ...deps,
      writeTasksSnapshot: undefined,
    };

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'No snapshot',
        schedule_type: 'interval',
        schedule_value: '600000',
        targetJid: 'main@g.us',
      },
      'main',
      true,
      depsNoSnapshot,
    );

    // Should create the task without error
    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
  });
});
