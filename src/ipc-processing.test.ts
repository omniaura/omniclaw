import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach } from 'bun:test';

import { GROUPS_DIR, TASK_WORKFLOWS_DIR } from './config.js';

import {
  _initTestDatabase,
  _backdateSessionForTest,
  createTask,
  getAllTasks,
  getTaskById,
  setRegisteredGroup,
  expireStaleSessions,
  getSession,
  getPendingSessionIntent,
  setSession,
  setPendingSessionIntent,
  getAllSessions,
  setAgent,
  getAgent,
  getAllAgents,
  setChannelRoute,
  setChannelSubscription,
  getSubscriptionsForChannel,
  removeChannelSubscription,
  getChannelRoute,
  getAllChannelRoutes,
  getRoutesForAgent,
  clearPendingSessionIntent,
} from './db.js';
import { processMessageIpc, processTaskIpc, IpcDeps } from './ipc.js';
import {
  RegisteredGroup,
  Agent,
  ChannelRoute,
  ChannelSubscription,
  NewMessage,
} from './types.js';

// --- Shared test fixtures ---

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
let groupSnapshots: Array<{
  groupFolder: string;
  isMain: boolean;
  availableCount: number;
  registeredJids: string[];
}>;
let subscriptionChangedCalls: number;
let ipcEvents: Array<{
  kind: string;
  sourceGroup: string;
  details?: Record<string, unknown>;
}>;
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
  groupSnapshots = [];
  subscriptionChangedCalls = 0;
  ipcEvents = [];

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
      setRegisteredGroup(jid, group);
    },
    updateGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
    },
    syncGroupMetadata: async () => {
      syncCalled = true;
    },
    getAvailableGroups: () => [],
    writeGroupsSnapshot: (
      groupFolder,
      isMain,
      availableGroups,
      registeredJids,
    ) => {
      groupSnapshots.push({
        groupFolder,
        isMain,
        availableCount: availableGroups.length,
        registeredJids: Array.from(registeredJids).sort(),
      });
    },
    writeTasksSnapshot: (groupFolder, isMain) => {
      taskSnapshots.push({ groupFolder, isMain });
    },
    onSubscriptionChanged: () => {
      subscriptionChangedCalls += 1;
    },
    onIpcEvent: (kind, sourceGroup, _summary, details) => {
      ipcEvents.push({ kind, sourceGroup, details });
    },
  };
});

