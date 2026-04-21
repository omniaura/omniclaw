import { afterEach, describe, expect, it, mock } from 'bun:test';
import fs from 'fs';
import path from 'path';

import type { WebStateProvider } from './types.js';
import {
  getSolidHandler,
  initSolidHandler,
  isMainProcessRoute,
} from './solid-handler.js';

const solidOutputDir = path.join(process.cwd(), 'webui', '.output', 'server');
const solidOutputFile = path.join(solidOutputDir, 'index.mjs');
const originalFetch = globalThis.fetch;

const originalEnv = {
  NITRO_PORT: process.env.NITRO_PORT,
  PORT: process.env.PORT,
  NITRO_HOST: process.env.NITRO_HOST,
  HOST: process.env.HOST,
};

type ProxyRequestInit = RequestInit & { decompress?: boolean };

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
      maxActive: 0,
      maxIdle: 0,
    }),
    getQueueDetails: () => [],
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

afterEach(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(path.join(process.cwd(), 'webui', '.output'), {
    recursive: true,
    force: true,
  });

  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('solid-handler', () => {
  it('routes API, SSE, and websocket requests to the main process', () => {
    expect(isMainProcessRoute('/api/events')).toBe(true);
    expect(isMainProcessRoute('/api/logs/stream')).toBe(true);
    expect(isMainProcessRoute('/ws')).toBe(true);
    expect(isMainProcessRoute('/api/agents')).toBe(true);
    expect(isMainProcessRoute('/')).toBe(false);
    expect(isMainProcessRoute('/dashboard')).toBe(false);
  });

  it('falls back to the Datastar UI when the SolidStart bundle is unavailable', async () => {
    fs.rmSync(path.join(process.cwd(), 'webui', '.output'), {
      recursive: true,
      force: true,
    });

    const handler = await initSolidHandler(makeState());

    expect(handler).toBeNull();
  });

  it('initializes the proxy handler and forwards requests to the internal SolidStart server', async () => {
    fs.mkdirSync(solidOutputDir, { recursive: true });
    fs.writeFileSync(
      solidOutputFile,
      'globalThis.__solidHandlerLoaded = true;\n',
    );

    const fetchMock = mock(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Response(init?.body ? 'with-body' : 'without-body', {
          status: 202,
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const handler = await initSolidHandler(makeState());

    expect(handler).not.toBeNull();
    expect(getSolidHandler()).toBe(handler);
    expect(
      (globalThis as typeof globalThis & { __solidHandlerLoaded?: boolean })
        .__solidHandlerLoaded,
    ).toBe(true);
    expect(process.env.NITRO_HOST).toBe('127.0.0.1');
    expect(process.env.HOST).toBe('127.0.0.1');
    expect(process.env.NITRO_PORT).toBe(process.env.PORT);

    const internalPort = Number(process.env.PORT);
    expect(Number.isInteger(internalPort)).toBe(true);
    expect(internalPort).toBeGreaterThanOrEqual(40000);
    expect(internalPort).toBeLessThan(60000);

    const postResponse = await handler!(
      new Request('http://public.test/dashboard?tab=agents', {
        method: 'POST',
        headers: {
          'accept-encoding': 'gzip',
          'x-test': 'present',
        },
        body: 'hello world',
      }),
    );

    expect(postResponse.status).toBe(202);
    expect(await postResponse.text()).toBe('with-body');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [targetUrl, init] = fetchMock.mock.calls[0] as [
      string,
      ProxyRequestInit,
    ];
    expect(targetUrl).toBe(
      `http://127.0.0.1:${internalPort}/dashboard?tab=agents`,
    );
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.decompress).toBe(false);
    expect(init.body).toBeDefined();

    const headers = init.headers as Headers;
    expect(headers.get('host')).toBe(`127.0.0.1:${internalPort}`);
    expect(headers.get('accept-encoding')).toBe('identity');
    expect(headers.get('x-test')).toBe('present');

    const getResponse = await handler!(
      new Request('http://public.test/settings', { method: 'GET' }),
    );

    expect(await getResponse.text()).toBe('without-body');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, getInit] = fetchMock.mock.calls[1] as [string, ProxyRequestInit];
    expect(getInit.method).toBe('GET');
    expect(getInit.body).toBeUndefined();
  });
});
