/**
 * SPA navigation regression tests — issue #333
 *
 * Covers:
 * - /api/page/* SSE patch responses for all pages
 * - Navigation state preservation (title, nav, content)
 * - Page script initialization hooks presence
 * - Auth enforcement on SPA nav endpoints
 * - Unknown page handling
 * - Agent detail parametric page
 */

import { afterEach, describe, expect, it } from 'bun:test';

import type { Agent, ChannelSubscription, ScheduledTask } from '../types.js';
import {
  resetDiscoveryContextForTests,
  setDiscoveryContext,
} from './routes.js';
import { startWebServer, type WebServerHandle } from './server.js';
import type { WebStateProvider } from './types.js';

// ---- Factories ----

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-spa',
    name: 'SPA Agent',
    folder: 'spa-agent',
    backend: 'apple-container',
    agentRuntime: 'claude-agent-sdk',
    isAdmin: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-spa',
    group_folder: 'spa-agent',
    chat_jid: 'dc:spa',
    prompt: 'SPA test task',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    next_run: '2026-04-01T09:00:00.000Z',
    last_run: null,
    last_result: null,
    executing_since: null,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeState(
  overrides: Partial<WebStateProvider> = {},
): WebStateProvider {
  return {
    getAgents: () => ({
      'agent-spa': makeAgent(),
      'agent-admin': makeAgent({
        id: 'agent-admin',
        name: 'Admin Agent',
        folder: 'admin-agent',
        isAdmin: true,
      }),
    }),
    getChannelSubscriptions: () => ({
      'dc:spa': [
        {
          channelJid: 'dc:spa',
          agentId: 'agent-spa',
          trigger: '@SPA',
          requiresTrigger: true,
          priority: 100,
          isPrimary: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ] as ChannelSubscription[],
    }),
    getTasks: () => [makeTask()],
    getTaskById: (id) => (id === 'task-spa' ? makeTask() : undefined),
    getMessages: () => [],
    getChats: () => [
      {
        jid: 'dc:spa',
        name: 'spa-channel',
        last_message_time: '2026-03-01T12:00:00.000Z',
      },
    ],
    getQueueStats: () => ({
      activeContainers: 1,
      idleContainers: 2,
      maxActive: 4,
      maxIdle: 3,
    }),
    getQueueDetails: () => [],
    getIpcEvents: () => [],
    getTaskRunLogs: () => [],
    getTaskRunPhaseEvents: () => [],
    searchMessages: () => [],
    createTask: () => {},
    updateTask: () => {},
    deleteTask: () => {},
    calculateNextRun: () => '2026-04-01T09:00:00.000Z',
    readContextFile: () => null,
    writeContextFile: () => {},
    updateAgentAvatar: () => {},
    setAgentEnabled: () => true,
    resolveChatImage: async () => null,
    resolveDiscordGuildImage: async () => null,
    ...overrides,
  };
}

// ---- Test setup ----

const testAuth = { username: 'admin', password: 'secret' };
const authHeader = `Basic ${btoa(`${testAuth.username}:${testAuth.password}`)}`;
let handle: WebServerHandle | null = null;

afterEach(async () => {
  if (handle) {
    await handle.stop();
    handle = null;
  }
  resetDiscoveryContextForTests();
});

function baseUrl(path: string): string {
  return `http://localhost:${handle!.port}${path}`;
}

function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has('Authorization')) {
    headers.set('Authorization', authHeader);
  }
  return fetch(baseUrl(path), { ...init, headers });
}

/**
 * Parse an SSE response body and extract all `datastar-patch-elements` fragments.
 * Returns the concatenated HTML from all patch events.
 */
function extractSsePatchHtml(body: string): string {
  const fragments: string[] = [];
  const lines = body.split('\n');
  let inData = false;
  let currentData = '';

  for (const line of lines) {
    if (line.startsWith('event: datastar-patch-elements')) {
      inData = true;
      currentData = '';
    } else if (inData && line.startsWith('data: fragments ')) {
      currentData += line.slice('data: fragments '.length);
    } else if (inData && line === '') {
      if (currentData) fragments.push(currentData);
      inData = false;
      currentData = '';
    }
  }
  if (currentData) fragments.push(currentData);

  return fragments.join('\n');
}

// ---- SPA page navigation tests ----

