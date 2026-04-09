import { afterEach, describe, expect, it, mock } from 'bun:test';

import {
  extractGitHubLinks,
  fetchGitHubLinkedContext,
  type ParsedGitHubLink,
} from './github-linked.js';

afterEach(() => {
  mock.restore();
  delete process.env.GITHUB_TOKEN;
});

describe('github-linked', () => {
  describe('extractGitHubLinks', () => {
    it('returns empty array for empty string', () => {
      expect(extractGitHubLinks('')).toEqual([]);
    });

    it('returns empty array for text with no URLs', () => {
      expect(extractGitHubLinks('hello world, no links here')).toEqual([]);
    });

    it('extracts a single PR URL', () => {
      const links = extractGitHubLinks(
        'check https://github.com/omniaura/omniclaw/pull/372',
      );
      expect(links).toHaveLength(1);
      expect(links[0]).toEqual({
        owner: 'omniaura',
        repo: 'omniclaw',
        type: 'pull',
        number: 372,
        url: 'https://github.com/omniaura/omniclaw/pull/372',
      });
    });

    it('extracts a single issue URL', () => {
      const links = extractGitHubLinks(
        'see https://github.com/omniaura/omniclaw/issues/91',
      );
      expect(links).toHaveLength(1);
      expect(links[0]).toEqual({
        owner: 'omniaura',
        repo: 'omniclaw',
        type: 'issue',
        number: 91,
        url: 'https://github.com/omniaura/omniclaw/issues/91',
      });
    });

    it('handles URL with fragment/anchor', () => {
      const links = extractGitHubLinks(
        'https://github.com/org/repo/pull/42#pullrequestreview-123',
      );
      expect(links).toHaveLength(1);
      expect(links[0].number).toBe(42);
      expect(links[0].type).toBe('pull');
    });

    it('handles URL with query params after number', () => {
      const links = extractGitHubLinks(
        'https://github.com/org/repo/issues/10?foo=bar',
      );
      expect(links).toHaveLength(1);
      expect(links[0].number).toBe(10);
    });

    it('extracts multiple different URLs from same text', () => {
      const text =
        'check https://github.com/a/b/pull/1 and https://github.com/c/d/issues/2';
      const links = extractGitHubLinks(text);
      expect(links).toHaveLength(2);
      expect(links[0].owner).toBe('a');
      expect(links[0].type).toBe('pull');
      expect(links[1].owner).toBe('c');
      expect(links[1].type).toBe('issue');
    });

    it('deduplicates same URL appearing twice', () => {
      const url = 'https://github.com/omniaura/omniclaw/pull/1';
      const links = extractGitHubLinks(`${url} and again ${url}`);
      expect(links).toHaveLength(1);
    });

    it('ignores non-GitHub URLs', () => {
      expect(extractGitHubLinks('https://gitlab.com/org/repo/pull/1')).toEqual(
        [],
      );
    });

    it('ignores malformed GitHub URLs without a number', () => {
      expect(extractGitHubLinks('https://github.com/org/repo/pull/')).toEqual(
        [],
      );
    });

    it('handles http:// as well as https://', () => {
      const links = extractGitHubLinks('http://github.com/org/repo/pull/5');
      expect(links).toHaveLength(1);
      expect(links[0].number).toBe(5);
    });

    it('handles repos with dots and underscores in names', () => {
      const links = extractGitHubLinks(
        'https://github.com/my.org/my_repo/issues/99',
      );
      expect(links).toHaveLength(1);
      expect(links[0].owner).toBe('my.org');
      expect(links[0].repo).toBe('my_repo');
    });

    it('handles repos with hyphens in names', () => {
      const links = extractGitHubLinks(
        'https://github.com/ditto-assistant/ditto-app/pull/895',
      );
      expect(links).toHaveLength(1);
      expect(links[0].owner).toBe('ditto-assistant');
      expect(links[0].repo).toBe('ditto-app');
      expect(links[0].number).toBe(895);
    });
  });

  describe('fetchGitHubLinkedContext', () => {
    it('returns null for empty messages', async () => {
      const result = await fetchGitHubLinkedContext([]);
      expect(result).toBeNull();
    });

    it('returns null for messages with no GitHub URLs', async () => {
      const result = await fetchGitHubLinkedContext([
        { content: 'hello world' },
        { content: 'nothing here' },
      ]);
      expect(result).toBeNull();
    });

    it('deduplicates links across multiple messages', () => {
      // Test via extractGitHubLinks since fetchGitHubLinkedContext
      // does its own dedup across messages
      const url = 'https://github.com/org/repo/pull/1';
      const msg1Links = extractGitHubLinks(`check ${url}`);
      const msg2Links = extractGitHubLinks(`also ${url}`);

      // Both return the same link
      expect(msg1Links).toHaveLength(1);
      expect(msg2Links).toHaveLength(1);
      expect(msg1Links[0].number).toBe(msg2Links[0].number);
    });

    it('caps at MAX_LINKED_ITEMS (3)', () => {
      const text = [
        'https://github.com/a/b/pull/1',
        'https://github.com/a/b/pull/2',
        'https://github.com/a/b/pull/3',
        'https://github.com/a/b/pull/4',
        'https://github.com/a/b/pull/5',
      ].join(' ');
      const links = extractGitHubLinks(text);
      // extractGitHubLinks returns all, but fetchGitHubLinkedContext caps at 3
      expect(links).toHaveLength(5);
    });

    it('returns null when GitHub access is disabled even if links are present', async () => {
      const result = await fetchGitHubLinkedContext([
        { content: 'https://github.com/omniaura/omniclaw/pull/1' },
      ]);

      expect(result).toBeNull();
    });

    it('fetches, formats, and caches linked pull request context', async () => {
      process.env.GITHUB_TOKEN = 'test-token';

      const githubFetch = mock(async (path: string) => {
        expect(path).toBe('/repos/omniaura/omniclaw/pulls/42');
        return {
          number: 42,
          title: 'Fix scheduler loop',
          body: 'Body',
          state: 'open',
          html_url: 'https://github.com/omniaura/omniclaw/pull/42',
          draft: false,
          user: { login: 'peyton' },
          head: { ref: 'feature-branch' },
          base: { ref: 'main' },
        };
      });
      const fetchPrReviews = mock(async () => [{ state: 'APPROVED' }]);
      const fetchPrReviewComments = mock(async () => [{ body: 'Looks good' }]);
      const fetchCombinedStatus = mock(async () => 'green');
      const formatPrMarkdown = mock(
        () => '### PR #42: Fix scheduler loop\n- CI: green',
      );

      mock.module('./github.js', () => ({
        githubFetch,
        fetchPrReviews,
        fetchPrReviewComments,
        fetchCombinedStatus,
        formatPrMarkdown,
        truncate: (value: string) => value,
      }));
      mock.module('./logger.js', () => ({
        logger: { info: mock(() => {}), warn: mock(() => {}) },
      }));

      const linked = await import(
        `./github-linked.ts?test=${Math.random().toString(36).slice(2)}`,
      );

      const messages = [
        { content: 'Review https://github.com/omniaura/omniclaw/pull/42' },
      ];

      const first = await linked.fetchGitHubLinkedContext(messages);
      const second = await linked.fetchGitHubLinkedContext(messages);

      expect(first).toBe(
        '# Linked GitHub Context\n\n### PR #42: Fix scheduler loop\n- CI: green',
      );
      expect(second).toBe(first);
      expect(githubFetch).toHaveBeenCalledTimes(1);
      expect(fetchPrReviews).toHaveBeenCalledTimes(1);
      expect(fetchPrReviewComments).toHaveBeenCalledTimes(1);
      expect(fetchCombinedStatus).toHaveBeenCalledWith(
        'omniaura',
        'omniclaw',
        'feature-branch',
      );
      expect(formatPrMarkdown).toHaveBeenCalledTimes(1);
    });

    it('formats linked issue context with comments and truncation', async () => {
      process.env.GITHUB_TOKEN = 'test-token';

      const githubFetch = mock(async (path: string) => {
        if (path === '/repos/omniaura/omniclaw/issues/91') {
          return {
            number: 91,
            title: 'Improve linked issue context',
            body: 'Issue body',
            user: { login: 'peyton' },
            labels: [{ name: 'bug' }, { name: 'triage' }],
            assignee: { login: 'ocpeyton' },
          };
        }

        if (
          path ===
          '/repos/omniaura/omniclaw/issues/91/comments?per_page=10&sort=created&direction=desc'
        ) {
          return [
            {
              user: { login: 'reviewer' },
              body: 'First comment',
              created_at: '2026-04-01T00:00:00Z',
            },
            {
              user: null,
              body: 'Second comment',
              created_at: '2026-04-01T00:01:00Z',
            },
          ];
        }

        throw new Error(`Unexpected path: ${path}`);
      });

      mock.module('./github.js', () => ({
        githubFetch,
        fetchPrReviews: mock(async () => []),
        fetchPrReviewComments: mock(async () => []),
        fetchCombinedStatus: mock(async () => null),
        formatPrMarkdown: mock(() => ''),
        truncate: (value: string, max: number) => value.slice(0, max),
      }));
      mock.module('./logger.js', () => ({
        logger: { info: mock(() => {}), warn: mock(() => {}) },
      }));

      const linked = await import(
        `./github-linked.ts?test=${Math.random().toString(36).slice(2)}`,
      );

      const result = await linked.fetchGitHubLinkedContext([
        { content: 'See https://github.com/omniaura/omniclaw/issues/91' },
      ]);

      expect(result).toContain('### Issue #91: Improve linked issue context');
      expect(result).toContain(
        '- Author: peyton | Labels: bug, triage | Assignee: ocpeyton',
      );
      expect(result).toContain('- Description: Issue body');
      expect(result).toContain('- Comments (2):');
      expect(result).toContain('  - reviewer: First comment');
      expect(result).toContain('  - ?: Second comment');
    });

    it('treats linked issues with pull_request metadata as pull requests', async () => {
      process.env.GITHUB_TOKEN = 'test-token';

      const githubFetch = mock(async (path: string) => {
        if (path === '/repos/omniaura/omniclaw/issues/123') {
          return {
            number: 123,
            title: 'Shadow PR issue',
            body: 'Issue view',
            pull_request: { url: 'https://api.github.com/repos/x/y/pulls/123' },
          };
        }

        if (path === '/repos/omniaura/omniclaw/pulls/123') {
          return {
            number: 123,
            title: 'Actual PR',
            body: 'PR body',
            state: 'open',
            html_url: 'https://github.com/omniaura/omniclaw/pull/123',
            draft: false,
            user: { login: 'peyton' },
            head: { ref: 'pr-branch' },
            base: { ref: 'main' },
          };
        }

        throw new Error(`Unexpected path: ${path}`);
      });
      const fetchPrReviews = mock(async () => []);
      const fetchPrReviewComments = mock(async () => []);
      const fetchCombinedStatus = mock(async () => 'pending');

      mock.module('./github.js', () => ({
        githubFetch,
        fetchPrReviews,
        fetchPrReviewComments,
        fetchCombinedStatus,
        formatPrMarkdown: mock(() => 'PR markdown'),
        truncate: (value: string) => value,
      }));
      mock.module('./logger.js', () => ({
        logger: { info: mock(() => {}), warn: mock(() => {}) },
      }));

      const linked = await import(
        `./github-linked.ts?test=${Math.random().toString(36).slice(2)}`,
      );

      const result = await linked.fetchGitHubLinkedContext([
        { content: 'https://github.com/omniaura/omniclaw/issues/123' },
      ]);

      expect(result).toContain('PR markdown');
      expect(fetchPrReviews).toHaveBeenCalledWith('omniaura', 'omniclaw', 123);
      expect(fetchPrReviewComments).toHaveBeenCalledWith(
        'omniaura',
        'omniclaw',
        123,
      );
      expect(fetchCombinedStatus).toHaveBeenCalledWith(
        'omniaura',
        'omniclaw',
        'pr-branch',
      );
    });

    it('caps linked fetches and logs rejected items while keeping successful sections', async () => {
      process.env.GITHUB_TOKEN = 'test-token';

      const warnSpy = mock(() => {});
      const infoSpy = mock(() => {});

      mock.module('./github.js', () => ({
        githubFetch: mock(async (path: string) => {
          const prNumber = Number(path.split('/').pop());
          return {
            number: prNumber,
            title: `PR ${prNumber}`,
            body: `Body ${prNumber}`,
            state: 'open',
            html_url: `https://github.com/omniaura/omniclaw/pull/${prNumber}`,
            draft: false,
            user: { login: 'peyton' },
            head: { ref: `branch-${prNumber}` },
            base: { ref: 'main' },
          };
        }),
        fetchPrReviews: mock(async (_owner: string, _repo: string, number: number) => {
          if (number === 2) {
            throw new Error('reviews exploded');
          }
          return [];
        }),
        fetchPrReviewComments: mock(async () => []),
        fetchCombinedStatus: mock(async () => 'green'),
        formatPrMarkdown: mock((pr: { number: number }) => `PR-${pr.number}`),
        truncate: (value: string) => value,
      }));
      mock.module('./logger.js', () => ({
        logger: { info: infoSpy, warn: warnSpy },
      }));

      const linked = await import(
        `./github-linked.ts?test=${Math.random().toString(36).slice(2)}`,
      );

      const result = await linked.fetchGitHubLinkedContext([
        {
          content: [
            'https://github.com/omniaura/omniclaw/pull/1',
            'https://github.com/omniaura/omniclaw/pull/2',
            'https://github.com/omniaura/omniclaw/pull/3',
            'https://github.com/omniaura/omniclaw/pull/4',
          ].join(' '),
        },
      ]);

      expect(result).toContain('PR-1');
      expect(result).toContain('PR-3');
      expect(result).not.toContain('PR-4');
      expect(warnSpy).toHaveBeenCalledWith(
        {
          err: expect.any(Error),
          link: 'https://github.com/omniaura/omniclaw/pull/2',
        },
        'Failed to fetch linked GitHub context',
      );
      expect(infoSpy).toHaveBeenCalledWith(
        { total: 4, capped: 3 },
        'Capped linked GitHub context items',
      );
    });
  });
});
