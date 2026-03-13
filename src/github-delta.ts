/**
 * GitHub Activity Delta Context
 *
 * Fetches GitHub activity (PR lifecycle, reviews, comments, issues) that occurred
 * between user messages, so agents see a compact delta digest instead of stale snapshots.
 *
 * Per-channel watched repos are configured in data/github-watches.json under
 * the `channelWatches` key. Delta cursors are persisted in the SQLite DB.
 */

import { logger } from './logger.js';
import type { GitHubChannelWatch, GitHubWatchesConfig } from './types.js';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

// --- GitHub API types ---

interface GitHubIssueComment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
  html_url: string;
}

interface GitHubPrListItem {
  number: number;
  title: string;
  state: string;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  user: { login: string } | null;
  html_url: string;
  draft: boolean;
}

interface GitHubIssueListItem {
  number: number;
  title: string;
  state: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  user: { login: string } | null;
  html_url: string;
  pull_request?: unknown;
}

interface GitHubPrReview {
  id: number;
  user: { login: string } | null;
  state: string;
  body: string | null;
  submitted_at: string;
  html_url: string;
}

interface GitHubPrReviewComment {
  id: number;
  user: { login: string } | null;
  body: string;
  path: string;
  line: number | null;
  created_at: string;
  html_url: string;
}

interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string } | null;
  };
  html_url: string;
  author: { login: string } | null;
}

// --- Normalized delta event ---

export interface DeltaEvent {
  eventId: string;
  repo: string;
  type:
    | 'pr_opened'
    | 'pr_closed'
    | 'pr_merged'
    | 'pr_reopened'
    | 'pr_review'
    | 'pr_review_comment'
    | 'pr_commits'
    | 'issue_opened'
    | 'issue_closed'
    | 'issue_reopened'
    | 'issue_comment';
  actor: string;
  subject: string;
  url: string;
  occurredAt: string;
  summary: string;
}

// --- GitHub API helpers ---