describe('SPA page navigation via /api/page/*', () => {
  /** All known SPA pages and their expected title and content markers. */
  const spaPages: Array<{
    name: string;
    expectedTitle: string;
    contentMarker: string;
    initPage: string;
  }> = [
    {
      name: 'dashboard',
      expectedTitle: 'Dashboard',
      contentMarker: 'stat-agents',
      initPage: 'dashboard',
    },
    {
      name: 'agents',
      expectedTitle: 'Agents',
      contentMarker: 'agent-spa',
      initPage: 'agents',
    },
    {
      name: 'tasks',
      expectedTitle: 'Tasks',
      contentMarker: 'Task Manager',
      initPage: 'tasks',
    },
    {
      name: 'logs',
      expectedTitle: 'Logs',
      contentMarker: 'logs-page',
      initPage: 'logs',
    },
    {
      name: 'conversations',
      expectedTitle: 'Conversations',
      contentMarker: 'conversations',
      initPage: 'conversations',
    },
    {
      name: 'context',
      expectedTitle: 'Context',
      contentMarker: 'context',
      initPage: 'context',
    },
    {
      name: 'ipc',
      expectedTitle: 'IPC Inspector',
      contentMarker: 'ipc',
      initPage: 'ipc',
    },
    {
      name: 'network',
      expectedTitle: 'Network',
      contentMarker: 'network-root',
      initPage: 'network',
    },
    {
      name: 'system',
      expectedTitle: 'System',
      contentMarker: 'system',
      initPage: 'system',
    },
    {
      name: 'settings',
      expectedTitle: 'Settings',
      contentMarker: 'settings',
      initPage: 'settings',
    },
  ];

  for (const page of spaPages) {
    it(`GET /api/page/${page.name} returns SSE patch with title, nav, and content`, async () => {
      handle = startWebServer({ port: 0, auth: testAuth }, makeState());
      const res = await authedFetch(`/api/page/${page.name}`);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.headers.get('cache-control')).toContain('no-cache');

      const body = await res.text();

      // Title patch — ensures page title is correctly set for browser history
      expect(body).toContain(
        `<title id="page-title">OmniClaw — ${page.expectedTitle}</title>`,
      );

      // Nav patch — active nav link must be updated
      expect(body).toContain('<nav id="nav-links">');

      // Content patch — page-specific content must be present
      expect(body).toContain(`<main id="content">`);
    });
  }

  it('returns 404 for unknown page names', async () => {
    handle = startWebServer({ port: 0, auth: testAuth }, makeState());
    const res = await authedFetch('/api/page/nonexistent');

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Unknown page' });
  });

  it('requires auth on SPA page endpoints when auth is configured', async () => {
    handle = startWebServer({ port: 0, auth: testAuth }, makeState());
    const res = await fetch(baseUrl('/api/page/dashboard'));

    expect(res.status).toBe(401);
  });

  it('allows SPA page access without auth when not configured', async () => {
    handle = startWebServer({ port: 0 }, makeState());
    const res = await fetch(baseUrl('/api/page/dashboard'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });
});

// ---- Navigation round-trip tests (regression for #323, #324, #325) ----

describe('SPA navigation round-trips preserve correct state', () => {
  it('navigating Dashboard → Agents → Dashboard produces correct nav state', async () => {
    handle = startWebServer({ port: 0, auth: testAuth }, makeState());

    // Initial dashboard load — full HTML
    const dashRes = await authedFetch('/');
    const dashHtml = await dashRes.text();
    expect(dashHtml).toContain('class="nav-link active">Dashboard</a>');
    expect(dashHtml).not.toContain('class="nav-link active">Agents</a>');

    // Navigate to Agents via SPA
    const agentsRes = await authedFetch('/api/page/agents');
    const agentsBody = await agentsRes.text();
    expect(agentsBody).toContain('class="nav-link active">Agents</a>');

    // Navigate back to Dashboard via SPA
    const dashBackRes = await authedFetch('/api/page/dashboard');
    const dashBackBody = await dashBackRes.text();
    expect(dashBackBody).toContain('class="nav-link active">Dashboard</a>');
    expect(dashBackBody).toContain('stat-agents');
  });

  it('navigating Dashboard → Logs → Tasks produces distinct page content', async () => {
    handle = startWebServer({ port: 0, auth: testAuth }, makeState());

    const logsRes = await authedFetch('/api/page/logs');
    const logsBody = await logsRes.text();
    expect(logsBody).toContain('logs-page');
    expect(logsBody).toContain('logs-toolbar');
    expect(logsBody).toContain(
      '<title id="page-title">OmniClaw — Logs</title>',
    );

    const tasksRes = await authedFetch('/api/page/tasks');
    const tasksBody = await tasksRes.text();
    expect(tasksBody).toContain('Task Manager');
    expect(tasksBody).toContain(
      '<title id="page-title">OmniClaw — Tasks</title>',
    );
    // Logs content should NOT appear in tasks response
    expect(tasksBody).not.toContain('logs-toolbar');
  });

  it('full-page loads and SPA navigations render identical content for same page', async () => {
    handle = startWebServer({ port: 0, auth: testAuth }, makeState());

    // Full-page load of tasks
    const fullRes = await authedFetch('/tasks');
    const fullHtml = await fullRes.text();

    // SPA navigation to tasks
    const spaRes = await authedFetch('/api/page/tasks');
    const spaBody = await spaRes.text();

    // Both should contain the task manager content
    expect(fullHtml).toContain('Task Manager');
    expect(spaBody).toContain('Task Manager');

    // Both should contain the SPA agent task
    expect(fullHtml).toContain('SPA test task');
    expect(spaBody).toContain('SPA test task');
  });
});

// ---- Network page graceful degradation ----

describe('Network page with discovery unavailable', () => {
  it('SPA nav to network shows degraded state when discovery is not configured', async () => {
    // No discovery context set — simulates discovery unavailable
    handle = startWebServer({ port: 0, auth: testAuth }, makeState());

    const res = await authedFetch('/api/page/network');
    const body = await res.text();

    expect(res.status).toBe(200);
    // Should render the network page with discovery unavailable indicator
    expect(body).toContain('network-root');
    expect(body).toContain('data-discovery-available="false"');
  });

  it('full-page /network renders with disabled controls', async () => {
    handle = startWebServer({ port: 0, auth: testAuth }, makeState());

    const res = await authedFetch('/network');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('network-root');
    expect(html).toContain('disabled');
    expect(html).toContain(
      'Discovery controls are unavailable in this environment.',
    );
  });

  it('network page shows active state when discovery is configured', async () => {
    setDiscoveryContext(
      {
        instanceId: 'test-local',
        instanceName: 'TestNode',
        version: '1.0.0',
        trustStore: {
          getPendingRequests: () => [],
        } as never,
        discovery: null,
        state: makeState(),
      },
      () => ({
        instanceId: 'test-local',
        instanceName: 'TestNode',
        discoveryAvailable: true,
        discoveryEnabled: true,
        runtime: {
          enabled: true,
          active: true,
          currentNetwork: null,
          trustedNetworks: [],
        },
        peers: [],
        pendingRequests: [],
      }),
    );

    handle = startWebServer({ port: 0, auth: testAuth }, makeState());

    const res = await authedFetch('/network');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('TestNode');
    expect(html).toContain('data-discovery-available="true"');
  });
});

// ---- Task CRUD round-trip ----

describe('Task Manager CRUD round-trip via API', () => {
  function makeTaskStore() {
    const tasks = new Map<string, ScheduledTask>();
    return {
      tasks,
      state: makeState({
        getTasks: () => [...tasks.values()],
        getTaskById: (id) => tasks.get(id),
        createTask: (task) => {
          tasks.set(task.id, {
            ...task,
            last_run: null,
            last_result: null,
            executing_since: null,
          });
        },
        updateTask: (id, updates) => {
          const existing = tasks.get(id);
          if (!existing) throw new Error('Task not found');
          tasks.set(id, { ...existing, ...updates });
        },
        deleteTask: (id) => {
          tasks.delete(id);
        },
        calculateNextRun: (type, value) => {
          if (type === 'cron') return '2026-04-01T09:00:00.000Z';
          if (type === 'interval')
            return new Date(Date.now() + parseInt(value, 10)).toISOString();
          if (type === 'once') return value;
          return null;
        },
      }),
    };
  }

  it('creates, reads, edits, pauses, and deletes a task', async () => {
    const store = makeTaskStore();
    handle = startWebServer({ port: 0, auth: testAuth }, store.state);

    // 1. Create
    const createRes = await authedFetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group_folder: 'spa-agent',
        chat_jid: 'dc:spa',
        prompt: 'CRUD round-trip task',
        schedule_type: 'cron',
        schedule_value: '0 12 * * *',
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as ScheduledTask;
    expect(created.prompt).toBe('CRUD round-trip task');
    expect(created.status).toBe('active');
    const taskId = created.id;

    // 2. Read — verify task appears in list
    const listRes = await authedFetch('/api/tasks');
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as ScheduledTask[];
    expect(list.find((t) => t.id === taskId)).toBeDefined();

    // 3. Edit prompt
    const editRes = await authedFetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Updated prompt' }),
    });
    expect(editRes.status).toBe(200);
    const edited = (await editRes.json()) as ScheduledTask;
    expect(edited.prompt).toBe('Updated prompt');

    // 4. Pause
    const pauseRes = await authedFetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
    });
    expect(pauseRes.status).toBe(200);
    const paused = (await pauseRes.json()) as ScheduledTask;
    expect(paused.status).toBe('paused');

    // 5. Delete
    const deleteRes = await authedFetch(`/api/tasks/${taskId}`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);

    // 6. Confirm deleted
    expect(store.tasks.has(taskId)).toBe(false);
    const afterDelete = await authedFetch('/api/tasks');
    const remaining = (await afterDelete.json()) as ScheduledTask[];
    expect(remaining.find((t) => t.id === taskId)).toBeUndefined();
  });

  it('handles create → resume cycle for paused tasks', async () => {
    const store = makeTaskStore();
    handle = startWebServer({ port: 0, auth: testAuth }, store.state);

    // Create as active
    const createRes = await authedFetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group_folder: 'spa-agent',
        chat_jid: 'dc:spa',
        prompt: 'Pause-resume task',
        schedule_type: 'interval',
        schedule_value: '60000',
      }),
    });
    const task = (await createRes.json()) as ScheduledTask;

    // Pause
    await authedFetch(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
    });

    // Resume
    const resumeRes = await authedFetch(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });
    expect(resumeRes.status).toBe(200);
    const resumed = (await resumeRes.json()) as ScheduledTask;
    expect(resumed.status).toBe('active');
    expect(resumed.next_run).toBeTruthy();
  });
});

