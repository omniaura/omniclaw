import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import path from 'path';
import os from 'os';

import {
  readIpcJsonFile,
  listIpcJsonFiles,
  quarantineIpcFile,
} from './ipc-file-security.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ipc-security-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('readIpcJsonFile', () => {
  it('reads a valid JSON file', () => {
    const filePath = path.join(tmpDir, 'valid.json');
    writeFileSync(filePath, JSON.stringify({ type: 'message', text: 'hello' }));

    const result = readIpcJsonFile(filePath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as { type: string }).type).toBe('message');
      expect((result.data as { text: string }).text).toBe('hello');
    }
  });

  it('rejects symlinks', () => {
    const realFile = path.join(tmpDir, 'real.json');
    const link = path.join(tmpDir, 'link.json');
    writeFileSync(realFile, JSON.stringify({ type: 'test' }));
    symlinkSync(realFile, link);

    const result = readIpcJsonFile(link);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('symlink rejected');
    }
  });

  it('rejects non-existent files', () => {
    const result = readIpcJsonFile(path.join(tmpDir, 'missing.json'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('lstat failed');
    }
  });

  it('rejects directories', () => {
    const dirPath = path.join(tmpDir, 'subdir');
    mkdirSync(dirPath);

    const result = readIpcJsonFile(dirPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('not a regular file');
    }
  });

  it('rejects oversized files', () => {
    const filePath = path.join(tmpDir, 'big.json');
    // Create a file just over 1 MiB
    const bigContent = '{"data":"' + 'x'.repeat(1024 * 1024 + 100) + '"}';
    writeFileSync(filePath, bigContent);

    const result = readIpcJsonFile(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('too large');
    }
  });

  it('rejects invalid JSON', () => {
    const filePath = path.join(tmpDir, 'bad.json');
    writeFileSync(filePath, '{ invalid json !!!');

    const result = readIpcJsonFile(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('invalid JSON');
    }
  });

  it('reads files with unicode content', () => {
    const filePath = path.join(tmpDir, 'unicode.json');
    writeFileSync(
      filePath,
      JSON.stringify({ text: '🎉 こんにちは 안녕하세요' }),
    );

    const result = readIpcJsonFile(filePath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as { text: string }).text).toBe(
        '🎉 こんにちは 안녕하세요',
      );
    }
  });

  it('reads empty JSON object', () => {
    const filePath = path.join(tmpDir, 'empty.json');
    writeFileSync(filePath, '{}');

    const result = readIpcJsonFile(filePath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({});
    }
  });

  it('accepts file just under size limit', () => {
    const filePath = path.join(tmpDir, 'justunder.json');
    const MAX_SIZE = 1024 * 1024;
    // Build JSON and verify byte length is under limit before writing
    const jsonOverhead = Buffer.byteLength(JSON.stringify({ d: '' }));
    const content = JSON.stringify({
      d: 'a'.repeat(MAX_SIZE - jsonOverhead - 1),
    });
    expect(Buffer.byteLength(content)).toBeLessThan(MAX_SIZE);
    writeFileSync(filePath, content);

    const result = readIpcJsonFile(filePath);
    expect(result.ok).toBe(true);
  });
});

describe('listIpcJsonFiles', () => {
  it('lists only .json regular files', () => {
    writeFileSync(path.join(tmpDir, 'a.json'), '{}');
    writeFileSync(path.join(tmpDir, 'b.json'), '{}');
    writeFileSync(path.join(tmpDir, 'readme.txt'), 'hello');
    mkdirSync(path.join(tmpDir, 'subdir'));

    const files = listIpcJsonFiles(tmpDir);
    expect(files.sort()).toEqual(['a.json', 'b.json']);
  });

  it('excludes symlinks to .json files', () => {
    const realFile = path.join(tmpDir, 'real.json');
    writeFileSync(realFile, '{}');
    symlinkSync(realFile, path.join(tmpDir, 'link.json'));

    const files = listIpcJsonFiles(tmpDir);
    expect(files).toEqual(['real.json']);
  });

  it('returns empty array for non-existent directory', () => {
    const files = listIpcJsonFiles(path.join(tmpDir, 'nonexistent'));
    expect(files).toEqual([]);
  });

  it('returns empty array for empty directory', () => {
    const emptyDir = path.join(tmpDir, 'empty');
    mkdirSync(emptyDir);

    const files = listIpcJsonFiles(emptyDir);
    expect(files).toEqual([]);
  });
});

describe('quarantineIpcFile', () => {
  it('moves file to errors directory with timestamp', () => {
    const filePath = path.join(tmpDir, 'bad.json');
    writeFileSync(filePath, 'corrupt');

    quarantineIpcFile(filePath, tmpDir, 'invalid JSON', 'test-group');

    expect(existsSync(filePath)).toBe(false);
    // Verify file was moved to errors dir with timestamp prefix
    const errDir = path.join(tmpDir, 'errors');
    const files = readdirSync(errDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^test-group-\d+-bad\.json$/);
  });

  it('creates errors directory if it does not exist', () => {
    const filePath = path.join(tmpDir, 'bad2.json');
    writeFileSync(filePath, 'corrupt');

    expect(existsSync(path.join(tmpDir, 'errors'))).toBe(false);
    quarantineIpcFile(filePath, tmpDir, 'test', 'mygroup');
    expect(existsSync(path.join(tmpDir, 'errors'))).toBe(true);
  });

  it('prevents filename collisions with timestamps', async () => {
    const filePath1 = path.join(tmpDir, 'dup.json');
    writeFileSync(filePath1, 'corrupt1');
    quarantineIpcFile(filePath1, tmpDir, 'test', 'grp');

    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 5));

    const filePath2 = path.join(tmpDir, 'dup.json');
    writeFileSync(filePath2, 'corrupt2');
    quarantineIpcFile(filePath2, tmpDir, 'test', 'grp');

    const errDir = path.join(tmpDir, 'errors');
    const files = readdirSync(errDir);
    expect(files.length).toBe(2);
    // Both should match the pattern but have different timestamps
    for (const f of files) {
      expect(f).toMatch(/^grp-\d+-dup\.json$/);
    }
  });

  it('handles already-deleted files gracefully', () => {
    const filePath = path.join(tmpDir, 'gone.json');
    // File doesn't exist - should not throw
    expect(() => {
      quarantineIpcFile(filePath, tmpDir, 'missing', 'test-group');
    }).not.toThrow();
  });
});
