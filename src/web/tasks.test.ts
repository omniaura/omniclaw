import { describe, expect, it } from 'bun:test';

import type { Agent, ChannelSubscription, ScheduledTask } from '../types.js';
import { handleRequest } from './routes.js';
import {
  renderTaskTableRows,
  renderTasks,
  renderTasksContent,
} from './tasks.js';
import type { WebStateProvider } from './types.js';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
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
    prompt: 'Run <check> & sync the network state for this agent',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    next_run: null,
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    executing_since: null,
    ...overrides,
  };
}

function makeState(tasks: ScheduledTask[] = [makeTask()]): WebStateProvider {
  return {
    getAgents: () => ({ 'agent-1': makeAgent() }),
    getChannelSubscriptions: () => ({
      'dc:123': [
        {
          channelJid: 'dc:123',
          agentId: 'agent-1',
          trigger: '@Test',
          requiresTrigger: true,
          priority: 100,
          isPrimary: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ] as ChannelSubscription[],
    }),
    getTasks: () => tasks,
    getTaskById: (id) => tasks.find((task) => task.id === id),
    getMessages: () => [],
    getChats: () => [
      {
        jid: 'dc:123',
        name: 'general',
        last_message_time: '2026-03-01T12:00:00.000Z',
      },
    ],
    getQueueStats: () => ({
      activeContainers: 1,
      idleContainers: 0,
      maxActive: 8,
      maxIdle: 4,
    }),
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
    resolveChatImage: async () => null,
    resolveDiscordGuildImage: async () => null,
  };
}

describe('renderTaskTableRows', () => {
  it('renders escaped task details and action buttons', () => {
    const html = renderTaskTableRows([
      makeTask({
        prompt: 'Run <check> & sync the network state for this agent',
      }),
      makeTask({
        id: 'task-002',
        status: 'paused',
        context_mode: 'group',
      }),
    ]);

    expect(html).toContain('data-task-id="task-001"');
    expect(html).toContain('Run &lt;check&gt; &amp; sync the network state');
    expect(html).toContain('>Pause<');
    expect(html).toContain('>Resume<');
    expect(html).toContain('badge status-active');
    expect(html).toContain('badge status-paused');
  });

  it('formats interval schedule labels across millisecond, second, minute, and hour boundaries', () => {
    const html = renderTaskTableRows([
      makeTask({
        id: 'task-ms',
        schedule_type: 'interval',
        schedule_value: '999',
      }),
      makeTask({
        id: 'task-sec',
        schedule_type: 'interval',
        schedule_value: '15000',
      }),
      makeTask({
        id: 'task-min',
        schedule_type: 'interval',
        schedule_value: '120000',
      }),
      makeTask({
        id: 'task-hour',
        schedule_type: 'interval',
        schedule_value: '5400000',
      }),
      makeTask({
        id: 'task-invalid',
        schedule_type: 'interval',
        schedule_value: 'soon',
      }),
    ]);

    expect(html).toContain('<span class="sched-label">999ms</span>');
    expect(html).toContain('<span class="sched-label">15s</span>');
    expect(html).toContain('<span class="sched-label">2m</span>');
    expect(html).toContain('<span class="sched-label">1.5h</span>');
    expect(html).toContain('<span class="sched-label">soon</span>');
  });

  it('formats next and last run times relative to a deterministic current time', () => {
    const RealDate = Date;
    const fixedNow = new RealDate('2026-05-08T12:00:00.000Z');

    class FixedDate extends RealDate {
      constructor(value?: string | number | Date) {
        super(value ?? fixedNow.getTime());
      }

      static now() {
        return fixedNow.getTime();
      }
    }

    globalThis.Date = FixedDate as DateConstructor;
    try {
      const html = renderTaskTableRows([
        makeTask({
          id: 'task-relative',
          next_run: '2026-05-08T12:45:00.000Z',
          last_run: '2026-05-07T12:00:00.000Z',
          last_result: 'error',
        }),
      ]);

      expect(html).toContain('>in 45m</td>');
      expect(html).toContain('class="td-time run-error"');
      expect(html).toContain('>1d ago</td>');
    } finally {
      globalThis.Date = RealDate;
    }
  });
});

describe('renderTasksContent', () => {
  it('renders task stats, filters, and agent/channel options', () => {
    const html = renderTasksContent(
      makeState([
        makeTask(),
        makeTask({ id: 'task-002', status: 'paused' }),
        makeTask({ id: 'task-003', status: 'completed' }),
      ]),
    );

    expect(html).toContain('Task Manager');
    expect(html).toContain('3 total');
    expect(html).toContain('1 active');
    expect(html).toContain('1 paused');
    expect(html).toContain('1 completed');
    expect(html).toContain('data-filter="active"');
    expect(html).toContain('Test Agent');
    expect(html).toContain('general');
  });

  it('renders the empty state when no tasks exist', () => {
    const html = renderTasksContent(makeState([]));

    expect(html).toContain(
      'No scheduled tasks yet. Create one to get started.',
    );
  });
});

describe('renderTasksContent — schedule input groups', () => {
  it('renders interval input with number and unit selector', () => {
    const html = renderTasksContent(makeState());

    // Create modal interval inputs
    expect(html).toContain('id="tmc-interval-num"');
    expect(html).toContain('id="tmc-interval-unit"');
    expect(html).toContain('id="tmc-interval-group"');
    // Unit options
    expect(html).toContain('>seconds</option>');
    expect(html).toContain('>minutes</option>');
    expect(html).toContain('>hours</option>');
  });

  it('renders datetime-local input for one-shot tasks', () => {
    const html = renderTasksContent(makeState());

    // Create modal datetime picker
    expect(html).toContain('id="tmc-once-datetime"');
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain('id="tmc-once-group"');
  });

  it('renders separate cron, interval, and once input groups for both modals', () => {
    const html = renderTasksContent(makeState());

    // Create modal groups
    expect(html).toContain('id="tmc-cron-group"');
    expect(html).toContain('id="tmc-interval-group"');
    expect(html).toContain('id="tmc-once-group"');
    // Edit modal groups
    expect(html).toContain('id="tme-cron-group"');
    expect(html).toContain('id="tme-interval-group"');
    expect(html).toContain('id="tme-once-group"');
  });

  it('hides interval and once groups by default', () => {
    const html = renderTasksContent(makeState());

    // Interval and once groups should be hidden by default (cron is shown)
    expect(html).toContain('id="tmc-interval-group" style="display:none"');
    expect(html).toContain('id="tmc-once-group" style="display:none"');
    // Cron group should not have display:none
    expect(html).not.toContain('id="tmc-cron-group" style="display:none"');
  });

  it('renders schedule type dropdown without raw format hints', () => {
    const html = renderTasksContent(makeState());

    // Should use clean labels, not "Interval (ms)" or "Once (ISO timestamp)"
    expect(html).toContain('>Interval</option>');
    expect(html).toContain('>Once</option>');
    expect(html).not.toContain('Interval (ms)');
    expect(html).not.toContain('ISO timestamp');
  });
});

describe('renderTasks', () => {
  it('wraps the task manager in the shared shell', () => {
    const html = renderTasks(makeState());

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title id="page-title">OmniClaw — Tasks</title>');
    expect(html).toContain('class="nav-link active">Tasks</a>');
  });
});

describe('GET /tasks', () => {
  it('returns the task manager page HTML', async () => {
    const response = await handleRequest(
      new Request('http://localhost/tasks'),
      makeState(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    );
    expect(await response.text()).toContain('Task Manager');
  });
});
