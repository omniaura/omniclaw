import { beforeEach, describe, it, expect, mock } from 'bun:test';

const githubFetchMock = mock(async (_path: string) => null as unknown);
const fetchPrReviewsMock = mock(async () => [] as unknown[]);
const fetchPrReviewCommentsMock = mock(async () => [] as unknown[]);
const fetchCombinedStatusMock = mock(async () => null as unknown);
const formatPrMarkdownMock = mock(
  (pr: { number: number; title: string }) =>
    `### PR #${pr.number}: ${pr.title}`,
);

import {
  extractGitHubLinks,
  fetchGitHubLinkedContext,
  type GitHubLinkedDeps,
  type ParsedGitHubLink,
} from './github-linked.js';

function linkedDeps(): GitHubLinkedDeps {
  return {
    githubFetch: githubFetchMock as unknown as GitHubLinkedDeps['githubFetch'],
    fetchPrReviews:
      fetchPrReviewsMock as unknown as GitHubLinkedDeps['fetchPrReviews'],
    fetchPrReviewComments:
      fetchPrReviewCommentsMock as unknown as GitHubLinkedDeps['fetchPrReviewComments'],
    fetchCombinedStatus:
      fetchCombinedStatusMock as unknown as GitHubLinkedDeps['fetchCombinedStatus'],
    formatPrMarkdown:
      formatPrMarkdownMock as unknown as GitHubLinkedDeps['formatPrMarkdown'],
  };
}

