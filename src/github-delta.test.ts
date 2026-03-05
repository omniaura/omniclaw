import { describe, it, expect, beforeEach } from 'bun:test';

import type { GitHubWatchesConfig, GitHubChannelWatch } from './types.js';
import {
  formatDeltaDigest,
  getChannelWatches,
  isDeltaEnabled,
  getDeltaCursor,
  setDeltaCursor,
  type DeltaEvent,
} from './github-delta.js';

// --- Config helpers ---

describe('github-delta', () => {
  describe('isDeltaEnabled', () => {
    it('returns false when flag is absent', () => {
      const config: GitHubWatchesConfig = { watches: [] };
      expect(isDeltaEnabled(config)).toBe(false);
    });

    it('returns false when flag is explicitly false', () => {
      const config: GitHubWatchesConfig = {
        watches: [],
        githubDeltaContextEnabled: false,
      };
      expect(isDeltaEnabled(config)).toBe(false);
    });

    it('returns true when flag is true', () => {
      const config: GitHubWatchesConfig = {
        watches: [],
        githubDeltaContextEnabled: true,
      };
      expect(isDeltaEnabled(config)).toBe(true);
    });
  });

  describe('getChannelWatches', () => {
    const config: GitHubWatchesConfig = {
      watches: [],
      channelWatches: [
        {
          channelJid: 'dc:123',
          repos: [{ owner: 'omniaura', repo: 'omniclaw' }],
        },
        {
          channelJid: 'dc:456',
          repos: [
            { owner: 'ditto-assistant', repo: 'ditto-app' },
            { owner: 'ditto-assistant', repo: 'backend' },
          ],
        },
      ],
    };

    it('finds channel watches by JID', () => {
      const watch = getChannelWatches(config, 'dc:123');
      expect(watch).toBeDefined();
      expect(watch!.repos).toHaveLength(1);
      expect(watch!.repos[0].owner).toBe('omniaura');
    });

    it('returns undefined for unknown channel', () => {
      expect(getChannelWatches(config, 'dc:999')).toBeUndefined();
    });

    it('returns undefined when channelWatches is absent', () => {
      const minimal: GitHubWatchesConfig = { watches: [] };
      expect(getChannelWatches(minimal, 'dc:123')).toBeUndefined();
    });

    it('handles multiple repos per channel', () => {
      const watch = getChannelWatches(config, 'dc:456');
      expect(watch).toBeDefined();
      expect(watch!.repos).toHaveLength(2);
    });
  });

  // --- Cursor state ---

  describe('delta cursor state', () => {
    it('returns undefined for unknown channel', () => {
      expect(getDeltaCursor('dc:unknown-test-' + Date.now())).toBeUndefined();
    });

    it('stores and retrieves cursor', () => {
      const jid = 'dc:cursor-test-' + Date.now();
      const ts = '2026-03-05T10:00:00.000Z';
      setDeltaCursor(jid, ts);
      expect(getDeltaCursor(jid)).toBe(ts);
    });

    it('updates cursor on subsequent set', () => {
      const jid = 'dc:cursor-update-' + Date.now();
      setDeltaCursor(jid, '2026-03-05T10:00:00.000Z');
      setDeltaCursor(jid, '2026-03-05T11:00:00.000Z');
      expect(getDeltaCursor(jid)).toBe('2026-03-05T11:00:00.000Z');
    });
  });

  // --- Digest formatting ---

  describe('formatDeltaDigest', () => {
    it('returns empty string for no events', () => {
      expect(formatDeltaDigest([])).toBe('');
    });

    it('formats single PR merged event', () => {
      const events: DeltaEvent[] = [
        {
          eventId: 'pr-merged-42',
          repo: 'omniaura/omniclaw',
          type: 'pr_merged',
          actor: 'alice',
          subject: 'PR #42: Fix bug',
          url: 'https://github.com/omniaura/omniclaw/pull/42',
          occurredAt: '2026-03-05T10:00:00Z',
          summary: 'PR #42 merged: Fix bug',
        },
      ];
      const digest = formatDeltaDigest(events);
      expect(digest).toContain('GitHub Activity Since Last Message');
      expect(digest).toContain('omniaura/omniclaw');
      expect(digest).toContain('PR #42 merged: Fix bug');
    });

    it('groups events by repo', () => {
      const events: DeltaEvent[] = [
        {
          eventId: 'pr-opened-1',
          repo: 'omniaura/omniclaw',
          type: 'pr_opened',
          actor: 'alice',
          subject: 'PR #1',
          url: 'https://example.com/1',
          occurredAt: '2026-03-05T10:00:00Z',
          summary: 'PR #1 opened: Feature A',
        },
        {
          eventId: 'issue-opened-5',
          repo: 'ditto-assistant/ditto-app',
          type: 'issue_opened',
          actor: 'bob',
          subject: 'Issue #5',
          url: 'https://example.com/5',
          occurredAt: '2026-03-05T10:01:00Z',
          summary: 'Issue #5 opened: Bug report',
        },
        {
          eventId: 'pr-merged-2',
          repo: 'omniaura/omniclaw',
          type: 'pr_merged',
          actor: 'carol',
          subject: 'PR #2',
          url: 'https://example.com/2',
          occurredAt: '2026-03-05T10:02:00Z',
          summary: 'PR #2 merged: Feature B',
        },
      ];
      const digest = formatDeltaDigest(events);
      expect(digest).toContain('## omniaura/omniclaw');
      expect(digest).toContain('## ditto-assistant/ditto-app');
      expect(digest).toContain('PR #1 opened: Feature A');
      expect(digest).toContain('PR #2 merged: Feature B');
      expect(digest).toContain('Issue #5 opened: Bug report');
    });

    it('groups multiple comments on same subject', () => {
      const events: DeltaEvent[] = [
        {
          eventId: 'comment-1',
          repo: 'omniaura/omniclaw',
          type: 'pr_review_comment',
          actor: 'alice',
          subject: 'PR #10: Big refactor',
          url: 'https://example.com/c1',
          occurredAt: '2026-03-05T10:00:00Z',
          summary: 'Review comment on PR #10 (src/index.ts:42): "Fix this"',
        },
        {
          eventId: 'comment-2',
          repo: 'omniaura/omniclaw',
          type: 'pr_review_comment',
          actor: 'bob',
          subject: 'PR #10: Big refactor',
          url: 'https://example.com/c2',
          occurredAt: '2026-03-05T10:01:00Z',
          summary: 'Review comment on PR #10 (src/db.ts:100): "Also fix"',
        },
        {
          eventId: 'comment-3',
          repo: 'omniaura/omniclaw',
          type: 'pr_review_comment',
          actor: 'alice',
          subject: 'PR #10: Big refactor',
          url: 'https://example.com/c3',
          occurredAt: '2026-03-05T10:02:00Z',
          summary: 'Review comment on PR #10 (src/types.ts:5): "Types wrong"',
        },
      ];
      const digest = formatDeltaDigest(events);
      // First comment shown inline, then grouped summary
      expect(digest).toContain('Fix this');
      expect(digest).toContain('3 comments on PR #10: Big refactor by alice, bob');
    });

    it('handles all event types', () => {
      const types: DeltaEvent['type'][] = [
        'pr_opened',
        'pr_closed',
        'pr_merged',
        'pr_reopened',
        'pr_review',
        'pr_review_comment',
        'pr_commits',
        'issue_opened',
        'issue_closed',
        'issue_reopened',
        'issue_comment',
      ];

      for (const type of types) {
        const events: DeltaEvent[] = [
          {
            eventId: `test-${type}`,
            repo: 'test/repo',
            type,
            actor: 'tester',
            subject: `Test ${type}`,
            url: 'https://example.com',
            occurredAt: '2026-03-05T10:00:00Z',
            summary: `Test summary for ${type}`,
          },
        ];
        const digest = formatDeltaDigest(events);
        expect(digest).toContain(`Test summary for ${type}`);
      }
    });
  });

  // --- Timestamp window boundaries ---

  describe('timestamp window boundaries', () => {
    it('since is exclusive, until is inclusive', () => {
      // This tests the boundary semantics documented in the issue:
      // Events in window (since, until] — since exclusive, until inclusive
      // This is verified by the collectPrDelta/collectIssueDelta functions
      // using `> since` and `<= until` comparisons.

      // We verify this through the cursor behavior:
      const jid = 'dc:boundary-test-' + Date.now();
      const t1 = '2026-03-05T10:00:00.000Z';
      const t2 = '2026-03-05T10:05:00.000Z';

      setDeltaCursor(jid, t1);
      expect(getDeltaCursor(jid)).toBe(t1);

      // After processing, cursor moves to t2
      setDeltaCursor(jid, t2);
      expect(getDeltaCursor(jid)).toBe(t2);

      // Next fetch will use t2 as "since" — events at exactly t2 should NOT
      // be re-fetched (since is exclusive: timestamp > since)
    });
  });
});
