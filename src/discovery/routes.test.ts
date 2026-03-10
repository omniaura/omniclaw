import { afterEach, describe, expect, it, mock } from 'bun:test';

import {
  handleDiscoveryRequest,
  type DiscoveryRouteContext,
} from './routes.js';

const defaultState = {
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
  createTask: () => {},
  updateTask: () => {},
  deleteTask: () => {},
  calculateNextRun: () => null,
  readContextFile: () => null,
  writeContextFile: () => {},
  updateAgentAvatar: () => {},
};

function makeContext(
  overrides: Partial<DiscoveryRouteContext> = {},
): DiscoveryRouteContext {
  return {
    instanceId: 'local-instance',
    instanceName: 'Local',
    version: '1.0.0',
    trustStore: {
      isPeerTrusted: () => false,
      createPairRequest: () => ({
        id: 'req-1',
        fromInstanceId: 'remote-instance',
        fromName: 'Remote',
        fromHost: '127.0.0.1',
        fromPort: 6001,
        callbackToken: 'callback-token',
        status: 'pending',
        sharedSecret: null,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      }),
    } as any,
    discovery: {
      getPeers: () => new Map(),
      stop: () => {},
    },
    state: defaultState as any,
    ...overrides,
  };
}

afterEach(() => {
  mock.restore();
});

describe('handleDiscoveryRequest', () => {
  it('does not replay stored secrets when a trusted peer re-pairs', async () => {
    const fetchSpy = mock(() => {
      throw new Error('should not be called');
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const req = new Request('http://localhost/api/discovery/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instanceId: 'trusted-peer',
        name: 'Trusted Peer',
        host: '127.0.0.1',
        port: 6001,
        callbackToken: 'callback-token',
      }),
    });

    const ctx = makeContext({
      trustStore: {
        isPeerTrusted: (instanceId: string) => instanceId === 'trusted-peer',
      } as any,
    });

    const res = await handleDiscoveryRequest(req, new URL(req.url), ctx);
    expect(res).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await (res as Response).json()) as { status: string }).toEqual({
      status: 'already_trusted',
    });
  });
});
