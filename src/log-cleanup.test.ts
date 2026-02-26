import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { collectLogFiles, evictOldest } from './log-cleanup.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-cleanup-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- collectLogFiles ---

describe('collectLogFiles', () => {
  it('collects files from the logs directory', () => {
    const logsDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logsDir);
    fs.writeFileSync(path.join(logsDir, 'omniclaw.log'), 'data');
    fs.writeFileSync(path.join(logsDir, 'omniclaw.stdout.log'), 'out');
    fs.writeFileSync(path.join(logsDir, 'other.txt'), 'other');

    const files = collectLogFiles(logsDir);

    expect(files.length).toBe(3);
    const mainLog = files.find((f) => f.path.endsWith('omniclaw.log'));
    expect(mainLog).toBeDefined();
    expect(mainLog!.truncateOnly).toBe(true);

    const other = files.find((f) => f.path.endsWith('other.txt'));
    expect(other).toBeDefined();
    expect(other!.truncateOnly).toBe(false);
  });

  it('marks all three main log names as truncateOnly', () => {
    const logsDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logsDir);
    for (const name of ['omniclaw.log', 'omniclaw.stdout.log', 'omniclaw.error.log']) {
      fs.writeFileSync(path.join(logsDir, name), 'x');
    }

    const files = collectLogFiles(logsDir);
    expect(files.every((f) => f.truncateOnly)).toBe(true);
  });

  it('returns empty array for nonexistent logs dir', () => {
    const files = collectLogFiles(path.join(tmpDir, 'nonexistent'));
    expect(files.length).toBe(0);
  });
});

// --- evictOldest ---

describe('evictOldest', () => {
  it('deletes oldest files until total is under budget', () => {
    const dir = path.join(tmpDir, 'evict');
    fs.mkdirSync(dir);

    // Create 3 files, 100 bytes each = 300 total
    const files = [];
    for (let i = 0; i < 3; i++) {
      const p = path.join(dir, `file-${i}.log`);
      fs.writeFileSync(p, 'x'.repeat(100));
      const mtime = new Date(Date.now() - (3 - i) * 60000);
      fs.utimesSync(p, mtime, mtime);
      const stat = fs.statSync(p);
      files.push({ path: p, size: stat.size, mtimeMs: stat.mtimeMs, truncateOnly: false });
    }

    // Budget of 150 — need to delete oldest 2 (200 bytes) to get to 100
    const cleaned = evictOldest(files, 150);

    expect(cleaned).toBe(2);
    expect(fs.existsSync(path.join(dir, 'file-0.log'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'file-1.log'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'file-2.log'))).toBe(true);
  });

  it('truncates main process logs instead of deleting them', () => {
    const dir = path.join(tmpDir, 'trunc');
    fs.mkdirSync(dir);

    const p = path.join(dir, 'omniclaw.log');
    fs.writeFileSync(p, 'x'.repeat(500));
    const stat = fs.statSync(p);

    const files = [
      { path: p, size: stat.size, mtimeMs: stat.mtimeMs, truncateOnly: true },
    ];

    // Budget of 100 — must truncate the 500-byte file
    const cleaned = evictOldest(files, 100);

    expect(cleaned).toBe(1);
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBe(0);
  });

  it('does nothing when total is under budget', () => {
    const dir = path.join(tmpDir, 'ok');
    fs.mkdirSync(dir);

    const p = path.join(dir, 'small.log');
    fs.writeFileSync(p, 'tiny');
    const stat = fs.statSync(p);

    const files = [
      { path: p, size: stat.size, mtimeMs: stat.mtimeMs, truncateOnly: false },
    ];

    const cleaned = evictOldest(files, 1000);

    expect(cleaned).toBe(0);
    expect(fs.existsSync(p)).toBe(true);
  });

  it('handles already-vanished files gracefully', () => {
    const dir = path.join(tmpDir, 'vanish');
    fs.mkdirSync(dir);

    // One real file + one vanished file, both over budget
    const realPath = path.join(dir, 'real.log');
    fs.writeFileSync(realPath, 'x'.repeat(100));
    const stat = fs.statSync(realPath);

    const files = [
      { path: path.join(dir, 'gone.log'), size: 100, mtimeMs: 0, truncateOnly: false },
      { path: realPath, size: stat.size, mtimeMs: stat.mtimeMs, truncateOnly: false },
    ];

    // Budget 50 — should attempt both, not throw on the vanished one
    const cleaned = evictOldest(files, 50);
    // gone.log vanished (no increment), real.log deleted (increment)
    expect(cleaned).toBe(1);
    expect(fs.existsSync(realPath)).toBe(false);
  });

  it('evicts oldest first, preserving newest files', () => {
    const dir = path.join(tmpDir, 'order');
    fs.mkdirSync(dir);

    const now = Date.now();
    const entries = [];

    for (let i = 0; i < 5; i++) {
      const p = path.join(dir, `log-${i}.log`);
      fs.writeFileSync(p, 'x'.repeat(100));
      const mtime = new Date(now - (5 - i) * 60000);
      fs.utimesSync(p, mtime, mtime);
      const stat = fs.statSync(p);
      entries.push({ path: p, size: stat.size, mtimeMs: stat.mtimeMs, truncateOnly: false });
    }

    // Total 500, budget 200 — need to delete 3 oldest (300 bytes)
    const cleaned = evictOldest(entries, 200);

    expect(cleaned).toBe(3);
    // Oldest 3 gone
    expect(fs.existsSync(path.join(dir, 'log-0.log'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'log-1.log'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'log-2.log'))).toBe(false);
    // Newest 2 remain
    expect(fs.existsSync(path.join(dir, 'log-3.log'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'log-4.log'))).toBe(true);
  });
});
