import { afterEach, describe, expect, it } from 'bun:test';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { listLocalContextFiles } from './context-files.js';

const realExistsSync = fs.existsSync;
const realReaddirSync = fs.readdirSync;
const realStatSync = fs.statSync;
const realReadFileSync = fs.readFileSync;

const mockedFs = fs as unknown as {
  existsSync: typeof fs.existsSync;
  readdirSync: typeof fs.readdirSync;
  statSync: typeof fs.statSync;
  readFileSync: typeof fs.readFileSync;
};

type FakeDirent = Pick<fs.Dirent, 'name' | 'isDirectory'>;

function dir(name: string): FakeDirent {
  return { name, isDirectory: () => true };
}

function file(name: string): FakeDirent {
  return { name, isDirectory: () => false };
}

afterEach(() => {
  mockedFs.existsSync = realExistsSync;
  mockedFs.readdirSync = realReaddirSync;
  mockedFs.statSync = realStatSync;
  mockedFs.readFileSync = realReadFileSync;
});

describe('listLocalContextFiles', () => {
  it('recursively lists CLAUDE.md files, hashes contents, and skips hidden folders', () => {
    const root = GROUPS_DIR;
    const alphaClaude = path.join(root, 'alpha', 'CLAUDE.md');
    const nestedClaude = path.join(root, 'beta', 'nested', 'CLAUDE.md');
    const alphaContent = '# alpha\nhello\n';
    const nestedContent = '# nested\nworld\n';

    mockedFs.existsSync = ((target: fs.PathLike) =>
      target === root) as typeof fs.existsSync;
    mockedFs.readdirSync = ((target: fs.PathLike) => {
      const dirPath = String(target);
      if (dirPath === root) {
        return [
          dir('alpha'),
          dir('beta'),
          dir('.hidden'),
          dir('node_modules'),
          file('README.md'),
        ];
      }
      if (dirPath === path.join(root, 'alpha')) {
        return [file('CLAUDE.md')];
      }
      if (dirPath === path.join(root, 'beta')) {
        return [dir('nested')];
      }
      if (dirPath === path.join(root, 'beta', 'nested')) {
        return [file('CLAUDE.md')];
      }
      throw new Error(`Unexpected readdir for ${dirPath}`);
    }) as unknown as typeof fs.readdirSync;
    mockedFs.statSync = ((target: fs.PathLike) => {
      const filePath = String(target);
      if (filePath === alphaClaude) {
        return {
          size: alphaContent.length,
          mtime: new Date('2026-03-10T00:00:00.000Z'),
        } as fs.Stats;
      }
      if (filePath === nestedClaude) {
        return {
          size: nestedContent.length,
          mtime: new Date('2026-03-11T00:00:00.000Z'),
        } as fs.Stats;
      }
      throw new Error(`Unexpected stat for ${filePath}`);
    }) as typeof fs.statSync;
    mockedFs.readFileSync = ((target: fs.PathLike) => {
      const filePath = String(target);
      if (filePath === alphaClaude) return alphaContent;
      if (filePath === nestedClaude) return nestedContent;
      throw new Error(`Unexpected read for ${filePath}`);
    }) as typeof fs.readFileSync;

    const files = listLocalContextFiles();

    expect(files).toEqual([
      {
        path: 'alpha',
        hash: crypto.createHash('sha256').update(alphaContent).digest('hex'),
        size: alphaContent.length,
        mtime: '2026-03-10T00:00:00.000Z',
      },
      {
        path: 'beta/nested',
        hash: crypto.createHash('sha256').update(nestedContent).digest('hex'),
        size: nestedContent.length,
        mtime: '2026-03-11T00:00:00.000Z',
      },
    ]);
  });

  it('returns an empty list when the groups directory does not exist', () => {
    mockedFs.existsSync = (() => false) as typeof fs.existsSync;

    expect(listLocalContextFiles()).toEqual([]);
  });

  it('skips unreadable directories and files', () => {
    const root = GROUPS_DIR;
    const okClaude = path.join(root, 'ok', 'CLAUDE.md');
    const okContent = 'safe';

    mockedFs.existsSync = ((target: fs.PathLike) =>
      target === root) as typeof fs.existsSync;
    mockedFs.readdirSync = ((target: fs.PathLike) => {
      const dirPath = String(target);
      if (dirPath === root) {
        return [dir('broken-dir'), dir('ok'), dir('escape')];
      }
      if (dirPath === path.join(root, 'broken-dir')) {
        throw new Error('no access');
      }
      if (dirPath === path.join(root, 'ok')) {
        return [file('CLAUDE.md')];
      }
      if (dirPath === path.join(root, 'escape')) {
        return [file('CLAUDE.md')];
      }
      throw new Error(`Unexpected readdir for ${dirPath}`);
    }) as unknown as typeof fs.readdirSync;
    mockedFs.statSync = ((target: fs.PathLike) => {
      const filePath = String(target);
      if (filePath === okClaude) {
        return {
          size: okContent.length,
          mtime: new Date('2026-03-12T00:00:00.000Z'),
        } as fs.Stats;
      }
      throw new Error('bad stat');
    }) as typeof fs.statSync;
    mockedFs.readFileSync = ((target: fs.PathLike) => {
      const filePath = String(target);
      if (filePath === okClaude) return okContent;
      throw new Error('bad read');
    }) as typeof fs.readFileSync;

    const files = listLocalContextFiles();

    expect(files).toEqual([
      {
        path: 'ok',
        hash: crypto.createHash('sha256').update(okContent).digest('hex'),
        size: okContent.length,
        mtime: '2026-03-12T00:00:00.000Z',
      },
    ]);
  });
});
