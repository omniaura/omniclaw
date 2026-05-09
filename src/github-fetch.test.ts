import { afterEach, describe, expect, it } from 'bun:test';

const originalToken = process.env.GITHUB_TOKEN;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = originalToken;
  }
  globalThis.fetch = originalFetch;
});

async function importGithubWithToken() {
  process.env.GITHUB_TOKEN = 'test-token';
  return import(`./github.js?test=${crypto.randomUUID()}`);
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('github API fetch paths', () => {
  it('sends authenticated GitHub headers and returns null for non-OK responses', async () => {
    const github = await importGithubWithToken();
    const seen: Array<{ url: string; authorization: string | null }> = [];

    globalThis.fetch = ((url, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(url),
        authorization: headers.get('authorization'),
      });
      return Promise.resolve(new Response('rate limited', { status: 403 }));
    }) as typeof fetch;

    const result = await github.githubFetch('/repos/omniaura/omniclaw/pulls');

    expect(result).toBeNull();
    expect(seen).toEqual([
      {
        url: 'https://api.github.com/repos/omniaura/omniclaw/pulls',
        authorization: 'Bearer test-token',
      },
    ]);
  });

  it('classifies combined check suite status deterministically', async () => {
    const github = await importGithubWithToken();
    const suitesByRef: Record<string, unknown[]> = {
      passing: [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'success' },
      ],
      failing: [{ status: 'completed', conclusion: 'failure' }],
      pending: [
        { status: 'in_progress', conclusion: null },
        { status: 'completed', conclusion: 'success' },
      ],
      mixed: [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'cancelled' },
      ],
      unknown: [],
    };

    globalThis.fetch = ((url) => {
      const ref = String(url).split('/commits/')[1]?.split('/')[0] ?? '';
      return Promise.resolve(jsonResponse({ check_suites: suitesByRef[ref] }));
    }) as typeof fetch;

    expect(await github.fetchCombinedStatus('o', 'r', 'passing')).toBe(
      'passing',
    );
    expect(await github.fetchCombinedStatus('o', 'r', 'failing')).toBe(
      'failing',
    );
    expect(await github.fetchCombinedStatus('o', 'r', 'pending')).toBe(
      'pending',
    );
    expect(await github.fetchCombinedStatus('o', 'r', 'mixed')).toBe('mixed');
    expect(await github.fetchCombinedStatus('o', 'r', 'unknown')).toBe(
      'unknown',
    );
  });

  it('builds repo context from mocked PRs and issues without fetching review comments when disabled', async () => {
    const github = await importGithubWithToken();
    const requestedPaths: string[] = [];

    globalThis.fetch = ((url) => {
      const path = new URL(String(url)).pathname;
      requestedPaths.push(path);

      if (path.endsWith('/pulls')) {
        return Promise.resolve(
          jsonResponse([
            {
              number: 12,
              title: 'Add coverage',
              user: { login: 'peyton' },
              head: { ref: 'coverage-branch' },
              base: { ref: 'main' },
              state: 'open',
              draft: false,
              requested_reviewers: [],
              html_url: 'https://github.com/omniaura/omniclaw/pull/12',
              body: 'Deterministic tests',
              created_at: '2026-05-07T00:00:00Z',
              updated_at: '2026-05-07T00:00:00Z',
            },
          ]),
        );
      }

      if (path.endsWith('/reviews')) {
        return Promise.resolve(
          jsonResponse([{ user: { login: 'reviewer' }, state: 'APPROVED' }]),
        );
      }

      if (path.endsWith('/check-suites')) {
        return Promise.resolve(
          jsonResponse({
            check_suites: [{ status: 'completed', conclusion: 'success' }],
          }),
        );
      }

      if (path.endsWith('/issues')) {
        return Promise.resolve(
          jsonResponse([
            {
              number: 7,
              title: 'Real issue',
              user: { login: 'alice' },
              state: 'open',
              labels: [{ name: 'bug' }],
              assignee: null,
              html_url: 'https://github.com/omniaura/omniclaw/issues/7',
              body: 'Issue body',
              created_at: '2026-05-07T00:00:00Z',
              updated_at: '2026-05-07T00:00:00Z',
            },
            {
              number: 8,
              title: 'PR returned as issue',
              user: { login: 'bob' },
              state: 'open',
              labels: [],
              assignee: null,
              html_url: 'https://github.com/omniaura/omniclaw/pull/8',
              body: null,
              created_at: '2026-05-07T00:00:00Z',
              updated_at: '2026-05-07T00:00:00Z',
              pull_request: {},
            },
          ]),
        );
      }

      throw new Error(`unexpected GitHub path: ${path}`);
    }) as typeof fetch;

    const markdown = await github.fetchGitHubContext(
      {
        agentId: 'github-context-test',
        repos: [
          {
            owner: 'omniaura',
            repo: 'omniclaw',
            openPrs: { limit: 2, includeReviewComments: false },
            recentIssues: { limit: 2 },
          },
        ],
      },
      0,
    );

    expect(markdown).toContain('# GitHub Context');
    expect(markdown).toContain('## omniaura/omniclaw');
    expect(markdown).toContain('### Open PRs (1)');
    expect(markdown).toContain('PR #12: Add coverage');
    expect(markdown).toContain('CI: passing | Reviews: reviewer: APPROVED');
    expect(markdown).toContain('### Open Issues (1)');
    expect(markdown).toContain('**#7**: Real issue');
    expect(markdown).not.toContain('PR returned as issue');
    expect(requestedPaths).not.toContain(
      '/repos/omniaura/omniclaw/pulls/12/comments',
    );
  });

  it('renders empty repo sections when GitHub returns no PRs or issues', async () => {
    const github = await importGithubWithToken();

    globalThis.fetch = (() =>
      Promise.resolve(jsonResponse([]))) as unknown as typeof fetch;

    const markdown = await github.fetchGitHubContext(
      {
        agentId: 'github-empty-repo-test',
        repos: [{ owner: 'omniaura', repo: 'empty' }],
      },
      0,
    );

    expect(markdown).toContain('## omniaura/empty');
    expect(markdown).toContain('No open PRs.');
    expect(markdown).toContain('No open issues.');
  });

  it('returns stale cached context when a later refresh throws', async () => {
    const github = await importGithubWithToken();
    const watch = {
      agentId: 'github-stale-cache-test',
      repos: [{ owner: 'omniaura', repo: 'omniclaw' }],
    };

    globalThis.fetch = ((url) => {
      const path = new URL(String(url)).pathname;

      if (path.endsWith('/pulls')) {
        return Promise.resolve(
          jsonResponse([
            {
              number: 12,
              title: 'Cached PR',
              user: { login: 'peyton' },
              head: { ref: 'cached-branch' },
              base: { ref: 'main' },
              state: 'open',
              draft: false,
              requested_reviewers: [],
              html_url: 'https://github.com/omniaura/omniclaw/pull/12',
              body: 'Cached body',
              created_at: '2026-05-07T00:00:00Z',
              updated_at: '2026-05-07T00:00:00Z',
            },
          ]),
        );
      }

      if (path.endsWith('/reviews') || path.endsWith('/comments')) {
        return Promise.resolve(jsonResponse([]));
      }

      if (path.endsWith('/check-suites')) {
        return Promise.resolve(
          jsonResponse({
            check_suites: [{ status: 'completed', conclusion: 'success' }],
          }),
        );
      }

      if (path.endsWith('/issues')) {
        return Promise.resolve(
          jsonResponse([
            {
              number: 7,
              title: 'Cached issue',
              user: { login: 'alice' },
              state: 'open',
              labels: [{ name: 'bug' }],
              assignee: null,
              html_url: 'https://github.com/omniaura/omniclaw/issues/7',
              body: 'Cached issue body',
              created_at: '2026-05-07T00:00:00Z',
              updated_at: '2026-05-07T00:00:00Z',
            },
          ]),
        );
      }

      throw new Error(`unexpected GitHub path: ${path}`);
    }) as typeof fetch;

    const cached = await github.fetchGitHubContext(watch, 60_000);
    globalThis.fetch = (() =>
      Promise.resolve(jsonResponse({}))) as unknown as typeof fetch;

    const stale = await github.fetchGitHubContext(watch, -1);

    expect(cached).toContain('PR #12: Cached PR');
    expect(cached).toContain('**#7**: Cached issue');
    expect(stale).toBe(cached);
  });
});
