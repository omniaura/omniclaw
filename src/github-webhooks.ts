import { createHmac, timingSafeEqual } from 'crypto';

import {
  getWatchingAgentsForRepo,
  invalidateGitHubContextCacheForAgents,
  loadGitHubWatchesConfig,
} from './github.js';
import { logger } from './logger.js';
import type { GitHubWatchesConfig } from './types.js';

const DEFAULT_PATH = '/webhooks/github';
const DELIVERY_TTL_MS = 10 * 60_000;

interface GitHubRepoRef {
  owner: { login: string };
  name: string;
  full_name: string;
}

interface GitHubSender {
  login: string;
}

type GitHubWebhookPayload = {
  action?: string;
  repository?: GitHubRepoRef;
  sender?: GitHubSender;
  pull_request?: {
    number: number;
    title: string;
    html_url?: string;
  };
  review?: {
    state?: string;
    html_url?: string;
    body?: string;
  };
  comment?: {
    body?: string;
    html_url?: string;
    path?: string;
    line?: number | null;
  };
  issue?: {
    number: number;
    title: string;
    html_url?: string;
  };
  check_suite?: {
    head_branch?: string;
    status?: string;
    conclusion?: string | null;
    html_url?: string;
  };
};

export interface GitHubWebhookNotification {
  event: string;
  action: string;
  deliveryId: string;
  owner: string;
  repo: string;
  summary: string;
  url?: string;
  agentIds: string[];
  cacheEntriesInvalidated: number;
}

interface ParsedWebhook {
  event: string;
  action: string;
  owner: string;
  repo: string;
  summary: string;
  url?: string;
}

function truncate(text: string | undefined, maxLen: number): string {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen)}...`;
}

function parseWebhookPayload(
  event: string,
  payload: GitHubWebhookPayload,
): ParsedWebhook | null {
  const repository = payload.repository;
  if (!repository?.owner?.login || !repository?.name) return null;

  const owner = repository.owner.login;
  const repo = repository.name;
  const action = payload.action || 'updated';
  const sender = payload.sender?.login || 'unknown';

  if (event === 'pull_request_review_comment' && payload.pull_request) {
    const pr = payload.pull_request;
    const comment = payload.comment;
    const fileLoc = comment?.path
      ? `${comment.path}${comment.line ? `:${comment.line}` : ''}`
      : 'unknown file';
    return {
      event,
      action,
      owner,
      repo,
      summary:
        `GitHub webhook: ${owner}/${repo} PR #${pr.number} received ` +
        `a review comment by @${sender} on ${fileLoc} (${truncate(comment?.body, 180)})`,
      url: comment?.html_url || pr.html_url,
    };
  }

  if (event === 'pull_request_review' && payload.pull_request) {
    const pr = payload.pull_request;
    const reviewState = payload.review?.state?.toLowerCase() || action;
    return {
      event,
      action,
      owner,
      repo,
      summary:
        `GitHub webhook: ${owner}/${repo} PR #${pr.number} review is ${reviewState} ` +
        `by @${sender} (${truncate(payload.review?.body, 180)})`,
      url: payload.review?.html_url || pr.html_url,
    };
  }

  if (event === 'issues' && payload.issue) {
    const issue = payload.issue;
    return {
      event,
      action,
      owner,
      repo,
      summary:
        `GitHub webhook: ${owner}/${repo} issue #${issue.number} ${action} ` +
        `by @${sender} (${issue.title})`,
      url: issue.html_url,
    };
  }

  if (event === 'issue_comment' && payload.issue) {
    const issue = payload.issue;
    return {
      event,
      action,
      owner,
      repo,
      summary:
        `GitHub webhook: ${owner}/${repo} issue #${issue.number} comment ${action} ` +
        `by @${sender} (${truncate(payload.comment?.body, 180)})`,
      url: payload.comment?.html_url || issue.html_url,
    };
  }

  if (event === 'check_suite' && payload.check_suite) {
    const suite = payload.check_suite;
    const conclusion = suite.conclusion || suite.status || action;
    return {
      event,
      action,
      owner,
      repo,
      summary:
        `GitHub webhook: ${owner}/${repo} CI check suite is ${conclusion} ` +
        `on branch ${suite.head_branch || 'unknown'}`,
      url: suite.html_url,
    };
  }

  return null;
}

