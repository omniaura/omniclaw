import { describe, expect, it, afterEach } from 'bun:test';
import type { ChannelSubscription } from '../types.js';
import type { WebStateProvider, QueueStats } from './types.js';
import type { GroupQueueDetail } from '../group-queue.js';
import type { IpcEvent } from './ipc-events.js';
import { startWebServer, type WebServerHandle } from './server.js';
import { renderIpcInspector } from './ipc-inspector.js';

// ---- Helpers ----

function randomPort(): number {
  return 0;
}

const defaultStats: QueueStats = {
  activeContainers: 2,
  idleContainers: 1,
  maxActive: 5,
  maxIdle: 3,
};

const sampleQueueDetails: GroupQueueDetail[] = [
  {
    folderKey: 'agent-alpha',
    messageLane: {
      active: true,
      idle: false,
      pendingCount: 2,
      containerName: 'ctr-alpha-msg',
      reason: 'running',
    },
    taskLane: {
      active: true,
      pendingCount: 1,
      containerName: 'ctr-alpha-task',
      activeTask: {
        taskId: 'task-123',
        promptPreview: 'Do something important',
        startedAt: Date.now() - 30000,
        runningMs: 30000,
      },
      reason: 'running',
    },
    retryCount: 0,
  },
  {
    folderKey: 'agent-beta',
    messageLane: {
      active: true,
      idle: true,
      pendingCount: 0,
      containerName: 'ctr-beta-msg',
      reason: 'cooling-down',
    },
    taskLane: {
      active: false,
      pendingCount: 0,
      containerName: null,
      activeTask: null,
      reason: 'no-work',
    },
    retryCount: 2,
  },
];

const sampleEvents: IpcEvent[] = [
  {
    id: 2,
    kind: 'task_created',
    timestamp: '2026-03-06T12:00:01.000Z',
    sourceGroup: 'agent-alpha',
    summary: 'Task task-123 created for agent-beta',
    details: { taskId: 'task-123' },
  },
  {
    id: 1,
    kind: 'message_sent',
    timestamp: '2026-03-06T12:00:00.000Z',
    sourceGroup: 'agent-beta',
    summary: 'Message sent to dc:456',
  },
];

function makeState(
  overrides: Partial<WebStateProvider> = {},
): WebStateProvider {
  return {
    getAgents: () => ({}),
    getChannelSubscriptions: () => ({}),
    getTasks: () => [],
    getTaskById: () => undefined,
    getMessages: () => [],
    getChats: () => [],
    getQueueStats: () => defaultStats,
    getQueueDetails: () => sampleQueueDetails,
    getIpcEvents: () => sampleEvents,
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
    ...overrides,
  };
}

// ---- Tests ----

