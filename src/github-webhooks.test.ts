import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHmac } from 'crypto';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import {
  _resetGitHubWebhookReplayCacheForTest,
  buildGitHubWebhookNotification,
  isGitHubWebhookDeliveryProcessed,
  markGitHubWebhookDeliveryProcessed,
  readGitHubWebhookBody,
  startGitHubWebhookServer,
  verifyGitHubWebhookSignature,
} from './github-webhooks.js';
import { _initTestDatabase, isGitHubWebhookDeliveryRecorded } from './db.js';
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

  beforeEach(() => {
    _initTestDatabase();
    _resetGitHubWebhookReplayCacheForTest();
  });

  afterAll(() => {
    fs.rmSync(path.join(DATA_DIR, 'github-watches.json'), { force: true });
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

  it('rejects duplicate deliveries after an in-memory cache reset', () => {
    const now = Date.parse('2026-03-16T00:00:00.000Z');

    expect(markGitHubWebhookDeliveryProcessed('delivery-replay', now)).toBe(
      true,
    );

    _resetGitHubWebhookReplayCacheForTest();

    expect(
      markGitHubWebhookDeliveryProcessed('delivery-replay', now + 1_000),
    ).toBe(false);
  });

  it('reads webhook bodies within the configured byte limit', async () => {
    const body = JSON.stringify({ hello: 'world' });
    const req = new Request('http://localhost/webhooks/github', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
    });

    await expect(readGitHubWebhookBody(req, 1024)).resolves.toBe(body);
  });

  it('rejects oversized webhook bodies from content-length before reading', async () => {
    const body = JSON.stringify({ hello: 'world' });
    const req = new Request('http://localhost/webhooks/github', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'content-length': '2048',
      },
    });

    await expect(readGitHubWebhookBody(req, 1024)).rejects.toThrow(
      'GitHub webhook body exceeded 1024 bytes',
    );
  });

  it('rejects oversized streamed webhook bodies without content-length', async () => {
    const req = new Request('http://localhost/webhooks/github', {
      method: 'POST',
      duplex: 'half',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"hello":"'));
          controller.enqueue(new TextEncoder().encode('world"}'));
          controller.close();
        },
      }),
      headers: {
        'content-type': 'application/json',
      },
    });

    await expect(readGitHubWebhookBody(req, 8)).rejects.toThrow(
      'GitHub webhook body exceeded 8 bytes',
    );
  });

  it('serves valid signed webhook requests within the byte limit', async () => {
    const body = JSON.stringify({
      action: 'opened',
      repository: {
        owner: { login: 'omniaura' },
        name: 'omniclaw',
        full_name: 'omniaura/omniclaw',
      },
      sender: { login: 'reviewer' },
      issue: {
        number: 1,
        title: 'hello',
        html_url: 'https://github.com/omniaura/omniclaw/issues/1',
      },
    });
    const digest = createHmac('sha256', secret).update(body).digest('hex');
    const deliveries: string[] = [];
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DATA_DIR, 'github-watches.json'),
      JSON.stringify(config),
    );
    const server = startGitHubWebhookServer({
      secret,
      port: 0,
      maxBodyBytes: 1024,
      onNotification: async (notification) => {
        deliveries.push(notification.deliveryId);
      },
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/webhooks/github`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-github-delivery': 'delivery-ok',
            'x-github-event': 'issues',
            'x-hub-signature-256': `sha256=${digest}`,
          },
          body,
        },
      );

      expect(response.status).toBe(200);
      expect(deliveries).toEqual(['delivery-ok']);
    } finally {
      server.stop();
    }
  });

  it('rejects oversized webhook requests with 413 before signature verification', async () => {
    const body = JSON.stringify({ hello: 'world' });
    const deliveries: string[] = [];
    const server = startGitHubWebhookServer({
      secret,
      port: 0,
      maxBodyBytes: 8,
      onNotification: async (notification) => {
        deliveries.push(notification.deliveryId);
      },
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/webhooks/github`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': '2048',
            'x-github-delivery': 'delivery-too-large',
            'x-github-event': 'issues',
            'x-hub-signature-256': 'sha256=deadbeef',
          },
          body,
        },
      );

      expect(response.status).toBe(413);
      expect(deliveries).toEqual([]);
    } finally {
      server.stop();
    }
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
          html_url:
            'https://github.com/omniaura/omniclaw/pull/264#pullrequestreview-1',
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
          html_url:
            'https://github.com/omniaura/omniclaw/issues/223#issuecomment-1',
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

describe('isGitHubWebhookDeliveryProcessed', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetGitHubWebhookReplayCacheForTest();
  });

  it('returns false for unknown delivery', () => {
    expect(isGitHubWebhookDeliveryProcessed('never-seen')).toBe(false);
  });

  it('returns true after delivery is marked via in-memory cache', () => {
    markGitHubWebhookDeliveryProcessed('delivery-check-1');
    expect(isGitHubWebhookDeliveryProcessed('delivery-check-1')).toBe(true);
  });

  it('returns true from DB after in-memory cache is cleared', () => {
    const now = Date.parse('2026-03-20T00:00:00.000Z');
    markGitHubWebhookDeliveryProcessed('delivery-check-2', now);
    _resetGitHubWebhookReplayCacheForTest();
    expect(
      isGitHubWebhookDeliveryProcessed('delivery-check-2', now + 1000),
    ).toBe(true);
  });
});

