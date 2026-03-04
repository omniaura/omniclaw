import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHmac } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import {
  buildGitHubWebhookNotification,
  verifyGitHubWebhookSignature,
} from './github-webhooks.js';

describe('github webhooks', () => {
  const secret = 'super-secret-key';
  const configPath = path.join(DATA_DIR, 'github-watches.json');
  let backupConfig: string | null = null;

  beforeEach(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    backupConfig = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, 'utf8')
      : null;
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          watches: [
            {
              agentId: 'agent-a',
              repos: [{ owner: 'omniaura', repo: 'omniclaw' }],
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
  });

  afterEach(() => {
    if (backupConfig !== null) {
      fs.writeFileSync(configPath, backupConfig, 'utf8');
    } else if (fs.existsSync(configPath)) {
      fs.rmSync(configPath, { force: true });
    }
  });

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
