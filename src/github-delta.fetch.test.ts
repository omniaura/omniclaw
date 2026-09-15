import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { DATA_DIR } from './config.js';
import type { GitHubWatchesConfig } from './types.js';

const { fetchGitHubDelta, getDeltaCursor, setDeltaCursor } =
  await import('./github-delta.js');

const originalFetch = globalThis.fetch;
const originalGitHubToken = process.env.GITHUB_TOKEN;
const configPath = path.join(DATA_DIR, 'github-watches.json');
const originalConfigExists = fs.existsSync(configPath);
const originalConfigContents = originalConfigExists
  ? fs.readFileSync(configPath, 'utf8')
  : null;

function makeChannelJid(prefix: string): string {
  return `dc:${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function writeGitHubWatchesConfig(config: GitHubWatchesConfig): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config));
}

function installGitHubFetchMock(responses: Record<string, unknown | Error>) {
  const fetchMock = mock((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const apiPath = url.replace('https://api.github.com', '');
    const response = responses[apiPath];

    if (response instanceof Error) {
      return Promise.reject(response);
    }

    if (response === undefined) {
      throw new Error(`Unexpected GitHub fetch: ${apiPath}`);
    }

    return Promise.resolve(jsonResponse(response));
  });

  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

describe('fetchGitHubDelta', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;

    if (originalConfigExists && originalConfigContents !== null) {
      fs.writeFileSync(configPath, originalConfigContents);
    } else if (fs.existsSync(configPath)) {
      fs.rmSync(configPath);
    }

    if (originalGitHubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalGitHubToken;
    }
  });

  it('initializes the cursor on the first message without fetching activity', async () => {
    const channelJid = makeChannelJid('first-message');
    const timestamp = '2026-03-25T12:00:00.000Z';
    const fetchMock = mock(() => {
      throw new Error('fetch should not run before a cursor exists');
    });

    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    writeGitHubWatchesConfig({
      watches: [],
      githubDeltaContextEnabled: true,
      channelWatches: [
        {
          channelJid,
          repos: [{ owner: 'omniaura', repo: 'omniclaw' }],
        },
      ],
    });

    const digest = await fetchGitHubDelta(channelJid, timestamp);

    expect(digest).toBeNull();
    expect(getDeltaCursor(channelJid)).toBe(timestamp);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips API calls for windows shorter than five seconds and still advances the cursor', async () => {
    const channelJid = makeChannelJid('narrow-window');
    const since = '2026-03-25T12:00:00.000Z';
    const until = '2026-03-25T12:00:04.000Z';
    const fetchMock = mock(() => {
      throw new Error('fetch should not run for a narrow window');
    });

    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    writeGitHubWatchesConfig({
      watches: [],
      githubDeltaContextEnabled: true,
      channelWatches: [
        {
          channelJid,
          repos: [{ owner: 'omniaura', repo: 'omniclaw' }],
        },
      ],
    });
    setDeltaCursor(channelJid, since);

    const digest = await fetchGitHubDelta(channelJid, until);

    expect(digest).toBeNull();
    expect(getDeltaCursor(channelJid)).toBe(until);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('collects PR and issue activity, dedupes repeated events, and advances the cursor', async () => {
    const channelJid = makeChannelJid('digest');
    const since = '2026-03-25T12:00:00.000Z';
    const until = '2026-03-25T12:30:00.000Z';

    writeGitHubWatchesConfig({
      watches: [],
      githubDeltaContextEnabled: true,
      channelWatches: [
        {
          channelJid,
          repos: [{ owner: 'omniaura', repo: 'omniclaw' }],
        },
      ],
    });
    setDeltaCursor(channelJid, since);

    const fetchMock = installGitHubFetchMock({
      '/repos/omniaura/omniclaw/pulls?state=all&sort=updated&direction=desc&per_page=30':
        [
          {
            number: 12,
            title: 'Tighten CI checks',
            state: 'open',
            merged_at: null,
            created_at: '2026-03-25T12:10:00.000Z',
            updated_at: '2026-03-25T12:29:00.000Z',
            closed_at: null,
            user: { login: 'alice' },
            html_url: 'https://github.com/omniaura/omniclaw/pull/12',
            draft: false,
          },
        ],
      '/repos/omniaura/omniclaw/pulls/12/reviews?per_page=20': [
        {
          id: 401,
          user: { login: 'bob' },
          state: 'APPROVED',
          body: 'Looks good\nwith one nit',
          submitted_at: '2026-03-25T12:20:00.000Z',
          html_url:
            'https://github.com/omniaura/omniclaw/pull/12#pullrequestreview-401',
        },
      ],
      '/repos/omniaura/omniclaw/pulls/12/comments?sort=created&direction=desc&per_page=20':
        [
          {
            id: 501,
            user: { login: 'carol' },
            body: 'Please rename this helper',
            path: 'src/index.ts',
            line: 42,
            created_at: '2026-03-25T12:25:00.000Z',
            html_url:
              'https://github.com/omniaura/omniclaw/pull/12#discussion_r501',
          },
          {
            id: 501,
            user: { login: 'carol' },
            body: 'Please rename this helper',
            path: 'src/index.ts',
            line: 42,
            created_at: '2026-03-25T12:25:00.000Z',
            html_url:
              'https://github.com/omniaura/omniclaw/pull/12#discussion_r501',
          },
        ],
      '/repos/omniaura/omniclaw/pulls/12/commits?per_page=20': [
        {
          sha: 'abc123',
          commit: {
            message: 'Add CI backstop',
            author: { name: 'Alice', date: '2026-03-25T12:15:00.000Z' },
          },
          html_url: 'https://github.com/omniaura/omniclaw/commit/abc123',
          author: { login: 'alice' },
        },
        {
          sha: 'def456',
          commit: {
            message: 'Polish logging',
            author: { name: 'Alice', date: '2026-03-25T12:28:00.000Z' },
          },
          html_url: 'https://github.com/omniaura/omniclaw/commit/def456',
          author: { login: 'alice' },
        },
      ],
      [`/repos/omniaura/omniclaw/issues?state=all&sort=updated&direction=desc&per_page=30&since=${since}`]:
        [
          {
            number: 22,
            title: 'Document app setup',
            state: 'open',
            created_at: '2026-03-25T12:05:00.000Z',
            updated_at: '2026-03-25T12:22:00.000Z',
            closed_at: null,
            user: { login: 'dana' },
            html_url: 'https://github.com/omniaura/omniclaw/issues/22',
          },
        ],
      [`/repos/omniaura/omniclaw/issues/22/comments?since=${since}&per_page=10`]:
        [
          {
            id: 601,
            body: 'I can take this',
            created_at: '2026-03-25T12:21:00.000Z',
            updated_at: '2026-03-25T12:21:00.000Z',
            user: { login: 'erin' },
            html_url:
              'https://github.com/omniaura/omniclaw/issues/22#issuecomment-601',
          },
          {
            id: 601,
            body: 'I can take this',
            created_at: '2026-03-25T12:21:00.000Z',
            updated_at: '2026-03-25T12:21:00.000Z',
            user: { login: 'erin' },
            html_url:
              'https://github.com/omniaura/omniclaw/issues/22#issuecomment-601',
          },
        ],
    });

    const digest = await fetchGitHubDelta(channelJid, until);

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(digest).not.toBeNull();
    expect(digest).toContain('# GitHub Activity Since Last Message');
    expect(digest).toContain('## omniaura/omniclaw');
    expect(digest).toContain('Issue #22 opened: Document app setup');
    expect(digest).toContain('PR #12 opened: Tighten CI checks');
    expect(digest).toContain(
      'APPROVED review on PR #12 by bob: "Looks good with one nit"',
    );
    expect(digest).toContain(
      'Review comment on PR #12 (src/index.ts:42): "Please rename this helper"',
    );
    expect(digest).toContain('2 new commits on PR #12');
    expect(digest).toContain('Comment on issue #22 by erin: "I can take this"');
    expect(digest).not.toContain('2 comments on Issue #22: Document app setup');
    expect(digest).not.toContain('2 comments on PR #12: Tighten CI checks');
    expect(getDeltaCursor(channelJid)).toBe(until);
  });

  it('suppresses already injected events on repeated windows for the same channel', async () => {
    const channelJid = makeChannelJid('ring-buffer');
    const since = '2026-03-25T12:00:00.000Z';
    const until = '2026-03-25T12:10:00.000Z';

    writeGitHubWatchesConfig({
      watches: [],
      githubDeltaContextEnabled: true,
      channelWatches: [
        {
          channelJid,
          repos: [{ owner: 'omniaura', repo: 'omniclaw' }],
        },
      ],
    });

    const responses = {
      '/repos/omniaura/omniclaw/pulls?state=all&sort=updated&direction=desc&per_page=30':
        [
          {
            number: 88,
            title: 'Wire delta context',
            state: 'open',
            merged_at: null,
            created_at: '2026-03-25T12:05:00.000Z',
            updated_at: '2026-03-25T12:05:00.000Z',
            closed_at: null,
            user: { login: 'alice' },
            html_url: 'https://github.com/omniaura/omniclaw/pull/88',
            draft: false,
          },
        ],
      '/repos/omniaura/omniclaw/pulls/88/reviews?per_page=20': [],
      '/repos/omniaura/omniclaw/pulls/88/comments?sort=created&direction=desc&per_page=20':
        [],
      '/repos/omniaura/omniclaw/pulls/88/commits?per_page=20': [],
      [`/repos/omniaura/omniclaw/issues?state=all&sort=updated&direction=desc&per_page=30&since=${since}`]:
        [],
    };

    setDeltaCursor(channelJid, since);
    installGitHubFetchMock(responses);
    const firstDigest = await fetchGitHubDelta(channelJid, until);

    expect(firstDigest).toContain('PR #88 opened: Wire delta context');

    setDeltaCursor(channelJid, since);
    installGitHubFetchMock(responses);
    const secondDigest = await fetchGitHubDelta(channelJid, until);

    expect(secondDigest).toBeNull();
    expect(getDeltaCursor(channelJid)).toBe(until);
  });

  it('returns null without reading config or fetching when no GitHub token is configured', async () => {
    const channelJid = makeChannelJid('no-token');
    const fetchMock = mock(() => {
      throw new Error('fetch should not run without a token');
    });

    delete process.env.GITHUB_TOKEN;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const digest = await fetchGitHubDelta(
      channelJid,
      '2026-03-25T12:10:00.000Z',
    );

    expect(digest).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('advances the cursor and returns null when GitHub API responses are not ok', async () => {
    const channelJid = makeChannelJid('api-not-ok');
    const since = '2026-03-25T12:00:00.000Z';
    const until = '2026-03-25T12:10:00.000Z';
    const fetchMock = mock(() =>
      Promise.resolve(new Response('rate limited', { status: 403 })),
    );

    writeGitHubWatchesConfig({
      watches: [],
      githubDeltaContextEnabled: true,
      channelWatches: [
        {
          channelJid,
          repos: [{ owner: 'omniaura', repo: 'omniclaw' }],
        },
      ],
    });
    setDeltaCursor(channelJid, since);
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const digest = await fetchGitHubDelta(channelJid, until);

    expect(digest).toBeNull();
    expect(getDeltaCursor(channelJid)).toBe(until);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('advances the cursor and returns null when GitHub API requests reject', async () => {
    const channelJid = makeChannelJid('api-reject');
    const since = '2026-03-25T12:00:00.000Z';
    const until = '2026-03-25T12:10:00.000Z';
    const fetchMock = mock(() => Promise.reject(new Error('network down')));

    writeGitHubWatchesConfig({
      watches: [],
      githubDeltaContextEnabled: true,
      channelWatches: [
        {
          channelJid,
          repos: [{ owner: 'omniaura', repo: 'omniclaw' }],
        },
      ],
    });
    setDeltaCursor(channelJid, since);
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const digest = await fetchGitHubDelta(channelJid, until);

    expect(digest).toBeNull();
    expect(getDeltaCursor(channelJid)).toBe(until);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