async function githubFetch<T>(urlPath: string): Promise<T | null> {
  if (!GITHUB_TOKEN) return null;
  const url = `https://api.github.com${urlPath}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'OmniClaw/1.0',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, url },
        'GitHub delta API request failed',
      );
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ err, url }, 'GitHub delta API request error');
    return null;
  }
}

// --- Delta collection per repo ---

const PER_REPO_EVENT_CAP = 25;

async function collectPrDelta(
  owner: string,
  repo: string,
  since: string,
  until: string,
): Promise<DeltaEvent[]> {
  const events: DeltaEvent[] = [];
  const repoSlug = `${owner}/${repo}`;

  // Fetch recently updated PRs
  const prs = await githubFetch<GitHubPrListItem[]>(
    `/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=30`,
  );
  if (!prs) return events;

  for (const pr of prs) {
    // Skip PRs not updated in our window
    if (pr.updated_at <= since) continue;

    // PR opened
    if (pr.created_at > since && pr.created_at <= until) {
      events.push({
        eventId: `pr-opened-${pr.number}`,
        repo: repoSlug,
        type: 'pr_opened',
        actor: pr.user?.login || 'unknown',
        subject: `PR #${pr.number}: ${pr.title}`,
        url: pr.html_url,
        occurredAt: pr.created_at,
        summary: `PR #${pr.number} opened${pr.draft ? ' (draft)' : ''}: ${pr.title}`,
      });
    }

    // PR merged
    if (pr.merged_at && pr.merged_at > since && pr.merged_at <= until) {
      events.push({
        eventId: `pr-merged-${pr.number}`,
        repo: repoSlug,
        type: 'pr_merged',
        actor: pr.user?.login || 'unknown',
        subject: `PR #${pr.number}: ${pr.title}`,
        url: pr.html_url,
        occurredAt: pr.merged_at,
        summary: `PR #${pr.number} merged: ${pr.title}`,
      });
    }

    // PR closed (without merge)
    if (
      pr.state === 'closed' &&
      !pr.merged_at &&
      pr.closed_at &&
      pr.closed_at > since &&
      pr.closed_at <= until
    ) {
      events.push({
        eventId: `pr-closed-${pr.number}`,
        repo: repoSlug,
        type: 'pr_closed',
        actor: pr.user?.login || 'unknown',
        subject: `PR #${pr.number}: ${pr.title}`,
        url: pr.html_url,
        occurredAt: pr.closed_at,
        summary: `PR #${pr.number} closed: ${pr.title}`,
      });
    }

    // Fetch reviews for active PRs updated in window
    if (pr.state === 'open' || pr.merged_at) {
      const reviews = await githubFetch<GitHubPrReview[]>(
        `/repos/${owner}/${repo}/pulls/${pr.number}/reviews?per_page=20`,
      );
      if (reviews) {
        for (const review of reviews) {
          const reviewTime = review.submitted_at;
          if (reviewTime > since && reviewTime <= until) {
            events.push({
              eventId: `pr-review-${review.id}`,
              repo: repoSlug,
              type: 'pr_review',
              actor: review.user?.login || 'unknown',
              subject: `PR #${pr.number}: ${pr.title}`,
              url: review.html_url,
              occurredAt: reviewTime,
              summary: `${review.state} review on PR #${pr.number} by ${review.user?.login || '?'}${review.body ? `: "${truncate(review.body, 80)}"` : ''}`,
            });
          }
        }
      }

      // Fetch review comments
      const reviewComments = await githubFetch<GitHubPrReviewComment[]>(
        `/repos/${owner}/${repo}/pulls/${pr.number}/comments?sort=created&direction=desc&per_page=20`,
      );
      if (reviewComments) {
        for (const comment of reviewComments) {
          if (comment.created_at > since && comment.created_at <= until) {
            events.push({
              eventId: `pr-review-comment-${comment.id}`,
              repo: repoSlug,
              type: 'pr_review_comment',
              actor: comment.user?.login || 'unknown',
              subject: `PR #${pr.number}: ${pr.title}`,
              url: comment.html_url,
              occurredAt: comment.created_at,
              summary: `Review comment on PR #${pr.number} (${comment.path}${comment.line ? `:${comment.line}` : ''}): "${truncate(comment.body, 80)}"`,
            });
          }
        }
      }

      // Fetch new commits on open PRs
      if (pr.state === 'open') {
        const commits = await githubFetch<GitHubCommit[]>(
          `/repos/${owner}/${repo}/pulls/${pr.number}/commits?per_page=20`,
        );
        if (commits) {
          const newCommits = commits.filter(
            (c) =>
              c.commit.author?.date &&
              c.commit.author.date > since &&
              c.commit.author.date <= until,
          );
          if (newCommits.length > 0) {
            events.push({
              eventId: `pr-commits-${pr.number}-${newCommits.length}`,
              repo: repoSlug,
              type: 'pr_commits',
              actor:
                newCommits[newCommits.length - 1].author?.login || 'unknown',
              subject: `PR #${pr.number}: ${pr.title}`,
              url: pr.html_url,
              occurredAt:
                newCommits[newCommits.length - 1].commit.author?.date || until,
              summary: `${newCommits.length} new commit${newCommits.length > 1 ? 's' : ''} on PR #${pr.number}`,
            });
          }
        }
      }
    }

    if (events.length >= PER_REPO_EVENT_CAP) break;
  }

  return events.slice(0, PER_REPO_EVENT_CAP);
}

async function collectIssueDelta(
  owner: string,
  repo: string,
  since: string,
  until: string,
): Promise<DeltaEvent[]> {
  const events: DeltaEvent[] = [];
  const repoSlug = `${owner}/${repo}`;

  // Fetch recently updated issues (excludes PRs)
  const issues = await githubFetch<GitHubIssueListItem[]>(
    `/repos/${owner}/${repo}/issues?state=all&sort=updated&direction=desc&per_page=30&since=${since}`,
  );
  if (!issues) return events;

  for (const issue of issues) {
    // GitHub returns PRs as issues too — skip them
    if (issue.pull_request) continue;
    if (issue.updated_at <= since) continue;

    // Issue opened
    if (issue.created_at > since && issue.created_at <= until) {
      events.push({
        eventId: `issue-opened-${issue.number}`,
        repo: repoSlug,
        type: 'issue_opened',
        actor: issue.user?.login || 'unknown',
        subject: `Issue #${issue.number}: ${issue.title}`,
        url: issue.html_url,
        occurredAt: issue.created_at,
        summary: `Issue #${issue.number} opened: ${issue.title}`,
      });
    }

    // Issue closed
    if (
      issue.state === 'closed' &&
      issue.closed_at &&
      issue.closed_at > since &&
      issue.closed_at <= until
    ) {
      events.push({
        eventId: `issue-closed-${issue.number}`,
        repo: repoSlug,
        type: 'issue_closed',
        actor: issue.user?.login || 'unknown',
        subject: `Issue #${issue.number}: ${issue.title}`,
        url: issue.html_url,
        occurredAt: issue.closed_at,
        summary: `Issue #${issue.number} closed: ${issue.title}`,
      });
    }

    // Fetch comments for issues updated in window
    const comments = await githubFetch<GitHubIssueComment[]>(
      `/repos/${owner}/${repo}/issues/${issue.number}/comments?since=${since}&per_page=10`,
    );
    if (comments) {
      for (const comment of comments) {
        if (comment.created_at > since && comment.created_at <= until) {
          events.push({
            eventId: `issue-comment-${comment.id}`,
            repo: repoSlug,
            type: 'issue_comment',
            actor: comment.user?.login || 'unknown',
            subject: `Issue #${issue.number}: ${issue.title}`,
            url: comment.html_url,
            occurredAt: comment.created_at,
            summary: `Comment on issue #${issue.number} by ${comment.user?.login || '?'}: "${truncate(comment.body, 80)}"`,
          });
        }
      }
    }

    if (events.length >= PER_REPO_EVENT_CAP) break;
  }

  return events.slice(0, PER_REPO_EVENT_CAP);
}

