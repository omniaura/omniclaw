import { createHmac, timingSafeEqual } from 'crypto';

import {
  getWatchingAgentsForRepo,
  invalidateGitHubContextCacheForAgents,
  loadGitHubWatchesConfig,
} from './github.js';
import {
  isGitHubWebhookDeliveryRecorded,
  recordGitHubWebhookDelivery,
} from './db.js';
import { logger } from './logger.js';
import type { GitHubWatchesConfig } from './types.js';

const DEFAULT_PATH = '/webhooks/github';
const DELIVERY_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const textDecoder = new TextDecoder();

class RequestBodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`GitHub webhook body exceeded ${limitBytes} bytes`);
  }
}

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

export function markGitHubWebhookDeliveryProcessed(
  deliveryId: string,
  now = Date.now(),
): boolean {
  cleanupDeliveryCache(now);
  if (recentlyProcessedDeliveries.has(deliveryId)) return false;
  if (!recordGitHubWebhookDelivery(deliveryId, DELIVERY_TTL_MS, now)) {
    return false;
  }
  recentlyProcessedDeliveries.set(deliveryId, now);
  return true;
}

/**
 * Read-only check: returns true if the delivery was already successfully
 * processed (in-memory cache or persisted DB).  Does NOT insert anything.
 */
export function isGitHubWebhookDeliveryProcessed(
  deliveryId: string,
  now = Date.now(),
): boolean {
  cleanupDeliveryCache(now);
  if (recentlyProcessedDeliveries.has(deliveryId)) return true;
  return isGitHubWebhookDeliveryRecorded(deliveryId, now);
}

export function _resetGitHubWebhookReplayCacheForTest(): void {
  recentlyProcessedDeliveries.clear();
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
  maxBodyBytes?: number;
  onNotification: (notification: GitHubWebhookNotification) => Promise<void>;
}

function parseContentLengthHeader(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

export async function readGitHubWebhookBody(
  req: Request,
  maxBodyBytes: number,
): Promise<string> {
  const contentLength = parseContentLengthHeader(req.headers.get('content-length'));
  if (contentLength !== null && contentLength > maxBodyBytes) {
    throw new RequestBodyTooLargeError(maxBodyBytes);
  }

  if (!req.body) return '';

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    totalBytes += value.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new RequestBodyTooLargeError(maxBodyBytes);
    }

    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return textDecoder.decode(body);
}

export function startGitHubWebhookServer(options: GitHubWebhookServerOptions): {
  stop: () => void;
  port: number;
} {
  const pathname = options.path || DEFAULT_PATH;
  const maxBodyBytes = options.maxBodyBytes || DEFAULT_MAX_BODY_BYTES;
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
      let rawBody: string;
      try {
        rawBody = await readGitHubWebhookBody(req, maxBodyBytes);
      } catch (err) {
        if (err instanceof RequestBodyTooLargeError) {
          logger.warn(
            { deliveryId, event, maxBodyBytes },
            'Rejected oversized GitHub webhook payload',
          );
          return new Response('Payload Too Large', { status: 413 });
        }
        throw err;
      }

      if (!verifyGitHubWebhookSignature(rawBody, signature, options.secret)) {
        logger.warn({ deliveryId, event }, 'Invalid GitHub webhook signature');
        return new Response('Invalid signature', { status: 401 });
      }

      // Read-only duplicate check — does NOT mark the delivery as processed.
      // We only persist the delivery after the handler succeeds so that
      // GitHub retries are not suppressed by parse or handler failures (#365).
      if (isGitHubWebhookDeliveryProcessed(deliveryId)) {
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
        // Event parsed but not watched — safe to mark as processed so
        // retries of unwatched events are still short-circuited.
        markGitHubWebhookDeliveryProcessed(deliveryId);
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

      // Mark as processed only after the handler succeeds.
      markGitHubWebhookDeliveryProcessed(deliveryId);

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

  const port = server.port ?? Number(new URL(server.url).port);

  return {
    port,
    stop: () => server.stop(true),
  };
}
