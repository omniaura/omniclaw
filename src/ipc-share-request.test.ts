import { describe, it, expect, beforeEach } from 'bun:test';

import {
  trackShareRequest,
  consumeShareRequest,
  type PendingShareRequest,
} from './ipc.js';

// We need a fresh map for each test. Since the map is module-level,
// we use consume to drain all tracked entries between tests.
// The functions are pure enough that we test them as-is.

function makeMeta(
  overrides: Partial<PendingShareRequest> = {},
): PendingShareRequest {
  return {
    sourceJid: 'source@g.us',
    sourceName: 'Source Group',
    sourceGroup: 'source-group',
    description: 'Need project context',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('share request tracking', () => {
  // Consume any leftover entries from previous tests
  beforeEach(() => {
    // Clean up by consuming any known test IDs
    for (let i = 0; i < 100; i++) {
      consumeShareRequest(`test-${i}`);
    }
    consumeShareRequest('msg-1');
    consumeShareRequest('msg-2');
    consumeShareRequest('msg-3');
    consumeShareRequest('stale-1');
    consumeShareRequest('fresh-1');
    consumeShareRequest('consume-me');
    consumeShareRequest('once-only');
    consumeShareRequest('tracked');
    consumeShareRequest('nonexistent');
  });

  // --- Basic track/consume ---

  it('tracks a share request and consumes it', () => {
    const meta = makeMeta();
    trackShareRequest('msg-1', meta);

    const result = consumeShareRequest('msg-1');
    expect(result).toBeDefined();
    expect(result!.sourceJid).toBe('source@g.us');
    expect(result!.sourceName).toBe('Source Group');
    expect(result!.description).toBe('Need project context');
  });

  it('consume returns undefined for untracked message ID', () => {
    const result = consumeShareRequest('nonexistent');
    expect(result).toBeUndefined();
  });

  it('consume removes the entry (single-use)', () => {
    trackShareRequest('once-only', makeMeta());

    const first = consumeShareRequest('once-only');
    expect(first).toBeDefined();

    const second = consumeShareRequest('once-only');
    expect(second).toBeUndefined();
  });

  // --- Multiple entries ---

  it('tracks multiple independent share requests', () => {
    trackShareRequest('msg-1', makeMeta({ sourceGroup: 'group-a' }));
    trackShareRequest('msg-2', makeMeta({ sourceGroup: 'group-b' }));

    const a = consumeShareRequest('msg-1');
    const b = consumeShareRequest('msg-2');

    expect(a!.sourceGroup).toBe('group-a');
    expect(b!.sourceGroup).toBe('group-b');
  });

  it('consuming one entry does not affect others', () => {
    trackShareRequest('msg-1', makeMeta({ description: 'first' }));
    trackShareRequest('msg-2', makeMeta({ description: 'second' }));

    consumeShareRequest('msg-1');

    const second = consumeShareRequest('msg-2');
    expect(second).toBeDefined();
    expect(second!.description).toBe('second');
  });

  // --- Overwrite behavior ---

  it('overwrites entry when same message ID is tracked twice', () => {
    trackShareRequest('msg-1', makeMeta({ description: 'original' }));
    trackShareRequest('msg-1', makeMeta({ description: 'updated' }));

    const result = consumeShareRequest('msg-1');
    expect(result!.description).toBe('updated');
  });

  // --- TTL / stale cleanup ---

  it('cleans up stale entries when a new one is tracked', () => {
    // Track a stale entry (timestamp 25 hours ago)
    const staleTimestamp = Date.now() - 25 * 60 * 60 * 1000;
    trackShareRequest('stale-1', makeMeta({ timestamp: staleTimestamp }));

    // Track a fresh entry — this triggers cleanup
    trackShareRequest('fresh-1', makeMeta({ timestamp: Date.now() }));

    // The stale entry should have been cleaned up
    const stale = consumeShareRequest('stale-1');
    expect(stale).toBeUndefined();

    // The fresh entry should still be there
    const fresh = consumeShareRequest('fresh-1');
    expect(fresh).toBeDefined();
  });

  it('preserves entries within the 24-hour TTL', () => {
    // Track an entry just under 24 hours old
    const recentTimestamp = Date.now() - 23 * 60 * 60 * 1000;
    trackShareRequest('msg-1', makeMeta({ timestamp: recentTimestamp }));

    // Track another entry to trigger cleanup
    trackShareRequest('msg-2', makeMeta({ timestamp: Date.now() }));

    // The recent entry should still be present
    const recent = consumeShareRequest('msg-1');
    expect(recent).toBeDefined();
  });

  // --- serverFolder tracking ---

  it('tracks serverFolder when provided', () => {
    trackShareRequest('msg-1', makeMeta({ serverFolder: 'servers/12345' }));

    const result = consumeShareRequest('msg-1');
    expect(result!.serverFolder).toBe('servers/12345');
  });

  it('serverFolder is undefined when not provided', () => {
    trackShareRequest('msg-1', makeMeta());

    const result = consumeShareRequest('msg-1');
    expect(result!.serverFolder).toBeUndefined();
  });
});
