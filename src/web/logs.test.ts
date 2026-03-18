import { describe, expect, it, afterEach } from 'bun:test';
import type { Agent, ChannelSubscription } from '../types.js';
import type { WebStateProvider, QueueStats } from './types.js';
import { startWebServer, type WebServerHandle } from './server.js';
import { renderLogs, renderLogsContent } from './logs.js';

// ---- Helpers ----

const defaultStats: QueueStats = {
  activeContainers: 1,
  idleContainers: 0,
  maxActive: 5,
  maxIdle: 3,
};

const sampleAgents: Record<string, Agent> = {
  'omniclaw-main': {
    id: 'omniclaw-main',
    name: 'OmniClaw',
    folder: 'omniclaw-main',
    backend: 'apple-container' as const,
    agentRuntime: 'claude-agent-sdk' as const,
    isAdmin: true,
    description: 'Main orchestrator',
    createdAt: '2026-03-01T00:00:00.000Z',
  },
  'helper-bot': {
    id: 'helper-bot',
    name: 'Helper',
    folder: 'helper-bot',
    backend: 'docker' as const,
    agentRuntime: 'claude-agent-sdk' as const,
    isAdmin: false,
    description: 'Helper agent',
    createdAt: '2026-03-01T00:00:00.000Z',
  },
};

function makeState(
  overrides: Partial<WebStateProvider> = {},
): WebStateProvider {
  return {
    getAgents: () => sampleAgents,
    getChannelSubscriptions: () => ({}),
    getTasks: () => [],
    getTaskById: () => undefined,
    getMessages: () => [],
    getChats: () => [],
    getQueueStats: () => defaultStats,
    getQueueDetails: () => [],
    getIpcEvents: () => [],
    getTaskRunLogs: () => [],
    createTask: () => {},
    updateTask: () => {},
    deleteTask: () => {},
    calculateNextRun: () => '2026-03-15T09:00:00.000Z',
    readContextFile: () => null,
    writeContextFile: () => {},
    updateAgentAvatar: () => {},
    ...overrides,
  };
}

// ---- Content tests ----

describe('renderLogsContent', () => {
  it('renders the logs page structure', () => {
    const html = renderLogsContent(makeState());
    expect(html).toContain('logs-page');
    expect(html).toContain('logs-toolbar');
    expect(html).toContain('logs-output');
    expect(html).toContain('logs-status-bar');
  });

  it('renders search input', () => {
    const html = renderLogsContent(makeState());
    expect(html).toContain('logs-search-input');
    expect(html).toContain('Search logs');
  });

  it('renders level filter buttons', () => {
    const html = renderLogsContent(makeState());
    expect(html).toContain('data-log-level="debug"');
    expect(html).toContain('data-log-level="info"');
    expect(html).toContain('data-log-level="warn"');
    expect(html).toContain('data-log-level="error"');
  });

  it('renders source filter dropdown with agents', () => {
    const html = renderLogsContent(makeState());
    expect(html).toContain('logs-source-filter');
    expect(html).toContain('all sources');
    expect(html).toContain('OmniClaw');
    expect(html).toContain('Helper');
  });

  it('renders export button', () => {
    const html = renderLogsContent(makeState());
    expect(html).toContain('logs-btn-export');
    expect(html).toContain('export');
  });

  it('renders clear button', () => {
    const html = renderLogsContent(makeState());
    expect(html).toContain('logs-btn-clear');
    expect(html).toContain('clear');
  });

  it('renders auto-scroll button', () => {
    const html = renderLogsContent(makeState());
    expect(html).toContain('logs-btn-autoscroll');
  });

  it('includes data-init for page script activation', () => {
    const html = renderLogsContent(makeState());
    expect(html).toContain("window.__initPage && window.__initPage('logs')");
  });

  it('renders empty source dropdown with no agents', () => {
    const html = renderLogsContent(makeState({ getAgents: () => ({}) }));
    expect(html).toContain('all sources');
    // No agent options
    expect(html).not.toContain('OmniClaw');
  });

  it('escapes agent names in source filter', () => {
    const xssAgents: Record<string, Agent> = {
      xss: {
        id: 'xss',
        name: '<script>alert(1)</script>',
        folder: 'xss',
        backend: 'docker' as const,
        agentRuntime: 'claude-agent-sdk' as const,
        isAdmin: false,
        description: '',
        createdAt: '2026-03-01T00:00:00.000Z',
      },
    };
    const html = renderLogsContent(makeState({ getAgents: () => xssAgents }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ---- Shell wrapper tests ----

describe('renderLogs', () => {
  it('wraps content in SPA shell with nav', () => {
    const html = renderLogs(makeState());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('OmniClaw');
    expect(html).toContain('href="/logs"');
    expect(html).toContain('logs-page');
  });

  it('marks logs nav link as active', () => {
    const html = renderLogs(makeState());
    // The Logs nav link should be active
    expect(html).toContain('data-page="logs"');
    // Match: class="nav-link active" on the logs link
    const match = html.match(/href="\/logs"[^>]*class="nav-link active"/);
    expect(match).not.toBeNull();
  });

  it('includes all page scripts', () => {
    const html = renderLogs(makeState());
    expect(html).toContain('__pageInits');
    expect(html).toContain('logs');
  });
});

// ---- Route tests ----

describe('Logs page routes', () => {
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

  it('GET /logs returns HTML page', async () => {
    handle = startWebServer({ port: 0, auth: testAuth }, makeState());
    const res = await fetch(`http://localhost:${handle.port}/logs`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('logs-page');
    expect(html).toContain('logs-output');
  });

  it('GET /api/page/logs returns a Datastar patch response for SPA nav', async () => {
    handle = startWebServer({ port: 0, auth: testAuth }, makeState());
    const res = await fetch(`http://localhost:${handle.port}/api/page/logs`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('logs-page');
    expect(body).toContain('logs-output');
    expect(body).toContain('<title id="page-title">OmniClaw — Logs</title>');
  });

  it('nav includes Logs link on all pages', async () => {
    handle = startWebServer({ port: 0, auth: testAuth }, makeState());
    // Check dashboard
    const dashRes = await fetch(`http://localhost:${handle.port}/`, {
      headers: authHeaders,
    });
    const dashHtml = await dashRes.text();
    expect(dashHtml).toContain('href="/logs"');
    expect(dashHtml).toContain('data-page="logs"');

    // Check tasks page
    const tasksRes = await fetch(`http://localhost:${handle.port}/tasks`, {
      headers: authHeaders,
    });
    const tasksHtml = await tasksRes.text();
    expect(tasksHtml).toContain('href="/logs"');
  });

  it('requires auth when configured', async () => {
    handle = startWebServer({ port: 0, auth: testAuth }, makeState());
    const res = await fetch(`http://localhost:${handle.port}/logs`);
    expect(res.status).toBe(401);
  });

  it('allows access without auth when auth not configured', async () => {
    handle = startWebServer({ port: 0 }, makeState());
    const res = await fetch(`http://localhost:${handle.port}/logs`);
    expect(res.status).toBe(200);
  });
});