// --- Helpers ---

function truncate(text: string, maxLen: number): string {
  const cleaned = text.replace(/\r\n/g, '\n').replace(/\n/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + '…';
}

/** Deduplicate events by eventId */
function dedupeEvents(events: DeltaEvent[]): DeltaEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    if (seen.has(e.eventId)) return false;
    seen.add(e.eventId);
    return true;
  });
}

// --- Ring buffer for cross-turn dedupe ---

const RING_BUFFER_SIZE = 200;
const channelRingBuffers = new Map<string, Set<string>>();

function getOrCreateRingBuffer(channelJid: string): Set<string> {
  let buf = channelRingBuffers.get(channelJid);
  if (!buf) {
    buf = new Set();
    channelRingBuffers.set(channelJid, buf);
  }
  return buf;
}

function filterAlreadyInjected(
  channelJid: string,
  events: DeltaEvent[],
): DeltaEvent[] {
  const buf = getOrCreateRingBuffer(channelJid);
  return events.filter((e) => !buf.has(e.eventId));
}

function markAsInjected(channelJid: string, events: DeltaEvent[]): void {
  const buf = getOrCreateRingBuffer(channelJid);
  for (const e of events) {
    buf.add(e.eventId);
    // Evict oldest when buffer exceeds size
    if (buf.size > RING_BUFFER_SIZE) {
      const first = buf.values().next().value;
      if (first) buf.delete(first);
    }
  }
}

// --- Delta cursor state (in-memory + DB persistence) ---

const deltaCursors = new Map<string, string>();
let cursorsLoaded = false;

/** Warm in-memory cursors from DB (called once at startup). */
export function loadDeltaCursorsFromDb(): void {
  if (cursorsLoaded) return;
  try {
    const { loadAllDeltaCursors } = require('./db.js');
    const saved = loadAllDeltaCursors() as Map<string, string>;
    for (const [jid, ts] of saved) {
      deltaCursors.set(jid, ts);
    }
    cursorsLoaded = true;
  } catch {
    // DB not initialized yet — will be populated on first message
  }
}

export function getDeltaCursor(channelJid: string): string | undefined {
  if (!cursorsLoaded) loadDeltaCursorsFromDb();
  return deltaCursors.get(channelJid);
}

export function setDeltaCursor(channelJid: string, timestamp: string): void {
  deltaCursors.set(channelJid, timestamp);
  try {
    const { setDeltaCursorInDb } = require('./db.js');
    setDeltaCursorInDb(channelJid, timestamp);
  } catch {
    // DB write failed — in-memory state is still updated
  }
}

// --- Config helpers ---

export function getChannelWatches(
  config: GitHubWatchesConfig,
  channelJid: string,
): GitHubChannelWatch | undefined {
  return config.channelWatches?.find((w) => w.channelJid === channelJid);
}

export function isDeltaEnabled(config: GitHubWatchesConfig): boolean {
  return config.githubDeltaContextEnabled === true;
}

// --- Main entry point ---

const GLOBAL_EVENT_CAP = 100;
const MAX_CONCURRENT_REPOS = 3;

/**
 * Fetch GitHub activity delta for a channel since the last user message.
 *
 * @param channelJid - The channel JID to fetch delta for
 * @param currentMessageTimestamp - ISO timestamp of the current user message (exclusive upper bound)
 * @returns Formatted markdown digest, or null if no events / feature disabled / error
 */
