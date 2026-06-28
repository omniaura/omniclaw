import { describe, it, expect } from 'bun:test';
import { Effect, Either } from 'effect';
import path from 'path';
import {
  rejectTraversalSegments,
  rejectTraversalSegmentsEffect,
  assertPathWithin,
  assertPathWithinEffect,
  PathTraversalError,
} from './path-security.js';

describe('rejectTraversalSegments', () => {
  // --- Valid paths that should pass ---

  it('allows simple relative paths', () => {
    expect(() => rejectTraversalSegments('file.txt', 'test')).not.toThrow();
  });

  it('allows nested relative paths', () => {
    expect(() =>
      rejectTraversalSegments('dir/subdir/file.txt', 'test'),
    ).not.toThrow();
  });

  it('allows paths with dots in filenames', () => {
    expect(() =>
      rejectTraversalSegments('archive.tar.gz', 'test'),
    ).not.toThrow();
  });

  it('allows paths with single dot directory', () => {
    expect(() => rejectTraversalSegments('./file.txt', 'test')).not.toThrow();
  });

  it('allows deeply nested paths', () => {
    expect(() =>
      rejectTraversalSegments('a/b/c/d/e/f.txt', 'test'),
    ).not.toThrow();
  });

  it('allows paths starting with shared/', () => {
    expect(() =>
      rejectTraversalSegments('shared/group-a/data.json', 'test'),
    ).not.toThrow();
  });

  // --- Traversal attacks that should be rejected ---

  it('rejects simple parent traversal', () => {
    expect(() => rejectTraversalSegments('../secret.txt', 'test')).toThrow(
      /Path traversal/,
    );
  });

  it('rejects double parent traversal', () => {
    expect(() => rejectTraversalSegments('../../.env', 'test')).toThrow(
      /Path traversal/,
    );
  });

  it('rejects traversal in middle of path', () => {
    expect(() => rejectTraversalSegments('dir/../../../.env', 'test')).toThrow(
      /Path traversal/,
    );
  });

  it('rejects traversal that normalizes within the path', () => {
    expect(() => rejectTraversalSegments('agent/../outside', 'test')).toThrow(
      /Path traversal/,
    );
  });

  it('rejects trailing traversal that normalizes to current path', () => {
    expect(() => rejectTraversalSegments('agent/..', 'test')).toThrow(
      /Path traversal/,
    );
  });

  it('rejects traversal that normalizes to parent', () => {
    expect(() => rejectTraversalSegments('a/b/../../..', 'test')).toThrow(
      /Path traversal/,
    );
  });

  it('rejects traversal targeting .env specifically', () => {
    expect(() => rejectTraversalSegments('../../.env', 'test')).toThrow(
      /Path traversal/,
    );
  });

  it('rejects traversal targeting other group data', () => {
    expect(() =>
      rejectTraversalSegments('../other-group/CLAUDE.md', 'test'),
    ).toThrow(/Path traversal/);
  });

  // --- Absolute paths should be rejected ---

  it('rejects absolute paths', () => {
    expect(() => rejectTraversalSegments('/etc/passwd', 'test')).toThrow(
      /Absolute path rejected/,
    );
  });

  it('rejects root path', () => {
    expect(() => rejectTraversalSegments('/', 'test')).toThrow(
      /Absolute path rejected/,
    );
  });

  // --- Error message includes label ---

  it('includes label in error message', () => {
    expect(() => rejectTraversalSegments('../x', 'readFile')).toThrow(
      /readFile/,
    );
  });

  it('includes the offending path in error message', () => {
    expect(() => rejectTraversalSegments('../../.env', 'test')).toThrow(
      /\.\.\/\.\.\/\.env/,
    );
  });
});