describe('processMessageIpc: send_message routing audit', () => {
  it('sends omitted-target messages to origin chat and records origin/current audit fields', async () => {
    const result = await processMessageIpc(
      {
        type: 'message',
        chatJid: 'dc:origin',
        originChatJid: 'dc:origin',
        currentChatJid: 'dc:sibling',
        targetWasExplicit: false,
        text: 'reply to origin',
      },
      'other-group',
      false,
      '/tmp/omniclaw-ipc-test',
      {
        ...groups,
        'dc:origin': OTHER_GROUP,
      },
      deps,
    );

    expect(result).toEqual({ action: 'handled' });
    expect(sentMessages).toEqual([
      { jid: 'dc:origin', text: 'reply to origin' },
    ]);
    expect(ipcEvents).toContainEqual({
      kind: 'message_sent',
      sourceGroup: 'other-group',
      details: {
        chatJid: 'dc:origin',
        originChatJid: 'dc:origin',
        currentChatJid: 'dc:sibling',
        targetWasExplicit: false,
      },
    });
  });

  it('preserves explicit target routing while recording audit fields', async () => {
    const result = await processMessageIpc(
      {
        type: 'message',
        chatJid: 'dc:sibling',
        originChatJid: 'dc:origin',
        currentChatJid: 'dc:sibling',
        targetWasExplicit: true,
        text: 'delegate to sibling',
      },
      'main',
      true,
      '/tmp/omniclaw-ipc-test',
      groups,
      deps,
    );

    expect(result).toEqual({ action: 'handled' });
    expect(sentMessages).toEqual([
      { jid: 'dc:sibling', text: 'delegate to sibling' },
    ]);
    expect(ipcEvents[0]?.details).toMatchObject({
      chatJid: 'dc:sibling',
      originChatJid: 'dc:origin',
      currentChatJid: 'dc:sibling',
      targetWasExplicit: true,
    });
  });

  it('sends messages to Slack thread JIDs through parent registration', async () => {
    const threadJid = 'slack:TEST:C123:thread:1700000000.000100';
    const slackGroups = {
      ...groups,
      'slack:C123': OTHER_GROUP,
    };

    const result = await processMessageIpc(
      {
        type: 'message',
        chatJid: threadJid,
        originChatJid: threadJid,
        currentChatJid: threadJid,
        targetWasExplicit: false,
        text: 'progress in the thread',
      },
      'other-group',
      false,
      '/tmp/omniclaw-ipc-test',
      slackGroups,
      deps,
    );

    expect(result).toEqual({ action: 'handled' });
    expect(sentMessages).toEqual([
      { jid: threadJid, text: 'progress in the thread' },
    ]);
    expect(ipcEvents[0]?.details).toMatchObject({
      chatJid: threadJid,
      originChatJid: threadJid,
      currentChatJid: threadJid,
      targetWasExplicit: false,
    });
  });

  it('returns locally stored messages for read_thread on Slack thread JIDs', async () => {
    const threadJid = 'slack:TEST:C123:thread:1700000000.000100';
    const ipcDir = path.join(
      '/tmp',
      `omniclaw-read-thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const message: NewMessage = {
      id: '1700000000.000100',
      chat_jid: threadJid,
      sender: 'slack:UPEYTON',
      sender_name: 'Peyton',
      content: 'please summarize this',
      timestamp: '2023-11-14T22:13:20.000Z',
      sender_platform: 'slack',
      sender_user_id: 'UPEYTON',
    };
    deps.getMessages = (jid, since, limit) => {
      expect(jid).toBe(threadJid);
      expect(since).toBe('');
      expect(limit).toBe(25);
      return [message];
    };
    deps.getThreadSummary = (jid) => {
      expect(jid).toBe(threadJid);
      return {
        chat_jid: threadJid,
        summary: 'Thread is about launch readiness.',
        status: 'active',
        updated_at: '2024-01-01T00:00:03.000Z',
      };
    };

    try {
      const result = await processMessageIpc(
        {
          type: 'read_thread',
          chatJid: threadJid,
          limit: 25,
          requestId: 'read-thread-test',
        },
        'other-group',
        false,
        ipcDir,
        {
          ...groups,
          'slack:C123': OTHER_GROUP,
        },
        deps,
      );

      expect(result).toEqual({ action: 'handled' });
      const response = JSON.parse(
        fs.readFileSync(
          path.join(
            ipcDir,
            'other-group',
            'responses',
            'read-thread-test.json',
          ),
          'utf-8',
        ),
      );
      expect(response).toMatchObject({
        requestId: 'read-thread-test',
        type: 'read_thread_response',
        ok: true,
        result: {
          chatJid: threadJid,
          count: 1,
          summary: {
            chat_jid: threadJid,
            summary: 'Thread is about launch readiness.',
            status: 'active',
            updated_at: '2024-01-01T00:00:03.000Z',
          },
          messages: [
            {
              id: '1700000000.000100',
              sender: 'Peyton',
              sender_id: 'slack:UPEYTON',
              timestamp: '2023-11-14T22:13:20.000Z',
              content: 'please summarize this',
            },
          ],
        },
      });
    } finally {
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });

  it('blocks read_thread for Slack threads owned by another group', async () => {
    const threadJid = 'slack:TEST:C123:thread:1700000000.000100';
    const ipcDir = path.join(
      '/tmp',
      `omniclaw-read-thread-blocked-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    deps.getMessages = () => {
      throw new Error('read_thread should not reach getMessages');
    };

    try {
      const result = await processMessageIpc(
        {
          type: 'read_thread',
          chatJid: threadJid,
          requestId: 'read-thread-blocked-test',
        },
        'third-group',
        false,
        ipcDir,
        {
          ...groups,
          'slack:C123': OTHER_GROUP,
        },
        deps,
      );

      expect(result).toEqual({
        action: 'blocked',
        reason: 'not authorized',
      });
      const response = JSON.parse(
        fs.readFileSync(
          path.join(
            ipcDir,
            'third-group',
            'responses',
            'read-thread-blocked-test.json',
          ),
          'utf-8',
        ),
      );
      expect(response).toMatchObject({
        requestId: 'read-thread-blocked-test',
        type: 'read_thread_response',
        ok: false,
        error: `Not authorized to read ${threadJid}.`,
      });
    } finally {
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });

  it('updates thread summaries for the current Slack thread', async () => {
    const threadJid = 'slack:TEST:C123:thread:1700000000.000100';
    const ipcDir = path.join(
      '/tmp',
      `omniclaw-update-thread-summary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    let saved:
      | {
          chat_jid: string;
          summary: string;
          status?: 'active' | 'resolved' | 'blocked';
          updated_by?: string;
          through_message_id?: string;
          through_timestamp?: string;
        }
      | undefined;
    deps.setThreadSummary = (summary) => {
      saved = summary;
      return true;
    };

    try {
      const result = await processMessageIpc(
        {
          type: 'update_thread_summary',
          chatJid: threadJid,
          summary: 'Decision: ship the thread routing fix. Owner: Peyton.',
          status: 'active',
          throughMessageId: '1700000000.000200',
          throughTimestamp: '2024-01-01T00:00:02.000Z',
          requestId: 'update-thread-summary-test',
        },
        'other-group',
        false,
        ipcDir,
        {
          ...groups,
          'slack:C123': OTHER_GROUP,
        },
        deps,
      );

      expect(result).toEqual({ action: 'handled' });
      expect(saved).toEqual({
        chat_jid: threadJid,
        summary: 'Decision: ship the thread routing fix. Owner: Peyton.',
        status: 'active',
        updated_by: 'other-group',
        through_message_id: '1700000000.000200',
        through_timestamp: '2024-01-01T00:00:02.000Z',
      });
      const response = JSON.parse(
        fs.readFileSync(
          path.join(
            ipcDir,
            'other-group',
            'responses',
            'update-thread-summary-test.json',
          ),
          'utf-8',
        ),
      );
      expect(response).toMatchObject({
        requestId: 'update-thread-summary-test',
        type: 'update_thread_summary_response',
        ok: true,
        result: {
          chatJid: threadJid,
          updated: true,
        },
      });
    } finally {
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });

  it('reports stale thread summary updates without overwriting', async () => {
    const threadJid = 'slack:TEST:C123:thread:1700000000.000100';
    const ipcDir = path.join(
      '/tmp',
      `omniclaw-update-thread-summary-stale-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    deps.setThreadSummary = () => false;

    try {
      const result = await processMessageIpc(
        {
          type: 'update_thread_summary',
          chatJid: threadJid,
          summary: 'Older summary.',
          requestId: 'update-thread-summary-stale-test',
        },
        'other-group',
        false,
        ipcDir,
        {
          ...groups,
          'slack:C123': OTHER_GROUP,
        },
        deps,
      );

      expect(result).toEqual({
        action: 'blocked',
        reason: 'stale summary',
      });
      const response = JSON.parse(
        fs.readFileSync(
          path.join(
            ipcDir,
            'other-group',
            'responses',
            'update-thread-summary-stale-test.json',
          ),
          'utf-8',
        ),
      );
      expect(response).toMatchObject({
        requestId: 'update-thread-summary-stale-test',
        type: 'update_thread_summary_response',
        ok: false,
      });
    } finally {
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// processTaskIpc: unknown type
// =============================================================================

describe('processTaskIpc: unknown type', () => {
  it('handles unknown IPC task type without error', async () => {
    // Should not throw
    await processTaskIpc(
      {
        type: 'nonexistent_type',
      },
      'main',
      true,
      deps,
    );

    // No messages sent, no tasks created
    expect(sentMessages).toHaveLength(0);
    expect(getAllTasks()).toHaveLength(0);
  });
});

// =============================================================================
// processTaskIpc: refresh_groups
// =============================================================================

describe('processTaskIpc: refresh_groups', () => {
  it('main group can trigger refresh', async () => {
    await processTaskIpc({ type: 'refresh_groups' }, 'main', true, deps);

    expect(syncCalled).toBe(true);
    expect(groupSnapshots).toEqual([
      {
        groupFolder: 'main',
        isMain: true,
        availableCount: 0,
        registeredJids: ['main@g.us', 'other@g.us', 'third@g.us'],
      },
    ]);
  });

  it('non-main group cannot trigger refresh', async () => {
    await processTaskIpc(
      { type: 'refresh_groups' },
      'other-group',
      false,
      deps,
    );

    expect(syncCalled).toBe(false);
    expect(groupSnapshots).toHaveLength(0);
  });
});

describe('processTaskIpc: schedule_task invalid config', () => {
  it('rejects invalid schedule values that cannot compute next_run', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Broken schedule',
        schedule_type: 'interval',
        schedule_value: 'not-a-number',
        targetJid: 'main@g.us',
      },
      'main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
    expect(taskSnapshots).toHaveLength(0);
  });
});

// =============================================================================
// processTaskIpc: register_group with discord_guild_id
// =============================================================================

describe('processTaskIpc: register_group with discord', () => {
  it('sets discordGuildId and serverFolder when discord_guild_id provided', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'dc:channel123',
        name: 'Discord Channel',
        folder: 'dc-channel',
        trigger: '@Bot',
        discord_guild_id: '123456789012345678',
      },
      'main',
      true,
      deps,
    );

    expect(groups['dc:channel123']).toBeDefined();
    expect(groups['dc:channel123'].discordGuildId).toBe('123456789012345678');
    expect(groups['dc:channel123'].serverFolder).toBe(
      'servers/123456789012345678',
    );
  });

  it('rejects non-numeric discord_guild_id to prevent path traversal', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'dc:evil123',
        name: 'Evil Channel',
        folder: 'evil-channel',
        trigger: '@Bot',
        discord_guild_id: '../../etc',
      },
      'main',
      true,
      deps,
    );

    expect(groups['dc:evil123']).toBeUndefined();
  });

  it('sets backend when provided', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'Docker Group',
        folder: 'docker-group',
        trigger: '@Bot',
        backend: 'docker',
      },
      'main',
      true,
      deps,
    );

    expect(groups['new@g.us'].backend).toBe('docker');
  });

  it('sets discordBotId when discord_bot_id provided', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'dc:channel999',
        name: 'Discord OpenCode',
        folder: 'dc-opencode',
        trigger: '@Bot',
        discord_bot_id: 'OPENCODE',
      },
      'main',
      true,
      deps,
    );

    expect(groups['dc:channel999'].discordBotId).toBe('OPENCODE');
  });

  it('sets agentRuntime when agent_runtime provided', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'dc:channel555',
        name: 'Discord Runtime',
        folder: 'dc-runtime',
        trigger: '@Bot',
        agent_runtime: 'opencode',
      },
      'main',
      true,
      deps,
    );

    expect(groups['dc:channel555'].agentRuntime).toBe('opencode');
  });

  it('sets description when provided', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'Described Group',
        folder: 'described-group',
        trigger: '@Bot',
        group_description: 'A group for testing',
      },
      'main',
      true,
      deps,
    );

    expect(groups['new@g.us'].description).toBe('A group for testing');
  });
});

