import { createHash, createHmac, randomUUID } from 'crypto';
import { afterEach, describe, expect, it, mock } from 'bun:test';

import {
  checkPeerAuth,
  fetchTrustedRemoteAgents,
  handleDiscoveryRequest,
  type DiscoveryRouteContext,
} from './routes.js';
import { PairRequestHostMismatchError } from './trust-store.js';

const realFetch = globalThis.fetch;

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

function withSocketAddress(req: Request, remoteAddress: string): Request {
  Object.defineProperty(req, 'socket', {
    value: { remoteAddress },
    configurable: true,
  });
  return req;
}

afterEach(() => {
  mock.restore();
  globalThis.fetch = realFetch;
});

describe('handleDiscoveryRequest', () => {
  it('merges discovered and stored peers while omitting revoked stored-only peers', async () => {
    const discoveredPeers = new Map([
      [
        'trusted-online',
        {
          instanceId: 'trusted-online',
          name: 'Trusted Online',
          host: '10.0.0.10',
          port: 6100,
          addresses: ['10.0.0.10'],
          version: '1.0.0',
          firstSeen: '2026-05-21T00:00:00.000Z',
        },
      ],
      [
        'new-peer',
        {
          instanceId: 'new-peer',
          name: 'New Peer',
          host: '10.0.0.11',
          port: 6101,
          addresses: ['10.0.0.11'],
          version: '1.0.0',
          firstSeen: '2026-05-21T00:00:00.000Z',
        },
      ],
    ]);

    const req = new Request('http://localhost/api/discovery/peers', {
      method: 'GET',
    });
    const ctx = makeContext({
      discovery: { getPeers: () => discoveredPeers, stop: () => {} },
      trustStore: {
        getAllPeers: () => [
          {
            instanceId: 'trusted-online',
            name: 'Stored Trusted Name',
            sharedSecret: 'secret',
            status: 'trusted',
            host: '192.0.2.10',
            port: 6200,
            approvedAt: '2026-05-20T00:00:00.000Z',
            lastSeen: '2026-05-20T01:00:00.000Z',
            createdAt: '2026-05-19T00:00:00.000Z',
          },
          {
            instanceId: 'trusted-offline',
            name: 'Trusted Offline',
            sharedSecret: 'secret',
            status: 'trusted',
            host: '192.0.2.20',
            port: 6201,
            approvedAt: '2026-05-20T00:00:00.000Z',
            lastSeen: null,
            createdAt: '2026-05-19T00:00:00.000Z',
          },
          {
            instanceId: 'revoked-offline',
            name: 'Revoked Offline',
            sharedSecret: null,
            status: 'revoked',
            host: '192.0.2.30',
            port: 6202,
            approvedAt: null,
            lastSeen: null,
            createdAt: '2026-05-19T00:00:00.000Z',
          },
        ],
      } as any,
    });

    const res = await handleDiscoveryRequest(req, new URL(req.url), ctx);
    expect(res).not.toBeNull();
    expect(await (res as Response).json()).toEqual([
      {
        instanceId: 'trusted-online',
        name: 'Trusted Online',
        host: '10.0.0.10',
        port: 6100,
        addresses: ['10.0.0.10'],
        status: 'trusted',
        online: true,
        approvedAt: '2026-05-20T00:00:00.000Z',
        lastSeen: '2026-05-20T01:00:00.000Z',
      },
      {
        instanceId: 'new-peer',
        name: 'New Peer',
        host: '10.0.0.11',
        port: 6101,
        addresses: ['10.0.0.11'],
        status: 'discovered',
        online: true,
        approvedAt: null,
        lastSeen: null,
      },
      {
        instanceId: 'trusted-offline',
        name: 'Trusted Offline',
        host: '192.0.2.20',
        port: 6201,
        addresses: [],
        status: 'trusted',
        online: false,
        approvedAt: '2026-05-20T00:00:00.000Z',
        lastSeen: null,
      },
    ]);
  });

  it('fetches agents only from online trusted peers and reports fetch failures offline', async () => {
    const clientInputs: Array<{
      instanceId: string;
      host: string | null;
      port: number | null;
      sharedSecret: string | null;
    }> = [];
    const lastSeenUpdates: string[] = [];
    const storedPeers = [
      {
        instanceId: 'trusted-online',
        name: 'Trusted Online',
        sharedSecret: 'secret-a',
        status: 'trusted',
        host: '192.0.2.10',
        port: 6200,
        approvedAt: '2026-05-20T00:00:00.000Z',
        lastSeen: null,
        createdAt: '2026-05-19T00:00:00.000Z',
      },
      {
        instanceId: 'trusted-failing',
        name: 'Trusted Failing',
        sharedSecret: 'secret-b',
        status: 'trusted',
        host: '192.0.2.11',
        port: 6201,
        approvedAt: '2026-05-20T00:00:00.000Z',
        lastSeen: null,
        createdAt: '2026-05-19T00:00:00.000Z',
      },
      {
        instanceId: 'trusted-offline',
        name: 'Trusted Offline',
        sharedSecret: 'secret-c',
        status: 'trusted',
        host: '192.0.2.12',
        port: 6202,
        approvedAt: '2026-05-20T00:00:00.000Z',
        lastSeen: null,
        createdAt: '2026-05-19T00:00:00.000Z',
      },
      {
        instanceId: 'pending-online',
        name: 'Pending Online',
        sharedSecret: null,
        status: 'pending',
        host: '192.0.2.13',
        port: 6203,
        approvedAt: null,
        lastSeen: null,
        createdAt: '2026-05-19T00:00:00.000Z',
      },
    ];
    const discoveredPeers = new Map([
      [
        'trusted-online',
        {
          instanceId: 'trusted-online',
          name: 'Trusted Online',
          host: '10.0.0.10',
          port: 6100,
          addresses: ['10.0.0.10'],
          version: '1.0.0',
          firstSeen: '2026-05-21T00:00:00.000Z',
        },
      ],
      [
        'trusted-failing',
        {
          instanceId: 'trusted-failing',
          name: 'Trusted Failing',
          host: '10.0.0.11',
          port: 6101,
          addresses: ['10.0.0.11'],
          version: '1.0.0',
          firstSeen: '2026-05-21T00:00:00.000Z',
        },
      ],
      [
        'pending-online',
        {
          instanceId: 'pending-online',
          name: 'Pending Online',
          host: '10.0.0.13',
          port: 6103,
          addresses: ['10.0.0.13'],
          version: '1.0.0',
          firstSeen: '2026-05-21T00:00:00.000Z',
        },
      ],
    ]);

    const ctx = makeContext({
      discovery: { getPeers: () => discoveredPeers, stop: () => {} },
      trustStore: {
        getAllPeers: () => storedPeers,
        getPeer: (instanceId: string) =>
          storedPeers.find((peer) => peer.instanceId === instanceId) ?? null,
        updatePeerLastSeen: (instanceId: string) => {
          lastSeenUpdates.push(instanceId);
        },
      } as any,
      createPeerClient: (peer) => {
        clientInputs.push(peer);
        return {
          getAgents: async () => {
            if (peer.instanceId === 'trusted-failing') {
              throw new Error('remote unavailable');
            }
            return [
              {
                id: 'remote-agent',
                name: 'Remote Agent',
                folder: 'remote-agent',
                backend: 'docker',
                agentRuntime: 'opencode',
                channels: [],
              },
            ];
          },
          getStats: async () => ({}),
          streamLogs: async () => new Response(''),
          getContextLayers: async () => ({}),
          listContextFiles: async () => [],
          writeContextFile: async () => ({ ok: true }),
        };
      },
    });

    const result = await fetchTrustedRemoteAgents(ctx);

    expect(clientInputs).toEqual([
      {
        instanceId: 'trusted-online',
        host: '10.0.0.10',
        port: 6100,
        sharedSecret: 'secret-a',
      },
      {
        instanceId: 'trusted-failing',
        host: '10.0.0.11',
        port: 6101,
        sharedSecret: 'secret-b',
      },
    ]);
    expect(lastSeenUpdates).toEqual(['trusted-online', 'trusted-failing']);
    expect(result).toEqual([
      {
        instanceId: 'trusted-online',
        instanceName: 'Trusted Online',
        online: true,
        host: '10.0.0.10',
        port: 6100,
        agents: [
          {
            id: 'remote-agent',
            name: 'Remote Agent',
            folder: 'remote-agent',
            backend: 'docker',
            agentRuntime: 'opencode',
            channels: [],
          },
        ],
      },
      {
        instanceId: 'trusted-failing',
        instanceName: 'Trusted Failing',
        online: false,
        host: '10.0.0.11',
        port: 6101,
        agents: [],
      },
    ]);
  });

  it('does not replay stored secrets when a trusted peer re-pairs', async () => {
    const fetchSpy = mock(() => {
      throw new Error('should not be called');
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const req = withSocketAddress(
      new Request('http://localhost/api/discovery/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instanceId: 'trusted-peer',
          name: 'Trusted Peer',
          host: '198.51.100.9',
          port: 6001,
          callbackToken: 'callback-token',
          keyAgreementPublicKey: 'test-public-key',
        }),
      }),
      '10.0.0.22',
    );

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

  it('stores the callback host from the socket address instead of the request body', async () => {
    const createPairRequest = mock(() => ({
      id: 'req-2',
      fromInstanceId: 'remote-instance',
      fromName: 'Remote',
      fromHost: '10.0.0.22',
      fromPort: 6001,
      callbackToken: 'callback-token',
      status: 'pending',
      sharedSecret: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    }));
    const req = withSocketAddress(
      new Request('http://localhost/api/discovery/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instanceId: 'remote-instance',
          name: 'Remote',
          host: '169.254.169.254',
          port: 6001,
          callbackToken: 'callback-token',
          keyAgreementPublicKey: 'test-public-key',
        }),
      }),
      '10.0.0.22',
    );

    const ctx = makeContext({
      trustStore: {
        isPeerTrusted: () => false,
        createPairRequest,
      } as any,
    });

    const res = await handleDiscoveryRequest(req, new URL(req.url), ctx);
    expect(res).not.toBeNull();
    expect(createPairRequest).toHaveBeenCalledWith(
      'remote-instance',
      'Remote',
      '10.0.0.22',
      6001,
      'callback-token',
      'test-public-key',
    );
    expect(
      (await (res as Response).json()) as {
        status: string;
        requestId: string;
      },
    ).toEqual({
      status: 'pending',
      requestId: 'req-2',
    });
  });

  it('normalizes IPv4-mapped IPv6 socket addresses before storing the callback host', async () => {
    const createPairRequest = mock(() => ({
      id: 'req-3',
      fromInstanceId: 'remote-instance',
      fromName: 'Remote',
      fromHost: '10.0.0.22',
      fromPort: 6001,
      callbackToken: 'callback-token',
      status: 'pending',
      sharedSecret: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    }));
    const req = withSocketAddress(
      new Request('http://localhost/api/discovery/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instanceId: 'remote-instance',
          name: 'Remote',
          host: '169.254.169.254',
          port: 6001,
          callbackToken: 'callback-token',
          keyAgreementPublicKey: 'test-public-key',
        }),
      }),
      '::ffff:10.0.0.22',
    );

    const ctx = makeContext({
      trustStore: {
        isPeerTrusted: () => false,
        createPairRequest,
      } as any,
    });

    const res = await handleDiscoveryRequest(req, new URL(req.url), ctx);
    expect(res).not.toBeNull();
    expect(createPairRequest).toHaveBeenCalledWith(
      'remote-instance',
      'Remote',
      '10.0.0.22',
      6001,
      'callback-token',
      'test-public-key',
    );
  });

  it('rejects pair requests when the requester address is unavailable', async () => {
    const req = new Request('http://localhost/api/discovery/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instanceId: 'remote-instance',
        name: 'Remote',
        host: '127.0.0.1',
        port: 6001,
        callbackToken: 'callback-token',
        keyAgreementPublicKey: 'test-public-key',
      }),
    });

    const res = await handleDiscoveryRequest(
      req,
      new URL(req.url),
      makeContext(),
    );
    expect(res).not.toBeNull();
    expect((await (res as Response).json()) as { error: string }).toEqual({
      error: 'Unable to determine requester address',
    });
    expect((res as Response).status).toBe(400);
  });

  it('rejects pair requests with invalid callback ports', async () => {
    for (const port of [70000, 0, -1]) {
      const req = withSocketAddress(
        new Request('http://localhost/api/discovery/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instanceId: 'remote-instance',
            name: 'Remote',
            host: '127.0.0.1',
            port,
            callbackToken: 'callback-token',
            keyAgreementPublicKey: 'test-public-key',
          }),
        }),
        '10.0.0.22',
      );

      const res = await handleDiscoveryRequest(
        req,
        new URL(req.url),
        makeContext(),
      );
      expect(res).not.toBeNull();
      expect((await (res as Response).json()) as { error: string }).toEqual({
        error: 'Invalid port',
      });
      expect((res as Response).status).toBe(400);
    }
  });

  it('returns 409 when pair request is bound to a different host (#489)', async () => {
    const req = withSocketAddress(
      new Request('http://localhost/api/discovery/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instanceId: 'victim-instance',
          name: 'Attacker',
          host: '10.0.0.99',
          port: 9999,
          callbackToken: 'attacker-callback',
          keyAgreementPublicKey: 'attacker-pub',
        }),
      }),
      '10.0.0.99',
    );

    const ctx = makeContext({
      trustStore: {
        isPeerTrusted: () => false,
        createPairRequest: () => {
          throw new PairRequestHostMismatchError(
            'victim-instance',
            '10.0.0.30',
            '10.0.0.99',
          );
        },
      } as any,
    });

    const res = await handleDiscoveryRequest(req, new URL(req.url), ctx);
    expect(res).not.toBeNull();
    expect((res as Response).status).toBe(409);
    const body = (await (res as Response).json()) as { error: string };
    expect(body.error).toContain('bound to a different host');
  });

  it('rejects oversized pair requests before creating trust-store state', async () => {
    let createPairRequestCalls = 0;
    const req = withSocketAddress(
      new Request('http://localhost/api/discovery/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instanceId: 'remote-instance',
          name: 'Remote',
          port: 6001,
          callbackToken: 'x'.repeat(70 * 1024),
          keyAgreementPublicKey: 'test-public-key',
        }),
      }),
      '10.0.0.22',
    );

    const res = await handleDiscoveryRequest(
      req,
      new URL(req.url),
      makeContext({
        trustStore: {
          isPeerTrusted: () => false,
          createPairRequest: () => {
            createPairRequestCalls += 1;
            throw new Error('should not be called');
          },
        } as any,
      }),
    );

    expect(res).not.toBeNull();
    expect((res as Response).status).toBe(413);
    expect((await (res as Response).json()) as { error: string }).toEqual({
      error: 'Request body too large',
    });
    expect(createPairRequestCalls).toBe(0);
  });
});

