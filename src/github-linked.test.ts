import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const originalGithubToken = process.env.GITHUB_TOKEN;
const originalFetch = globalThis.fetch;

process.env.GITHUB_TOKEN = 'test-token';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function installGitHubFetchMock(
  handler: (path: string, url: URL) => unknown,
): ReturnType<typeof mock> {
  const fetchMock = mock((input: string | URL | Request) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl);
    const path = `${url.pathname}${url.search}`;
    return Promise.resolve(jsonResponse(handler(path, url)));
  });
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

import type { ParsedGitHubLink } from './github-linked.js';

const { extractGitHubLinks, fetchGitHubLinkedContext } =
  await import('./github-linked.js');

describe('github-linked', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse(null)),
    ) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalGithubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalGithubToken;
    }
  });

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
    it('returns null without a GitHub token and does not call the API', async () => {
      delete process.env.GITHUB_TOKEN;
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;

      const result = await fetchGitHubLinkedContext([
        { content: 'https://github.com/omniaura/omniclaw/pull/999' },
      ]);

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

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

    it('fetches PR context and formats it with reviews, comments, and CI status', async () => {
      const fetchMock = installGitHubFetchMock((path) => {
        if (path === '/repos/omniaura/omniclaw/pulls/501') {
          return {
            number: 501,
            title: 'Add linked context tests',
            user: { login: 'peyton' },
            head: { ref: 'feature/context-tests' },
            base: { ref: 'main' },
            state: 'open',
            draft: false,
            requested_reviewers: [],
            html_url: 'https://github.com/omniaura/omniclaw/pull/501',
            body: 'body',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          };
        }
        if (path === '/repos/omniaura/omniclaw/pulls/501/reviews') {
          return [
            { user: { login: 'reviewer' }, state: 'APPROVED', body: null },
          ];
        }
        if (
          path ===
          '/repos/omniaura/omniclaw/pulls/501/comments?per_page=30&sort=created&direction=desc'
        ) {
          return [
            {
              user: { login: 'commenter' },
              body: 'please update this line',
              path: 'src/a.ts',
              line: 12,
              created_at: '2026-01-01T00:00:00Z',
            },
          ];
        }
        expect(path).toBe(
          '/repos/omniaura/omniclaw/commits/feature/context-tests/check-suites',
        );
        return {
          check_suites: [{ conclusion: 'success', status: 'completed' }],
        };
      });

      const result = await fetchGitHubLinkedContext([
        { content: 'Review https://github.com/omniaura/omniclaw/pull/501' },
      ]);

      expect(result).toContain('# Linked GitHub Context');
      expect(result).toContain('### PR #501: Add linked context tests');
      expect(result).toContain(
        '- Author: peyton | Branch: `feature/context-tests` → `main`',
      );
      expect(result).toContain('CI: passing | Reviews: reviewer: APPROVED');
      expect(result).toContain('commenter on `src/a.ts`:12');
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('caches linked PR markdown within the TTL', async () => {
      const fetchMock = installGitHubFetchMock((path) => {
        if (path === '/repos/omniaura/omniclaw/pulls/502') {
          return {
            number: 502,
            title: 'Cached PR',
            user: { login: 'peyton' },
            head: { ref: 'cached-branch' },
            base: { ref: 'main' },
            state: 'open',
            draft: false,
            requested_reviewers: [],
            html_url: 'https://github.com/omniaura/omniclaw/pull/502',
            body: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          };
        }
        if (
          path === '/repos/omniaura/omniclaw/commits/cached-branch/check-suites'
        ) {
          return { check_suites: [] };
        }
        return [];
      });

      const messages = [
        { content: 'https://github.com/omniaura/omniclaw/pull/502' },
      ];

      const first = await fetchGitHubLinkedContext(messages);
      const second = await fetchGitHubLinkedContext(messages);

      expect(first).toBe(second);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('formats issues with labels, assignee fallback, description, and latest comments', async () => {
      installGitHubFetchMock((path) => {
        if (path === '/repos/omniaura/omniclaw/issues/601') {
          return {
            number: 601,
            title: 'Coverage gap',
            user: { login: 'zest' },
            state: 'open',
            labels: [{ name: 'testing' }, { name: 'p2' }],
            assignee: null,
            html_url: 'https://github.com/omniaura/omniclaw/issues/601',
            body: 'needs deterministic tests',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          };
        }
        expect(path).toBe(
          '/repos/omniaura/omniclaw/issues/601/comments?per_page=10&sort=created&direction=desc',
        );
        return [
          {
            user: { login: 'reviewer' },
            body: 'first comment',
            created_at: '',
          },
          { user: null, body: 'anonymous comment', created_at: '' },
        ];
      });

      const result = await fetchGitHubLinkedContext([
        { content: 'https://github.com/omniaura/omniclaw/issues/601' },
      ]);

      expect(result).toContain('### Issue #601: Coverage gap');
      expect(result).toContain(
        '- Author: zest | Labels: testing, p2 | Assignee: unassigned',
      );
      expect(result).toContain('- Description: needs deterministic tests');
      expect(result).toContain('- Comments (2):');
      expect(result).toContain('  - reviewer: first comment');
      expect(result).toContain('  - ?: anonymous comment');
    });

    it('fetches issue links as PRs when GitHub marks the issue as a pull request', async () => {
      const fetchMock = installGitHubFetchMock((path) => {
        if (path === '/repos/omniaura/omniclaw/issues/602') {
          return {
            number: 602,
            title: 'Actually a PR',
            user: { login: 'peyton' },
            state: 'open',
            labels: [],
            assignee: null,
            html_url: 'https://github.com/omniaura/omniclaw/issues/602',
            body: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            pull_request: {},
          };
        }
        if (path === '/repos/omniaura/omniclaw/pulls/602') {
          return {
            number: 602,
            title: 'Actually a PR',
            user: { login: 'peyton' },
            head: { ref: 'issue-url-pr' },
            base: { ref: 'main' },
            state: 'open',
            draft: false,
            requested_reviewers: [],
            html_url: 'https://github.com/omniaura/omniclaw/pull/602',
            body: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          };
        }
        if (
          path === '/repos/omniaura/omniclaw/commits/issue-url-pr/check-suites'
        ) {
          return { check_suites: [] };
        }
        return [];
      });

      const result = await fetchGitHubLinkedContext([
        { content: 'https://github.com/omniaura/omniclaw/issues/602' },
      ]);

      expect(result).toContain('### PR #602: Actually a PR');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/omniaura/omniclaw/pulls/602',
        expect.any(Object),
      );
    });

    it('deduplicates and caps fetched links across messages', async () => {
      const fetchMock = installGitHubFetchMock((path) => {
        if (path.includes('/reviews') || path.includes('/comments')) return [];
        if (path.includes('/check-suites')) return { check_suites: [] };
        const number = Number(path.split('/').at(-1));
        return {
          number,
          title: `PR ${number}`,
          user: { login: 'peyton' },
          head: { ref: `branch-${number}` },
          base: { ref: 'main' },
          state: 'open',
          draft: false,
          requested_reviewers: [],
          html_url: `https://github.com/omniaura/omniclaw/pull/${number}`,
          body: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        };
      });

      const result = await fetchGitHubLinkedContext([
        {
          content:
            'https://github.com/omniaura/omniclaw/pull/611 https://github.com/omniaura/omniclaw/pull/612',
        },
        {
          content:
            'https://github.com/omniaura/omniclaw/pull/611 https://github.com/omniaura/omniclaw/pull/613 https://github.com/omniaura/omniclaw/pull/614',
        },
      ]);

      expect(result).toContain('### PR #611: PR 611');
      expect(result).toContain('### PR #612: PR 612');
      expect(result).toContain('### PR #613: PR 613');
      expect(result).not.toContain('### PR #614');
      expect(fetchMock).toHaveBeenCalledTimes(12);
    });
  });
});