describe('renderIpcInspector', () => {
  it('renders HTML with queue details and events', () => {
    const html = renderIpcInspector(makeState());
    expect(html).toContain('IPC Inspector');
    expect(html).toContain('agent-alpha');
    expect(html).toContain('agent-beta');
    expect(html).toContain('task-123');
    expect(html).toContain('Message sent to dc:456');
  });

  it('shows correct stats', () => {
    const html = renderIpcInspector(makeState());
    // Processing = active - idle = 2 - 1 = 1
    expect(html).toContain('1/5');
    // Idle
    expect(html).toContain('1/3');
    // Groups tracked
    expect(html).toContain('>2<');
  });

  it('shows aggregate pending messages stat card', () => {
    // alpha has 2 pending msgs, beta has 0 → total 2
    const html = renderIpcInspector(makeState());
    expect(html).toContain('id="stat-pending-messages">2<');
  });

  it('shows aggregate pending tasks stat card', () => {
    // alpha has 1 pending task, beta has 0 → total 1
    const html = renderIpcInspector(makeState());
    expect(html).toContain('id="stat-pending-tasks">1<');
  });

  it('shows aggregate retrying stat card with retry depth', () => {
    // beta has retryCount=2 → 1 retrying group, 2 total retries
    const html = renderIpcInspector(makeState());
    expect(html).toContain('id="stat-retrying">1 (2)<');
  });

  it('shows zero retrying when no groups are retrying', () => {
    const html = renderIpcInspector(makeState({ getQueueDetails: () => [] }));
    expect(html).toContain('id="stat-retrying">0<');
  });

  it('shows empty state when no groups', () => {
    const html = renderIpcInspector(makeState({ getQueueDetails: () => [] }));
    expect(html).toContain('No groups currently tracked');
  });

  it('shows empty state when no events', () => {
    const html = renderIpcInspector(makeState({ getIpcEvents: () => [] }));
    expect(html).toContain('No IPC events recorded');
  });

  it('renders lane badges correctly', () => {
    const html = renderIpcInspector(makeState());
    // agent-alpha has active message lane
    expect(html).toContain('lane-active');
    // agent-beta has idle message lane
    expect(html).toContain('lane-idle');
  });

  it('shows retry count when > 0', () => {
    const html = renderIpcInspector(makeState());
    expect(html).toContain('retry-count');
  });

  it('renders structured reason codes alongside lane badges', () => {
    const html = renderIpcInspector(makeState());
    // agent-alpha has running message lane
    expect(html).toContain('reason-running');
    // agent-beta has cooling-down message lane and no-work task lane
    expect(html).toContain('reason-cooling-down');
    expect(html).toContain('reason-no-work');
    // Reason text appears
    expect(html).toContain('>running<');
    expect(html).toContain('>cooling-down<');
    expect(html).toContain('>no-work<');
  });

  it('renders back-pressure reason for queued work without container', () => {
    const detail: GroupQueueDetail = {
      folderKey: 'agent-gamma',
      messageLane: {
        active: false,
        idle: false,
        pendingCount: 3,
        containerName: null,
        reason: 'back-pressure',
      },
      taskLane: {
        active: false,
        pendingCount: 2,
        containerName: null,
        activeTask: null,
        reason: 'back-pressure',
      },
      retryCount: 0,
    };
    const html = renderIpcInspector(
      makeState({ getQueueDetails: () => [detail] }),
    );
    expect(html).toContain('reason-back-pressure');
  });

  it('renders retrying reason when retryCount > 0 and lane idle', () => {
    const detail: GroupQueueDetail = {
      folderKey: 'agent-delta',
      messageLane: {
        active: false,
        idle: false,
        pendingCount: 1,
        containerName: null,
        reason: 'retrying',
      },
      taskLane: {
        active: false,
        pendingCount: 0,
        containerName: null,
        activeTask: null,
        reason: 'no-work',
      },
      retryCount: 3,
    };
    const html = renderIpcInspector(
      makeState({ getQueueDetails: () => [detail] }),
    );
    expect(html).toContain('reason-retrying');
    expect(html).toContain('>retrying<');
  });

  it('renders a "last error" column header in the queue table', () => {
    const html = renderIpcInspector(makeState());
    expect(html).toContain('>last error<');
  });

  it('renders em-dash placeholder when no lastError is present', () => {
    const html = renderIpcInspector(makeState());
    // agent-alpha and agent-beta have no lastError; both rows should render
    // an em-dash placeholder inside the last-error cell.
    expect(html).toContain('<td class="last-error">\u2014</td>');
  });

  it('renders lastError message, age, and logs link when present', () => {
    const detail: GroupQueueDetail = {
      folderKey: 'agent-epsilon',
      messageLane: {
        active: false,
        idle: false,
        pendingCount: 1,
        containerName: null,
        reason: 'retrying',
        lastError: {
          message: 'connect ECONNREFUSED 127.0.0.1:5432',
          at: Date.now() - 2_500,
        },
      },
      taskLane: {
        active: false,
        pendingCount: 0,
        containerName: null,
        activeTask: null,
        reason: 'no-work',
      },
      retryCount: 1,
    };
    const html = renderIpcInspector(
      makeState({ getQueueDetails: () => [detail] }),
    );
    expect(html).toContain('class="last-error-link"');
    expect(html).toContain('href="/logs"');
    expect(html).toContain('connect ECONNREFUSED 127.0.0.1:5432');
    // Age should be rendered in seconds (~2.5s)
    expect(html).toMatch(/last-error-age">[0-9.]+s<\/span>/);
  });

  it('HTML-escapes lastError messages to prevent injection', () => {
    const detail: GroupQueueDetail = {
      folderKey: 'agent-xss',
      messageLane: {
        active: false,
        idle: false,
        pendingCount: 1,
        containerName: null,
        reason: 'retrying',
        lastError: {
          message: '<img src=x onerror=alert(1)>',
          at: Date.now(),
        },
      },
      taskLane: {
        active: false,
        pendingCount: 0,
        containerName: null,
        activeTask: null,
        reason: 'no-work',
      },
      retryCount: 1,
    };
    const html = renderIpcInspector(
      makeState({ getQueueDetails: () => [detail] }),
    );
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders task lane lastError message, age, and logs link when present', () => {
    const detail: GroupQueueDetail = {
      folderKey: 'agent-zeta',
      messageLane: {
        active: false,
        idle: false,
        pendingCount: 0,
        containerName: null,
        reason: 'no-work',
      },
      taskLane: {
        active: false,
        pendingCount: 0,
        containerName: null,
        activeTask: null,
        reason: 'no-work',
        lastError: {
          message: 'scheduled task crashed',
          at: Date.now() - 4_000,
        },
      },
      retryCount: 0,
    };
    const html = renderIpcInspector(
      makeState({ getQueueDetails: () => [detail] }),
    );
    expect(html).toContain('class="last-error-link"');
    expect(html).toContain('href="/logs"');
    expect(html).toContain('scheduled task crashed');
    expect(html).toMatch(/last-error-age">[0-9.]+s<\/span>/);
  });

  it('labels both lanes when message and task lanes both have errors', () => {
    const detail: GroupQueueDetail = {
      folderKey: 'agent-eta',
      messageLane: {
        active: false,
        idle: false,
        pendingCount: 1,
        containerName: null,
        reason: 'retrying',
        lastError: { message: 'message lane error', at: Date.now() },
      },
      taskLane: {
        active: false,
        pendingCount: 0,
        containerName: null,
        activeTask: null,
        reason: 'no-work',
        lastError: { message: 'task lane error', at: Date.now() },
      },
      retryCount: 1,
    };
    const html = renderIpcInspector(
      makeState({ getQueueDetails: () => [detail] }),
    );
    expect(html).toContain('message lane error');
    expect(html).toContain('task lane error');
    expect(html).toContain('<span class="last-error-lane">msg</span>');
    expect(html).toContain('<span class="last-error-lane">task</span>');
  });

  it('does not render a lane label when only one lane has an error', () => {
    const detail: GroupQueueDetail = {
      folderKey: 'agent-theta',
      messageLane: {
        active: false,
        idle: false,
        pendingCount: 0,
        containerName: null,
        reason: 'no-work',
      },
      taskLane: {
        active: false,
        pendingCount: 0,
        containerName: null,
        activeTask: null,
        reason: 'no-work',
        lastError: { message: 'only task failed', at: Date.now() },
      },
      retryCount: 0,
    };
    const html = renderIpcInspector(
      makeState({ getQueueDetails: () => [detail] }),
    );
    expect(html).toContain('only task failed');
    expect(html).not.toContain('<span class="last-error-lane">');
  });

  it('escapes HTML in group names', () => {
    const xssDetail: GroupQueueDetail = {
      folderKey: '<script>alert(1)</script>',
      messageLane: {
        active: false,
        idle: false,
        pendingCount: 0,
        containerName: null,
        reason: 'no-work',
      },
      taskLane: {
        active: false,
        pendingCount: 0,
        containerName: null,
        activeTask: null,
        reason: 'no-work',
      },
      retryCount: 0,
    };
    const html = renderIpcInspector(
      makeState({ getQueueDetails: () => [xssDetail] }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders message lane running age when runningMs is provided', () => {
    const detail: GroupQueueDetail = {
      folderKey: 'agent-epsilon',
      messageLane: {
        active: true,
        idle: false,
        pendingCount: 0,
        containerName: 'ctr-eps-msg',
        reason: 'running',
        startedAt: Date.now() - 45000,
        runningMs: 45000,
      },
      taskLane: {
        active: false,
        pendingCount: 0,
        containerName: null,
        activeTask: null,
        reason: 'no-work',
      },
      retryCount: 0,
    };
    const html = renderIpcInspector(
      makeState({ getQueueDetails: () => [detail] }),
    );
    expect(html).toContain('lane-age');
    // 45000 ms formats as 45.0s
    expect(html).toContain('45.0s');
  });

  it('omits message lane age when runningMs is null/undefined', () => {
    const detail: GroupQueueDetail = {
      folderKey: 'agent-zeta',
      messageLane: {
        active: false,
        idle: false,
        pendingCount: 0,
        containerName: null,
        reason: 'no-work',
        startedAt: null,
        runningMs: null,
      },
      taskLane: {
        active: false,
        pendingCount: 0,
        containerName: null,
        activeTask: null,
        reason: 'no-work',
      },
      retryCount: 0,
    };
    const html = renderIpcInspector(
      makeState({ getQueueDetails: () => [detail] }),
    );
    // The CSS rule for .lane-age is bundled in the shell, so only assert that
    // no element with class="lane-age" is emitted in the rendered markup.
    expect(html).not.toContain('class="lane-age"');
  });

  it('omits message lane age when runningMs is exactly 0', () => {
    // Aligns the visibility threshold with agents-page `shouldShowAge`: a freshly
    // transitioned row (runningMs === 0) should not render a `0ms` chip, since
    // the status badge already conveys that the lane is executing.
    const detail: GroupQueueDetail = {
      folderKey: 'agent-just-started',
      messageLane: {
        active: true,
        idle: false,
        pendingCount: 0,
        containerName: 'ctr-just-started',
        reason: 'running',
        startedAt: Date.now(),
        runningMs: 0,
      },
      taskLane: {
        active: false,
        pendingCount: 0,
        containerName: null,
        activeTask: null,
        reason: 'no-work',
      },
      retryCount: 0,
    };
    const html = renderIpcInspector(
      makeState({ getQueueDetails: () => [detail] }),
    );
    expect(html).not.toContain('class="lane-age"');
  });

  it('allowlists lane reason codes before rendering class names', () => {
    const xssDetail: GroupQueueDetail = {
      folderKey: 'agent-xss',
      messageLane: {
        active: false,
        idle: false,
        pendingCount: 0,
        containerName: null,
        reason: 'no-work"><script>alert(1)</script>' as never,
      },
      taskLane: {
        active: false,
        pendingCount: 0,
        containerName: null,
        activeTask: null,
        reason: 'no-work onmouseover=alert(1)' as never,
      },
      retryCount: 0,
    };
    const html = renderIpcInspector(
      makeState({ getQueueDetails: () => [xssDetail] }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('onmouseover=alert(1)');
    expect(html).toContain('reason-unknown');
    expect(html).toContain('>unknown<');
  });
});

describe('IPC Inspector API routes', () => {
  const testAuth = { username: 'admin', password: 'secret' };
  const authHeaders = {
    Authorization: `Basic ${btoa(`${testAuth.username}:${testAuth.password}`)}`,
  };
  let handle: WebServerHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = undefined;
    }
  });

  it('GET /api/ipc/queue returns queue details', async () => {
    handle = startWebServer(
      { port: randomPort(), auth: testAuth },
      makeState(),
    );
    const res = await fetch(`http://localhost:${handle.port}/api/ipc/queue`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as GroupQueueDetail[];
    expect(data).toHaveLength(2);
    expect(data[0].folderKey).toBe('agent-alpha');
    expect(data[1].folderKey).toBe('agent-beta');
    expect(data[0].taskLane.activeTask?.taskId).toBe('task-123');
  });

  it('GET /api/ipc/events returns recent events', async () => {
    handle = startWebServer(
      { port: randomPort(), auth: testAuth },
      makeState(),
    );
    const res = await fetch(`http://localhost:${handle.port}/api/ipc/events`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as IpcEvent[];
    expect(data).toHaveLength(2);
    expect(data[0].kind).toBe('task_created');
  });

  it('GET /api/ipc/events respects count param', async () => {
    handle = startWebServer(
      { port: randomPort(), auth: testAuth },
      makeState(),
    );
    const res = await fetch(
      `http://localhost:${handle.port}/api/ipc/events?count=1`,
      { headers: authHeaders },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /ipc returns HTML page', async () => {
    handle = startWebServer(
      { port: randomPort(), auth: testAuth },
      makeState(),
    );
    const res = await fetch(`http://localhost:${handle.port}/ipc`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('IPC Inspector');
    expect(html).toContain('agent-alpha');
  });

  it('nav links include IPC on dashboard', async () => {
    handle = startWebServer(
      { port: randomPort(), auth: testAuth },
      makeState(),
    );
    const res = await fetch(`http://localhost:${handle.port}/`, {
      headers: authHeaders,
    });
    const html = await res.text();
    expect(html).toContain('href="/ipc"');
  });

  it('nav links include IPC on conversations', async () => {
    handle = startWebServer(
      { port: randomPort(), auth: testAuth },
      makeState(),
    );
    const res = await fetch(`http://localhost:${handle.port}/conversations`, {
      headers: authHeaders,
    });
    const html = await res.text();
    expect(html).toContain('href="/ipc"');
  });
});
