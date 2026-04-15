/**
 * IP-based rate limiting for the login endpoint.
 *
 * Tracks failed login attempts per source IP using a sliding window.
 * After exceeding the threshold, subsequent attempts receive HTTP 429.
 * A successful login resets the counter for that IP.
 */

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const CLEANUP_INTERVAL_MS = 5 * 60_000; // 5 minutes

export interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export interface RateLimitConfig {
  /** Maximum failed attempts before blocking. Default: 5. */
  maxAttempts?: number;
  /** Sliding window duration in milliseconds. Default: 60 000 (1 minute). */
  windowMs?: number;
}

export interface RateLimiter {
  /** Record a failed login attempt. Returns true if the IP is now blocked. */
  recordFailure(ip: string): boolean;
  /** Check whether an IP is currently blocked. */
  isBlocked(ip: string): boolean;
  /** Reset the counter for an IP (call on successful login). */
  reset(ip: string): void;
  /** Seconds until the current window expires for a blocked IP. Returns 0 if not blocked. */
  retryAfter(ip: string): number;
  /** Remove stale entries. */
  cleanup(): void;
  /** Stop the background cleanup timer. */
  dispose(): void;
  /** Number of tracked IPs (for testing). */
  readonly size: number;
}

/**
 * Create an in-memory rate limiter for login attempts.
 */
export function createRateLimiter(config?: RateLimitConfig): RateLimiter {
  const maxAttempts = config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
  const entries = new Map<string, RateLimitEntry>();

  const cleanupTimer = setInterval(() => cleanup(), CLEANUP_INTERVAL_MS);
  // Allow the process to exit without waiting for the timer.
  if (typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    cleanupTimer.unref();
  }

  function getEntry(ip: string, now: number): RateLimitEntry | null {
    const entry = entries.get(ip);
    if (!entry) return null;
    // Window expired — remove and treat as fresh.
    if (now - entry.windowStart >= windowMs) {
      entries.delete(ip);
      return null;
    }
    return entry;
  }

  function cleanup(): void {
    const now = Date.now();
    for (const [ip, entry] of entries) {
      if (now - entry.windowStart >= windowMs) {
        entries.delete(ip);
      }
    }
  }

  return {
    recordFailure(ip: string): boolean {
      const now = Date.now();
      const existing = getEntry(ip, now);
      if (existing) {
        existing.count++;
        return existing.count >= maxAttempts;
      }
      entries.set(ip, { count: 1, windowStart: now });
      return 1 >= maxAttempts;
    },

    isBlocked(ip: string): boolean {
      const now = Date.now();
      const entry = getEntry(ip, now);
      return entry !== null && entry.count >= maxAttempts;
    },

    reset(ip: string): void {
      entries.delete(ip);
    },

    retryAfter(ip: string): number {
      const now = Date.now();
      const entry = getEntry(ip, now);
      if (!entry || entry.count < maxAttempts) return 0;
      const remaining = windowMs - (now - entry.windowStart);
      return Math.max(1, Math.ceil(remaining / 1000));
    },

    cleanup,

    dispose(): void {
      clearInterval(cleanupTimer);
    },

    get size(): number {
      return entries.size;
    },
  };
}