export function verifyGitHubWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signatureHeader.slice('sha256='.length);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

const recentlyProcessedDeliveries = new Map<string, number>();

function cleanupDeliveryCache(now = Date.now()): void {
  for (const [deliveryId, ts] of recentlyProcessedDeliveries) {
    if (now - ts > DELIVERY_TTL_MS) {
      recentlyProcessedDeliveries.delete(deliveryId);
    }
  }
}

function markDeliveryProcessed(deliveryId: string): boolean {
  const now = Date.now();
  cleanupDeliveryCache(now);
  if (recentlyProcessedDeliveries.has(deliveryId)) return false;
  recentlyProcessedDeliveries.set(deliveryId, now);
  return true;
}

export function buildGitHubWebhookNotification(
  event: string,
  deliveryId: string,
  payload: GitHubWebhookPayload,
  configOverride?: GitHubWatchesConfig | null,
): GitHubWebhookNotification | null {
  const parsed = parseWebhookPayload(event, payload);
  if (!parsed) return null;

  const config =
    configOverride === undefined ? loadGitHubWatchesConfig() : configOverride;
  if (!config) return null;

  const agentIds = getWatchingAgentsForRepo(config, parsed.owner, parsed.repo);
  if (agentIds.length === 0) return null;

  const cacheEntriesInvalidated =
    invalidateGitHubContextCacheForAgents(agentIds);

  return {
    event: parsed.event,
    action: parsed.action,
    deliveryId,
    owner: parsed.owner,
    repo: parsed.repo,
    summary: parsed.summary,
    url: parsed.url,
    agentIds,
    cacheEntriesInvalidated,
  };
}

export interface GitHubWebhookServerOptions {
  secret: string;
  port: number;
  path?: string;
  onNotification: (notification: GitHubWebhookNotification) => Promise<void>;
}

export function startGitHubWebhookServer(options: GitHubWebhookServerOptions): {
  stop: () => void;
} {
  const pathname = options.path || DEFAULT_PATH;
  const server = Bun.serve({
    port: options.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== 'POST' || url.pathname !== pathname) {
        return new Response('Not Found', { status: 404 });
      }

      const deliveryId =
        req.headers.get('x-github-delivery') || 'unknown-delivery';
      const event = req.headers.get('x-github-event') || '';
      const signature = req.headers.get('x-hub-signature-256');
      const rawBody = await req.text();

      if (!verifyGitHubWebhookSignature(rawBody, signature, options.secret)) {
        logger.warn({ deliveryId, event }, 'Invalid GitHub webhook signature');
        return new Response('Invalid signature', { status: 401 });
      }

      if (!markDeliveryProcessed(deliveryId)) {
        return new Response('Duplicate delivery ignored', { status: 202 });
      }

      let payload: GitHubWebhookPayload;
      try {
        payload = JSON.parse(rawBody) as GitHubWebhookPayload;
      } catch (err) {
        logger.warn(
          { err, deliveryId, event },
          'Invalid GitHub webhook JSON payload',
        );
        return new Response('Bad payload', { status: 400 });
      }

      const notification = buildGitHubWebhookNotification(
        event,
        deliveryId,
        payload,
      );
      if (!notification) {
        return new Response('Ignored', { status: 202 });
      }

      try {
        await options.onNotification(notification);
      } catch (err) {
        logger.error(
          { err, event, deliveryId },
          'Failed handling GitHub webhook notification',
        );
        return new Response('Handler error', { status: 500 });
      }

      logger.info(
        {
          event: notification.event,
          action: notification.action,
          deliveryId,
          owner: notification.owner,
          repo: notification.repo,
          agentCount: notification.agentIds.length,
          cacheEntriesInvalidated: notification.cacheEntriesInvalidated,
        },
        'Processed GitHub webhook',
      );

      return new Response('OK', { status: 200 });
    },
  });

  logger.info(
    { port: options.port, path: pathname },
    'GitHub webhook server started',
  );

  return {
    stop: () => server.stop(true),
  };
}