// ---- Auth flow ----

describe('Auth flow: login → session → logout', () => {
  it('rejects unauthenticated requests and accepts valid credentials', async () => {
    handle = startWebServer({ port: 0, auth: testAuth }, makeState());

    // Step 1: No credentials → 401
    const noAuthRes = await fetch(baseUrl('/'));
    expect(noAuthRes.status).toBe(401);
    expect(noAuthRes.headers.get('WWW-Authenticate')).toContain('Basic');

    // Step 2: Wrong credentials → 401
    const wrongRes = await fetch(baseUrl('/'), {
      headers: { Authorization: `Basic ${btoa('admin:wrong')}` },
    });
    expect(wrongRes.status).toBe(401);

    // Step 3: Correct credentials → 200
    const authRes = await authedFetch('/');
    expect(authRes.status).toBe(200);
    const html = await authRes.text();
    expect(html).toContain('OmniClaw');

    // Step 4: API endpoints also require auth
    const apiNoAuth = await fetch(baseUrl('/api/agents'));
    expect(apiNoAuth.status).toBe(401);

    const apiAuth = await authedFetch('/api/agents');
    expect(apiAuth.status).toBe(200);
  });

  it('all pages require auth when configured', async () => {
    handle = startWebServer({ port: 0, auth: testAuth }, makeState());

    const pages = [
      '/',
      '/tasks',
      '/logs',
      '/network',
      '/conversations',
      '/context',
      '/ipc',
      '/system',
      '/settings',
      '/agents-list',
    ];

    for (const page of pages) {
      const res = await fetch(baseUrl(page));
      expect(res.status).toBe(401);
    }
  });

  it('all pages accessible without auth when not configured', async () => {
    handle = startWebServer({ port: 0 }, makeState());

    const pages = ['/', '/tasks', '/logs', '/network'];

    for (const page of pages) {
      const res = await fetch(baseUrl(page));
      expect(res.status).toBe(200);
    }
  });
});

