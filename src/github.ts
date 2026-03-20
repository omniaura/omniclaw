/**
 * GitHub Context Injection
 *
 * Polls GitHub REST API for open PRs, issues, and review comments
 * for configured watched repos. Results are cached to avoid excessive API calls.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import type {
  GitHubAgentWatch,
  GitHubRepoWatch,
  GitHubWatchesConfig,
} from './types.js';

const DEFAULT_CACHE_TTL_MS = 300_000; // 5 minutes
const DEFAULT_PR_LIMIT = 10;
const DEFAULT_ISSUE_LIMIT = 10;
const MAX_LIST_LIMIT = 50;

// --- Types for GitHub API responses ---

export interface GitHubPr {
  number: number;
  title: string;
  user: { login: string } | null;
  head: { ref: string };
  base: { ref: string };
  state: string;
  draft: boolean;
  requested_reviewers: Array<{ login: string }>;
  html_url: string;
  body: string | null;
  created_at: string;
  updated_at: string;
}

export interface GitHubReviewComment {
  user: { login: string } | null;
  body: string;
  path: string;
  line: number | null;
  created_at: string;
}

export interface GitHubReview {
  user: { login: string } | null;
  state: string;
  body: string | null;
}

export interface GitHubIssue {
  number: number;
  title: string;
  user: { login: string } | null;
  state: string;
  labels: Array<{ name: string }>;
  assignee: { login: string } | null;
  html_url: string;
  body: string | null;
  created_at: string;
  updated_at: string;
  pull_request?: unknown; // Present if the issue is actually a PR
}

interface GitHubCheckSuite {
  conclusion: string | null;
  status: string;
}

// --- Cache ---

interface CacheEntry {
  markdown: string;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

function getCacheKey(agentId: string): string {
  return `github:${agentId}`;
}

export function invalidateGitHubContextCacheForAgents(
  agentIds: string[],
): number {
  let removed = 0;
  for (const agentId of agentIds) {
    if (cache.delete(getCacheKey(agentId))) removed++;
  }
  return removed;
}

export function getWatchingAgentsForRepo(
  config: GitHubWatchesConfig,
  owner: string,
  repo: string,
): string[] {
  const ownerLc = owner.toLowerCase();
  const repoLc = repo.toLowerCase();
  return config.watches
    .filter((watch) =>
      watch.repos.some(
        (watchedRepo) =>
          watchedRepo.owner.toLowerCase() === ownerLc &&
          watchedRepo.repo.toLowerCase() === repoLc,
      ),
    )
    .map((watch) => watch.agentId);
}

export function normalizeLimit(
  value: number | undefined,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value as number);
  if (rounded <= 0) return fallback;
  return Math.min(rounded, MAX_LIST_LIMIT);
}

// --- Config loading ---

const CONFIG_FILENAME = 'github-watches.json';

export function loadGitHubWatchesConfig(): GitHubWatchesConfig | null {
  const configPath = path.join(DATA_DIR, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as GitHubWatchesConfig;
  } catch (err) {
    logger.warn({ err, configPath }, 'Failed to parse github-watches.json');
    return null;
  }
}

export function getWatchesForAgent(
  config: GitHubWatchesConfig,
  agentId: string,
): GitHubAgentWatch | undefined {
  return config.watches.find((w) => w.agentId === agentId);
}

// --- GitHub API ---

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

export async function githubFetch<T>(urlPath: string): Promise<T | null> {
  if (!GITHUB_TOKEN) {
    logger.warn('GITHUB_TOKEN not set — skipping GitHub API call');
    return null;
  }
  const url = `https://api.github.com${urlPath}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'OmniClaw/1.0',
      },
    });
    if (!res.ok) {
      logger.warn({ status: res.status, url }, 'GitHub API request failed');
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ err, url }, 'GitHub API request error');
    return null;
  }
}

async function fetchOpenPrs(
  owner: string,
  repo: string,
  limit: number,
): Promise<GitHubPr[]> {
  const prs = await githubFetch<GitHubPr[]>(
    `/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${limit}`,
  );
  return prs || [];
}

export async function fetchPrReviewComments(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<GitHubReviewComment[]> {
  const comments = await githubFetch<GitHubReviewComment[]>(
    `/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=30&sort=created&direction=desc`,
  );
  return comments || [];
}

export async function fetchPrReviews(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<GitHubReview[]> {
  const reviews = await githubFetch<GitHubReview[]>(
    `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
  );
  return reviews || [];
}

async function fetchRecentIssues(
  owner: string,
  repo: string,
  limit: number,
): Promise<GitHubIssue[]> {
  const issues = await githubFetch<GitHubIssue[]>(
    `/repos/${owner}/${repo}/issues?state=open&sort=updated&direction=desc&per_page=${limit}`,
  );
  // Filter out PRs (GitHub API returns PRs as issues too)
  return (issues || []).filter((i) => !i.pull_request);
}

export async function fetchCombinedStatus(
  owner: string,
  repo: string,
  ref: string,
): Promise<string> {
  const result = await githubFetch<{ check_suites: GitHubCheckSuite[] }>(
    `/repos/${owner}/${repo}/commits/${ref}/check-suites`,
  );
  if (!result?.check_suites?.length) return 'unknown';
  const suites = result.check_suites;
  if (suites.some((s) => s.conclusion === 'failure')) return 'failing';
  if (suites.some((s) => s.status === 'in_progress')) return 'pending';
  if (suites.every((s) => s.conclusion === 'success')) return 'passing';
  return 'mixed';
}

// --- Markdown formatting ---

export function truncate(text: string | null | undefined, maxLen: number): string {
  if (!text) return '';
  const cleaned = text.replace(/\r\n/g, '\n').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + '…';
}

export function formatPrMarkdown(
  pr: GitHubPr,
  reviews: GitHubReview[],
  comments: GitHubReviewComment[],
  ciStatus: string,
): string {
  const draft = pr.draft ? ' (DRAFT)' : '';
  const author = pr.user?.login || 'unknown';
  const reviewState =
    reviews.length > 0
      ? reviews
          .filter((r) => r.state !== 'COMMENTED' && r.state !== 'PENDING')
          .map((r) => `${r.user?.login}: ${r.state}`)
          .join(', ') || 'pending review'
      : 'pending review';

  const lines: string[] = [];
  lines.push(`### PR #${pr.number}: ${pr.title}${draft}`);
  lines.push(
    `- Author: ${author} | Branch: \`${pr.head.ref}\` → \`${pr.base.ref}\``,
  );
  lines.push(`- CI: ${ciStatus} | Reviews: ${reviewState}`);

  if (pr.body) {
    lines.push(`- Description: ${truncate(pr.body, 200)}`);
  }

  if (comments.length > 0) {
    lines.push(`- Review comments (${comments.length}):`);
    // Show most recent comments first, limit to 5
    for (const c of comments.slice(0, 5)) {
      const file = c.path ? ` on \`${c.path}\`` : '';
      const line = c.line ? `:${c.line}` : '';
      lines.push(
        `  - ${c.user?.login || '?'}${file}${line}: ${truncate(c.body, 150)}`,
      );
    }
    if (comments.length > 5) {
      lines.push(`  - ... and ${comments.length - 5} more comments`);
    }
  }

  return lines.join('\n');
}

export function formatIssueMarkdown(issue: GitHubIssue): string {
  const author = issue.user?.login || 'unknown';
  const labels = issue.labels.map((l) => l.name).join(', ') || 'none';
  const assignee = issue.assignee?.login || 'unassigned';
  const lines: string[] = [];
  lines.push(`- **#${issue.number}**: ${issue.title}`);
  lines.push(`  Labels: ${labels} | Assignee: ${assignee} | Author: ${author}`);
  if (issue.body) {
    lines.push(`  ${truncate(issue.body, 150)}`);
  }
  return lines.join('\n');
}

// --- Main fetch + format ---

async function fetchRepoContext(watch: GitHubRepoWatch): Promise<string> {
  const { owner, repo } = watch;
  const prLimit = normalizeLimit(watch.openPrs?.limit, DEFAULT_PR_LIMIT);
  const issueLimit = normalizeLimit(
    watch.recentIssues?.limit,
    DEFAULT_ISSUE_LIMIT,
  );
  const includeReviewComments = watch.openPrs?.includeReviewComments ?? true;

  const sections: string[] = [];
  sections.push(`## ${owner}/${repo}`);

  // Fetch PRs
  const prs = await fetchOpenPrs(owner, repo, prLimit);
  if (prs.length > 0) {
    sections.push(`\n### Open PRs (${prs.length})`);
    for (const pr of prs) {
      // Fetch reviews and comments in parallel per PR
      const [reviews, comments, ciStatus] = await Promise.all([
        fetchPrReviews(owner, repo, pr.number),
        includeReviewComments
          ? fetchPrReviewComments(owner, repo, pr.number)
          : Promise.resolve([]),
        fetchCombinedStatus(owner, repo, pr.head.ref),
      ]);
      sections.push(formatPrMarkdown(pr, reviews, comments, ciStatus));
    }
  } else {
    sections.push('\nNo open PRs.');
  }

  // Fetch issues
  const issues = await fetchRecentIssues(owner, repo, issueLimit);
  if (issues.length > 0) {
    sections.push(`\n### Open Issues (${issues.length})`);
    for (const issue of issues) {
      sections.push(formatIssueMarkdown(issue));
    }
  } else {
    sections.push('\nNo open issues.');
  }

  return sections.join('\n');
}

/**
 * Fetch GitHub context for an agent's watched repos.
 * Results are cached for `cacheTtlMs` (default 5 minutes).
 */
