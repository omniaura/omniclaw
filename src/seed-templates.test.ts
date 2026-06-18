/**
 * Tests for seed template versioning and reconciliation — issue #247
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildSeededContent,
  extractSeedVersion,
  getDiscordChannelSeed,
  getServerSeed,
  inferTemplateKey,
  reconcileSeededFiles,
  SEED_TEMPLATES,
} from './seed-templates.js';

// ---- Test helpers ----

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-template-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(relativePath: string, content: string): string {
  const fullPath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  return fullPath;
}

// =============================================================================
// Version marker utilities
// =============================================================================

describe('extractSeedVersion', () => {
  it('extracts version from a valid marker', () => {
    const content = 'Some content\n\n<!-- omniclaw-seed:v3 -->';
    expect(extractSeedVersion(content)).toBe(3);
  });

  it('extracts version with trailing whitespace', () => {
    const content = 'Content\n<!-- omniclaw-seed:v7 -->  \n';
    expect(extractSeedVersion(content)).toBe(7);
  });

  it('returns null when no marker is present', () => {
    expect(extractSeedVersion('Just regular content')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractSeedVersion('')).toBeNull();
  });

  it('returns null for marker in wrong position (not at end)', () => {
    const content = '<!-- omniclaw-seed:v1 -->\nMore content after';
    expect(extractSeedVersion(content)).toBeNull();
  });

  it('handles large version numbers', () => {
    const content = 'Content\n<!-- omniclaw-seed:v999 -->';
    expect(extractSeedVersion(content)).toBe(999);
  });
});

describe('buildSeededContent', () => {
  it('appends version marker to template body', () => {
    const template = { key: 'test', version: 5, body: 'Hello world\n' };
    const result = buildSeededContent(template);

    expect(result).toBe('Hello world\n\n<!-- omniclaw-seed:v5 -->');
    expect(extractSeedVersion(result)).toBe(5);
  });

  it('produces content that round-trips through extractSeedVersion', () => {
    for (const template of SEED_TEMPLATES.values()) {
      const content = buildSeededContent(template);
      expect(extractSeedVersion(content)).toBe(template.version);
    }
  });
});

// =============================================================================
// Template registry
// =============================================================================

describe('SEED_TEMPLATES', () => {
  it('contains discord-channel and server templates', () => {
    expect(SEED_TEMPLATES.has('discord-channel')).toBe(true);
    expect(SEED_TEMPLATES.has('server')).toBe(true);
  });

  it('all templates have positive version numbers', () => {
    for (const template of SEED_TEMPLATES.values()) {
      expect(template.version).toBeGreaterThan(0);
    }
  });

  it('all templates have non-empty body content', () => {
    for (const template of SEED_TEMPLATES.values()) {
      expect(template.body.length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// Seed content helpers
// =============================================================================

describe('getDiscordChannelSeed', () => {
  it('returns content with version marker', () => {
    const content = getDiscordChannelSeed();
    expect(extractSeedVersion(content)).not.toBeNull();
  });

  it('includes channel-specific guidance', () => {
    const content = getDiscordChannelSeed();
    expect(content).toContain('Discord');
    expect(content).toContain('secondary channel');
  });

  it('includes silent-by-default guidance for unaddressed turns', () => {
    const content = getDiscordChannelSeed();
    expect(content).toContain('<internal>');
    expect(content).toContain('stripInternalTags');
  });

  it('matches the discord-channel template version', () => {
    const content = getDiscordChannelSeed();
    const template = SEED_TEMPLATES.get('discord-channel')!;
    expect(extractSeedVersion(content)).toBe(template.version);
  });
});

describe('getServerSeed', () => {
  it('returns content with version marker', () => {
    const content = getServerSeed();
    expect(extractSeedVersion(content)).not.toBeNull();
  });

  it('includes server-level guidance', () => {
    const content = getServerSeed();
    expect(content).toContain('Server Shared Context');
    expect(content).toContain('all channels');
  });

  it('matches the server template version', () => {
    const content = getServerSeed();
    const template = SEED_TEMPLATES.get('server')!;
    expect(extractSeedVersion(content)).toBe(template.version);
  });
});

// =============================================================================
// inferTemplateKey
// =============================================================================

describe('inferTemplateKey', () => {
  it('returns server for server-level paths', () => {
    expect(inferTemplateKey('/groups/servers/my-guild/CLAUDE.md', true)).toBe(
      'server',
    );
  });

  it('returns discord-channel for non-server paths', () => {
    expect(inferTemplateKey('/groups/my-channel/CLAUDE.md', false)).toBe(
      'discord-channel',
    );
  });
});

// =============================================================================
// Reconciliation
// =============================================================================

describe('reconcileSeededFiles', () => {
  it('reports empty results for nonexistent directory', () => {
    const result = reconcileSeededFiles('/nonexistent/path');
    expect(result.updated).toHaveLength(0);
    expect(result.current).toHaveLength(0);
    expect(result.unversioned).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('reports empty results for empty directory', () => {
    const result = reconcileSeededFiles(tmpDir);
    expect(result.updated).toHaveLength(0);
  });

  it('detects unversioned files (pre-versioning seeded files)', () => {
    writeFile(
      'my-group/CLAUDE.md',
      '## Old channel content\nNo version marker',
    );

    const result = reconcileSeededFiles(tmpDir);
    expect(result.unversioned).toHaveLength(1);
    expect(result.unversioned[0]).toContain('my-group/CLAUDE.md');
  });

  it('detects stale versioned files in dry-run mode', () => {
    // Write a CLAUDE.md with an old version
    writeFile(
      'my-channel/CLAUDE.md',
      '## Old content\n\n<!-- omniclaw-seed:v1 -->',
    );

    const result = reconcileSeededFiles(tmpDir, true);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]).toContain('my-channel/CLAUDE.md');
  });

  it('does not modify files in dry-run mode', () => {
    const filePath = writeFile(
      'my-channel/CLAUDE.md',
      '## Old content\n\n<!-- omniclaw-seed:v1 -->',
    );

    reconcileSeededFiles(tmpDir, true);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('Old content');
    expect(extractSeedVersion(content)).toBe(1);
  });

  it('updates stale files when dryRun=false', () => {
    const filePath = writeFile(
      'stale-group/CLAUDE.md',
      '## Stale content\n\n<!-- omniclaw-seed:v1 -->',
    );

    const result = reconcileSeededFiles(tmpDir, false);
    expect(result.updated).toHaveLength(1);

    const newContent = fs.readFileSync(filePath, 'utf-8');
    const newVersion = extractSeedVersion(newContent);
    const template = SEED_TEMPLATES.get('discord-channel')!;
    expect(newVersion).toBe(template.version);
    expect(newContent).toContain(template.body);
  });

  it('reports current files that are already up-to-date', () => {
    const template = SEED_TEMPLATES.get('discord-channel')!;
    writeFile('up-to-date/CLAUDE.md', buildSeededContent(template));

    const result = reconcileSeededFiles(tmpDir, true);
    expect(result.current).toHaveLength(1);
    expect(result.updated).toHaveLength(0);
  });

  it('handles server-level files in servers/ subdirectory', () => {
    writeFile(
      'servers/my-guild/CLAUDE.md',
      '## Old server\n\n<!-- omniclaw-seed:v1 -->',
    );

    const result = reconcileSeededFiles(tmpDir, true);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]).toContain('servers/my-guild/CLAUDE.md');
  });

  it('ignores non-directory entries inside servers/', () => {
    writeFile('servers/README.md', 'not a server folder');
    writeFile(
      'servers/real-server/CLAUDE.md',
      '## Old server\n\n<!-- omniclaw-seed:v1 -->',
    );

    const result = reconcileSeededFiles(tmpDir, true);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]).toContain('servers/real-server/CLAUDE.md');
  });

  it('reports current server files that match latest version', () => {
    const serverTemplate = SEED_TEMPLATES.get('server')!;
    writeFile(
      'servers/current-guild/CLAUDE.md',
      buildSeededContent(serverTemplate),
    );

    const result = reconcileSeededFiles(tmpDir, true);
    expect(result.current).toHaveLength(1);
  });

  it('handles mixed stale and current files', () => {
    const discordTemplate = SEED_TEMPLATES.get('discord-channel')!;
    const serverTemplate = SEED_TEMPLATES.get('server')!;

    // One stale, one current
    writeFile(
      'stale-channel/CLAUDE.md',
      '## Stale\n\n<!-- omniclaw-seed:v1 -->',
    );
    writeFile('current-channel/CLAUDE.md', buildSeededContent(discordTemplate));
    writeFile(
      'servers/stale-server/CLAUDE.md',
      '## Stale server\n\n<!-- omniclaw-seed:v1 -->',
    );
    writeFile(
      'servers/current-server/CLAUDE.md',
      buildSeededContent(serverTemplate),
    );

    const result = reconcileSeededFiles(tmpDir, true);
    expect(result.updated).toHaveLength(2);
    expect(result.current).toHaveLength(2);
  });

  it('skips directories without CLAUDE.md', () => {
    fs.mkdirSync(path.join(tmpDir, 'empty-group'), { recursive: true });
    const result = reconcileSeededFiles(tmpDir, true);
    expect(result.updated).toHaveLength(0);
    expect(result.current).toHaveLength(0);
  });

  it('records errors when a discovered CLAUDE.md cannot be read', () => {
    fs.mkdirSync(path.join(tmpDir, 'broken-channel', 'CLAUDE.md'), {
      recursive: true,
    });

    const result = reconcileSeededFiles(tmpDir, true);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toContain('broken-channel/CLAUDE.md');
    expect(result.errors[0].error).toBeTruthy();
  });
});