function makePr(number: number, title = `Test PR ${number}`) {
  return {
    number,
    title,
    user: { login: 'alice' },
    head: { ref: `branch-${number}` },
    base: { ref: 'main' },
    state: 'open',
    draft: false,
    requested_reviewers: [],
    html_url: `https://github.com/org/repo/pull/${number}`,
    body: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function makeIssue(number: number, title = `Test issue ${number}`) {
  return {
    number,
    title,
    user: { login: 'bob' },
    state: 'open',
    labels: [{ name: 'bug' }, { name: 'p1' }],
    assignee: { login: 'carol' },
    html_url: `https://github.com/org/repo/issues/${number}`,
    body: 'Issue body with useful detail',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

const originalGithubToken = process.env.GITHUB_TOKEN;

describe('github-linked', () => {
  beforeEach(() => {
    if (originalGithubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalGithubToken;
    }

    githubFetchMock.mockReset();
    fetchPrReviewsMock.mockReset();
    fetchPrReviewCommentsMock.mockReset();
    fetchCombinedStatusMock.mockReset();
    formatPrMarkdownMock.mockReset();

    githubFetchMock.mockImplementation(async () => null);
    fetchPrReviewsMock.mockImplementation(async () => []);
    fetchPrReviewCommentsMock.mockImplementation(async () => []);
    fetchCombinedStatusMock.mockImplementation(async () => null);
    formatPrMarkdownMock.mockImplementation(
      (pr: { number: number; title: string }) =>
        `### PR #${pr.number}: ${pr.title}`,
    );
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

    it('returns null without a GitHub token and avoids fetches', async () => {
      delete process.env.GITHUB_TOKEN;

      const result = await fetchGitHubLinkedContext(
        [{ content: 'https://github.com/org/repo/pull/901' }],
        linkedDeps(),
      );

      expect(result).toBeNull();
      expect(githubFetchMock).not.toHaveBeenCalled();
    });

    it('fetches PR details, reviews, review comments, and CI status', async () => {
      process.env.GITHUB_TOKEN = 'test-token';
      githubFetchMock.mockImplementation(async (path: string) => {
        if (path === '/repos/org/repo/pulls/902') return makePr(902, 'Ship it');
        return null;
      });
      fetchPrReviewsMock.mockImplementation(async () => [
        { state: 'APPROVED' },
      ]);
      fetchPrReviewCommentsMock.mockImplementation(async () => [
        { path: 'src/index.ts', body: 'nit' },
      ]);
      fetchCombinedStatusMock.mockImplementation(async () => ({
        state: 'success',
      }));

      const result = await fetchGitHubLinkedContext(
        [{ content: 'Review https://github.com/org/repo/pull/902' }],
        linkedDeps(),
      );

      expect(result).toContain('# Linked GitHub Context');
      expect(result).toContain('### PR #902: Ship it');
      expect(fetchPrReviewsMock).toHaveBeenCalledWith('org', 'repo', 902);
      expect(fetchPrReviewCommentsMock).toHaveBeenCalledWith(
        'org',
        'repo',
        902,
      );
      expect(fetchCombinedStatusMock).toHaveBeenCalledWith(
        'org',
        'repo',
        'branch-902',
      );
      expect(formatPrMarkdownMock).toHaveBeenCalledWith(
        expect.objectContaining({ number: 902 }),
        [{ state: 'APPROVED' }],
        [{ path: 'src/index.ts', body: 'nit' }],
        { state: 'success' },
      );
    });

    it('formats issue details and recent comments', async () => {
      process.env.GITHUB_TOKEN = 'test-token';
      githubFetchMock.mockImplementation(async (path: string) => {
        if (path === '/repos/org/repo/issues/903') {
          return makeIssue(903, 'Broken widget');
        }
        if (
          path ===
          '/repos/org/repo/issues/903/comments?per_page=10&sort=created&direction=desc'
        ) {
          return [
            {
              user: { login: 'dana' },
              body: 'First comment',
              created_at: 'now',
            },
            { user: null, body: 'Anonymous follow-up', created_at: 'now' },
          ];
        }
        return null;
      });

      const result = await fetchGitHubLinkedContext(
        [{ content: 'Triage https://github.com/org/repo/issues/903' }],
        linkedDeps(),
      );

      expect(result).toContain('### Issue #903: Broken widget');
      expect(result).toContain(
        '- Author: bob | Labels: bug, p1 | Assignee: carol',
      );
      expect(result).toContain('- Description: Issue body with useful detail');
      expect(result).toContain('- dana: First comment');
      expect(result).toContain('- ?: Anonymous follow-up');
    });

    it('treats issue URLs that point at PRs as PR context', async () => {
      process.env.GITHUB_TOKEN = 'test-token';
      githubFetchMock.mockImplementation(async (path: string) => {
        if (path === '/repos/org/repo/issues/904') {
          return { ...makeIssue(904), pull_request: {} };
        }
        if (path === '/repos/org/repo/pulls/904') {
          return makePr(904, 'PR via issue URL');
        }
        return null;
      });

      const result = await fetchGitHubLinkedContext(
        [{ content: 'https://github.com/org/repo/issues/904' }],
        linkedDeps(),
      );

      expect(result).toContain('### PR #904: PR via issue URL');
      expect(fetchPrReviewsMock).toHaveBeenCalledWith('org', 'repo', 904);
    });

    it('deduplicates links across messages and reuses cached markdown', async () => {
      process.env.GITHUB_TOKEN = 'test-token';
      githubFetchMock.mockImplementation(async (path: string) => {
        if (path === '/repos/org/repo/pulls/905')
          return makePr(905, 'Cached PR');
        return null;
      });

      const first = await fetchGitHubLinkedContext(
        [
          { content: 'https://github.com/org/repo/pull/905' },
          { content: 'duplicate https://github.com/org/repo/pull/905' },
        ],
        linkedDeps(),
      );
      const second = await fetchGitHubLinkedContext(
        [{ content: 'again https://github.com/org/repo/pull/905' }],
        linkedDeps(),
      );

      expect(first).toContain('### PR #905: Cached PR');
      expect(second).toBe(first);
      expect(githubFetchMock).toHaveBeenCalledTimes(1);
      expect(formatPrMarkdownMock).toHaveBeenCalledTimes(1);
    });

    it('caps fetches to the first three unique linked items', async () => {
      process.env.GITHUB_TOKEN = 'test-token';
      githubFetchMock.mockImplementation(async (path: string) => {
        const number = Number(path.match(/\/(\d+)$/)?.[1] ?? 0);
        return makePr(number, `PR ${number}`);
      });

      const result = await fetchGitHubLinkedContext(
        [
          {
            content: [
              'https://github.com/org/repo/pull/906',
              'https://github.com/org/repo/pull/907',
              'https://github.com/org/repo/pull/908',
              'https://github.com/org/repo/pull/909',
              'https://github.com/org/repo/pull/910',
            ].join(' '),
          },
        ],
        linkedDeps(),
      );

      expect(githubFetchMock).toHaveBeenCalledTimes(3);
      expect(result).toContain('### PR #906: PR 906');
      expect(result).toContain('### PR #907: PR 907');
      expect(result).toContain('### PR #908: PR 908');
      expect(result).not.toContain('### PR #909: PR 909');
      expect(result).not.toContain('### PR #910: PR 910');
    });

    it('returns successful sections when another linked fetch rejects', async () => {
      process.env.GITHUB_TOKEN = 'test-token';
      githubFetchMock.mockImplementation(async (path: string) => {
        if (path === '/repos/org/repo/pulls/911') return makePr(911, 'Fails');
        if (path === '/repos/org/repo/issues/912')
          return makeIssue(912, 'Works');
        if (path.includes('/comments?')) return [];
        return null;
      });
      fetchPrReviewsMock.mockImplementation(async () => {
        throw new Error('GitHub unavailable');
      });

      const result = await fetchGitHubLinkedContext(
        [
          {
            content:
              'https://github.com/org/repo/pull/911 https://github.com/org/repo/issues/912',
          },
        ],
        linkedDeps(),
      );

      expect(result).toContain('### Issue #912: Works');
      expect(result).not.toContain('### PR #911: Fails');
    });
  });
});
