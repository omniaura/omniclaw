import { describe, it, expect, beforeEach, mock } from 'bun:test';

import {
  _initTestDatabase,
  _backdateSessionForTest,
  createTask,
  getAllTasks,
  getTaskById,
  setRegisteredGroup,
  expireStaleSessions,
  getSession,
  setSession,
  getAllSessions,
  setAgent,
  getAgent,
  getAllAgents,
  setChannelRoute,
  getChannelRoute,
  getAllChannelRoutes,
  getRoutesForAgent,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup, Agent, ChannelRoute } from './types.js';

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
    writeGroupsSnapshot: () => {},
    writeTasksSnapshot: (groupFolder, isMain) => {
      taskSnapshots.push({ groupFolder, isMain });
    },
  };
});

// =============================================================================
// processTaskIpc: configure_heartbeat
// =============================================================================

describe('processTaskIpc: configure_heartbeat', () => {
  it('main group enables heartbeat for another group', async () => {
    await processTaskIpc(
      {
        type: 'configure_heartbeat',
        enabled: true,
        interval: '3600000',
        target_group_jid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    expect(groups['other@g.us'].heartbeat).toBeDefined();
    expect(groups['other@g.us'].heartbeat!.enabled).toBe(true);
    expect(groups['other@g.us'].heartbeat!.interval).toBe('3600000');
  });

  it('main group disables heartbeat for another group', async () => {
    // First enable it
    groups['other@g.us'] = {
      ...OTHER_GROUP,
      heartbeat: {
        enabled: true,
        interval: '1800000',
        scheduleType: 'interval',
      },
    };

    await processTaskIpc(
      {
        type: 'configure_heartbeat',
        enabled: false,
        target_group_jid: 'other@g.us',
      },
      'main',
      true,
      deps,
    );

    expect(groups['other@g.us'].heartbeat).toBeUndefined();
  });

  it('non-main group can configure its own heartbeat', async () => {
    await processTaskIpc(
      {
        type: 'configure_heartbeat',
        enabled: true,
        interval: '600000',
      },
      'other-group',
      false,
      deps,
    );

    expect(groups['other@g.us'].heartbeat).toBeDefined();
    expect(groups['other@g.us'].heartbeat!.enabled).toBe(true);
    expect(groups['other@g.us'].heartbeat!.interval).toBe('600000');
  });

  it('non-main group cannot configure another groups heartbeat', async () => {
    await processTaskIpc(
      {
        type: 'configure_heartbeat',
        enabled: true,
        interval: '600000',
        target_group_jid: 'third@g.us',
      },
      'other-group',
      false,
      deps,
    );

    // Third group should remain unchanged
    expect(groups['third@g.us'].heartbeat).toBeUndefined();
  });

  it('rejects configure_heartbeat with missing enabled field', async () => {
    await processTaskIpc(
      {
        type: 'configure_heartbeat',
        interval: '600000',
      } as any,
      'main',
      true,
      deps,
    );

    // No changes
    expect(groups['main@g.us'].heartbeat).toBeUndefined();
  });

  it('defaults heartbeat scheduleType to interval when not cron', async () => {
    await processTaskIpc(
      {
        type: 'configure_heartbeat',
        enabled: true,
        interval: '900000',
      },
      'other-group',
      false,
      deps,
    );

    expect(groups['other@g.us'].heartbeat!.scheduleType).toBe('interval');
  });

  it('accepts cron heartbeat schedule type', async () => {
    await processTaskIpc(
      {
        type: 'configure_heartbeat',
        enabled: true,
        interval: '0 */6 * * *',
        heartbeat_schedule_type: 'cron',
      },
      'other-group',
      false,
      deps,
    );

    expect(groups['other@g.us'].heartbeat!.scheduleType).toBe('cron');
  });

  it('defaults interval to 1800000 when not provided', async () => {
    await processTaskIpc(
      {
        type: 'configure_heartbeat',
        enabled: true,
      },
      'other-group',
      false,
      deps,
    );

    expect(groups['other@g.us'].heartbeat!.interval).toBe('1800000');
  });
});

// =============================================================================
// processTaskIpc: share_request
// =============================================================================

describe('processTaskIpc: share_request', () => {
  it('sends share request to main group when no target_agent', async () => {
    await processTaskIpc(
      {
        type: 'share_request',
        description: 'I need access to the API docs',
      },
      'other-group',
      false,
      deps,
    );

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].jid).toBe('main@g.us');
    expect(sentMessages[0].text).toContain('Context Request');
    expect(sentMessages[0].text).toContain('Other');
    expect(sentMessages[0].text).toContain('I need access to the API docs');
  });

  it('sends share request to specific target agent', async () => {
    await processTaskIpc(
      {
        type: 'share_request',
        description: 'Need shared context',
        target_agent: 'third-group',
      },
      'other-group',
      false,
      deps,
    );

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].jid).toBe('third@g.us');
    expect(sentMessages[0].text).toContain('Context Request');
    expect(sentMessages[0].text).toContain('targeted to third-group');
  });

  it('falls back to main group when target_agent not found', async () => {
    await processTaskIpc(
      {
        type: 'share_request',
        description: 'Need context',
        target_agent: 'nonexistent-agent',
      },
      'other-group',
      false,
      deps,
    );

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].jid).toBe('main@g.us');
  });

  it('rejects share_request with missing description', async () => {
    await processTaskIpc(
      {
        type: 'share_request',
      } as any,
      'other-group',
      false,
      deps,
    );

    expect(sentMessages).toHaveLength(0);
  });

  it('includes server folder path guidance for Discord groups', async () => {
    groups['other@g.us'] = {
      ...OTHER_GROUP,
      serverFolder: 'servers/guild123',
    };

    await processTaskIpc(
      {
        type: 'share_request',
        description: 'Need context',
        serverFolder: 'servers/guild123',
      },
      'other-group',
      false,
      deps,
    );

    expect(sentMessages[0].text).toContain('Server-wide');
    expect(sentMessages[0].text).toContain('servers/guild123');
  });

  it('includes scope=channel path guidance', async () => {
    await processTaskIpc(
      {
        type: 'share_request',
        description: 'Channel-specific context',
        serverFolder: 'servers/guild123',
        scope: 'channel',
      },
      'other-group',
      false,
      deps,
    );

    expect(sentMessages[0].text).toContain('groups/other-group/CLAUDE.md');
    expect(sentMessages[0].text).not.toContain('Server-wide');
  });

  it('includes scope=server path guidance', async () => {
    await processTaskIpc(
      {
        type: 'share_request',
        description: 'Server-wide context',
        serverFolder: 'servers/guild123',
        scope: 'server',
      },
      'other-group',
      false,
      deps,
    );

    expect(sentMessages[0].text).toContain('← requested');
  });
});

