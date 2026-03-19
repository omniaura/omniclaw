import { describe, expect, it } from 'bun:test';

import { handleRequest } from './routes.js';
import {
  buildSettingsData,
  renderSettingsContent,
  type SettingsData,
} from './settings.js';
import type { WebStateProvider } from './types.js';

function makeState(): WebStateProvider {
  return {
    getAgents: () => ({}),
    getChannelSubscriptions: () => ({}),
    getTasks: () => [],
    getTaskById: () => undefined,
    getMessages: () => [],
    getChats: () => [],
    getQueueStats: () => ({
      activeContainers: 0,
      idleContainers: 0,
      maxActive: 8,
      maxIdle: 4,
    }),
    getQueueDetails: () => [],
    getIpcEvents: () => [],
    getTaskRunLogs: () => [],
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

function makeSettingsData(overrides: Partial<SettingsData> = {}): SettingsData {
  return {
    general: {
      assistantName: 'TestBot',
      timezone: 'America/New_York',
      anthropicModel: null,
      localRuntime: 'container',
    },
    webUi: {
      port: 8080,
      hostname: '127.0.0.1',
      authEnabled: true,
      corsOrigin: null,
    },
    containers: {
      image: 'omniclaw-agent:latest',
      memory: '4G',
      timeoutMs: 7200000,
      startupTimeoutMs: 120000,
      idleTimeoutMs: 7200000,
      maxOutputSize: 10485760,
      maxActive: 8,
      maxIdle: 4,
      maxTask: 7,
    },
    channels: {
      discordBots: 2,
      discordBotIds: ['BOT_A', 'BOT_B'],
      discordDefaultBot: 'BOT_A',
      telegramBots: 1,
      slackBots: 0,
      slackDefaultBot: null,
    },
    scheduling: {
      sessionMaxAgeMs: 14400000,
      persistentTaskState: false,
      pollIntervalMs: 60000,
    },
    roster: {
      scope: 'channel',
      roleFilters: ['admin', 'mod'],
      cacheTtlMs: 300000,
      refreshIntervalMs: 900000,
    },
    discovery: {
      enabled: true,
      instanceName: 'test-host',
      trustLanAdmin: false,
    },
    github: {
      webhookPort: 9000,
      webhookPath: '/webhooks/github',
      secretConfigured: true,
    },
    paths: {
      store: '/data/store',
      groups: '/data/groups',
      data: '/data/data',
    },
    ...overrides,
  };
}

describe('buildSettingsData', () => {
  it('returns all expected top-level sections', () => {
    const data = buildSettingsData();
    expect(data).toHaveProperty('general');
    expect(data).toHaveProperty('webUi');
    expect(data).toHaveProperty('containers');
    expect(data).toHaveProperty('channels');
    expect(data).toHaveProperty('scheduling');
    expect(data).toHaveProperty('roster');
    expect(data).toHaveProperty('discovery');
    expect(data).toHaveProperty('github');
    expect(data).toHaveProperty('paths');
  });

  it('returns string assistant name', () => {
    const data = buildSettingsData();
    expect(typeof data.general.assistantName).toBe('string');
    expect(data.general.assistantName.length).toBeGreaterThan(0);
  });

  it('returns numeric container limits', () => {
    const data = buildSettingsData();
    expect(data.containers.maxActive).toBeGreaterThanOrEqual(1);
    expect(data.containers.maxIdle).toBeGreaterThanOrEqual(0);
    expect(data.containers.maxTask).toBeGreaterThanOrEqual(1);
    expect(data.containers.timeoutMs).toBeGreaterThan(0);
    expect(data.containers.startupTimeoutMs).toBeGreaterThan(0);
    expect(data.containers.idleTimeoutMs).toBeGreaterThan(0);
    expect(data.containers.maxOutputSize).toBeGreaterThan(0);
  });

  it('returns non-empty timezone', () => {
    const data = buildSettingsData();
    expect(typeof data.general.timezone).toBe('string');
    expect(data.general.timezone.length).toBeGreaterThan(0);
  });

  it('returns paths as strings', () => {
    const data = buildSettingsData();
    expect(typeof data.paths.store).toBe('string');
    expect(typeof data.paths.groups).toBe('string');
    expect(typeof data.paths.data).toBe('string');
  });

  it('does not expose any token or secret values directly', () => {
    const data = buildSettingsData();
    // Channels expose bot counts and IDs, never raw tokens
    expect(data.channels).not.toHaveProperty('tokens');
    // GitHub shows a boolean flag, not the actual secret string
    expect(typeof data.github.secretConfigured).toBe('boolean');
    // Web UI shows authEnabled boolean, not credentials
    expect(typeof data.webUi.authEnabled).toBe('boolean');
  });

  it('returns channel bot counts as numbers', () => {
    const data = buildSettingsData();
    expect(typeof data.channels.discordBots).toBe('number');
    expect(typeof data.channels.telegramBots).toBe('number');
    expect(typeof data.channels.slackBots).toBe('number');
  });
});

describe('renderSettingsContent', () => {
  it('renders all config section cards', () => {
    const html = renderSettingsContent(makeSettingsData());
    expect(html).toContain('general');
    expect(html).toContain('web ui');
    expect(html).toContain('containers');
    expect(html).toContain('channels');
    expect(html).toContain('scheduling');
    expect(html).toContain('roster');
    expect(html).toContain('discovery');
    expect(html).toContain('github');
    expect(html).toContain('paths');
  });

  it('renders the page header with settings title', () => {
    const html = renderSettingsContent(makeSettingsData());
    expect(html).toContain('settings');
    expect(html).toContain('read-only');
  });

  it('renders general section values', () => {
    const html = renderSettingsContent(makeSettingsData());
    expect(html).toContain('TestBot');
    expect(html).toContain('America/New_York');
    expect(html).toContain('container');
    expect(html).toContain('default'); // model override = null -> 'default'
  });

  it('renders model override when present', () => {
    const data = makeSettingsData({
      general: {
        assistantName: 'Bot',
        timezone: 'UTC',
        anthropicModel: 'claude-3-haiku-20240307',
        localRuntime: 'container',
      },
    });
    const html = renderSettingsContent(data);
    expect(html).toContain('claude-3-haiku-20240307');
  });

  it('renders web UI configuration', () => {
    const html = renderSettingsContent(makeSettingsData());
    expect(html).toContain('8080');
    expect(html).toContain('127.0.0.1');
    expect(html).toContain('enabled'); // auth badge
  });

  it('shows disabled when web UI port is null', () => {
    const data = makeSettingsData({
      webUi: {
        port: null,
        hostname: '127.0.0.1',
        authEnabled: false,
        corsOrigin: null,
      },
    });
    const html = renderSettingsContent(data);
    expect(html).toContain('disabled');
  });

  it('renders container limits', () => {
    const html = renderSettingsContent(makeSettingsData());
    expect(html).toContain('omniclaw-agent:latest');
    expect(html).toContain('4G');
    expect(html).toContain('2h'); // 7200000ms = 2h
    expect(html).toContain('2m'); // 120000ms = 2m
    expect(html).toContain('10 MB'); // 10485760 bytes
  });

  it('renders channel bot info', () => {
    const html = renderSettingsContent(makeSettingsData());
    expect(html).toContain('BOT_A, BOT_B');
    expect(html).toContain('BOT_A'); // default bot
  });

  it('omits discord default row when null', () => {
    const data = makeSettingsData({
      channels: {
        discordBots: 0,
        discordBotIds: [],
        discordDefaultBot: null,
        telegramBots: 0,
        slackBots: 0,
        slackDefaultBot: null,
      },
    });
    const html = renderSettingsContent(data);
    expect(html).not.toContain('discord default');
    expect(html).not.toContain('slack default');
  });

  it('renders scheduling configuration', () => {
    const html = renderSettingsContent(makeSettingsData());
    expect(html).toContain('4h'); // 14400000ms = 4h
    expect(html).toContain('1m'); // 60000ms = 1m
  });

  it('renders persistent task state badge', () => {
    const dataOff = makeSettingsData({
      scheduling: {
        sessionMaxAgeMs: 14400000,
        persistentTaskState: false,
        pollIntervalMs: 60000,
      },
    });
    const htmlOff = renderSettingsContent(dataOff);
    expect(htmlOff).toContain('badge-off');

    const dataOn = makeSettingsData({
      scheduling: {
        sessionMaxAgeMs: 14400000,
        persistentTaskState: true,
        pollIntervalMs: 60000,
      },
    });
    const htmlOn = renderSettingsContent(dataOn);
    expect(htmlOn).toContain('badge-on');
  });

  it('renders roster configuration', () => {
    const html = renderSettingsContent(makeSettingsData());
    expect(html).toContain('channel'); // scope
    expect(html).toContain('admin, mod'); // role filters
    expect(html).toContain('5m'); // 300000ms cache ttl
    expect(html).toContain('15m'); // 900000ms refresh
  });

  it('shows none when roster filters are empty', () => {
    const data = makeSettingsData({
      roster: {
        scope: 'guild',
        roleFilters: [],
        cacheTtlMs: 300000,
        refreshIntervalMs: 900000,
      },
    });
    const html = renderSettingsContent(data);
    expect(html).toContain('none');
  });

  it('renders discovery section', () => {
    const html = renderSettingsContent(makeSettingsData());
    expect(html).toContain('test-host');
    // discovery enabled = true
    expect(html).toContain('badge-on');
  });

  it('renders github webhook info', () => {
    const html = renderSettingsContent(makeSettingsData());
    expect(html).toContain('9000');
    expect(html).toContain('/webhooks/github');
    expect(html).toContain('configured'); // secret badge
  });

  it('shows disabled when webhook port is 0', () => {
    const data = makeSettingsData({
      github: {
        webhookPort: 0,
        webhookPath: '/webhooks/github',
        secretConfigured: false,
      },
    });
    const html = renderSettingsContent(data);
    expect(html).toContain('disabled'); // webhook port = 0
    expect(html).toContain('not set'); // no secret
  });

  it('renders file paths', () => {
    const html = renderSettingsContent(makeSettingsData());
    expect(html).toContain('/data/store');
    expect(html).toContain('/data/groups');
    expect(html).toContain('/data/data');
  });

  it('escapes HTML in settings values', () => {
    const data = makeSettingsData({
      general: {
        assistantName: '<script>alert("xss")</script>',
        timezone: 'US/Eastern&<>',
        anthropicModel: 'model"<>&',
        localRuntime: 'container',
      },
    });
    const html = renderSettingsContent(data);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;&lt;&gt;');
  });

  it('renders without data argument using config defaults', () => {
    const html = renderSettingsContent();
    expect(html).toContain('settings');
    expect(html).toContain('system-grid');
  });
});

describe('GET /api/settings route', () => {
  it('returns 200 with settings JSON', async () => {
    const res = await handleRequest(
      new Request('http://localhost/api/settings'),
      makeState(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const data = (await res.json()) as SettingsData;
    expect(data).toHaveProperty('general');
    expect(data).toHaveProperty('containers');
    expect(data).toHaveProperty('channels');
  });

  it('returns 405 for non-GET methods', async () => {
    const res = await handleRequest(
      new Request('http://localhost/api/settings', { method: 'POST' }),
      makeState(),
    );
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Method not allowed');
  });
});

describe('GET /settings page', () => {
  it('returns HTML with settings content', async () => {
    const res = await handleRequest(
      new Request('http://localhost/settings'),
      makeState(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('settings');
    expect(html).toContain('OmniClaw');
    expect(html).toContain('Settings'); // nav link
  });
});