// ---- checkPeerAuth body hash verification ----

const TEST_SECRET = 'test-shared-secret-32-bytes-long!';
const TEST_INSTANCE = 'peer-instance-1';

/** Build a signed request with valid peer auth headers. */
function buildSignedRequest(
  path: string,
  method: string,
  body: string,
  secret: string = TEST_SECRET,
  instanceId: string = TEST_INSTANCE,
): Request {
  const nonce = randomUUID();
  const timestamp = Date.now().toString();
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const signature = createHmac('sha256', secret)
    .update([method, path, timestamp, nonce, bodyHash].join('\n'))
    .digest('hex');

  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-OmniClaw-Instance': instanceId,
      'X-OmniClaw-Timestamp': timestamp,
      'X-OmniClaw-Nonce': nonce,
      'X-OmniClaw-Body-SHA256': bodyHash,
      'X-OmniClaw-Signature': signature,
    },
    body: body || undefined,
  });
}

function makeTrustStore(secret: string | null = TEST_SECRET) {
  return {
    getPeerSecret: () => secret,
    updatePeerLastSeen: () => {},
  } as any;
}

describe('checkPeerAuth — body hash verification', () => {
  it('accepts a request when computedBodyHash matches the header', () => {
    const body = JSON.stringify({ path: 'test/CLAUDE.md', content: 'hello' });
    const req = buildSignedRequest('/api/context/file', 'PUT', body);
    const computedHash = createHash('sha256').update(body).digest('hex');

    const result = checkPeerAuth(req, makeTrustStore(), computedHash);
    expect(result).toBe(true);
  });

  it('rejects a request when the body was tampered after signing', () => {
    const originalBody = JSON.stringify({
      path: 'test/CLAUDE.md',
      content: 'legitimate content',
    });
    const tamperedBody = JSON.stringify({
      path: 'test/CLAUDE.md',
      content: 'MALICIOUS INSTRUCTIONS',
    });

    // Sign headers with the original body
    const req = buildSignedRequest('/api/context/file', 'PUT', originalBody);
    // But compute the hash from the tampered body (simulating MITM)
    const tamperedHash = createHash('sha256')
      .update(tamperedBody)
      .digest('hex');

    const result = checkPeerAuth(req, makeTrustStore(), tamperedHash);
    expect(result).toBe(false);
  });

  it('accepts a GET request with empty body hash', () => {
    const req = buildSignedRequest('/api/agents', 'GET', '');
    const computedHash = createHash('sha256').update('').digest('hex');

    const result = checkPeerAuth(req, makeTrustStore(), computedHash);
    expect(result).toBe(true);
  });

  it('still works without computedBodyHash (backward compatibility)', () => {
    const body = JSON.stringify({ path: 'test/CLAUDE.md', content: 'hello' });
    const req = buildSignedRequest('/api/context/file', 'PUT', body);

    // No computedBodyHash — skips the body integrity check
    const result = checkPeerAuth(req, makeTrustStore());
    expect(result).toBe(true);
  });

  it('rejects when the shared secret is wrong', () => {
    const body = JSON.stringify({ data: 'test' });
    const req = buildSignedRequest('/api/context/file', 'PUT', body);
    const computedHash = createHash('sha256').update(body).digest('hex');

    const result = checkPeerAuth(
      req,
      makeTrustStore('wrong-secret-xxxxxxxxxx!'),
      computedHash,
    );
    expect(result).toBe(false);
  });

  it('rejects when no peer secret is stored', () => {
    const body = JSON.stringify({ data: 'test' });
    const req = buildSignedRequest('/api/context/file', 'PUT', body);
    const computedHash = createHash('sha256').update(body).digest('hex');

    const result = checkPeerAuth(req, makeTrustStore(null), computedHash);
    expect(result).toBe(false);
  });

  it('rejects when required auth headers are missing', () => {
    const req = new Request('http://localhost/api/context/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const computedHash = createHash('sha256').update('{}').digest('hex');

    const result = checkPeerAuth(req, makeTrustStore(), computedHash);
    expect(result).toBe(false);
  });

  it('rejects a replayed request with duplicate nonce', () => {
    const body = JSON.stringify({ data: 'test' });
    const req = buildSignedRequest('/api/context/file', 'PUT', body);
    const computedHash = createHash('sha256').update(body).digest('hex');

    // First call should succeed
    const first = checkPeerAuth(req, makeTrustStore(), computedHash);
    expect(first).toBe(true);

    // Replaying the exact same request (same nonce) should fail
    const replay = checkPeerAuth(req, makeTrustStore(), computedHash);
    expect(replay).toBe(false);
  });

  it('proxies trusted peer log streams', async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'event: log\ndata: {"level":"info","msg":"remote log"}\n\n',
                ),
              );
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
          },
        ),
      ),
    ) as unknown as typeof fetch;

    const req = new Request(
      'http://localhost/api/discovery/peers/peer-1/logs',
      {
        method: 'GET',
      },
    );

    const ctx = makeContext({
      trustStore: {
        getPeer: () => ({
          status: 'trusted',
          sharedSecret: 'secret',
          host: '127.0.0.1',
          port: 6001,
        }),
        updatePeerLastSeen: () => {},
      } as any,
    });

    const res = await handleDiscoveryRequest(req, new URL(req.url), ctx);
    expect(res).not.toBeNull();
    expect((res as Response).headers.get('Content-Type')).toContain(
      'text/event-stream',
    );
    const body = await (res as Response).text();
    expect(body).toContain('event: log');
    expect(body).toContain('remote log');
  });

  it('caps concurrent proxied peer log streams and releases slots on cancel', async () => {
    let streamCalls = 0;
    const ctx = makeContext({
      trustStore: {
        getPeer: () => ({
          instanceId: 'peer-1',
          status: 'trusted',
          sharedSecret: 'secret',
          host: '127.0.0.1',
          port: 6001,
        }),
        updatePeerLastSeen: () => {},
      } as any,
      createPeerClient: () => ({
        getAgents: async () => [],
        getStats: async () => ({}),
        streamLogs: async () => {
          streamCalls += 1;
          return new Response(new ReadableStream<Uint8Array>(), {
            headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
          });
        },
        getContextLayers: async () => ({}),
        listContextFiles: async () => [],
        writeContextFile: async () => ({ ok: true }),
      }),
    });

    const responses: Response[] = [];
    try {
      for (let i = 0; i < 100; i += 1) {
        const req = new Request(
          'http://localhost/api/discovery/peers/peer-1/logs',
          { method: 'GET' },
        );
        const res = await handleDiscoveryRequest(req, new URL(req.url), ctx);
        expect(res).not.toBeNull();
        responses.push(res as Response);
      }

      const cappedReq = new Request(
        'http://localhost/api/discovery/peers/peer-1/logs',
        { method: 'GET' },
      );
      const capped = (await handleDiscoveryRequest(
        cappedReq,
        new URL(cappedReq.url),
        ctx,
      )) as Response;

      expect(capped.status).toBe(429);
      expect(await capped.text()).toContain(
        'Too many proxied log stream connections',
      );
      expect(streamCalls).toBe(100);
    } finally {
      await Promise.all(responses.map((response) => response.body?.cancel()));
    }

    const retryReq = new Request(
      'http://localhost/api/discovery/peers/peer-1/logs',
      { method: 'GET' },
    );
    const retry = (await handleDiscoveryRequest(
      retryReq,
      new URL(retryReq.url),
      ctx,
    )) as Response;
    expect(retry.status).toBe(200);
    await retry.body?.cancel();
    expect(streamCalls).toBe(101);
  });

  it('returns SSE error event when peer is not trusted for log stream', async () => {
    const req = new Request(
      'http://localhost/api/discovery/peers/unknown-peer/logs',
      { method: 'GET' },
    );

    const ctx = makeContext({
      trustStore: {
        getPeer: () => null,
        updatePeerLastSeen: () => {},
      } as any,
    });

    const res = await handleDiscoveryRequest(req, new URL(req.url), ctx);
    expect(res).not.toBeNull();
    const response = res as Response;
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    const body = await response.text();
    expect(body).toContain('event: error');
    expect(body).toContain('Unknown peer');
  });

  it('returns SSE error event when remote access is not allowed for log stream', async () => {
    const req = new Request(
      'http://localhost/api/discovery/peers/peer-1/logs',
      { method: 'GET' },
    );

    const ctx = makeContext({
      trustStore: {
        getPeer: () => ({
          status: 'trusted',
          sharedSecret: 'secret',
          host: '127.0.0.1',
          port: 6001,
        }),
        updatePeerLastSeen: () => {},
      } as any,
      runtime: { isRemoteAccessAllowed: () => false } as any,
    });

    const res = await handleDiscoveryRequest(req, new URL(req.url), ctx);
    expect(res).not.toBeNull();
    const response = res as Response;
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    const body = await response.text();
    expect(body).toContain('event: error');
    expect(body).toContain('Remote access not allowed');
  });

  it('returns JSON error with reason for context layers when peer unavailable', async () => {
    const req = new Request(
      'http://localhost/api/discovery/peers/unknown-peer/context/layers?folder=test',
      { method: 'GET' },
    );

    const ctx = makeContext({
      trustStore: {
        getPeer: () => null,
        updatePeerLastSeen: () => {},
      } as any,
    });

    const res = await handleDiscoveryRequest(req, new URL(req.url), ctx);
    expect(res).not.toBeNull();
    const response = res as Response;
    expect(response.status).toBe(403);
    const data = (await response.json()) as { error: string };
    expect(data.error).toBe('Unknown peer');
  });

  it('returns JSON error with reason for context write when peer unavailable', async () => {
    const req = new Request(
      'http://localhost/api/discovery/peers/unknown-peer/context/file',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'test/CLAUDE.md', content: 'hello' }),
      },
    );

    const ctx = makeContext({
      trustStore: {
        getPeer: () => null,
        updatePeerLastSeen: () => {},
      } as any,
    });

    const res = await handleDiscoveryRequest(req, new URL(req.url), ctx);
    expect(res).not.toBeNull();
    const response = res as Response;
    expect(response.status).toBe(403);
    const data = (await response.json()) as { error: string };
    expect(data.error).toBe('Unknown peer');
  });

  it('rejects oversized proxied context writes before calling the peer client', async () => {
    let writeCalls = 0;
    const req = new Request(
      'http://localhost/api/discovery/peers/peer-1/context/file',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: 'test/CLAUDE.md',
          content: 'x'.repeat(1024 * 1024 + 64),
        }),
      },
    );

    const ctx = makeContext({
      trustStore: {
        getPeer: () => ({
          instanceId: 'peer-1',
          status: 'trusted',
          sharedSecret: 'secret',
          host: '127.0.0.1',
          port: 6001,
        }),
        updatePeerLastSeen: () => {},
      } as any,
      createPeerClient: () => ({
        getAgents: async () => [],
        getStats: async () => ({}),
        streamLogs: async () => new Response(''),
        getContextLayers: async () => ({}),
        listContextFiles: async () => [],
        writeContextFile: async () => {
          writeCalls += 1;
          return { ok: true };
        },
      }),
    });

    const res = await handleDiscoveryRequest(req, new URL(req.url), ctx);
    expect(res).not.toBeNull();
    const response = res as Response;
    expect(response.status).toBe(413);
    expect((await response.json()) as { error: string }).toEqual({
      error: 'Request body too large',
    });
    expect(writeCalls).toBe(0);
  });

  it('uses an injected peer client override when provided', async () => {
    const req = new Request(
      'http://localhost/api/discovery/peers/peer-1/agents',
      {
        method: 'GET',
      },
    );

    const ctx = makeContext({
      trustStore: {
        getPeer: () => ({
          instanceId: 'peer-1',
          status: 'trusted',
          sharedSecret: 'secret',
          host: '127.0.0.1',
          port: 6001,
        }),
        updatePeerLastSeen: () => {},
      } as any,
      createPeerClient: () => ({
        getAgents: async () => [
          {
            id: 'remote-1',
            name: 'Remote Agent',
            folder: 'remote-1',
            backend: 'sprites',
            agentRuntime: 'opencode',
            channels: [],
          },
        ],
        getStats: async () => ({}),
        streamLogs: async () => new Response(''),
        getContextLayers: async () => ({}),
        listContextFiles: async () => [],
        writeContextFile: async () => ({ ok: true }),
      }),
    });

    const res = await handleDiscoveryRequest(req, new URL(req.url), ctx);
    expect(res).not.toBeNull();
    expect(await (res as Response).json()).toEqual([
      {
        id: 'remote-1',
        name: 'Remote Agent',
        folder: 'remote-1',
        backend: 'sprites',
        agentRuntime: 'opencode',
        channels: [],
      },
    ]);
  });
});
