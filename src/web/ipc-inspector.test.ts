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
    },
    taskLane: {
      active: false,
      pendingCount: 0,
      containerName: null,
      activeTask: null,
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
    searchMessages: () => [],
    createTask: () => {},
    updateTask: () => {},
    deleteTask: () => {},
    calculateNextRun: () => '2026-03-03T09:00:00.000Z',
    readContextFile: () => null,
    writeContextFile: () => {},
    updateAgentAvatar: () => {},
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

  it('escapes HTML in group names', () => {
    const xssDetail: GroupQueueDetail = {
      folderKey: '<script>alert(1)</script>',
      messageLane: {
        active: false,
        idle: false,
        pendingCount: 0,
        containerName: null,
      },
      taskLane: {
        active: false,
        pendingCount: 0,
        containerName: null,
        activeTask: null,
      },
      retryCount: 0,
    };
    const html = renderIpcInspector(
      makeState({ getQueueDetails: () => [xssDetail] }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
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
