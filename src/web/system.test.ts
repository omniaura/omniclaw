import { describe, expect, it } from 'bun:test';

import { handleRequest } from './routes.js';
import { buildHealthData, renderSystemContent } from './system.js';
import type { HealthData } from './system.js';
import type { WebStateProvider } from './types.js';
import type { Agent } from '../types.js';
import type { GroupQueueDetail } from '../group-queue.js';

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

function makeState(
  agents: Agent[] = [makeAgent()],
  queueDetails: GroupQueueDetail[] = [],
): WebStateProvider {
  const agentMap: Record<string, Agent> = {};
  for (const a of agents) agentMap[a.id] = a;
  return {
    getAgents: () => agentMap,
    getChannelSubscriptions: () => ({}),
    getTasks: () => [
      {
        id: 't1',
        group_folder: 'g1',
        chat_jid: 'j1',
        prompt: 'test',
        schedule_type: 'cron' as const,
        schedule_value: '0 * * * *',
        context_mode: 'isolated' as const,
        next_run: null,
        last_run: null,
        last_result: null,
        status: 'active' as const,
        created_at: '2026-01-01T00:00:00.000Z',
        executing_since: null,
      },
      {
        id: 't2',
        group_folder: 'g1',
        chat_jid: 'j1',
        prompt: 'paused task',
        schedule_type: 'interval' as const,
        schedule_value: '60000',
        context_mode: 'isolated' as const,
        next_run: null,
        last_run: null,
        last_result: null,
        status: 'paused' as const,
        created_at: '2026-01-01T00:00:00.000Z',
        executing_since: null,
      },
      {
        id: 't3',
        group_folder: 'g1',
        chat_jid: 'j1',
        prompt: 'done',
        schedule_type: 'once' as const,
        schedule_value: '2026-01-01T00:00:00',
        context_mode: 'group' as const,
        next_run: null,
        last_run: '2026-01-01T00:00:00.000Z',
        last_result: 'ok',
        status: 'completed' as const,
        created_at: '2026-01-01T00:00:00.000Z',
        executing_since: null,
      },
    ],
    getTaskById: () => undefined,
    getMessages: () => [],
    getChats: () => [],
    getQueueStats: () => ({
      activeContainers: 3,
      idleContainers: 1,
      maxActive: 8,
      maxIdle: 4,
    }),
    getQueueDetails: () => queueDetails,
    getIpcEvents: () => [],
    getTaskRunLogs: () => [],
    getTaskRunPhaseEvents: () => [],
    searchMessages: () => [],
    createTask: () => {},
    updateTask: () => {},
    deleteTask: () => {},
    calculateNextRun: () => null,
    readContextFile: () => null,
    writeContextFile: () => {},
    updateAgentAvatar: () => {},
  };
}

