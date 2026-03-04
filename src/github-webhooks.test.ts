import { describe, expect, it, mock } from 'bun:test';
import { createHmac } from 'crypto';

const loadGitHubWatchesConfig = mock(() => ({
  watches: [
    {
      agentId: 'agent-a',
      repos: [{ owner: 'omniaura', repo: 'omniclaw' }],
    },
  ],
}));

const getWatchingAgentsForRepo = mock(
  (_config: unknown, owner: string, repo: string) => {
    return owner.toLowerCase() === 'omniaura' &&
      repo.toLowerCase() === 'omniclaw'
      ? ['agent-a']
      : [];
  },
);

const invalidateGitHubContextCacheForAgents = mock((_agentIds: string[]) => 0);

mock.module('./github.js', () => ({
  loadGitHubWatchesConfig,
  getWatchingAgentsForRepo,
  invalidateGitHubContextCacheForAgents,
}));

import {
  buildGitHubWebhookNotification,
  verifyGitHubWebhookSignature,
} from './github-webhooks.js';

describe('github webhooks', () => {
  const secret = 'super-secret-key';

  it('verifies valid webhook signature', () => {
    const body = JSON.stringify({ hello: 'world' });
    const digest = createHmac('sha256', secret).update(body).digest('hex');

    const valid = verifyGitHubWebhookSignature(
      body,
      `sha256=${digest}`,
      secret,
    );
    expect(valid).toBe(true);
  });

  it('rejects invalid webhook signature', () => {
    const body = JSON.stringify({ hello: 'world' });
    const valid = verifyGitHubWebhookSignature(body, 'sha256=deadbeef', secret);
    expect(valid).toBe(false);
  });

  it('builds notification for watched PR review comment', () => {
    const notification = buildGitHubWebhookNotification(
      'pull_request_review_comment',
      'delivery-1',
      {
        action: 'created',
        repository: {
          owner: { login: 'omniaura' },
          name: 'omniclaw',
          full_name: 'omniaura/omniclaw',
        },
        sender: { login: 'reviewer' },
        pull_request: {
          number: 195,
          title: 'GitHub context injection',
          html_url: 'https://github.com/omniaura/omniclaw/pull/195',
        },
        comment: {
          body: 'Please simplify this branch selection logic.',
          html_url:
            'https://github.com/omniaura/omniclaw/pull/195#discussion_r1',
          path: 'src/index.ts',
          line: 120,
        },
      },
    );

    expect(notification).not.toBeNull();
    expect(notification?.owner).toBe('omniaura');
    expect(notification?.repo).toBe('omniclaw');
    expect(notification?.agentIds).toEqual(['agent-a']);
    expect(notification?.summary).toContain('PR #195');
    expect(notification?.summary).toContain('@reviewer');
    expect(getWatchingAgentsForRepo).toHaveBeenCalledTimes(1);
    expect(loadGitHubWatchesConfig).toHaveBeenCalledTimes(1);
  });

  it('ignores events for repos with no watchers', () => {
    const notification = buildGitHubWebhookNotification(
      'issues',
      'delivery-2',
      {
        action: 'opened',
        repository: {
          owner: { login: 'otherorg' },
          name: 'otherrepo',
          full_name: 'otherorg/otherrepo',
        },
        sender: { login: 'someone' },
        issue: {
          number: 1,
          title: 'hello',
          html_url: 'https://github.com/otherorg/otherrepo/issues/1',
        },
      },
    );

    expect(notification).toBeNull();
  });
});
