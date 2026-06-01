/**
 * Seeded CLAUDE.md templates with version tracking.
 *
 * Each template has a version string embedded as a comment at the end of the
 * file. When template content changes, bump the version. The reconciler can
 * detect stale files by comparing the embedded version against the current
 * template version.
 *
 * Version format: `<!-- omniclaw-seed:v{N} -->`
 *
 * @see Issue #247 — Reconcile seeded CLAUDE.md files when template guidance changes
 */

import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

export interface SeedTemplate {
  /** Unique key identifying this template type. */
  key: string;
  /** Current version number. Bump when content changes. */
  version: number;
  /** The template body (without the version marker — it's appended automatically). */
  body: string;
}

const DISCORD_CHANNEL_TEMPLATE: SeedTemplate = {
  key: 'discord-channel',
  version: 3,
  body: `## Channel: Discord (Secondary)
This group communicates via Discord, a secondary channel.
You can freely answer questions and have conversations here.
For significant actions (file changes, scheduled tasks, sending messages to other groups),
confirm intent with the current user in this chat before proceeding.

## Stay Silent When Nothing Is Addressed to You
Not every turn deserves a reply. Reactions, ambient chatter between other people,
and messages that don't mention or invite you are not requests for your output.
Default to silence in those cases — don't post filler like "got it" or "looking into it".

To end a turn silently, emit only \`<internal>…</internal>\` content. Anything inside
those tags is stripped before send (see \`stripInternalTags\` in \`src/router.ts\`), and
a turn that produces only internal-tagged text is suppressed entirely. Use this for
private notes-to-self when the right action is no action.

## Getting Context You Don't Have
When you need project context, repo access, credentials, or information that hasn't been shared with you:
- Use \`mcp__omniclaw__share_request\` to request it from the admin — don't ask users for what the admin should provide.
- Be specific: describe exactly what you need and why.
- Check local docs and repo files first before requesting.

## Working with Repos
You have \`git\` and \`GITHUB_TOKEN\` available in your environment.
When the admin shares a repo URL, clone it yourself:
\`\`\`bash
git clone https://github.com/org/repo.git /workspace/group/repos/repo
\`\`\`
Then read the code directly — don't ask the admin to copy files for you.
`,
};

const SERVER_TEMPLATE: SeedTemplate = {
  key: 'server',
  version: 2,
  body: `# Server Shared Context

This file is shared across all channels in this Discord server.
Use it for team-level context: members, projects, repos, conventions.
Channel-specific notes should go in the channel's own CLAUDE.md.

## Getting Context You Don't Have
If you need project info, repo URLs, or credentials not listed here, use \`mcp__omniclaw__share_request\` to request it from the admin.
Be explicit about what you need and why.

## Working with Repos
You have \`git\` and \`GITHUB_TOKEN\` available. When given a repo URL, clone it:
\`\`\`bash
git clone https://github.com/org/repo.git /workspace/group/repos/repo
\`\`\`
`,
};

// Registry of all templates
export const SEED_TEMPLATES: ReadonlyMap<string, SeedTemplate> = new Map([
  [DISCORD_CHANNEL_TEMPLATE.key, DISCORD_CHANNEL_TEMPLATE],
  [SERVER_TEMPLATE.key, SERVER_TEMPLATE],
]);

// ---------------------------------------------------------------------------
// Version marker utilities
// ---------------------------------------------------------------------------

const VERSION_MARKER_RE = /<!-- omniclaw-seed:v(\d+) -->$/;

/** Build the full seeded content with the version marker appended. */
export function buildSeededContent(template: SeedTemplate): string {
  return `${template.body}\n<!-- omniclaw-seed:v${template.version} -->`;
}

/** Extract the version number from a file's content. Returns null if no marker found. */
export function extractSeedVersion(content: string): number | null {
  const match = content.trimEnd().match(VERSION_MARKER_RE);
  return match ? parseInt(match[1], 10) : null;
}

