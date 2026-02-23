import { describe, it, expect } from 'bun:test';
import path from 'path';
import { rejectTraversalSegments, assertPathWithin } from './path-security.js';

describe('rejectTraversalSegments', () => {
  // --- Valid paths that should pass ---

  it('allows simple relative paths', () => {
    expect(() => rejectTraversalSegments('file.txt', 'test')).not.toThrow();
  });

  it('allows nested relative paths', () => {
    expect(() => rejectTraversalSegments('dir/subdir/file.txt', 'test')).not.toThrow();
  });

  it('allows paths with dots in filenames', () => {
    expect(() => rejectTraversalSegments('archive.tar.gz', 'test')).not.toThrow();
  });

  it('allows paths with single dot directory', () => {
    expect(() => rejectTraversalSegments('./file.txt', 'test')).not.toThrow();
  });

  it('allows deeply nested paths', () => {
    expect(() => rejectTraversalSegments('a/b/c/d/e/f.txt', 'test')).not.toThrow();
  });

  it('allows paths starting with shared/', () => {
    expect(() => rejectTraversalSegments('shared/group-a/data.json', 'test')).not.toThrow();
  });

  // --- Traversal attacks that should be rejected ---

  it('rejects simple parent traversal', () => {
    expect(() => rejectTraversalSegments('../secret.txt', 'test')).toThrow(/Path traversal/);
  });

  it('rejects double parent traversal', () => {
    expect(() => rejectTraversalSegments('../../.env', 'test')).toThrow(/Path traversal/);
  });

  it('rejects traversal in middle of path', () => {
    expect(() => rejectTraversalSegments('dir/../../../.env', 'test')).toThrow(/Path traversal/);
  });

  it('rejects traversal that normalizes to parent', () => {
    expect(() => rejectTraversalSegments('a/b/../../..', 'test')).toThrow(/Path traversal/);
  });

  it('rejects traversal targeting .env specifically', () => {
    expect(() => rejectTraversalSegments('../../.env', 'test')).toThrow(/Path traversal/);
  });

  it('rejects traversal targeting other group data', () => {
    expect(() => rejectTraversalSegments('../other-group/CLAUDE.md', 'test')).toThrow(/Path traversal/);
  });

  // --- Absolute paths should be rejected ---

  it('rejects absolute paths', () => {
    expect(() => rejectTraversalSegments('/etc/passwd', 'test')).toThrow(/Absolute path rejected/);
  });

  it('rejects root path', () => {
    expect(() => rejectTraversalSegments('/', 'test')).toThrow(/Absolute path rejected/);
  });

  // --- Error message includes label ---

  it('includes label in error message', () => {
    expect(() => rejectTraversalSegments('../x', 'readFile')).toThrow(/readFile/);
  });

  it('includes the offending path in error message', () => {
    expect(() => rejectTraversalSegments('../../.env', 'test')).toThrow(/\.\.\/\.\.\/\.env/);
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
    expect(() => assertPathWithin(resolved, parent, 'test')).toThrow(/Path traversal/);
  });

  it('rejects path to sibling directory', () => {
    const resolved = path.resolve(parent, '../other-group/secret.txt');
    expect(() => assertPathWithin(resolved, parent, 'test')).toThrow(/Path traversal/);
  });

  it('rejects path to parent of parent', () => {
    const resolved = path.resolve(parent, '../..');
    expect(() => assertPathWithin(resolved, parent, 'test')).toThrow(/Path traversal/);
  });

  it('rejects path with prefix match but different directory', () => {
    // /workspace/groups/my-group-evil should NOT be considered within /workspace/groups/my-group
    const evil = parent + '-evil/file.txt';
    expect(() => assertPathWithin(evil, parent, 'test')).toThrow(/Path traversal/);
  });

  // --- Error message ---

  it('includes label in error message', () => {
    const resolved = path.resolve(parent, '../../.env');
    expect(() => assertPathWithin(resolved, parent, 'writeFile')).toThrow(/writeFile/);
  });
});