export async function fetchGitHubContext(
  agentWatch: GitHubAgentWatch,
  cacheTtlMs: number = DEFAULT_CACHE_TTL_MS,
): Promise<string | null> {
  const cacheKey = getCacheKey(agentWatch.agentId);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < cacheTtlMs) {
    return cached.markdown;
  }

  try {
    const repoSections = await Promise.all(
      agentWatch.repos.map(fetchRepoContext),
    );
    const markdown = `# GitHub Context\n\n${repoSections.join('\n\n---\n\n')}`;
    cache.set(cacheKey, { markdown, fetchedAt: Date.now() });
    return markdown;
  } catch (err) {
    logger.error(
      { err, agentId: agentWatch.agentId },
      'Failed to fetch GitHub context',
    );
    // Return stale cache if available
    if (cached) return cached.markdown;
    return null;
  }
}

/**
 * Get GitHub context for an agent, loading config from disk.
 * Returns null if no watches configured or GITHUB_TOKEN not set.
 */
export async function getGitHubContextForAgent(
  agentId: string,
): Promise<string | null> {
  if (!GITHUB_TOKEN) return null;

  const config = loadGitHubWatchesConfig();
  if (!config) return null;

  const agentWatch = getWatchesForAgent(config, agentId);
  if (!agentWatch || agentWatch.repos.length === 0) return null;

  return fetchGitHubContext(agentWatch, config.cacheTtlMs);
}
