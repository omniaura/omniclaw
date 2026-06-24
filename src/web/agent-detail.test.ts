import { describe, it, expect, afterEach } from 'bun:test';

import { startWebServer, type WebServerHandle } from './server.js';
import type { WebStateProvider, QueueStats } from './types.js';
import type { Agent, ChannelSubscription, ScheduledTask } from '../types.js';
import type { RemotePeerAgents } from '../discovery/types.js';
import {
  buildAgentDetailData,
  formatScheduledTasksCount,
  formatTaskLastRun,
  lastRunOutcomeClass,
  renderAgentDetailContent,
} from './agent-detail.js';

// ---- Test fixtures ----

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    folder: 'test-agent',
    backend: 'apple-container',
    agentRuntime: 'claude-agent-sdk',
    isAdmin: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-001',
    group_folder: 'test-agent',
    chat_jid: 'dc:123',
    prompt: 'Run the daily check',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    next_run: '2026-03-02T09:00:00.000Z',
    last_run: null,
    last_result: null,
    executing_since: null,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const defaultStats: QueueStats = {
  activeContainers: 2,
  idleContainers: 1,
  maxActive: 8,
  maxIdle: 4,
};

const testChats = [
  {
    jid: 'dc:123',
    name: 'general',
    last_message_time: '2026-03-01T12:01:00.000Z',
  },
  {
    jid: 'dc:456',
    name: 'dev-chat',
    last_message_time: '2026-03-01T12:02:00.000Z',
  },
];

const remotePeers: RemotePeerAgents[] = [
  {
    instanceId: 'peer-1',
    instanceName: 'orangepi5',
    online: true,
    host: '10.0.0.12',
    port: 7777,
    agents: [
      {
        id: 'remote:agent',
        name: 'Remote Agent',
        folder: 'agents/remote',
        backend: 'docker',
        agentRuntime: 'opencode',
        avatarUrl: 'https://example.test/remote.png',
        channels: [
          {
            jid: 'dc:999',
            displayName: 'Remote Channel',
            channelFolder: 'servers/remote/spec',
            categoryFolder: 'servers/remote',
          },
        ],
      },
    ],
  },
];