describe('buildHealthData', () => {
  it('returns correct structure with status healthy', () => {
    const health = buildHealthData(makeState(), 5);
    expect(health.status).toBe('healthy');
    expect(health.sse_clients).toBe(5);
    expect(typeof health.uptime_seconds).toBe('number');
    expect(health.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  it('counts agents by backend and runtime', () => {
    const agents = [
      makeAgent({
        id: 'a1',
        backend: 'apple-container',
        agentRuntime: 'claude-agent-sdk',
      }),
      makeAgent({ id: 'a2', backend: 'docker', agentRuntime: 'opencode' }),
      makeAgent({
        id: 'a3',
        backend: 'apple-container',
        agentRuntime: 'claude-agent-sdk',
      }),
    ];
    const health = buildHealthData(makeState(agents), 0);
    expect(health.agents.total).toBe(3);
    expect(health.agents.by_backend).toEqual({
      'apple-container': 2,
      docker: 1,
    });
    expect(health.agents.by_runtime).toEqual({
      'claude-agent-sdk': 2,
      opencode: 1,
    });
  });

  it('counts tasks by status', () => {
    const health = buildHealthData(makeState(), 0);
    expect(health.tasks.active).toBe(1);
    expect(health.tasks.paused).toBe(1);
    expect(health.tasks.completed).toBe(1);
    expect(health.tasks.total).toBe(3);
  });

  it('reports container stats correctly', () => {
    const health = buildHealthData(makeState(), 0);
    expect(health.containers.active).toBe(2); // 3 active - 1 idle
    expect(health.containers.idle).toBe(1);
    expect(health.containers.max_active).toBe(8);
    expect(health.containers.max_idle).toBe(4);
  });

  it('reports memory in MB', () => {
    const health = buildHealthData(makeState(), 0);
    expect(health.memory.rss_mb).toBeGreaterThan(0);
    expect(health.memory.heap_used_mb).toBeGreaterThan(0);
    expect(health.memory.heap_total_mb).toBeGreaterThan(0);
  });

  it('reports cpu count and load averages', () => {
    const health = buildHealthData(makeState(), 0);
    expect(health.cpu.count).toBeGreaterThan(0);
    expect(typeof health.cpu.load_1m).toBe('number');
    expect(typeof health.cpu.load_5m).toBe('number');
    expect(typeof health.cpu.load_15m).toBe('number');
    expect(health.cpu.load_1m).toBeGreaterThanOrEqual(0);
    expect(health.cpu.load_5m).toBeGreaterThanOrEqual(0);
    expect(health.cpu.load_15m).toBeGreaterThanOrEqual(0);
  });

  it('reports host memory totals, free, used, and percentage', () => {
    const health = buildHealthData(makeState(), 0);
    expect(health.host_memory.total_mb).toBeGreaterThan(0);
    expect(health.host_memory.free_mb).toBeGreaterThanOrEqual(0);
    expect(health.host_memory.used_mb).toBeGreaterThanOrEqual(0);
    expect(health.host_memory.used_mb).toBeLessThanOrEqual(
      health.host_memory.total_mb,
    );
    expect(health.host_memory.used_pct).toBeGreaterThanOrEqual(0);
    expect(health.host_memory.used_pct).toBeLessThanOrEqual(100);
    // used + free should approximately equal total (within rounding)
    const sum = health.host_memory.used_mb + health.host_memory.free_mb;
    expect(Math.abs(sum - health.host_memory.total_mb)).toBeLessThan(1);
  });

  it('reports runtime info', () => {
    const health = buildHealthData(makeState(), 0);
    expect(health.runtime.platform).toBe(process.platform);
    expect(health.runtime.arch).toBe(process.arch);
    expect(typeof health.runtime.bun).toBe('string');
  });

  it('includes started_at timestamp', () => {
    const health = buildHealthData(makeState(), 0);
    expect(health.started_at).toBeTruthy();
    // Should be a valid ISO string
    expect(new Date(health.started_at).toISOString()).toBe(health.started_at);
  });

  it('handles zero agents', () => {
    const health = buildHealthData(makeState([]), 0);
    expect(health.agents.total).toBe(0);
    expect(health.agents.by_backend).toEqual({});
    expect(health.agents.by_runtime).toEqual({});
  });

  it('reports zero queue rollup when no groups are tracked', () => {
    const health = buildHealthData(makeState(), 0);
    expect(health.queue.groups).toBe(0);
    expect(health.queue.pending_messages).toBe(0);
    expect(health.queue.pending_tasks).toBe(0);
    expect(health.queue.processing_groups).toBe(0);
    expect(health.queue.running_tasks).toBe(0);
    expect(health.queue.retrying_groups).toBe(0);
  });

  it('aggregates queue rollup across all tracked groups', () => {
    const details: GroupQueueDetail[] = [
      {
        folderKey: 'g1',
        messageLane: {
          active: true,
          idle: false,
          pendingCount: 3,
          containerName: 'g1-msg',
        },
        taskLane: {
          active: true,
          pendingCount: 2,
          containerName: 'g1-task',
          activeTask: {
            taskId: 't-running',
            promptPreview: 'do work',
            startedAt: Date.now() - 5_000,
            runningMs: 5_000,
          },
        },
        retryCount: 0,
      },
      {
        folderKey: 'g2',
        messageLane: {
          active: false,
          idle: true,
          pendingCount: 1,
          containerName: null,
        },
        taskLane: {
          active: false,
          pendingCount: 4,
          containerName: null,
          activeTask: null,
        },
        retryCount: 2,
      },
      {
        folderKey: 'g3',
        messageLane: {
          active: true,
          idle: false,
          pendingCount: 0,
          containerName: 'g3-msg',
        },
        taskLane: {
          active: false,
          pendingCount: 0,
          containerName: null,
          activeTask: null,
        },
        retryCount: 1,
      },
    ];
    const health = buildHealthData(makeState([makeAgent()], details), 0);
    expect(health.queue.groups).toBe(3);
    expect(health.queue.pending_messages).toBe(4); // 3 + 1 + 0
    expect(health.queue.pending_tasks).toBe(6); // 2 + 4 + 0
    expect(health.queue.processing_groups).toBe(2); // g1, g3
    expect(health.queue.running_tasks).toBe(1); // only g1 has activeTask
    expect(health.queue.retrying_groups).toBe(2); // g2, g3
  });
});

describe('GET /api/health route', () => {
  it('returns 200 with health data', async () => {
    const res = await handleRequest(
      new Request('http://localhost/api/health'),
      makeState(),
      3,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const data = (await res.json()) as HealthData;
    expect(data.status).toBe('healthy');
    expect(data.sse_clients).toBe(3);
    expect(data.agents.total).toBe(1);
    expect(data.tasks.total).toBe(3);
  });

  it('defaults sseClientCount to 0 when not provided', async () => {
    const res = await handleRequest(
      new Request('http://localhost/api/health'),
      makeState(),
    );
    const data = (await res.json()) as HealthData;
    expect(data.sse_clients).toBe(0);
  });
});

describe('GET /system page', () => {
  it('returns HTML with system health content', async () => {
    const res = await handleRequest(
      new Request('http://localhost/system'),
      makeState(),
      2,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('system health');
    expect(html).toContain('OmniClaw');
    expect(html).toContain('sys-uptime');
    expect(html).toContain('sys-rss');
  });
});

describe('renderSystemContent', () => {
  it('renders metric cards for all sections', () => {
    const html = renderSystemContent(makeState(), 0);
    expect(html).toContain('system health');
    expect(html).toContain('server');
    expect(html).toContain('runtime');
    expect(html).toContain('memory');
    expect(html).toContain('cpu');
    expect(html).toContain('containers');
    expect(html).toContain('agents');
    expect(html).toContain('tasks');
    expect(html).toContain('queue');
  });

  it('renders queue rollup with stable IDs', () => {
    const details: GroupQueueDetail[] = [
      {
        folderKey: 'g1',
        messageLane: {
          active: true,
          idle: false,
          pendingCount: 7,
          containerName: 'g1-msg',
        },
        taskLane: {
          active: true,
          pendingCount: 3,
          containerName: 'g1-task',
          activeTask: {
            taskId: 't1',
            promptPreview: 'preview',
            startedAt: Date.now(),
            runningMs: 100,
          },
        },
        retryCount: 4,
      },
    ];
    const html = renderSystemContent(makeState([makeAgent()], details), 0);
    expect(html).toContain('id="sys-queue-groups"');
    expect(html).toContain('id="sys-queue-processing"');
    expect(html).toContain('id="sys-queue-running-tasks"');
    expect(html).toContain('id="sys-queue-pending-messages"');
    expect(html).toContain('id="sys-queue-pending-tasks"');
    expect(html).toContain('id="sys-queue-retrying"');
    // pending message count should appear (7)
    expect(html).toContain(
      '<span class="metric-value" id="sys-queue-pending-messages">7</span>',
    );
  });

  it('renders breakdown lists for agent backends', () => {
    const agents = [
      makeAgent({ id: 'a1', backend: 'apple-container' }),
      makeAgent({ id: 'a2', backend: 'docker' }),
    ];
    const html = renderSystemContent(makeState(agents), 0);
    expect(html).toContain('apple-container');
    expect(html).toContain('docker');
  });

  it('includes stable IDs for live updates', () => {
    const html = renderSystemContent(makeState(), 0);
    expect(html).toContain('id="sys-uptime"');
    expect(html).toContain('id="sys-rss"');
    expect(html).toContain('id="sys-heap-used"');
    expect(html).toContain('id="sys-sse"');
    expect(html).toContain('id="sys-agents-total"');
    expect(html).toContain('id="sys-containers-active"');
    expect(html).toContain('id="sys-tasks-active"');
    expect(html).toContain('id="health-status"');
    expect(html).toContain('id="sys-cpu-count"');
    expect(html).toContain('id="sys-cpu-load-1m"');
    expect(html).toContain('id="sys-cpu-load-5m"');
    expect(html).toContain('id="sys-cpu-load-15m"');
    expect(html).toContain('id="sys-host-mem-total"');
    expect(html).toContain('id="sys-host-mem-used"');
    expect(html).toContain('id="sys-host-mem-free"');
  });

  it('renders host memory metric card', () => {
    const html = renderSystemContent(makeState(), 0);
    expect(html).toContain('host memory');
  });

  it('escapes HTML in values', () => {
    const html = renderSystemContent(
      makeState([
        makeAgent({
          id: 'agent<script>&"',
          name: 'Agent <unsafe> & "quoted"',
          backend: 'docker<&>' as Agent['backend'],
          agentRuntime: 'opencode"<&' as Agent['agentRuntime'],
        }),
      ]),
      0,
    );

    expect(html).not.toContain('<script');
    expect(html).toContain('docker&lt;&amp;&gt;');
    expect(html).toContain('opencode&quot;&lt;&amp;');
  });
});
