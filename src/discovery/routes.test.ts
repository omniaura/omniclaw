import { createHash, createHmac, randomUUID } from 'crypto';
import { afterEach, describe, expect, it, mock } from 'bun:test';

import {
  checkPeerAuth,
  handleDiscoveryRequest,
  type DiscoveryRouteContext,
} from './routes.js';

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

afterEach(() => {
  mock.restore();
  globalThis.fetch = realFetch;
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
        keyAgreementPublicKey: 'test-public-key',
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
});