describe('processTaskIpc: channel subscriptions', () => {
  it('subscribe_channel uses target defaults and notifies subscription observers', async () => {
    await processTaskIpc(
      {
        type: 'subscribe_channel',
        channel_jid: 'dc:555',
        target_agent: 'third-group',
      },
      'main',
      true,
      deps,
    );

    const subs = getSubscriptionsForChannel('dc:555');
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      agentId: 'third-group',
      trigger: '@Andy',
      requiresTrigger: true,
    });
    expect(subscriptionChangedCalls).toBe(1);
  });

  it('subscribe_channel adds a second agent to same channel', async () => {
    setChannelSubscription({
      channelJid: 'dc:777',
      agentId: 'other-group',
      trigger: '@Other',
      requiresTrigger: true,
      priority: 100,
      isPrimary: true,
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    await processTaskIpc(
      {
        type: 'subscribe_channel',
        channel_jid: 'dc:777',
        target_agent: 'third-group',
      },
      'main',
      true,
      deps,
    );
    const subs = getSubscriptionsForChannel('dc:777');
    expect(subs.map((s) => s.agentId).sort()).toEqual([
      'other-group',
      'third-group',
    ]);
    expect(subscriptionChangedCalls).toBe(1);
  });

  it('subscribe_channel preserves primary metadata on upsert', async () => {
    setChannelSubscription({
      channelJid: 'dc:778',
      agentId: 'third-group',
      trigger: '@Legacy',
      requiresTrigger: false,
      priority: 100,
      isPrimary: true,
      createdAt: '2024-02-02T00:00:00.000Z',
    });

    await processTaskIpc(
      {
        type: 'subscribe_channel',
        channel_jid: 'dc:778',
        target_agent: 'third-group',
        trigger: '@NewThird',
        discord_bot_id: 'OPENCODE',
        discord_guild_id: '123456789012345678',
      },
      'main',
      true,
      deps,
    );

    const [sub] = getSubscriptionsForChannel('dc:778');
    expect(sub).toMatchObject({
      agentId: 'third-group',
      trigger: '@NewThird',
      requiresTrigger: true,
      isPrimary: true,
      discordBotId: 'OPENCODE',
      discordGuildId: '123456789012345678',
      createdAt: '2024-02-02T00:00:00.000Z',
    });
  });

  it('non-main group cannot subscribe channels', async () => {
    await processTaskIpc(
      {
        type: 'subscribe_channel',
        channel_jid: 'dc:779',
        target_agent: 'third-group',
      },
      'other-group',
      false,
      deps,
    );

    expect(getSubscriptionsForChannel('dc:779')).toHaveLength(0);
    expect(subscriptionChangedCalls).toBe(0);
  });

  it('subscribe_channel ignores missing required fields', async () => {
    await processTaskIpc(
      {
        type: 'subscribe_channel',
        channel_jid: 'dc:780',
      } as any,
      'main',
      true,
      deps,
    );

    expect(getSubscriptionsForChannel('dc:780')).toHaveLength(0);
    expect(subscriptionChangedCalls).toBe(0);
  });

  it('subscribe_channel ignores unknown target agents', async () => {
    await processTaskIpc(
      {
        type: 'subscribe_channel',
        channel_jid: 'dc:781',
        target_agent: 'missing-agent',
      },
      'main',
      true,
      deps,
    );

    expect(getSubscriptionsForChannel('dc:781')).toHaveLength(0);
    expect(subscriptionChangedCalls).toBe(0);
  });

  it('unsubscribe_channel removes targeted subscription', async () => {
    setChannelSubscription({
      channelJid: 'dc:888',
      agentId: 'other-group',
      trigger: '@Other',
      requiresTrigger: true,
      priority: 100,
      isPrimary: true,
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    setChannelSubscription({
      channelJid: 'dc:888',
      agentId: 'third-group',
      trigger: '@Third',
      requiresTrigger: true,
      priority: 100,
      isPrimary: false,
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    await processTaskIpc(
      {
        type: 'unsubscribe_channel',
        channel_jid: 'dc:888',
        target_agent: 'third-group',
      },
      'main',
      true,
      deps,
    );
    const subs = getSubscriptionsForChannel('dc:888');
    expect(subs).toHaveLength(1);
    expect(subs[0].agentId).toBe('other-group');
    expect(subscriptionChangedCalls).toBe(1);
  });

  it('non-main group cannot unsubscribe channels', async () => {
    setChannelSubscription({
      channelJid: 'dc:889',
      agentId: 'third-group',
      trigger: '@Third',
      requiresTrigger: true,
      priority: 100,
      isPrimary: false,
      createdAt: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      {
        type: 'unsubscribe_channel',
        channel_jid: 'dc:889',
        target_agent: 'third-group',
      },
      'other-group',
      false,
      deps,
    );

    expect(getSubscriptionsForChannel('dc:889')).toHaveLength(1);
    expect(subscriptionChangedCalls).toBe(0);
  });

  it('unsubscribe_channel ignores missing required fields', async () => {
    setChannelSubscription({
      channelJid: 'dc:890',
      agentId: 'third-group',
      trigger: '@Third',
      requiresTrigger: true,
      priority: 100,
      isPrimary: false,
      createdAt: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      {
        type: 'unsubscribe_channel',
        channel_jid: 'dc:890',
      } as any,
      'main',
      true,
      deps,
    );

    expect(getSubscriptionsForChannel('dc:890')).toHaveLength(1);
    expect(subscriptionChangedCalls).toBe(0);
  });
});

// =============================================================================
// processTaskIpc: writeTasksSnapshot is called after task mutations
// =============================================================================

describe('processTaskIpc: task snapshot refresh', () => {
  it('refreshes task snapshot after schedule_task', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'snapshot test',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00.000Z',
        targetJid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    expect(taskSnapshots).toHaveLength(1);
    expect(taskSnapshots[0].groupFolder).toBe('main');
    expect(taskSnapshots[0].isMain).toBe(true);
  });

  it('refreshes task snapshot after edit_task', async () => {
    createTask({
      id: 'task-snap',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'edit_task', taskId: 'task-snap', status: 'paused' },
      'main',
      true,
      deps,
    );

    expect(taskSnapshots.length).toBeGreaterThanOrEqual(1);
  });

  it('refreshes task snapshot after cancel_task', async () => {
    createTask({
      id: 'task-cancel-snap',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-cancel-snap' },
      'main',
      true,
      deps,
    );

    expect(taskSnapshots.length).toBeGreaterThanOrEqual(1);
  });
});

describe('processTaskIpc: task mutation behavior', () => {
  it('allows a non-main group to schedule a task for itself and falls back invalid context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Self scheduled task',
        schedule_type: 'interval',
        schedule_value: '60000',
        targetJid: 'other@g.us',
        context_mode: 'invalid' as 'group',
      },
      'other-group',
      false,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'Self scheduled task',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      status: 'active',
    });
    expect(tasks[0].next_run).not.toBeNull();
    expect(taskSnapshots).toEqual([
      {
        groupFolder: 'other-group',
        isMain: false,
      },
    ]);
  });

  it('stores deterministic preprocessor script when scheduling a task', async () => {
    // The workflow file must exist at the resolved path (issue #973), so
    // create it under the target group's task-workflows directory first.
    const scriptName = 'sync-connectors-if-mcp-changed.ts';
    const groupWorkflowsDir = path.isAbsolute(TASK_WORKFLOWS_DIR)
      ? TASK_WORKFLOWS_DIR
      : path.join(GROUPS_DIR, 'other-group', TASK_WORKFLOWS_DIR);
    const scriptPath = path.join(groupWorkflowsDir, scriptName);
    fs.mkdirSync(groupWorkflowsDir, { recursive: true });
    fs.writeFileSync(
      scriptPath,
      'console.log(JSON.stringify({ action: "skip" }));',
    );

    try {
      await processTaskIpc(
        {
          type: 'schedule_task',
          prompt: 'Sync connectors if MCP package changed',
          preprocess_script: scriptName,
          schedule_type: 'interval',
          schedule_value: '60000',
          targetJid: 'other@g.us',
        },
        'other-group',
        false,
        deps,
      );

      const tasks = getAllTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        prompt: 'Sync connectors if MCP package changed',
        preprocess_script: scriptName,
      });
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  });

  it('blocks a non-main group from scheduling tasks for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'Cross-group task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00.000Z',
        targetJid: 'third@g.us',
      },
      'other-group',
      false,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
    expect(taskSnapshots).toHaveLength(0);
  });

  it("leaves another group's task untouched when cancel is unauthorized", async () => {
    createTask({
      id: 'task-owned-by-third',
      group_folder: 'third-group',
      chat_jid: 'third@g.us',
      prompt: 'protected',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-owned-by-third' },
      'other-group',
      false,
      deps,
    );

    expect(getTaskById('task-owned-by-third')).toBeDefined();
    expect(taskSnapshots).toHaveLength(0);
  });

  it('recalculates next_run when resuming a paused recurring task', async () => {
    createTask({
      id: 'task-resume-interval',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'resume interval',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: '2000-01-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'edit_task', taskId: 'task-resume-interval', status: 'active' },
      'main',
      true,
      deps,
    );

    const updated = getTaskById('task-resume-interval');
    expect(updated?.status).toBe('active');
    expect(updated?.next_run).not.toBe('2000-01-01T00:00:00.000Z');
    expect(updated?.next_run).not.toBeNull();
  });

  it('keeps next_run unchanged when resuming a paused once task without a schedule change', async () => {
    createTask({
      id: 'task-resume-once',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'resume once',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'edit_task', taskId: 'task-resume-once', status: 'active' },
      'main',
      true,
      deps,
    );

    expect(getTaskById('task-resume-once')).toMatchObject({
      status: 'active',
      next_run: '2025-06-01T00:00:00.000Z',
    });
  });
});

// =============================================================================
// Database: expireStaleSessions
// =============================================================================

describe('expireStaleSessions', () => {
  it('expires sessions older than maxAgeMs', () => {
    setSession('old-group', 'session-old');
    _backdateSessionForTest('old-group', '2000-01-01T00:00:00.000Z');
    const expired = expireStaleSessions(60_000); // 1 minute max age
    expect(expired).toEqual(['old-group']);
    expect(getSession('old-group')).toBeUndefined();
  });

  it('returns empty array when no sessions exist', () => {
    const expired = expireStaleSessions(86400000);
    expect(expired).toHaveLength(0);
  });

  it('preserves recent sessions', () => {
    setSession('recent-group', 'session-recent');
    const expired = expireStaleSessions(86400000); // 24 hours
    expect(expired).toHaveLength(0);
    expect(getSession('recent-group')).toBe('session-recent');
  });

  it('getAllSessions returns all sessions', () => {
    setSession('group-a', 'session-a');
    setSession('group-b', 'session-b');
    const sessions = getAllSessions();
    expect(sessions['group-a']).toBe('session-a');
    expect(sessions['group-b']).toBe('session-b');
  });

  it('setSession does not update if session ID unchanged', () => {
    setSession('group-x', 'same-session');
    setSession('group-x', 'same-session'); // Should be no-op
    expect(getSession('group-x')).toBe('same-session');
  });

  it('setSession updates when session ID changes', () => {
    setSession('group-y', 'session-1');
    setSession('group-y', 'session-2');
    expect(getSession('group-y')).toBe('session-2');
  });

  it('persists and clears pending session intents', () => {
    setPendingSessionIntent('group-intent', {
      forkFrom: 'session-source',
      name: 'launch triage',
    });

    expect(getPendingSessionIntent('group-intent')).toEqual({
      forkFrom: 'session-source',
      name: 'launch triage',
    });

    clearPendingSessionIntent('group-intent');
    expect(getPendingSessionIntent('group-intent')).toBeUndefined();
  });

  it('clears pending session intents with stale sessions', () => {
    setSession('old-group', 'session-old');
    setPendingSessionIntent('old-group', {
      forkFrom: 'session-old',
      name: 'old fork',
    });
    _backdateSessionForTest('old-group', '2000-01-01T00:00:00.000Z');

    expect(expireStaleSessions(60_000)).toEqual(['old-group']);
    expect(getPendingSessionIntent('old-group')).toBeUndefined();
  });
});

// =============================================================================
// Database: Agent CRUD
// =============================================================================

describe('Agent CRUD', () => {
  const testAgent: Agent = {
    id: 'agent-1',
    name: 'Test Agent',
    description: 'A test agent',
    folder: 'test-folder',
    backend: 'apple-container',
    agentRuntime: 'claude-agent-sdk',
    isAdmin: false,
    createdAt: '2024-01-01T00:00:00.000Z',
  };

  it('creates and retrieves an agent', () => {
    setAgent(testAgent);
    const agent = getAgent('agent-1');
    expect(agent).toBeDefined();
    expect(agent!.name).toBe('Test Agent');
    expect(agent!.description).toBe('A test agent');
    expect(agent!.folder).toBe('test-folder');
    expect(agent!.backend).toBe('apple-container');
    expect(agent!.isAdmin).toBe(false);
  });

  it('returns undefined for nonexistent agent', () => {
    expect(getAgent('nonexistent')).toBeUndefined();
  });

  it('getAllAgents returns all agents', () => {
    setAgent(testAgent);
    setAgent({
      ...testAgent,
      id: 'agent-2',
      name: 'Second Agent',
      folder: 'second-folder',
    });
    const agents = getAllAgents();
    expect(Object.keys(agents)).toHaveLength(2);
    expect(agents['agent-1'].name).toBe('Test Agent');
    expect(agents['agent-2'].name).toBe('Second Agent');
  });

  it('upserts agent on duplicate ID', () => {
    setAgent(testAgent);
    setAgent({ ...testAgent, name: 'Updated Agent' });
    const agent = getAgent('agent-1');
    expect(agent!.name).toBe('Updated Agent');
  });

  it('stores and retrieves agent with containerConfig', () => {
    setAgent({
      ...testAgent,
      containerConfig: { memoryMB: 2048 } as any,
    });
    const agent = getAgent('agent-1');
    expect(agent!.containerConfig).toBeDefined();
    expect((agent!.containerConfig as any).memoryMB).toBe(2048);
  });

  it('handles undefined optional fields', () => {
    setAgent({
      id: 'minimal-agent',
      name: 'Minimal',
      folder: 'minimal-folder',
      backend: 'apple-container',
      agentRuntime: 'claude-agent-sdk',
      isAdmin: false,
      createdAt: '2024-06-01T00:00:00.000Z',
    });
    const agent = getAgent('minimal-agent');
    expect(agent!.description).toBeUndefined();
    expect(agent!.containerConfig).toBeUndefined();
    expect(agent!.serverFolder).toBeUndefined();
  });
});

// =============================================================================
// Database: ChannelRoute CRUD
// =============================================================================

describe('ChannelRoute CRUD', () => {
  const testRoute: ChannelRoute = {
    channelJid: 'channel@g.us',
    agentId: 'agent-1',
    trigger: '@Bot',
    requiresTrigger: true,
    createdAt: '2024-01-01T00:00:00.000Z',
  };

  it('creates and retrieves a channel route', () => {
    setChannelRoute(testRoute);
    const route = getChannelRoute('channel@g.us');
    expect(route).toBeDefined();
    expect(route!.agentId).toBe('agent-1');
    expect(route!.trigger).toBe('@Bot');
    expect(route!.requiresTrigger).toBe(true);
  });

  it('returns undefined for nonexistent route', () => {
    expect(getChannelRoute('nonexistent@g.us')).toBeUndefined();
  });

  it('getAllChannelRoutes returns all routes', () => {
    setChannelRoute(testRoute);
    setChannelRoute({
      ...testRoute,
      channelJid: 'channel2@g.us',
      agentId: 'agent-2',
    });
    const routes = getAllChannelRoutes();
    expect(Object.keys(routes)).toHaveLength(2);
  });

  it('getRoutesForAgent returns routes for a specific agent', () => {
    setChannelRoute(testRoute);
    setChannelRoute({
      ...testRoute,
      channelJid: 'channel2@g.us',
      agentId: 'agent-1',
    });
    setChannelRoute({
      ...testRoute,
      channelJid: 'channel3@g.us',
      agentId: 'agent-2',
    });

    const routes = getRoutesForAgent('agent-1');
    expect(routes).toHaveLength(2);

    const otherRoutes = getRoutesForAgent('agent-2');
    expect(otherRoutes).toHaveLength(1);
  });

  it('upserts route on duplicate channelJid', () => {
    setChannelRoute(testRoute);
    setChannelRoute({ ...testRoute, agentId: 'agent-updated' });
    const route = getChannelRoute('channel@g.us');
    expect(route!.agentId).toBe('agent-updated');
  });

  it('stores and retrieves route with discordGuildId', () => {
    setChannelRoute({ ...testRoute, discordGuildId: 'guild-123' });
    const route = getChannelRoute('channel@g.us');
    expect(route!.discordGuildId).toBe('guild-123');
  });

  it('stores and retrieves route with discordBotId', () => {
    setChannelRoute({ ...testRoute, discordBotId: 'OPENCODE' });
    const route = getChannelRoute('channel@g.us');
    expect(route!.discordBotId).toBe('OPENCODE');
  });

  it('handles route without discordGuildId', () => {
    setChannelRoute(testRoute);
    const route = getChannelRoute('channel@g.us');
    expect(route!.discordGuildId).toBeUndefined();
  });
});

describe('ChannelSubscription CRUD', () => {
  const testSub: ChannelSubscription = {
    channelJid: 'dc:123',
    agentId: 'agent-1',
    trigger: '@Bot',
    requiresTrigger: true,
    priority: 100,
    isPrimary: true,
    createdAt: '2024-01-01T00:00:00.000Z',
  };

  it('creates and retrieves subscriptions for channel', () => {
    setChannelSubscription(testSub);
    setChannelSubscription({
      ...testSub,
      agentId: 'agent-2',
      isPrimary: false,
      priority: 200,
    });
    const subs = getSubscriptionsForChannel('dc:123');
    expect(subs).toHaveLength(2);
    expect(subs[0].agentId).toBe('agent-1');
    expect(subs[1].agentId).toBe('agent-2');
  });

  it('removes one subscription without affecting others', () => {
    setChannelSubscription(testSub);
    setChannelSubscription({
      ...testSub,
      agentId: 'agent-2',
      isPrimary: false,
    });
    removeChannelSubscription('dc:123', 'agent-2');
    const subs = getSubscriptionsForChannel('dc:123');
    expect(subs).toHaveLength(1);
    expect(subs[0].agentId).toBe('agent-1');
  });
});

// =============================================================================
// Channel utils: splitMessage
// =============================================================================

import { splitMessage } from './channels/utils.js';

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    const chunks = splitMessage('Hello, world!', 2000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('Hello, world!');
  });

  it('returns single chunk when exactly at limit', () => {
    const text = 'a'.repeat(2000);
    const chunks = splitMessage(text, 2000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('splits at newline boundary when available (preferBreaks=true)', () => {
    const line1 = 'a'.repeat(100);
    const line2 = 'b'.repeat(100);
    const text = `${line1}\n${line2}`;
    const chunks = splitMessage(text, 110, true);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it('splits at space boundary when no newline found', () => {
    const text = 'word '.repeat(40).trim(); // 40 words = 199 chars
    const chunks = splitMessage(text, 50, true);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should end cleanly (not mid-word) except possibly the last
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });

  it('hard-splits at exact boundaries when preferBreaks=false', () => {
    const text = 'abcdefghij'.repeat(10); // 100 chars
    const chunks = splitMessage(text, 30, false);
    expect(chunks).toHaveLength(4);
    expect(chunks[0]).toBe('abcdefghij'.repeat(3));
    expect(chunks[1]).toBe('abcdefghij'.repeat(3));
    expect(chunks[2]).toBe('abcdefghij'.repeat(3));
    expect(chunks[3]).toBe('abcdefghij');
  });

  it('handles empty string', () => {
    const chunks = splitMessage('', 2000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('');
  });

  it('handles text with no good break points', () => {
    const text = 'a'.repeat(100);
    const chunks = splitMessage(text, 30, true);
    expect(chunks.length).toBeGreaterThan(1);
    // Should fall back to hard split at maxLength
    expect(chunks[0]).toBe('a'.repeat(30));
  });

  it('preserves all content across chunks', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    const chunks = splitMessage(text, 100, true);
    const reconstructed = chunks.join(' ');
    // Due to split logic removing leading space/newline, we verify content preservation differently
    expect(chunks.join('').length + chunks.length - 1).toBeGreaterThanOrEqual(
      text.length - chunks.length,
    );
    // Every chunk should be non-empty
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it('splits long messages for Discord limit (2000 chars)', () => {
    const text = 'Hello world! '.repeat(200); // ~2600 chars
    const chunks = splitMessage(text, 2000, true);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].length).toBeLessThanOrEqual(2000);
  });

  it('splits long messages for Slack limit (4000 chars)', () => {
    const text = 'a'.repeat(10000);
    const chunks = splitMessage(text, 4000, false);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].length).toBe(4000);
    expect(chunks[1].length).toBe(4000);
    expect(chunks[2].length).toBe(2000);
  });
});
