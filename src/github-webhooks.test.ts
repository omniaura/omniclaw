import { describe, expect, it } from 'bun:test';
import { createHmac } from 'crypto';
import {
  buildGitHubWebhookNotification,
  verifyGitHubWebhookSignature,
} from './github-webhooks.js';
import type { GitHubWatchesConfig } from './types.js';

describe('github webhooks', () => {
  const secret = 'super-secret-key';
  const config: GitHubWatchesConfig = {
    watches: [
      {
        agentId: 'agent-a',
        repos: [{ owner: 'omniaura', repo: 'omniclaw' }],
      },
    ],
  };

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
      config,
    );

    expect(notification).not.toBeNull();
    expect(notification?.owner).toBe('omniaura');
    expect(notification?.repo).toBe('omniclaw');
    expect(notification?.agentIds).toEqual(['agent-a']);
    expect(notification?.summary).toContain('PR #195');
    expect(notification?.summary).toContain('@reviewer');
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
      config,
    );

    expect(notification).toBeNull();
  });

  it('builds notification for PR reviews', () => {
    const notification = buildGitHubWebhookNotification(
      'pull_request_review',
      'delivery-3',
      {
        action: 'submitted',
        repository: {
          owner: { login: 'omniaura' },
          name: 'omniclaw',
          full_name: 'omniaura/omniclaw',
        },
        sender: { login: 'reviewer' },
        pull_request: {
          number: 264,
          title: 'Improve webhook coverage',
          html_url: 'https://github.com/omniaura/omniclaw/pull/264',
        },
        review: {
          state: 'APPROVED',
          body: 'Looks good to me.',
          html_url: 'https://github.com/omniaura/omniclaw/pull/264#pullrequestreview-1',
        },
      },
      config,
    );

    expect(notification).not.toBeNull();
    expect(notification?.summary).toContain('review is approved');
    expect(notification?.summary).toContain('@reviewer');
    expect(notification?.url).toContain('pullrequestreview');
  });

  it('builds notification for issue comments and truncates bodies', () => {
    const longBody = 'Needs more tests. '.repeat(20);
    const notification = buildGitHubWebhookNotification(
      'issue_comment',
      'delivery-4',
      {
        action: 'created',
        repository: {
          owner: { login: 'omniaura' },
          name: 'omniclaw',
          full_name: 'omniaura/omniclaw',
        },
        sender: { login: 'maintainer' },
        issue: {
          number: 223,
          title: 'Inject GitHub activity delta context',
          html_url: 'https://github.com/omniaura/omniclaw/issues/223',
        },
        comment: {
          body: longBody,
          html_url: 'https://github.com/omniaura/omniclaw/issues/223#issuecomment-1',
        },
      },
      config,
    );

    expect(notification).not.toBeNull();
    expect(notification?.summary).toContain('issue #223 comment created');
    expect(notification?.summary).toContain('@maintainer');
    expect(notification?.summary.endsWith('...)')).toBe(true);
    expect(notification?.url).toContain('issuecomment');
  });

  it('builds notification for check suites with fallback branch text', () => {
    const notification = buildGitHubWebhookNotification(
      'check_suite',
      'delivery-5',
      {
        action: 'completed',
        repository: {
          owner: { login: 'omniaura' },
          name: 'omniclaw',
          full_name: 'omniaura/omniclaw',
        },
        check_suite: {
          status: 'completed',
          conclusion: 'failure',
          html_url: 'https://github.com/omniaura/omniclaw/actions/runs/1',
        },
      },
      config,
    );

    expect(notification).not.toBeNull();
    expect(notification?.summary).toContain('CI check suite is failure');
    expect(notification?.summary).toContain('branch unknown');
  });

  it('ignores unsupported events and missing config', () => {
    const unsupported = buildGitHubWebhookNotification(
      'release',
      'delivery-6',
      {
        action: 'published',
        repository: {
          owner: { login: 'omniaura' },
          name: 'omniclaw',
          full_name: 'omniaura/omniclaw',
        },
      },
      config,
    );

    const missingConfig = buildGitHubWebhookNotification(
      'issues',
      'delivery-7',
      {
        action: 'opened',
        repository: {
          owner: { login: 'omniaura' },
          name: 'omniclaw',
          full_name: 'omniaura/omniclaw',
        },
        issue: {
          number: 1,
          title: 'hello',
        },
      },
      null,
    );

    expect(unsupported).toBeNull();
    expect(missingConfig).toBeNull();
  });
});