// ---- Agent detail parametric page ----

describe('Agent detail SPA navigation', () => {
  it('returns agent detail page via SPA nav with correct title', async () => {
    handle = startWebServer({ port: 0, auth: testAuth }, makeState());

    const res = await authedFetch('/api/page/agent-detail?id=agent-spa');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const body = await res.text();
    expect(body).toContain('SPA Agent');
  });

  it('returns not found title for unknown agent', async () => {
    handle = startWebServer({ port: 0, auth: testAuth }, makeState());

    const res = await authedFetch('/api/page/agent-detail?id=nonexistent');
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain('Agent Not Found');
  });
});

// ---- Page-level content markers ----

describe('Page content includes data-init hooks for script activation', () => {
  const pageInitMarkers: Array<{
    route: string;
    initPage: string;
  }> = [
    { route: '/', initPage: 'dashboard' },
    { route: '/tasks', initPage: 'tasks' },
    { route: '/logs', initPage: 'logs' },
  ];

  for (const { route, initPage } of pageInitMarkers) {
    it(`${route} includes __initPage('${initPage}') hook`, async () => {
      handle = startWebServer({ port: 0, auth: testAuth }, makeState());
      const res = await authedFetch(route);
      const html = await res.text();

      expect(html).toContain(
        `window.__initPage && window.__initPage('${initPage}')`,
      );
    });
  }
});

// ---- SSE response headers ----

describe('SSE response headers for SPA navigation', () => {
  it('includes proxy-safe headers on SSE responses', async () => {
    handle = startWebServer({ port: 0, auth: testAuth }, makeState());
    const res = await authedFetch('/api/page/dashboard');

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
  });

  it('includes CORS headers when corsOrigin is configured', async () => {
    handle = startWebServer(
      { port: 0, auth: testAuth, corsOrigin: 'http://localhost:5173' },
      makeState(),
    );
    const res = await authedFetch('/api/page/tasks');

    expect(res.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:5173',
    );
  });
});