describe('assertPathWithin', () => {
  const parent = '/workspace/groups/my-group';

  // --- Valid paths ---

  it('allows path within parent', () => {
    const resolved = path.join(parent, 'file.txt');
    expect(() => assertPathWithin(resolved, parent, 'test')).not.toThrow();
  });

  it('allows nested path within parent', () => {
    const resolved = path.join(parent, 'dir', 'subdir', 'file.txt');
    expect(() => assertPathWithin(resolved, parent, 'test')).not.toThrow();
  });

  it('allows the parent directory itself', () => {
    expect(() => assertPathWithin(parent, parent, 'test')).not.toThrow();
  });

  // --- Traversal attacks ---

  it('rejects path escaping via ..', () => {
    const resolved = path.resolve(parent, '../../.env');
    expect(() => assertPathWithin(resolved, parent, 'test')).toThrow(
      /Path traversal/,
    );
  });

  it('rejects path to sibling directory', () => {
    const resolved = path.resolve(parent, '../other-group/secret.txt');
    expect(() => assertPathWithin(resolved, parent, 'test')).toThrow(
      /Path traversal/,
    );
  });

  it('rejects path to parent of parent', () => {
    const resolved = path.resolve(parent, '../..');
    expect(() => assertPathWithin(resolved, parent, 'test')).toThrow(
      /Path traversal/,
    );
  });

  it('rejects path with prefix match but different directory', () => {
    // /workspace/groups/my-group-evil should NOT be considered within /workspace/groups/my-group
    const evil = parent + '-evil/file.txt';
    expect(() => assertPathWithin(evil, parent, 'test')).toThrow(
      /Path traversal/,
    );
  });

  // --- Error message ---

  it('includes label in error message', () => {
    const resolved = path.resolve(parent, '../../.env');
    expect(() => assertPathWithin(resolved, parent, 'writeFile')).toThrow(
      /writeFile/,
    );
  });
});

describe('path security Effect API', () => {
  it('returns Right for safe relative paths', () => {
    const result = Effect.runSync(
      rejectTraversalSegmentsEffect('nested/file.txt', 'readFile').pipe(
        Effect.either,
      ),
    );

    expect(Either.isRight(result)).toBe(true);
  });

  it('returns a typed PathTraversalError for unsafe relative paths', () => {
    const result = Effect.runSync(
      rejectTraversalSegmentsEffect('../secret.txt', 'readFile').pipe(
        Effect.either,
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(PathTraversalError);
      expect(result.left._tag).toBe('PathTraversalError');
      expect(result.left.path).toBe('../secret.txt');
      expect(result.left.label).toBe('readFile');
      expect(result.left.reason).toContain("contains '..' segments");
    }
  });

  it('returns a typed PathTraversalError for absolute relative-path inputs', () => {
    const absolutePath = '/tmp/secret.txt';
    const result = Effect.runSync(
      rejectTraversalSegmentsEffect(absolutePath, 'readFile').pipe(
        Effect.either,
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(PathTraversalError);
      expect(result.left.path).toBe(absolutePath);
      expect(result.left.label).toBe('readFile');
      expect(result.left.reason).toContain('Absolute path rejected');
    }
  });

  it('returns Right when the resolved path stays within the parent', () => {
    const parent = '/workspace/groups/my-group';
    const result = Effect.runSync(
      assertPathWithinEffect(
        path.join(parent, 'safe/file.txt'),
        parent,
        'writeFile',
      ).pipe(Effect.either),
    );

    expect(Either.isRight(result)).toBe(true);
  });

  it('returns Right when the resolved path exactly matches the parent', () => {
    const parent = '/workspace/groups/my-group';
    const result = Effect.runSync(
      assertPathWithinEffect(parent, parent, 'writeFile').pipe(Effect.either),
    );

    expect(Either.isRight(result)).toBe(true);
  });

  it('returns a typed PathTraversalError when the resolved path escapes the parent', () => {
    const parent = '/workspace/groups/my-group';
    const escaped = '/workspace/groups/other-group/secret.txt';
    const result = Effect.runSync(
      assertPathWithinEffect(escaped, parent, 'writeFile').pipe(Effect.either),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(PathTraversalError);
      expect(result.left.path).toBe(escaped);
      expect(result.left.label).toBe('writeFile');
      expect(result.left.reason).toContain('escapes');
      expect(result.left.reason).toContain(parent);
    }
  });
});
