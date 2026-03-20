/**
 * GitHub Linked Context
 *
 * Detects GitHub PR/issue URLs in user messages and auto-fetches
 * review comments, CI status, and summaries so agents don't need
 * to manually call `gh api`.
 */

import { logger } from './logger.js';
import {
  githubFetch,
  fetchPrReviews,
  fetchPrReviewComments,
  fetchCombinedStatus,
  formatPrMarkdown,
  truncate,
  type GitHubPr,
  type GitHubIssue,
} from './github.js';

// --- Types ---

export interface ParsedGitHubLink {
  owner: string;
  repo: string;
  type: 'pull' | 'issue';
  number: number;
  url: string;
}

interface GitHubIssueComment {
  user: { login: string } | null;
  body: string;
  created_at: string;
}

// --- URL Parsing ---

const GITHUB_URL_REGEX =
  /https?:\/\/github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)\/(pull|issues)\/(\d+)/g;

const MAX_LINKED_ITEMS = 3;

export function extractGitHubLinks(text: string): ParsedGitHubLink[] {
  const links: ParsedGitHubLink[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(GITHUB_URL_REGEX)) {
    const type = match[3] === 'pull' ? 'pull' : 'issue';
    const key = `${match[1]}/${match[2]}/${type}/${match[4]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      owner: match[1],
      repo: match[2],
      type,
      number: parseInt(match[4], 10),
      url: match[0],
    });
  }
  return links;
}

// --- Cache ---

const LINKED_CACHE_TTL_MS = 300_000; // 5 minutes

interface LinkedCacheEntry {
  markdown: string;
  fetchedAt: number;
}

const linkedCache = new Map<string, LinkedCacheEntry>();

function linkedCacheKey(link: ParsedGitHubLink): string {
  return `linked:${link.owner}/${link.repo}/${link.type}/${link.number}`;
}

function getCached(key: string): string | null {
  const entry = linkedCache.get(key);
  if (entry && Date.now() - entry.fetchedAt < LINKED_CACHE_TTL_MS) {
    return entry.markdown;
  }
  return null;
}

// --- Single-resource fetch ---

async function fetchSinglePr(
  owner: string,
  repo: string,
  number: number,
): Promise<GitHubPr | null> {
  return githubFetch<GitHubPr>(`/repos/${owner}/${repo}/pulls/${number}`);
}

async function fetchSingleIssue(
  owner: string,
  repo: string,
  number: number,
): Promise<GitHubIssue | null> {
  return githubFetch<GitHubIssue>(`/repos/${owner}/${repo}/issues/${number}`);
}

async function fetchIssueComments(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<GitHubIssueComment[]> {
  const comments = await githubFetch<GitHubIssueComment[]>(
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=10&sort=created&direction=desc`,
  );
  return comments || [];
}

// --- Formatting ---

function formatLinkedIssueMarkdown(
  issue: GitHubIssue,
  comments: GitHubIssueComment[],
): string {
  const author = issue.user?.login || 'unknown';
  const labels = issue.labels.map((l) => l.name).join(', ') || 'none';
  const assignee = issue.assignee?.login || 'unassigned';
  const lines: string[] = [];
  lines.push(`### Issue #${issue.number}: ${issue.title}`);
  lines.push(`- Author: ${author} | Labels: ${labels} | Assignee: ${assignee}`);
  if (issue.body) {
    lines.push(`- Description: ${truncate(issue.body, 300)}`);
  }

  if (comments.length > 0) {
    lines.push(`- Comments (${comments.length}):`);
    for (const c of comments.slice(0, 5)) {
      lines.push(
        `  - ${c.user?.login || '?'}: ${truncate(c.body, 150)}`,
      );
    }
    if (comments.length > 5) {
      lines.push(`  - ... and ${comments.length - 5} more comments`);
    }
  }

  return lines.join('\n');
}

// --- Per-link fetchers ---

async function fetchLinkedPr(link: ParsedGitHubLink): Promise<string | null> {
  const cacheKey = linkedCacheKey(link);
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const pr = await fetchSinglePr(link.owner, link.repo, link.number);
  if (!pr) return null;

  const [reviews, comments, ciStatus] = await Promise.all([
    fetchPrReviews(link.owner, link.repo, link.number),
    fetchPrReviewComments(link.owner, link.repo, link.number),
    fetchCombinedStatus(link.owner, link.repo, pr.head.ref),
  ]);

  const markdown = formatPrMarkdown(pr, reviews, comments, ciStatus);
  linkedCache.set(cacheKey, { markdown, fetchedAt: Date.now() });
  return markdown;
}

async function fetchLinkedIssue(
  link: ParsedGitHubLink,
): Promise<string | null> {
  const cacheKey = linkedCacheKey(link);
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const issue = await fetchSingleIssue(link.owner, link.repo, link.number);
  if (!issue) return null;

  // If this "issue" is actually a PR, fetch as PR for richer data
  if (issue.pull_request) {
    return fetchLinkedPr({ ...link, type: 'pull' });
  }

  const comments = await fetchIssueComments(
    link.owner,
    link.repo,
    link.number,
  );
  const markdown = formatLinkedIssueMarkdown(issue, comments);
  linkedCache.set(cacheKey, { markdown, fetchedAt: Date.now() });
  return markdown;
}

// --- Main entry point ---

/**
 * Extract GitHub PR/issue URLs from message content and fetch their context.
 * Returns formatted markdown or null if no links found.
 */
export async function fetchGitHubLinkedContext(
  messages: Array<{ content: string }>,
): Promise<string | null> {
  if (!process.env.GITHUB_TOKEN) return null;

  // Extract and deduplicate links across all messages
  const allLinks: ParsedGitHubLink[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    for (const link of extractGitHubLinks(msg.content)) {
      const key = linkedCacheKey(link);
      if (seen.has(key)) continue;
      seen.add(key);
      allLinks.push(link);
    }
  }

  if (allLinks.length === 0) return null;

  // Cap to avoid API overload
  const links = allLinks.slice(0, MAX_LINKED_ITEMS);

  if (links.length < allLinks.length) {
    logger.info(
      { total: allLinks.length, capped: links.length },
      'Capped linked GitHub context items',
    );
  }

  const results = await Promise.allSettled(
    links.map((link) =>
      link.type === 'pull' ? fetchLinkedPr(link) : fetchLinkedIssue(link),
    ),
  );

  const sections: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled' && result.value) {
      sections.push(result.value);
    } else if (result.status === 'rejected') {
      logger.warn(
        { err: result.reason, link: links[i].url },
        'Failed to fetch linked GitHub context',
      );
    }
  }

  if (sections.length === 0) return null;

  return `# Linked GitHub Context\n\n${sections.join('\n\n---\n\n')}`;
}