export async function fetchGitHubDelta(
  channelJid: string,
  currentMessageTimestamp: string,
): Promise<string | null> {
  if (!GITHUB_TOKEN) return null;

  // Load config
  let config: GitHubWatchesConfig;
  try {
    const { loadGitHubWatchesConfig } = await import('./github.js');
    config = (loadGitHubWatchesConfig() as GitHubWatchesConfig) ?? null;
    if (!config) return null;
  } catch {
    return null;
  }

  if (!isDeltaEnabled(config)) return null;

  const channelWatch = getChannelWatches(config, channelJid);
  if (!channelWatch || channelWatch.repos.length === 0) return null;

  const since = getDeltaCursor(channelJid);
  if (!since) {
    // First message in channel — set cursor, no delta to show
    setDeltaCursor(channelJid, currentMessageTimestamp);
    return null;
  }

  const until = currentMessageTimestamp;

  // Don't fetch if window is too narrow (< 5 seconds)
  if (new Date(until).getTime() - new Date(since).getTime() < 5_000) {
    setDeltaCursor(channelJid, until);
    return null;
  }

  try {
    const allEvents: DeltaEvent[] = [];

    // Bounded parallelism: process repos in batches
    const repos = channelWatch.repos;
    for (let i = 0; i < repos.length; i += MAX_CONCURRENT_REPOS) {
      const batch = repos.slice(i, i + MAX_CONCURRENT_REPOS);
      const results = await Promise.allSettled(
        batch.map(async (repo) => {
          const [prEvents, issueEvents] = await Promise.all([
            collectPrDelta(repo.owner, repo.repo, since, until),
            collectIssueDelta(repo.owner, repo.repo, since, until),
          ]);
          return [...prEvents, ...issueEvents];
        }),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          allEvents.push(...result.value);
        } else {
          logger.warn(
            { err: result.reason },
            'GitHub delta: partial repo fetch failed',
          );
        }
      }
    }

    if (allEvents.length === 0) {
      setDeltaCursor(channelJid, until);
      return null;
    }

    // Dedupe, sort, cap
    let events = dedupeEvents(allEvents);
    events = filterAlreadyInjected(channelJid, events);
    events.sort(
      (a, b) =>
        new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
    );
    events = events.slice(0, GLOBAL_EVENT_CAP);

    if (events.length === 0) {
      setDeltaCursor(channelJid, until);
      return null;
    }

    // Format digest
    const digest = formatDeltaDigest(events);

    // Update state
    markAsInjected(channelJid, events);
    setDeltaCursor(channelJid, until);

    logger.info(
      {
        channelJid,
        since,
        until,
        eventCount: events.length,
        repoCount: repos.length,
      },
      'GitHub delta context injected',
    );

    return digest;
  } catch (err) {
    logger.warn({ err, channelJid }, 'Failed to fetch GitHub delta context');
    // Don't block message handling — update cursor and move on
    setDeltaCursor(channelJid, until);
    return null;
  }
}

// --- Formatting ---

/**
 * Format delta events into a compact markdown digest for injection into the system prompt.
 */
export function formatDeltaDigest(events: DeltaEvent[]): string {
  if (events.length === 0) return '';

  // Group by repo for compact display
  const byRepo = new Map<string, DeltaEvent[]>();
  for (const event of events) {
    const list = byRepo.get(event.repo) || [];
    list.push(event);
    byRepo.set(event.repo, list);
  }

  // Group repetitive events (e.g., multiple comments on same PR)
  const lines: string[] = ['# GitHub Activity Since Last Message\n'];

  for (const [repo, repoEvents] of byRepo) {
    lines.push(`## ${repo}`);

    // Group comments by subject to condense
    const grouped = groupEvents(repoEvents);
    for (const line of grouped) {
      lines.push(`- ${line}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

/** Group repetitive events for compact display */
function groupEvents(events: DeltaEvent[]): string[] {
  const lines: string[] = [];
  const commentCounts = new Map<
    string,
    { count: number; actors: Set<string>; subject: string }
  >();

  for (const event of events) {
    if (event.type === 'pr_review_comment' || event.type === 'issue_comment') {
      const key = event.subject;
      const entry = commentCounts.get(key) || {
        count: 0,
        actors: new Set(),
        subject: key,
      };
      entry.count++;
      entry.actors.add(event.actor);
      commentCounts.set(key, entry);

      // Show first comment inline, rest will be summarized
      if (entry.count === 1) {
        lines.push(event.summary);
      }
    } else {
      lines.push(event.summary);
    }
  }

  // Append grouped comment summaries
  for (const [key, entry] of commentCounts) {
    if (entry.count > 1) {
      const actors = Array.from(entry.actors).join(', ');
      lines.push(`${entry.count} comments on ${entry.subject} by ${actors}`);
    }
  }

  return lines;
}
