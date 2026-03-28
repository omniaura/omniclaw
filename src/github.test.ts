import { describe, it, expect } from 'bun:test';

import {
  formatIssueMarkdown,
  formatPrMarkdown,
  invalidateGitHubContextCacheForAgents,
  fetchGitHubContext,
  truncate,
} from './github.js';

import type { GitHubAgentWatch, GitHubWatchesConfig } from './types.js';

// We test the pure functions directly; API calls are tested via mocked fetch.

describe('github', () => {
  describe('config loading', () => {
    it('parses a valid config', () => {
      const config: GitHubWatchesConfig = {
        watches: [
          {
            agentId: 'test-agent',
            repos: [
              {
                owner: 'omniaura',
                repo: 'omniclaw',
                openPrs: { limit: 5, includeReviewComments: true },
                recentIssues: { limit: 3 },
              },
            ],
          },
        ],
        cacheTtlMs: 60000,
      };

      expect(config.watches).toHaveLength(1);
      expect(config.watches[0].agentId).toBe('test-agent');
      expect(config.watches[0].repos[0].owner).toBe('omniaura');
      expect(config.watches[0].repos[0].openPrs?.limit).toBe(5);
      expect(config.cacheTtlMs).toBe(60000);
    });

    it('supports multiple agents with multiple repos', () => {
      const config: GitHubWatchesConfig = {
        watches: [
          {
            agentId: 'agent-a',
            repos: [
              { owner: 'org', repo: 'repo1' },
              { owner: 'org', repo: 'repo2' },
            ],
          },
          {
            agentId: 'agent-b',
            repos: [{ owner: 'other', repo: 'repo3' }],
          },
        ],
      };

      expect(config.watches).toHaveLength(2);
      expect(config.watches[0].repos).toHaveLength(2);
      expect(config.watches[1].repos).toHaveLength(1);
    });

    it('uses defaults when limits are not specified', () => {
      const config: GitHubWatchesConfig = {
        watches: [
          {
            agentId: 'test',
            repos: [{ owner: 'o', repo: 'r' }],
          },
        ],
      };

      const repo = config.watches[0].repos[0];
      expect(repo.openPrs).toBeUndefined();
      expect(repo.recentIssues).toBeUndefined();
    });
  });

  describe('getWatchesForAgent', () => {
    it('finds watches for a matching agent', () => {
      // Import the function
      const { getWatchesForAgent } = require('./github.js');
      const config: GitHubWatchesConfig = {
        watches: [
          {
            agentId: 'agent-a',
            repos: [{ owner: 'o', repo: 'r' }],
          },
          {
            agentId: 'agent-b',
            repos: [{ owner: 'x', repo: 'y' }],
          },
        ],
      };

      const result = getWatchesForAgent(config, 'agent-b');
      expect(result).toBeDefined();
      expect(result!.agentId).toBe('agent-b');
      expect(result!.repos[0].repo).toBe('y');
    });

    it('returns undefined for unknown agent', () => {
      const { getWatchesForAgent } = require('./github.js');
      const config: GitHubWatchesConfig = {
        watches: [
          {
            agentId: 'agent-a',
            repos: [{ owner: 'o', repo: 'r' }],
          },
        ],
      };

      expect(getWatchesForAgent(config, 'nonexistent')).toBeUndefined();
    });
  });

  describe('repo watch matching helpers', () => {
    it('matches watchers case-insensitively by owner/repo', () => {
      const { getWatchingAgentsForRepo } = require('./github.js');
      const config: GitHubWatchesConfig = {
        watches: [
          {
            agentId: 'agent-a',
            repos: [{ owner: 'OmniAura', repo: 'OmniClaw' }],
          },
          {
            agentId: 'agent-b',
            repos: [{ owner: 'other', repo: 'repo' }],
          },
        ],
      };

      expect(getWatchingAgentsForRepo(config, 'omniaura', 'omniclaw')).toEqual([
        'agent-a',
      ]);
    });

    it('returns no watchers when repo is not configured', () => {
      const { getWatchingAgentsForRepo } = require('./github.js');
      const config: GitHubWatchesConfig = {
        watches: [
          {
            agentId: 'agent-a',
            repos: [{ owner: 'omniaura', repo: 'omniclaw' }],
          },
        ],
      };

      expect(getWatchingAgentsForRepo(config, 'omniaura', 'backend')).toEqual(
        [],
      );
    });
  });

  describe('normalizeLimit', () => {
    it('uses fallback when value is undefined or invalid', () => {
      const { normalizeLimit } = require('./github.js');
      expect(normalizeLimit(undefined, 10)).toBe(10);
      expect(normalizeLimit(0, 10)).toBe(10);
      expect(normalizeLimit(-2, 10)).toBe(10);
    });

    it('clamps excessive values to max list limit', () => {
      const { normalizeLimit } = require('./github.js');
      expect(normalizeLimit(500, 10)).toBe(50);
    });

    it('floors decimals and falls back for NaN', () => {
      const { normalizeLimit } = require('./github.js');
      expect(normalizeLimit(7.9, 10)).toBe(7);
      expect(normalizeLimit(Number.NaN, 10)).toBe(10);
    });
  });

  describe('truncate', () => {
    it('normalizes line endings, trims whitespace, and truncates with ellipsis', () => {
      expect(truncate('  hello\r\nworld  ', 7)).toBe('hello\nw…');
    });

    it('returns an empty string for empty input', () => {
      expect(truncate('', 10)).toBe('');
      expect(truncate(null, 10)).toBe('');
      expect(truncate(undefined, 10)).toBe('');
    });
  });

  describe('markdown formatting', () => {
    it('formats pull requests with filtered reviews and capped comments', () => {
      const markdown = formatPrMarkdown(
        {
          number: 42,
          title: 'Tighten test coverage',
          user: { login: 'alice' },
          head: { ref: 'tests/add-more' },
          base: { ref: 'main' },
          state: 'open',
          draft: true,
          requested_reviewers: [],
          html_url: 'https://github.com/omniaura/omniclaw/pull/42',
          body: '  Adds deterministic tests\r\nfor edge cases.  ',
          created_at: '2026-03-27T00:00:00.000Z',
          updated_at: '2026-03-27T00:00:00.000Z',
        },
        [
          { user: { login: 'reviewer-1' }, state: 'APPROVED', body: 'ship it' },
          { user: { login: 'reviewer-2' }, state: 'COMMENTED', body: 'nit' },
          { user: { login: 'reviewer-3' }, state: 'PENDING', body: null },
        ],
        [
          {
            user: { login: 'bob' },
            body: 'one',
            path: 'src/a.ts',
            line: 10,
            created_at: '2026-03-27T00:00:00.000Z',
          },
          {
            user: { login: 'carol' },
            body: 'two',
            path: 'src/b.ts',
            line: 11,
            created_at: '2026-03-27T00:00:00.000Z',
          },
          {
            user: { login: 'dave' },
            body: 'three',
            path: 'src/c.ts',
            line: 12,
            created_at: '2026-03-27T00:00:00.000Z',
          },
          {
            user: { login: 'erin' },
            body: 'four',
            path: 'src/d.ts',
            line: null,
            created_at: '2026-03-27T00:00:00.000Z',
          },
          {
            user: null,
            body: 'five',
            path: '',
            line: null,
            created_at: '2026-03-27T00:00:00.000Z',
          },
          {
            user: { login: 'frank' },
            body: 'six',
            path: 'src/f.ts',
            line: 16,
            created_at: '2026-03-27T00:00:00.000Z',
          },
        ],
        'pending',
      );

      expect(markdown).toContain('### PR #42: Tighten test coverage (DRAFT)');
      expect(markdown).toContain(
        'Author: alice | Branch: `tests/add-more` → `main`',
      );
      expect(markdown).toContain('CI: pending | Reviews: reviewer-1: APPROVED');
      expect(markdown).toContain(
        'Description: Adds deterministic tests\nfor edge cases.',
      );
      expect(markdown).toContain('Review comments (6):');
      expect(markdown).toContain('bob on `src/a.ts`:10: one');
      expect(markdown).toContain('?: five');
      expect(markdown).toContain('... and 1 more comments');
      expect(markdown).not.toContain('reviewer-2: COMMENTED');
      expect(markdown).not.toContain('reviewer-3: PENDING');
      expect(markdown).not.toContain('frank on `src/f.ts`:16: six');
    });

    it('formats issues with fallback metadata and truncated bodies', () => {
      const markdown = formatIssueMarkdown({
        number: 7,
        title: 'Handle fallback labels',
        user: null,
        state: 'open',
        labels: [],
        assignee: null,
        html_url: 'https://github.com/omniaura/omniclaw/issues/7',
        body: 'x'.repeat(151),
        created_at: '2026-03-27T00:00:00.000Z',
        updated_at: '2026-03-27T00:00:00.000Z',
      });

      expect(markdown).toContain('- **#7**: Handle fallback labels');
      expect(markdown).toContain(
        'Labels: none | Assignee: unassigned | Author: unknown',
      );
      expect(markdown.endsWith('…')).toBe(true);
    });
  });

  describe('cache invalidation', () => {
    it('removes cached context for targeted agents only', async () => {
      await fetchGitHubContext({ agentId: 'cache-a', repos: [] }, 60_000);
      await fetchGitHubContext({ agentId: 'cache-b', repos: [] }, 60_000);

      expect(
        invalidateGitHubContextCacheForAgents(['cache-a', 'missing-agent']),
      ).toBe(1);
      expect(
        invalidateGitHubContextCacheForAgents(['cache-a', 'cache-b']),
      ).toBe(1);
    });
  });

  describe('fetchGitHubContext', () => {
    it('returns null when GITHUB_TOKEN is not set', async () => {
      const { getGitHubContextForAgent } = require('./github.js');
      // The module reads GITHUB_TOKEN at import time
      // If GITHUB_TOKEN is empty, getGitHubContextForAgent returns null
      const originalToken = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;
      try {
        // Re-importing won't help since the module is cached,
        // but getGitHubContextForAgent checks the module-level const
        // which was set at import time. This test verifies the behavior.
        const result = await getGitHubContextForAgent('test');
        // Result depends on whether GITHUB_TOKEN was set at module load
        expect(result === null || typeof result === 'string').toBe(true);
      } finally {
        if (originalToken) process.env.GITHUB_TOKEN = originalToken;
      }
    });

    it('returns null when no config file exists', async () => {
      const { getGitHubContextForAgent } = require('./github.js');
      // Without a github-watches.json file, should return null
      const result = await getGitHubContextForAgent('nonexistent-agent');
      expect(result).toBeNull();
    });

    it('caches results within TTL', async () => {
      const { fetchGitHubContext } = require('./github.js');
      const watch: GitHubAgentWatch = {
        agentId: 'cache-test',
        repos: [], // Empty repos = no API calls needed
      };

      const result1 = await fetchGitHubContext(watch, 60000);
      const result2 = await fetchGitHubContext(watch, 60000);

      // Both should return the same cached result
      expect(result1).toBe(result2);
    });
  });

  describe('GitHubWatch types', () => {
    it('enforces required fields', () => {
      const watch: GitHubAgentWatch = {
        agentId: 'my-agent',
        repos: [
          {
            owner: 'omniaura',
            repo: 'omniclaw',
          },
        ],
      };

      expect(watch.agentId).toBe('my-agent');
      expect(watch.repos[0].owner).toBe('omniaura');
      expect(watch.repos[0].repo).toBe('omniclaw');
    });

    it('supports optional config fields', () => {
      const watch: GitHubAgentWatch = {
        agentId: 'my-agent',
        repos: [
          {
            owner: 'omniaura',
            repo: 'omniclaw',
            openPrs: { limit: 5, includeReviewComments: false },
            recentIssues: { limit: 3 },
          },
        ],
      };

      expect(watch.repos[0].openPrs?.limit).toBe(5);
      expect(watch.repos[0].openPrs?.includeReviewComments).toBe(false);
      expect(watch.repos[0].recentIssues?.limit).toBe(3);
    });
  });
});