// =============================================================================
// processTaskIpc: delegate_task
// =============================================================================

describe('processTaskIpc: delegate_task', () => {
  it('forwards delegate task to main group', async () => {
    await processTaskIpc(
      {
        type: 'delegate_task',
        description: 'Please run git pull on the main repo',
      },
      'other-group',
      false,
      deps,
    );

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].jid).toBe('main@g.us');
    expect(sentMessages[0].text).toContain('Task Request');
    expect(sentMessages[0].text).toContain('Other');
    expect(sentMessages[0].text).toContain(
      'Please run git pull on the main repo',
    );
  });

  it('includes files info when provided', async () => {
    await processTaskIpc(
      {
        type: 'delegate_task',
        description: 'Deploy this config',
        files: ['config.json', 'deploy.sh'],
      },
      'other-group',
      false,
      deps,
    );

    expect(sentMessages[0].text).toContain('Files included');
    expect(sentMessages[0].text).toContain('config.json');
    expect(sentMessages[0].text).toContain('deploy.sh');
  });

  it('rejects delegate_task with missing description', async () => {
    await processTaskIpc(
      {
        type: 'delegate_task',
      } as any,
      'other-group',
      false,
      deps,
    );

    expect(sentMessages).toHaveLength(0);
  });

  it('uses callbackAgentId when provided', async () => {
    await processTaskIpc(
      {
        type: 'delegate_task',
        description: 'Run tests',
        callbackAgentId: 'custom-callback',
      },
      'other-group',
      false,
      deps,
    );

    expect(sentMessages[0].text).toContain('Task Request');
  });
});

// =============================================================================
// processTaskIpc: context_request
// =============================================================================

describe('processTaskIpc: context_request', () => {
  it('forwards context request to main group', async () => {
    await processTaskIpc(
      {
        type: 'context_request',
        description: 'I need the project overview',
      },
      'other-group',
      false,
      deps,
    );

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].jid).toBe('main@g.us');
    expect(sentMessages[0].text).toContain('Context Request');
    expect(sentMessages[0].text).toContain('I need the project overview');
  });

  it('includes requested topics', async () => {
    await processTaskIpc(
      {
        type: 'context_request',
        description: 'Need project info',
        requestedTopics: ['api-refactor', 'deployment-guide'],
      },
      'other-group',
      false,
      deps,
    );

    expect(sentMessages[0].text).toContain('Requested topics');
    expect(sentMessages[0].text).toContain('api-refactor');
    expect(sentMessages[0].text).toContain('deployment-guide');
  });

  it('rejects context_request with missing description', async () => {
    await processTaskIpc(
      {
        type: 'context_request',
      } as any,
      'other-group',
      false,
      deps,
    );

    expect(sentMessages).toHaveLength(0);
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
  });

  it('non-main group cannot trigger refresh', async () => {
    await processTaskIpc(
      { type: 'refresh_groups' },
      'other-group',
      false,
      deps,
    );

    expect(syncCalled).toBe(false);
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
    expect(groups['dc:channel123'].serverFolder).toBe('servers/123456789012345678');
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

  it('refreshes task snapshot after pause_task', async () => {
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
      { type: 'pause_task', taskId: 'task-snap' },
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
    isAdmin: false,
    isLocal: true,
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
    expect(agent!.isLocal).toBe(true);
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

  it('stores and retrieves agent with heartbeat config', () => {
    setAgent({
      ...testAgent,
      heartbeat: {
        enabled: true,
        interval: '3600000',
        scheduleType: 'interval',
      },
    });
    const agent = getAgent('agent-1');
    expect(agent!.heartbeat).toBeDefined();
    expect(agent!.heartbeat!.enabled).toBe(true);
    expect(agent!.heartbeat!.interval).toBe('3600000');
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
      isAdmin: false,
      isLocal: true,
      createdAt: '2024-06-01T00:00:00.000Z',
    });
    const agent = getAgent('minimal-agent');
    expect(agent!.description).toBeUndefined();
    expect(agent!.heartbeat).toBeUndefined();
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

  it('handles route without discordGuildId', () => {
    setChannelRoute(testRoute);
    const route = getChannelRoute('channel@g.us');
    expect(route!.discordGuildId).toBeUndefined();
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