describe('isGitHubWebhookDeliveryRecorded (DB)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('returns false when delivery is not in DB', () => {
    expect(isGitHubWebhookDeliveryRecorded('not-in-db')).toBe(false);
  });

  it('returns true after delivery is recorded', () => {
    const now = Date.parse('2026-03-20T00:00:00.000Z');
    markGitHubWebhookDeliveryProcessed('recorded-1', now);
    expect(isGitHubWebhookDeliveryRecorded('recorded-1', now + 1000)).toBe(
      true,
    );
  });
});

describe('webhook server retry behavior (#365)', () => {
  const secret = 'test-secret';
  let port: number;
  let server: { stop: () => void };
  let handlerCalls: number;
  let handlerShouldThrow: boolean;

  function sign(body: string): string {
    return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  }

  function makeIssuePayload() {
    return JSON.stringify({
      action: 'opened',
      repository: {
        owner: { login: 'omniaura' },
        name: 'omniclaw',
        full_name: 'omniaura/omniclaw',
      },
      sender: { login: 'user' },
      issue: {
        number: 999,
        title: 'Test issue',
        html_url: 'https://github.com/omniaura/omniclaw/issues/999',
      },
    });
  }

  async function sendWebhook(
    deliveryId: string,
    body: string,
    event = 'issues',
  ) {
    return fetch(`http://localhost:${port}/webhooks/github`, {
      method: 'POST',
      headers: {
        'x-github-delivery': deliveryId,
        'x-github-event': event,
        'x-hub-signature-256': sign(body),
        'content-type': 'application/json',
      },
      body,
    });
  }

  beforeEach(() => {
    _initTestDatabase();
    _resetGitHubWebhookReplayCacheForTest();
    handlerCalls = 0;
    handlerShouldThrow = false;

    // Write a github-watches config so buildGitHubWebhookNotification returns
    // a notification for omniaura/omniclaw events.
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DATA_DIR, 'github-watches.json'),
      JSON.stringify({
        watches: [
          {
            agentId: 'test-agent',
            repos: [{ owner: 'omniaura', repo: 'omniclaw' }],
          },
        ],
      }),
    );

    // Pick a random high port to avoid conflicts with parallel tests.
    port = 30_000 + Math.floor(Math.random() * 20_000);
    server = startGitHubWebhookServer({
      secret,
      port,
      async onNotification() {
        handlerCalls++;
        if (handlerShouldThrow) throw new Error('transient failure');
      },
    });
  });

  afterAll(() => {
    server?.stop();
    // Clean up config file
    const configPath = path.join(DATA_DIR, 'github-watches.json');
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  });

  it('allows retry after handler failure (500)', async () => {
    const body = makeIssuePayload();
    handlerShouldThrow = true;

    // First attempt — handler throws, should return 500
    const res1 = await sendWebhook('retry-handler-500', body);
    expect(res1.status).toBe(500);
    expect(handlerCalls).toBe(1);

    // Delivery should NOT be marked as processed
    expect(isGitHubWebhookDeliveryProcessed('retry-handler-500')).toBe(false);

    // Retry with same delivery ID — should be processed this time
    handlerShouldThrow = false;
    const res2 = await sendWebhook('retry-handler-500', body);
    expect(res2.status).toBe(200);
    expect(handlerCalls).toBe(2);

    // Now the delivery IS marked as processed
    expect(isGitHubWebhookDeliveryProcessed('retry-handler-500')).toBe(true);
  });

  it('allows retry after malformed JSON (400)', async () => {
    const badBody = 'not valid json{{{';
    const deliveryId = 'retry-bad-json';

    const res1 = await sendWebhook(deliveryId, badBody);
    expect(res1.status).toBe(400);

    // Delivery should NOT be marked as processed
    expect(isGitHubWebhookDeliveryProcessed(deliveryId)).toBe(false);

    // Retry with valid payload
    const goodBody = makeIssuePayload();
    const res2 = await fetch(`http://localhost:${port}/webhooks/github`, {
      method: 'POST',
      headers: {
        'x-github-delivery': deliveryId,
        'x-github-event': 'issues',
        'x-hub-signature-256': sign(goodBody),
        'content-type': 'application/json',
      },
      body: goodBody,
    });
    expect(res2.status).toBe(200);
    expect(handlerCalls).toBe(1);
  });

  it('rejects duplicate after successful processing', async () => {
    const body = makeIssuePayload();
    const deliveryId = 'no-double-process';

    const res1 = await sendWebhook(deliveryId, body);
    expect(res1.status).toBe(200);
    expect(handlerCalls).toBe(1);

    // Same delivery ID again — should be rejected as duplicate
    const res2 = await sendWebhook(deliveryId, body);
    expect(res2.status).toBe(202);
    expect(handlerCalls).toBe(1); // handler NOT called again
  });
});
