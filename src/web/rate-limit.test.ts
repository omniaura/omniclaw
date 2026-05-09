import { describe, it, expect, afterEach } from 'bun:test';

import { createRateLimiter } from './rate-limit.js';
import { startWebServer, type WebServerHandle } from './server.js';
import type { WebStateProvider, QueueStats } from './types.js';
import type { Agent } from '../types.js';

// ---- Fixtures ----

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

const defaultStats: QueueStats = {
  activeContainers: 0,
  idleContainers: 0,
  maxActive: 8,
  maxIdle: 4,
};

function makeState(
  overrides: Partial<WebStateProvider> = {},
): WebStateProvider {
  return {
    getAgents: () => ({ 'test-agent': makeAgent() }),
    getChannelSubscriptions: () => ({}),
    getTasks: () => [],
    getTaskById: () => undefined,
    getMessages: () => [],
    getChats: () => [],
    getQueueStats: () => defaultStats,
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
    setAgentEnabled: () => true,
    ...overrides,
  };
}

// ---- Unit tests for rate limiter ----

describe('RateLimiter', () => {
  it('allows requests under the threshold', () => {
    const limiter = createRateLimiter({ maxAttempts: 3, windowMs: 60_000 });
    expect(limiter.isBlocked('1.2.3.4')).toBe(false);
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4')).toBe(false);
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4')).toBe(false);
    limiter.dispose();
  });

  it('blocks after reaching the threshold', () => {
    const limiter = createRateLimiter({ maxAttempts: 3, windowMs: 60_000 });
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    const blocked = limiter.recordFailure('1.2.3.4');
    expect(blocked).toBe(true);
    expect(limiter.isBlocked('1.2.3.4')).toBe(true);
    limiter.dispose();
  });

  it('tracks IPs independently', () => {
    const limiter = createRateLimiter({ maxAttempts: 2, windowMs: 60_000 });
    limiter.recordFailure('1.1.1.1');
    limiter.recordFailure('1.1.1.1');
    expect(limiter.isBlocked('1.1.1.1')).toBe(true);
    expect(limiter.isBlocked('2.2.2.2')).toBe(false);
    expect(limiter.size).toBe(1);
    limiter.dispose();
  });

  it('resets the counter for an IP', () => {
    const limiter = createRateLimiter({ maxAttempts: 2, windowMs: 60_000 });
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4')).toBe(true);
    limiter.reset('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4')).toBe(false);
    expect(limiter.size).toBe(0);
    limiter.dispose();
  });

  it('returns a positive retryAfter for blocked IPs', () => {
    const limiter = createRateLimiter({ maxAttempts: 1, windowMs: 30_000 });
    limiter.recordFailure('1.2.3.4');
    const seconds = limiter.retryAfter('1.2.3.4');
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(30);
    limiter.dispose();
  });

  it('returns 0 retryAfter for non-blocked IPs', () => {
    const limiter = createRateLimiter({ maxAttempts: 5, windowMs: 60_000 });
    expect(limiter.retryAfter('1.2.3.4')).toBe(0);
    limiter.recordFailure('1.2.3.4');
    expect(limiter.retryAfter('1.2.3.4')).toBe(0);
    limiter.dispose();
  });

  it('expires entries after the window elapses', () => {
    // Use a very short window to test expiry
    const limiter = createRateLimiter({ maxAttempts: 1, windowMs: 1 });
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4')).toBe(true);

    // Wait for the window to expire
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy-wait a few ms
    }
    expect(limiter.isBlocked('1.2.3.4')).toBe(false);
    limiter.dispose();
  });

  it('cleanup removes stale entries', () => {
    const limiter = createRateLimiter({ maxAttempts: 1, windowMs: 1 });
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('5.6.7.8');
    expect(limiter.size).toBe(2);

    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy-wait
    }
    limiter.cleanup();
    expect(limiter.size).toBe(0);
    limiter.dispose();
  });

  it('uses default config when none provided', () => {
    const limiter = createRateLimiter();
    // Default is 5 attempts — should not block after 4 failures
    for (let i = 0; i < 4; i++) {
      limiter.recordFailure('1.2.3.4');
    }
    expect(limiter.isBlocked('1.2.3.4')).toBe(false);
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4')).toBe(true);
    limiter.dispose();
  });
});

// ---- Integration tests for rate limiting on /login ----

const TEST_PASSWORD = 'rate-limit-test-pwd';
let handle: WebServerHandle | null = null;

afterEach(async () => {
  if (handle) {
    await handle.stop();
    handle = null;
  }
});

function serverUrl(path: string): string {
  return `http://localhost:${handle!.port}${path}`;
}

async function postLogin(password: string): Promise<Response> {
  const form = new URLSearchParams();
  form.set('password', password);
  return fetch(serverUrl('/login'), {
    method: 'POST',
    body: form,
    redirect: 'manual',
  });
}

describe('login rate limiting', () => {
  it('returns 429 after too many failed login attempts', async () => {
    handle = startWebServer(
      { port: 0, sessionPassword: TEST_PASSWORD },
      makeState(),
    );

    // Exhaust the rate limit (default: 5 failures)
    for (let i = 0; i < 5; i++) {
      const res = await postLogin('wrong-password');
      expect(res.status).toBe(401);
      await res.text(); // drain body
    }

    // Next attempt should be rate-limited
    const blocked = await postLogin('wrong-password');
    expect(blocked.status).toBe(429);
    const html = await blocked.text();
    expect(html).toContain('Too many failed attempts');
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('blocks even correct password when rate-limited', async () => {
    handle = startWebServer(
      { port: 0, sessionPassword: TEST_PASSWORD },
      makeState(),
    );

    // Exhaust the rate limit
    for (let i = 0; i < 5; i++) {
      const res = await postLogin('wrong');
      await res.text();
    }

    // Correct password should still be rejected with 429
    const blocked = await postLogin(TEST_PASSWORD);
    expect(blocked.status).toBe(429);
    await blocked.text();
  });

  it('resets rate limit after successful login', async () => {
    handle = startWebServer(
      { port: 0, sessionPassword: TEST_PASSWORD },
      makeState(),
    );

    // 4 failures (under the threshold)
    for (let i = 0; i < 4; i++) {
      const res = await postLogin('wrong');
      await res.text();
    }

    // Successful login resets the counter
    const success = await postLogin(TEST_PASSWORD);
    expect(success.status).toBe(302);
    await success.text();

    // Should be able to fail again without being blocked
    const afterReset = await postLogin('wrong');
    expect(afterReset.status).toBe(401);
    await afterReset.text();
  });

  it('shows rate limit message on GET /login when blocked', async () => {
    handle = startWebServer(
      { port: 0, sessionPassword: TEST_PASSWORD },
      makeState(),
    );

    // Exhaust the rate limit
    for (let i = 0; i < 5; i++) {
      const res = await postLogin('wrong');
      await res.text();
    }

    // GET /login should also show the rate limit message
    const getRes = await fetch(serverUrl('/login'));
    expect(getRes.status).toBe(429);
    const html = await getRes.text();
    expect(html).toContain('Too many failed attempts');
    expect(getRes.headers.get('Retry-After')).toBeTruthy();
  });

  it('does not rate limit when session auth is disabled', async () => {
    handle = startWebServer({ port: 0 }, makeState());
    // Without sessionPassword, /login is not handled by session auth, so the
    // login limiter is bypassed instead of returning 429 after repeated posts.
    for (let i = 0; i < 6; i++) {
      const res = await postLogin('wrong-password');
      expect(res.status).not.toBe(429);
      await res.text();
    }
  });
});