function makeState(
  overrides: Partial<WebStateProvider> = {},
): WebStateProvider {
  return {
    getAgents: () => ({
      'test-agent': makeAgent(),
    }),
    getChannelSubscriptions: () => ({
      'dc:123': [
        {
          channelJid: 'dc:123',
          agentId: 'test-agent',
          trigger: '@Test',
          requiresTrigger: true,
          priority: 100,
          isPrimary: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ] as ChannelSubscription[],
    }),
    getTasks: () => [makeTask()],
    getTaskById: (id) => (id === 'task-001' ? makeTask() : undefined),
    getMessages: () => [],
    getChats: () => testChats,
    getQueueStats: () => defaultStats,
    getQueueDetails: () => [],
    getIpcEvents: () => [],
    getTaskRunLogs: () => [],
    getTaskRunPhaseEvents: () => [],
    searchMessages: () => [],
    createTask: () => {},
    updateTask: () => {},
    deleteTask: () => {},
    calculateNextRun: () => '2026-03-03T09:00:00.000Z',
    readContextFile: () => null,
    writeContextFile: () => {},
    updateAgentAvatar: () => {},
    setAgentEnabled: () => true,
    setAgentModel: () => true,
    resolveChatImage: async () => null,
    resolveDiscordGuildImage: async () => null,
    ...overrides,
  };
}

// ---- Unit tests for buildAgentDetailData ----

describe('buildAgentDetailData', () => {
  it('returns null for unknown agent', () => {
    const state = makeState();
    expect(buildAgentDetailData('nonexistent', state)).toBeNull();
  });

  it('returns agent data for valid ID', () => {
    const state = makeState();
    const data = buildAgentDetailData('test-agent', state);
    expect(data).not.toBeNull();
    expect(data!.id).toBe('test-agent');
    expect(data!.name).toBe('Test Agent');
    expect(data!.backend).toBe('apple-container');
    expect(data!.agentRuntime).toBe('claude-agent-sdk');
    expect(data!.isAdmin).toBe(false);
  });

  it('includes subscribed channels', () => {
    const state = makeState();
    const data = buildAgentDetailData('test-agent', state);
    expect(data!.channels).toHaveLength(1);
    expect(data!.channels[0].jid).toBe('dc:123');
    expect(data!.channels[0].displayName).toBe('general');
  });

  it('includes tasks matching agent folder', () => {
    const state = makeState();
    const data = buildAgentDetailData('test-agent', state);
    expect(data!.tasks).toHaveLength(1);
    expect(data!.tasks[0].id).toBe('task-001');
    expect(data!.tasks[0].prompt).toBe('Run the daily check');
  });

  it('excludes tasks for other agents', () => {
    const state = makeState({
      getTasks: () => [
        makeTask(),
        makeTask({ id: 'task-002', group_folder: 'other-agent' }),
      ],
    });
    const data = buildAgentDetailData('test-agent', state);
    expect(data!.tasks).toHaveLength(1);
    expect(data!.tasks[0].id).toBe('task-001');
  });

  it('includes recent chats for subscribed channels', () => {
    const state = makeState();
    const data = buildAgentDetailData('test-agent', state);
    // Agent is subscribed to dc:123 (general), not dc:456 (dev-chat)
    expect(data!.recentChats).toHaveLength(1);
    expect(data!.recentChats[0].jid).toBe('dc:123');
    expect(data!.recentChats[0].name).toBe('general');
  });

  it('includes admin agent details', () => {
    const state = makeState({
      getAgents: () => ({
        'test-agent': makeAgent({
          isAdmin: true,
          description: 'Main admin bot',
          serverFolder: 'servers/test-server',
          agentContextFolder: 'agents/test',
        }),
      }),
    });
    const data = buildAgentDetailData('test-agent', state);
    expect(data!.isAdmin).toBe(true);
    expect(data!.description).toBe('Main admin bot');
    expect(data!.serverFolder).toBe('servers/test-server');
    expect(data!.agentContextFolder).toBe('agents/test');
  });

  it('returns remote agent data when the ID matches a trusted peer agent', () => {
    const data = buildAgentDetailData(
      'peer-1:remote:agent',
      makeState(),
      remotePeers,
    );
    expect(data).not.toBeNull();
    expect(data!.id).toBe('peer-1:remote:agent');
    expect(data!.name).toBe('Remote Agent');
    expect(data!.remoteInstanceId).toBe('peer-1');
    expect(data!.remoteInstanceName).toBe('orangepi5');
    expect(data!.channels).toHaveLength(1);
    expect(data!.tasks).toHaveLength(0);
  });
});

// ---- Unit tests for formatTaskLastRun ----

describe('formatTaskLastRun', () => {
  const NOW = Date.parse('2026-06-12T12:00:00.000Z');

  it('returns em-dash when last_run is null', () => {
    expect(formatTaskLastRun(null, NOW)).toBe('—');
  });

  it('returns "<1m ago" for sub-minute deltas', () => {
    expect(formatTaskLastRun(new Date(NOW - 30_000).toISOString(), NOW)).toBe(
      '<1m ago',
    );
  });

  it('formats minutes for sub-hour deltas', () => {
    expect(
      formatTaskLastRun(new Date(NOW - 15 * 60_000).toISOString(), NOW),
    ).toBe('15m ago');
  });

  it('formats hours for sub-day deltas', () => {
    expect(
      formatTaskLastRun(new Date(NOW - 4 * 3_600_000).toISOString(), NOW),
    ).toBe('4h ago');
  });

  it('formats days for older deltas', () => {
    expect(
      formatTaskLastRun(new Date(NOW - 3 * 86_400_000).toISOString(), NOW),
    ).toBe('3d ago');
  });

  it('returns input verbatim for unparseable input', () => {
    expect(formatTaskLastRun('not-a-date', NOW)).toBe('not-a-date');
  });
});

describe('formatScheduledTasksCount', () => {
  it('returns bare total when no task is paused', () => {
    expect(
      formatScheduledTasksCount([
        { status: 'active' },
        { status: 'active' },
        { status: 'completed' },
      ]),
    ).toBe('3');
  });

  it('appends paused rollup when at least one task is paused', () => {
    expect(
      formatScheduledTasksCount([
        { status: 'active' },
        { status: 'paused' },
        { status: 'paused' },
      ]),
    ).toBe('3 (2 paused)');
  });

  it('returns "0" for an empty task list without a parenthetical', () => {
    expect(formatScheduledTasksCount([])).toBe('0');
  });
});

describe('lastRunOutcomeClass', () => {
  it('maps the done outcome state to run-success regardless of last_result', () => {
    // Schedulers write summary strings like "Completed" / "Run 1 done" /
    // a result excerpt into last_result. The colored badge needs to follow the
    // normalized outcome state instead, otherwise those rows render uncolored
    // even though the run clearly succeeded (#858).
    expect(lastRunOutcomeClass('done', 'Completed')).toBe('run-success');
    expect(lastRunOutcomeClass('done', 'Run 1 done')).toBe('run-success');
    expect(lastRunOutcomeClass('done')).toBe('run-success');
  });

  it('maps the blocked outcome state to run-error', () => {
    expect(lastRunOutcomeClass('blocked', 'Error: connection refused')).toBe(
      'run-error',
    );
    expect(lastRunOutcomeClass('blocked')).toBe('run-error');
  });

  it('maps the abandoned outcome state to run-error', () => {
    expect(lastRunOutcomeClass('abandoned', 'Error: Execution timed out')).toBe(
      'run-error',
    );
  });

  it('returns an empty class for the skipped outcome state', () => {
    // Skipped runs are intentional no-ops — neither success nor failure — so
    // the row should render neutral. The outcome-state badge already conveys
    // "skipped" on its own.
    expect(lastRunOutcomeClass('skipped', 'Skipped by preprocessor: foo')).toBe(
      '',
    );
  });

  it('falls back to the legacy last_result token when no outcome state is set', () => {
    expect(lastRunOutcomeClass(null, 'success')).toBe('run-success');
    expect(lastRunOutcomeClass(null, 'error')).toBe('run-error');
    expect(lastRunOutcomeClass(undefined, 'success')).toBe('run-success');
  });

  it('returns an empty class when both inputs are missing or unrecognized', () => {
    expect(lastRunOutcomeClass(null, null)).toBe('');
    expect(lastRunOutcomeClass(null)).toBe('');
    expect(lastRunOutcomeClass(null, 'Completed')).toBe('');
    expect(lastRunOutcomeClass(null, 'weird')).toBe('');
  });
});

// ---- Unit tests for renderAgentDetailContent ----

describe('renderAgentDetailContent', () => {
  it('renders not-found when data is null', () => {
    const html = renderAgentDetailContent(null, 'missing-id');
    expect(html).toContain('Agent not found');
    expect(html).toContain('missing-id');
    expect(html).toContain('Back to Dashboard');
  });

  it('renders agent name and badges', () => {
    const data = buildAgentDetailData('test-agent', makeState())!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('Test Agent');
    expect(html).toContain('apple-container');
    expect(html).toContain('claude-agent-sdk');
  });

  it('renders admin badge when agent is admin', () => {
    const state = makeState({
      getAgents: () => ({
        'test-agent': makeAgent({ isAdmin: true }),
      }),
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('badge-admin');
    expect(html).toContain('admin');
  });

  it('renders channels table', () => {
    const data = buildAgentDetailData('test-agent', makeState())!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('general');
    expect(html).toContain('dc:123');
    expect(html).toContain('messages');
  });

  it('renders tasks table with status badges', () => {
    const data = buildAgentDetailData('test-agent', makeState())!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('Run the daily check');
    expect(html).toContain('status-active');
    expect(html).toContain('cron');
  });

  it('annotates the scheduled tasks count with a paused rollup when a task is paused', () => {
    const state = makeState({
      getTasks: () => [
        makeTask({ id: 'task-001', status: 'active' }),
        makeTask({ id: 'task-002', status: 'paused' }),
      ],
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain(
      'scheduled tasks <span class="ad-count">2 (1 paused)</span>',
    );
  });

  it('omits the paused rollup when no task is paused', () => {
    const data = buildAgentDetailData('test-agent', makeState())!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('scheduled tasks <span class="ad-count">1</span>');
    expect(html).not.toContain('paused)');
  });

  it('renders last-run column with em-dash when task has never run', () => {
    const data = buildAgentDetailData('test-agent', makeState())!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('<th>last run</th>');
    expect(html).toContain('title="never run"');
  });

  it('renders last-run column with relative time and success class', () => {
    const state = makeState({
      getTasks: () => [
        makeTask({
          last_run: new Date(Date.now() - 5 * 60_000).toISOString(),
          last_result: 'success',
        }),
      ],
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('run-success');
    expect(html).toContain('5m ago');
  });

  it('renders last-run column with error class for failed runs', () => {
    const state = makeState({
      getTasks: () => [
        makeTask({
          last_run: new Date(Date.now() - 2 * 3_600_000).toISOString(),
          last_result: 'error',
        }),
      ],
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('run-error');
    expect(html).toContain('2h ago');
  });

  it('colors a scheduler "Completed" summary row green via last_outcome_state', () => {
    // The scheduler writes a free-text summary into last_result
    // (`'Completed'` for one-shots, `result.slice(0, 200)` for streamed
    // results, `'Error: ...'` for failures — see updateTaskAfterRun in
    // task-scheduler.ts) and the normalized state into last_outcome_state.
    // Before #858 the row coloring keyed off last_result === 'success', so
    // these real-world rows rendered neutral. The badge should now be
    // green via last_outcome_state alone.
    const state = makeState({
      getTasks: () => [
        makeTask({
          last_run: new Date(Date.now() - 5 * 60_000).toISOString(),
          last_result: 'Completed',
          last_outcome_state: 'done',
          last_outcome_reason: undefined,
        }),
      ],
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('run-success');
    expect(html).not.toContain('run-error');
  });

  it('colors a scheduler "Error: ..." summary row red via last_outcome_state', () => {
    const state = makeState({
      getTasks: () => [
        makeTask({
          last_run: new Date(Date.now() - 2 * 3_600_000).toISOString(),
          last_result: 'Error: container failed to start',
          last_outcome_state: 'blocked',
          last_outcome_reason: 'container failed to start',
        }),
      ],
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('run-error');
    expect(html).not.toContain('run-success');
  });

  it('leaves a skipped row neutral so only the outcome badge conveys the state', () => {
    const state = makeState({
      getTasks: () => [
        makeTask({
          last_run: new Date(Date.now() - 10 * 60_000).toISOString(),
          last_result: 'Skipped by preprocessor: nothing to do',
          last_outcome_state: 'skipped',
          last_outcome_reason: 'nothing to do',
        }),
      ],
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).not.toContain('run-success');
    expect(html).not.toContain('run-error');
  });

  it('uses correct colspan for empty-tasks row when local agent', () => {
    const state = makeState({ getTasks: () => [] });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('colspan="6"');
    expect(html).toContain('No scheduled tasks');
  });

  it('uses correct colspan for empty-tasks row when remote agent', () => {
    const data = buildAgentDetailData(
      'peer-1:remote:agent',
      makeState(),
      remotePeers,
    )!;
    const html = renderAgentDetailContent(data, 'peer-1:remote:agent');
    expect(html).toContain('colspan="5"');
  });

  it('renders recent conversations', () => {
    const data = buildAgentDetailData('test-agent', makeState())!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('conversations');
    expect(html).toContain('general');
  });

  it('renders info grid with agent metadata', () => {
    const data = buildAgentDetailData('test-agent', makeState())!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('test-agent'); // id
    expect(html).toContain('ad-info-grid');
    expect(html).toContain('folder');
  });

  it('renders description when present', () => {
    const state = makeState({
      getAgents: () => ({
        'test-agent': makeAgent({ description: 'A helpful assistant' }),
      }),
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('A helpful assistant');
  });

  it('truncates long prompts in task table display text', () => {
    const longPrompt = 'x'.repeat(100);
    const state = makeState({
      getTasks: () => [makeTask({ prompt: longPrompt })],
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    // Displayed text truncated to 80 chars + ellipsis, full prompt in title attr
    expect(html).toContain('\u2026');
    // The td content should be truncated (80 x's + ellipsis)
    expect(html).toContain('>' + 'x'.repeat(80) + '\u2026<');
  });

  it('shows empty state for channels when none subscribed', () => {
    const state = makeState({
      getChannelSubscriptions: () => ({}),
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('No channels subscribed');
  });

  it('shows empty state for tasks when none exist', () => {
    const state = makeState({
      getTasks: () => [],
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('No scheduled tasks');
  });

  it('shows empty state for conversations when none exist', () => {
    const state = makeState({
      getChannelSubscriptions: () => ({}),
      getChats: () => [],
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('No conversations');
  });

  it('includes back-to-dashboard link', () => {
    const data = buildAgentDetailData('test-agent', makeState())!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('dashboard');
    expect(html).toContain('data-nav');
    expect(html).toContain('data-page="dashboard"');
  });

  it('includes data-agent-folder attribute for live status polling', () => {
    const data = buildAgentDetailData('test-agent', makeState())!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('data-agent-folder="test-agent"');
  });

  it('includes execution status badge placeholder', () => {
    const data = buildAgentDetailData('test-agent', makeState())!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('id="ad-exec-status"');
    expect(html).toContain('exec-offline');
  });

  it('derives executing status and omits reason when actively running', () => {
    const state = makeState({
      getQueueDetails: () => [
        {
          folderKey: 'test-agent',
          messageLane: {
            active: true,
            idle: false,
            pendingCount: 0,
            containerName: 'test-agent-msg',
            reason: 'running',
          },
          taskLane: {
            active: false,
            pendingCount: 0,
            containerName: null,
            activeTask: null,
            reason: 'no-work',
          },
          retryCount: 0,
        },
      ],
    });
    const data = buildAgentDetailData('test-agent', state)!;
    expect(data.execStatus).toBe('executing');
    expect(data.execReason).toBe('running');
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('exec-executing');
    expect(html).toContain('data-exec-status="executing"');
    // Reason badge is suppressed for active states (label already conveys it).
    expect(html).not.toContain('lane-reason');
  });

  it('surfaces structured reason for idle agent (cooling-down)', () => {
    const state = makeState({
      getQueueDetails: () => [
        {
          folderKey: 'test-agent',
          messageLane: {
            active: false,
            idle: true,
            pendingCount: 0,
            containerName: 'test-agent-msg',
            reason: 'cooling-down',
          },
          taskLane: {
            active: false,
            pendingCount: 0,
            containerName: null,
            activeTask: null,
            reason: 'no-work',
          },
          retryCount: 0,
        },
      ],
    });
    const data = buildAgentDetailData('test-agent', state)!;
    expect(data.execStatus).toBe('idle');
    expect(data.execReason).toBe('cooling-down');
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('exec-idle');
    expect(html).toContain('reason-cooling-down');
    expect(html).toContain('data-exec-reason="cooling-down"');
  });

  it('surfaces back-pressure reason for queued agent with pending work', () => {
    const state = makeState({
      getQueueDetails: () => [
        {
          folderKey: 'test-agent',
          messageLane: {
            active: false,
            idle: false,
            pendingCount: 3,
            containerName: null,
            reason: 'back-pressure',
          },
          taskLane: {
            active: false,
            pendingCount: 0,
            containerName: null,
            activeTask: null,
            reason: 'no-work',
          },
          retryCount: 0,
        },
      ],
    });
    const data = buildAgentDetailData('test-agent', state)!;
    expect(data.execStatus).toBe('queued');
    expect(data.execReason).toBe('back-pressure');
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('exec-queued');
    expect(html).toContain('reason-back-pressure');
  });

  it('renders disabled badge when agent is explicitly disabled', () => {
    const state = makeState({
      getAgents: () => ({
        'test-agent': makeAgent({ enabled: false }),
      }),
      // Even with active queue state, disabled override wins.
      getQueueDetails: () => [
        {
          folderKey: 'test-agent',
          messageLane: {
            active: true,
            idle: false,
            pendingCount: 0,
            containerName: 'test-agent-msg',
            reason: 'running',
          },
          taskLane: {
            active: false,
            pendingCount: 0,
            containerName: null,
            activeTask: null,
            reason: 'no-work',
          },
          retryCount: 0,
        },
      ],
    });
    const data = buildAgentDetailData('test-agent', state)!;
    expect(data.execStatus).toBe('disabled');
    expect(data.execReason).toBeNull();
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('exec-disabled');
    expect(html).not.toContain('lane-reason');
  });

  it('falls back to offline with no reason for remote agents', () => {
    const data = buildAgentDetailData(
      'peer-1:remote:agent',
      makeState(),
      remotePeers,
    )!;
    expect(data.execStatus).toBe('offline');
    expect(data.execReason).toBeNull();
    const html = renderAgentDetailContent(data, 'peer-1:remote:agent');
    expect(html).toContain('exec-offline');
    expect(html).not.toContain('lane-reason');
  });

  it('renders task toggle buttons for local agents', () => {
    const data = buildAgentDetailData('test-agent', makeState())!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('data-task-toggle');
    expect(html).toContain('data-task-id="task-001"');
    expect(html).toContain('pause');
  });

  it('renders resume button for paused tasks', () => {
    const state = makeState({
      getTasks: () => [makeTask({ status: 'paused' })],
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('data-task-toggle="active"');
    expect(html).toContain('resume');
  });

  it('omits task toggle buttons for remote agents', () => {
    const data = buildAgentDetailData(
      'peer-1:remote:agent',
      makeState(),
      remotePeers,
    )!;
    const html = renderAgentDetailContent(data, 'peer-1:remote:agent');
    expect(html).not.toContain('data-task-toggle');
  });

  it('omits task toggle buttons for completed tasks', () => {
    const state = makeState({
      getTasks: () => [makeTask({ status: 'completed' })],
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).not.toContain('data-task-toggle');
  });

  it('renders avatar when URL is present', () => {
    const state = makeState({
      getAgents: () => ({
        'test-agent': makeAgent({
          avatarUrl: 'https://example.com/avatar.png',
        }),
      }),
    });
    const data = buildAgentDetailData('test-agent', state)!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('ad-avatar');
    expect(html).toContain('/api/agents/test-agent/avatar/image');
  });

  it('renders placeholder when no avatar URL', () => {
    const data = buildAgentDetailData('test-agent', makeState())!;
    const html = renderAgentDetailContent(data, 'test-agent');
    expect(html).toContain('ad-avatar-placeholder');
    expect(html).toContain('T'); // First letter of "Test Agent"
  });

  it('renders remote avatar and peer badge for remote agents', () => {
    const data = buildAgentDetailData(
      'peer-1:remote:agent',
      makeState(),
      remotePeers,
    )!;
    const html = renderAgentDetailContent(data, 'peer-1:remote:agent');
    expect(html).toContain('badge-remote');
    expect(html).toContain('orangepi5');
    expect(html).toContain(
      '/api/discovery/peers/peer-1/agents/remote%3Aagent/avatar/image',
    );
  });
});

// ---- Integration tests: HTTP routes ----

const testAuth = { username: 'admin', password: 'secret' };
const authHeader = `Basic ${btoa(`${testAuth.username}:${testAuth.password}`)}`;

let handle: WebServerHandle | null = null;

afterEach(async () => {
  if (handle) {
    await handle.stop();
    handle = null;
  }
});

function url(path: string): string {
  return `http://localhost:${handle!.port}${path}`;
}

function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has('Authorization')) headers.set('Authorization', authHeader);
  return fetch(url(path), { ...init, headers });
}

function testConfig(
  overrides: Partial<import('./types.js').WebServerConfig> = {},
) {
  return { port: 0, auth: testAuth, ...overrides };
}

describe('/agents page route', () => {
  it('serves agent detail HTML at /agents?id=test-agent', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/agents?id=test-agent');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('OmniClaw');
    expect(html).toContain('Test Agent');
  });

  it('shows not-found for unknown agent', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/agents?id=nonexistent');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Agent not found');
    expect(html).toContain('nonexistent');
  });

  it('shows not-found when no id param', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/agents');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Agent not found');
  });
});

interface JsonObject {
  [key: string]: unknown;
}

describe('/api/agents/:id/detail endpoint', () => {
  it('returns enriched agent data as JSON', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/api/agents/test-agent/detail');
    expect(res.status).toBe(200);
    const data = (await res.json()) as JsonObject;
    expect(data.id).toBe('test-agent');
    expect(data.name).toBe('Test Agent');
    expect(data.channels).toHaveLength(1);
    expect(data.tasks).toHaveLength(1);
    expect(data.recentChats).toHaveLength(1);
  });

  it('includes last_run and last_result on each task in JSON response', async () => {
    handle = startWebServer(
      testConfig(),
      makeState({
        getTasks: () => [
          makeTask({
            last_run: '2026-06-12T11:00:00.000Z',
            last_result: 'success',
          }),
        ],
      }),
    );
    const res = await authedFetch('/api/agents/test-agent/detail');
    const data = (await res.json()) as JsonObject;
    const tasks = data.tasks as Array<JsonObject>;
    expect(tasks[0].last_run).toBe('2026-06-12T11:00:00.000Z');
    expect(tasks[0].last_result).toBe('success');
  });

  it('returns 404 for unknown agent', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/api/agents/nonexistent/detail');
    expect(res.status).toBe(404);
    const data = (await res.json()) as JsonObject;
    expect(data.error).toBe('Agent not found');
  });

  it('requires authentication', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await fetch(url('/api/agents/test-agent/detail'));
    expect(res.status).toBe(401);
  });
});

describe('/api/page/agent-detail SPA navigation', () => {
  it('returns a Datastar patch response for known agents', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/api/page/agent-detail?id=test-agent');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Test Agent');
    expect(body).toContain(
      '<title id="page-title">OmniClaw — Test Agent</title>',
    );
  });

  it('returns not-found patch content for unknown agents', async () => {
    handle = startWebServer(testConfig(), makeState());
    const res = await authedFetch('/api/page/agent-detail?id=bad');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Agent not found');
    expect(body).toContain(
      '<title id="page-title">OmniClaw — Agent Not Found</title>',
    );
  });
});