/** Extract the template key from a file path pattern. */
export function inferTemplateKey(
  filePath: string,
  isServerLevel: boolean,
): string {
  if (isServerLevel) return 'server';
  // Default to discord-channel for group-level CLAUDE.md
  return 'discord-channel';
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  /** Files that were updated to the current template version. */
  updated: string[];
  /** Files that are already current. */
  current: string[];
  /** Files with no version marker (user-edited or pre-versioning). */
  unversioned: string[];
  /** Files that could not be read or processed. */
  errors: Array<{ path: string; error: string }>;
}

/**
 * Scan seeded CLAUDE.md files and report which ones are stale.
 *
 * @param groupsDir - Base directory containing group/server folders
 * @param dryRun - If true, only report; don't write updates (default: true)
 */
export function reconcileSeededFiles(
  groupsDir: string,
  dryRun = true,
): ReconcileResult {
  const result: ReconcileResult = {
    updated: [],
    current: [],
    unversioned: [],
    errors: [],
  };

  // Scan for CLAUDE.md files
  const entries = findClaudeMdFiles(groupsDir);

  for (const entry of entries) {
    try {
      const content = fs.readFileSync(entry.filePath, 'utf-8');
      const version = extractSeedVersion(content);
      const template = SEED_TEMPLATES.get(entry.templateKey);

      if (!template) {
        // No matching template — skip (custom file)
        continue;
      }

      if (version === null) {
        // No version marker — file predates versioning or was user-edited
        result.unversioned.push(entry.filePath);
        continue;
      }

      if (version >= template.version) {
        result.current.push(entry.filePath);
        continue;
      }

      // Stale — update if not dry run
      if (!dryRun) {
        const newContent = buildSeededContent(template);
        fs.writeFileSync(entry.filePath, newContent);
        logger.info(
          {
            op: 'seedReconcile',
            path: entry.filePath,
            oldVersion: version,
            newVersion: template.version,
            templateKey: entry.templateKey,
          },
          `Reconciled seeded CLAUDE.md from v${version} to v${template.version}`,
        );
      }
      result.updated.push(entry.filePath);
    } catch (err) {
      result.errors.push({
        path: entry.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

interface ClaudeMdEntry {
  filePath: string;
  templateKey: string;
}

/**
 * Find all seeded CLAUDE.md files that could match a known template.
 * Looks for:
 *  - servers/STAR/CLAUDE.md => server template
 *  - groups that start with dc: => discord-channel template
 *    (detected by checking if the CLAUDE.md has a seed version marker)
 */
function findClaudeMdFiles(groupsDir: string): ClaudeMdEntry[] {
  const entries: ClaudeMdEntry[] = [];

  if (!fs.existsSync(groupsDir)) return entries;

  // Scan top-level directories
  for (const dirName of fs.readdirSync(groupsDir)) {
    const dirPath = path.join(groupsDir, dirName);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    // Determine template key from directory structure
    // servers/* directories use the server template
    if (dirName === 'servers' || dirPath.includes('/servers/')) {
      // Scan subdirectories of servers/
      for (const serverDir of fs.readdirSync(dirPath)) {
        const serverPath = path.join(dirPath, serverDir);
        if (!fs.statSync(serverPath).isDirectory()) continue;
        const serverClaudeMd = path.join(dirPath, serverDir, 'CLAUDE.md');
        if (fs.existsSync(serverClaudeMd)) {
          entries.push({ filePath: serverClaudeMd, templateKey: 'server' });
        }
      }
      continue;
    }

    // For channel/group directories, reconcile any CLAUDE.md and let the
    // caller decide whether it is current, stale, or unversioned.
    const claudeMdPath = path.join(dirPath, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) continue;
    entries.push({
      filePath: claudeMdPath,
      templateKey: inferTemplateKey(claudeMdPath, false),
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Exports for use in index.ts seeding
// ---------------------------------------------------------------------------

/** Get the Discord channel template content (with version marker). */
export function getDiscordChannelSeed(): string {
  return buildSeededContent(DISCORD_CHANNEL_TEMPLATE);
}

/** Get the server-level template content (with version marker). */
export function getServerSeed(): string {
  return buildSeededContent(SERVER_TEMPLATE);
}
