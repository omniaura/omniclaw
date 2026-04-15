import { randomBytes, timingSafeEqual as cryptoTimingSafeEqual } from 'crypto';

import { escapeHtml } from './shared.js';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_TOKEN_BYTES = 32;
const MAX_SESSIONS = 100;
const COOKIE_NAME = 'omniclaw_session';

export interface Session {
  token: string;
  createdAt: number;
  expiresAt: number;
}

export interface SessionStore {
  /** Create a new session and return its token. */
  create(): string;
  /** Validate a session token. Returns true if valid and not expired. */
  validate(token: string): boolean;
  /** Revoke a session by token. */
  revoke(token: string): void;
  /** Purge expired sessions. */
  purge(): void;
  /** Number of active sessions. */
  readonly size: number;
}

/**
 * Create an in-memory session store with automatic expiry.
 */
export function createSessionStore(): SessionStore {
  const sessions = new Map<string, Session>();

  function purge(): void {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) {
        sessions.delete(token);
      }
    }
  }

  return {
    create(): string {
      // Purge expired sessions before creating new ones
      purge();

      // Evict oldest sessions if at capacity
      if (sessions.size >= MAX_SESSIONS) {
        const oldest = [...sessions.entries()].sort(
          ([, a], [, b]) => a.createdAt - b.createdAt,
        );
        const toRemove = oldest.slice(0, sessions.size - MAX_SESSIONS + 1);
        for (const [token] of toRemove) {
          sessions.delete(token);
        }
      }

      const token = randomBytes(SESSION_TOKEN_BYTES).toString('hex');
      const now = Date.now();
      sessions.set(token, {
        token,
        createdAt: now,
        expiresAt: now + SESSION_TTL_MS,
      });
      return token;
    },

    validate(token: string): boolean {
      if (!token || typeof token !== 'string') return false;
      const session = sessions.get(token);
      if (!session) return false;
      if (session.expiresAt <= Date.now()) {
        sessions.delete(token);
        return false;
      }
      return true;
    },

    revoke(token: string): void {
      sessions.delete(token);
    },

    purge,

    get size(): number {
      return sessions.size;
    },
  };
}

/**
 * Parse the session token from a Cookie header.
 */
export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const prefix = `${COOKIE_NAME}=`;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return null;
}

/**
 * Build a Set-Cookie header value for session creation.
 */
export function makeSessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

/**
 * Build a Set-Cookie header value that clears the session cookie.
 */
export function makeClearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/**
 * Constant-time password comparison to prevent timing attacks.
 */
export function verifyPassword(input: string, expected: string): boolean {
  if (typeof input !== 'string' || typeof expected !== 'string') return false;
  const inputBuf = Buffer.from(input);
  const expectedBuf = Buffer.from(expected);
  if (inputBuf.length !== expectedBuf.length) return false;
  return cryptoTimingSafeEqual(inputBuf, expectedBuf);
}

/**
 * Check if a request path should bypass session auth.
 */
export function isAuthExemptPath(pathname: string): boolean {
  return pathname === '/login' || pathname === '/logout';
}

/**
 * Render the login page HTML.
 */
export function renderLoginPage(error?: string): string {
  return (
    `<!DOCTYPE html><html lang="en"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>OmniClaw \u2014 Login</title>` +
    `<link rel="preconnect" href="https://fonts.googleapis.com">` +
    `<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">` +
    `<style>${loginCSS()}</style>` +
    `</head><body>` +
    `<div class="login-container">` +
    `<div class="login-card">` +
    `<div class="login-brand">omniclaw</div>` +
    `<p class="login-subtitle">Agent Management Console</p>` +
    (error ? `<div class="login-error">${escapeHtml(error)}</div>` : '') +
    `<form method="POST" action="/login" class="login-form">` +
    `<label for="password" class="login-label">Password</label>` +
    `<input type="password" id="password" name="password" class="login-input" placeholder="Enter password" autofocus required>` +
    `<button type="submit" class="login-button">Sign In</button>` +
    `</form>` +
    `</div>` +
    `</div>` +
    `</body></html>`
  );
}

function loginCSS(): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'JetBrains Mono', monospace;
      background: #0a0a0f;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-container {
      width: 100%;
      max-width: 400px;
      padding: 1rem;
    }
    .login-card {
      background: #13131a;
      border: 1px solid #2a2a3a;
      border-radius: 12px;
      padding: 2.5rem 2rem;
      text-align: center;
    }
    .login-brand {
      font-size: 1.8rem;
      font-weight: 700;
      color: #a78bfa;
      letter-spacing: 0.05em;
      margin-bottom: 0.25rem;
    }
    .login-subtitle {
      color: #888;
      font-size: 0.8rem;
      margin-bottom: 2rem;
    }
    .login-error {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #f87171;
      padding: 0.6rem 1rem;
      border-radius: 6px;
      font-size: 0.8rem;
      margin-bottom: 1.5rem;
    }
    .login-form { text-align: left; }
    .login-label {
      display: block;
      font-size: 0.75rem;
      color: #999;
      margin-bottom: 0.4rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .login-input {
      width: 100%;
      padding: 0.75rem 1rem;
      background: #1a1a24;
      border: 1px solid #2a2a3a;
      border-radius: 8px;
      color: #e0e0e0;
      font-family: inherit;
      font-size: 0.9rem;
      outline: none;
      transition: border-color 0.15s;
    }
    .login-input:focus { border-color: #a78bfa; }
    .login-button {
      width: 100%;
      margin-top: 1.25rem;
      padding: 0.75rem;
      background: #a78bfa;
      color: #0a0a0f;
      border: none;
      border-radius: 8px;
      font-family: inherit;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    .login-button:hover { background: #8b5cf6; }
  `;
}
