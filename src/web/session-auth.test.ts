import { describe, it, expect, afterEach, spyOn } from 'bun:test';

import {
  createSessionStore,
  parseSessionCookie,
  makeSessionCookie,
  makeClearSessionCookie,
  verifyPassword,
  isAuthExemptPath,
  renderLoginPage,
} from './session-auth.js';
import { startWebServer, type WebServerHandle } from './server.js';
import type { WebStateProvider, QueueStats } from './types.js';
import type { Agent, ChannelSubscription, ScheduledTask } from '../types.js';

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
    setAgentModel: () => true,
    ...overrides,
  };
}

// ---- Unit tests for session store ----

describe('SessionStore', () => {
  it('creates and validates sessions', () => {
    const store = createSessionStore();
    const token = store.create();
    expect(token).toBeString();
    expect(token.length).toBe(64); // 32 bytes hex
    expect(store.validate(token)).toBe(true);
    expect(store.size).toBe(1);
  });

  it('rejects invalid tokens', () => {
    const store = createSessionStore();
    expect(store.validate('')).toBe(false);
    expect(store.validate('nonexistent-token')).toBe(false);
  });

  it('revokes sessions', () => {
    const store = createSessionStore();
    const token = store.create();
    expect(store.validate(token)).toBe(true);
    store.revoke(token);
    expect(store.validate(token)).toBe(false);
    expect(store.size).toBe(0);
  });

  it('handles multiple sessions', () => {
    const store = createSessionStore();
    const t1 = store.create();
    const t2 = store.create();
    const t3 = store.create();
    expect(store.size).toBe(3);
    expect(store.validate(t1)).toBe(true);
    expect(store.validate(t2)).toBe(true);
    expect(store.validate(t3)).toBe(true);
    store.revoke(t2);
    expect(store.validate(t1)).toBe(true);
    expect(store.validate(t2)).toBe(false);
    expect(store.validate(t3)).toBe(true);
  });

  it('purges expired sessions', () => {
    const store = createSessionStore();
    const token = store.create();
    expect(store.validate(token)).toBe(true);
    // Manually expire by manipulating time isn't feasible here,
    // but we can verify purge runs without errors
    store.purge();
    expect(store.validate(token)).toBe(true);
  });

  it('invalidates expired sessions during validation and purge', () => {
    const now = spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000);
      const store = createSessionStore();
      const token = store.create();
      const purgeToken = store.create();
      expect(store.size).toBe(2);

      // Advance to exactly expiresAt to cover the <= expiry boundary.
      now.mockReturnValue(1_000 + 24 * 60 * 60 * 1000);
      expect(store.validate(token)).toBe(false);
      expect(store.size).toBe(1);

      store.purge();
      expect(store.validate(purgeToken)).toBe(false);
      expect(store.size).toBe(0);
    } finally {
      now.mockRestore();
    }
  });

  it('evicts the oldest session when the store reaches capacity', () => {
    const now = spyOn(Date, 'now');
    try {
      const store = createSessionStore();
      const tokens: string[] = [];

      for (let i = 0; i < 100; i++) {
        now.mockReturnValue(10_000 + i);
        tokens.push(store.create());
      }

      now.mockReturnValue(20_000);
      const newest = store.create();

      expect(store.size).toBe(100);
      expect(store.validate(tokens[0])).toBe(false);
      expect(store.validate(tokens[1])).toBe(true);
      expect(store.validate(newest)).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it('purges expired sessions before evicting at capacity', () => {
    const now = spyOn(Date, 'now');
    try {
      const store = createSessionStore();
      const tokens: string[] = [];

      for (let i = 0; i < 100; i++) {
        now.mockReturnValue(10_000 + i);
        tokens.push(store.create());
      }

      now.mockReturnValue(10_000 + 99 + 24 * 60 * 60 * 1000);
      const newest = store.create();

      expect(store.size).toBe(1);
      expect(store.validate(tokens[0]!)).toBe(false);
      expect(store.validate(tokens[99]!)).toBe(false);
      expect(store.validate(newest)).toBe(true);
    } finally {
      now.mockRestore();
    }
  });
});

// ---- Unit tests for cookie helpers ----

describe('parseSessionCookie', () => {
  it('returns null for missing header', () => {
    expect(parseSessionCookie(null)).toBeNull();
  });

  it('returns null for empty header', () => {
    expect(parseSessionCookie('')).toBeNull();
  });

  it('extracts session token from single cookie', () => {
    expect(parseSessionCookie('omniclaw_session=abc123')).toBe('abc123');
  });

  it('extracts session token from multiple cookies', () => {
    expect(
      parseSessionCookie('other=val; omniclaw_session=xyz789; foo=bar'),
    ).toBe('xyz789');
  });

  it('returns null when session cookie is missing', () => {
    expect(parseSessionCookie('other=val; foo=bar')).toBeNull();
  });
});

describe('makeSessionCookie', () => {
  it('builds a proper Set-Cookie header', () => {
    const cookie = makeSessionCookie('token123');
    expect(cookie).toContain('omniclaw_session=token123');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=');
  });
});

describe('makeClearSessionCookie', () => {
  it('clears the session cookie', () => {
    const cookie = makeClearSessionCookie();
    expect(cookie).toContain('omniclaw_session=');
    expect(cookie).toContain('Max-Age=0');
  });
});

// ---- Unit tests for password verification ----

describe('verifyPassword', () => {
  it('returns true for matching passwords', () => {
    expect(verifyPassword('secret', 'secret')).toBe(true);
  });

  it('returns false for non-matching passwords', () => {
    expect(verifyPassword('wrong', 'secret')).toBe(false);
  });

  it('returns false for different length passwords', () => {
    expect(verifyPassword('short', 'muchlongerpassword')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(verifyPassword('', '')).toBe(true);
    expect(verifyPassword('', 'notempty')).toBe(false);
  });
});

// ---- Unit tests for path exemption ----

describe('isAuthExemptPath', () => {
  it('exempts login and logout', () => {
    expect(isAuthExemptPath('/login')).toBe(true);
    expect(isAuthExemptPath('/logout')).toBe(true);
  });

  it('does not exempt other paths', () => {
    expect(isAuthExemptPath('/')).toBe(false);
    expect(isAuthExemptPath('/api/agents')).toBe(false);
    expect(isAuthExemptPath('/agents')).toBe(false);
  });
});

// ---- Unit tests for login page rendering ----

describe('renderLoginPage', () => {
  it('renders a login form', () => {
    const html = renderLoginPage();
    expect(html).toContain('<form');
    expect(html).toContain('action="/login"');
    expect(html).toContain('type="password"');
    expect(html).toContain('Sign In');
    expect(html).toContain('omniclaw');
  });

  it('renders an error message when provided', () => {
    const html = renderLoginPage('Invalid password');
    expect(html).toContain('Invalid password');
    expect(html).toContain('login-error');
  });

  it('escapes HTML in error messages', () => {
    const html = renderLoginPage('<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ---- Integration tests for session auth middleware ----

const TEST_PASSWORD = 'test-secret-password';
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

describe('session auth middleware', () => {
  it('redirects unauthenticated page requests to /login', async () => {
    handle = startWebServer(
      { port: 0, sessionPassword: TEST_PASSWORD },
      makeState(),
    );
    const res = await fetch(serverUrl('/'), { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login');
  });

  it('returns 401 JSON for unauthenticated API requests', async () => {
    handle = startWebServer(
      { port: 0, sessionPassword: TEST_PASSWORD },
      makeState(),
    );
    const res = await fetch(serverUrl('/api/agents'));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('serves the login page on GET /login', async () => {
    handle = startWebServer(
      { port: 0, sessionPassword: TEST_PASSWORD },
      makeState(),
    );
    const res = await fetch(serverUrl('/login'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Sign In');
    expect(html).toContain('action="/login"');
  });

  it('rejects wrong password on POST /login', async () => {
    handle = startWebServer(
      { port: 0, sessionPassword: TEST_PASSWORD },
      makeState(),
    );
    const form = new URLSearchParams();
    form.set('password', 'wrong-password');
    const res = await fetch(serverUrl('/login'), {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain('Invalid password');
  });

  it('sets session cookie on correct password', async () => {
    handle = startWebServer(
      { port: 0, sessionPassword: TEST_PASSWORD },
      makeState(),
    );
    const form = new URLSearchParams();
    form.set('password', TEST_PASSWORD);
    const res = await fetch(serverUrl('/login'), {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/');
    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toContain('omniclaw_session=');
    expect(setCookie).toContain('HttpOnly');
  });

  it('rejects oversized login bodies with 413', async () => {
    handle = startWebServer(
      { port: 0, sessionPassword: TEST_PASSWORD },
      makeState(),
    );

    const oversizedBody = `password=${'x'.repeat(1024 * 1024 + 64)}`;
    const res = await fetch(serverUrl('/login'), {
      method: 'POST',
      body: oversizedBody,
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      redirect: 'manual',
    });

    expect(res.status).toBe(413);
    expect(await res.text()).toBe('Request body too large');
  });

  it('rejects oversized streamed login bodies without content-length', async () => {
    handle = startWebServer(
      { port: 0, sessionPassword: TEST_PASSWORD },
      makeState(),
    );

    const res = await fetch(serverUrl('/login'), {
      method: 'POST',
      duplex: 'half',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('password='));
          controller.enqueue(
            new TextEncoder().encode('x'.repeat(1024 * 1024 + 64)),
          );
          controller.close();
        },
      }),
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      redirect: 'manual',
    });

    expect(res.status).toBe(413);
    expect(await res.text()).toBe('Request body too large');
  });

  it('allows authenticated requests with session cookie', async () => {
    handle = startWebServer(
      { port: 0, sessionPassword: TEST_PASSWORD },
      makeState(),
    );

    // Login to get a session cookie
    const form = new URLSearchParams();
    form.set('password', TEST_PASSWORD);
    const loginRes = await fetch(serverUrl('/login'), {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    const setCookie = loginRes.headers.get('Set-Cookie')!;
    const cookieValue = setCookie.split(';')[0]; // omniclaw_session=<token>

    // Access a protected route with the session cookie
    const res = await fetch(serverUrl('/api/health'), {
      headers: { Cookie: cookieValue },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('agents');
  });

  it('logout clears session and redirects to login', async () => {
    handle = startWebServer(
      { port: 0, sessionPassword: TEST_PASSWORD },
      makeState(),
    );

    // Login first
    const form = new URLSearchParams();
    form.set('password', TEST_PASSWORD);
    const loginRes = await fetch(serverUrl('/login'), {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    const setCookie = loginRes.headers.get('Set-Cookie')!;
    const cookieValue = setCookie.split(';')[0];

    // Logout
    const logoutRes = await fetch(serverUrl('/logout'), {
      headers: { Cookie: cookieValue },
      redirect: 'manual',
    });
    expect(logoutRes.status).toBe(302);
    expect(logoutRes.headers.get('Location')).toBe('/login');
    expect(logoutRes.headers.get('Set-Cookie')).toContain('Max-Age=0');

    // Session should now be invalid
    const afterLogout = await fetch(serverUrl('/'), {
      headers: { Cookie: cookieValue },
      redirect: 'manual',
    });
    expect(afterLogout.status).toBe(302);
    expect(afterLogout.headers.get('Location')).toBe('/login');
  });

  it('skips auth when sessionPassword is not configured', async () => {
    handle = startWebServer({ port: 0 }, makeState());
    const res = await fetch(serverUrl('/api/health'));
    expect(res.status).toBe(200);
  });

  it('session auth takes precedence over Basic Auth when both configured', async () => {
    handle = startWebServer(
      {
        port: 0,
        auth: { username: 'admin', password: 'basic-secret' },
        sessionPassword: TEST_PASSWORD,
      },
      makeState(),
    );

    // Basic Auth alone should NOT work when session auth is enabled
    const basicRes = await fetch(serverUrl('/'), {
      headers: { Authorization: `Basic ${btoa('admin:basic-secret')}` },
      redirect: 'manual',
    });
    expect(basicRes.status).toBe(302);
    expect(basicRes.headers.get('Location')).toBe('/login');

    // Session auth should work
    const form = new URLSearchParams();
    form.set('password', TEST_PASSWORD);
    const loginRes = await fetch(serverUrl('/login'), {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    expect(loginRes.status).toBe(302);
    expect(loginRes.headers.get('Location')).toBe('/');
  });

  it('allows access to the full dashboard page when authenticated', async () => {
    handle = startWebServer(
      { port: 0, sessionPassword: TEST_PASSWORD },
      makeState(),
    );

    // Login
    const form = new URLSearchParams();
    form.set('password', TEST_PASSWORD);
    const loginRes = await fetch(serverUrl('/login'), {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    const cookieValue = loginRes.headers.get('Set-Cookie')!.split(';')[0];

    // Access dashboard
    const res = await fetch(serverUrl('/'), {
      headers: { Cookie: cookieValue },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('omniclaw');
    expect(html).toContain('Dashboard');
  });
});
