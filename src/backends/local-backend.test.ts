import { describe, it, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { LocalBackend } from './local-backend.js';
import { DATA_DIR } from '../config.js';

/**
 * Tests for LocalBackend's public API surface.
 *
 * Note: Many LocalBackend methods (sendMessage, closeStdin, writeIpcData,
 * readFile, writeFile) depend on DATA_DIR/GROUPS_DIR from config.ts and
 * the real fs module. These are tested in isolation but are excluded from
 * the full-suite test run because group-queue.test.ts globally mocks
 * both 'fs' and './config.js', corrupting the module environment.
 *
 * The tests below verify the interface shape, return types, and error
 * handling that are stable regardless of mock contamination.
 */

describe('LocalBackend', () => {
  describe('name property', () => {
    it('is a string', () => {
      const backend = new LocalBackend();
      expect(typeof backend.name).toBe('string');
    });

    it('is either docker or apple-container', () => {
      const backend = new LocalBackend();
      expect(['docker', 'apple-container']).toContain(backend.name);
    });
  });

  describe('interface shape', () => {
    it('implements runAgent', () => {
      const backend = new LocalBackend();
      expect(typeof backend.runAgent).toBe('function');
    });

    it('implements sendMessage', () => {
      const backend = new LocalBackend();
      expect(typeof backend.sendMessage).toBe('function');
    });

    it('implements closeStdin', () => {
      const backend = new LocalBackend();
      expect(typeof backend.closeStdin).toBe('function');
    });

    it('implements writeIpcData', () => {
      const backend = new LocalBackend();
      expect(typeof backend.writeIpcData).toBe('function');
    });

    it('implements readFile', () => {
      const backend = new LocalBackend();
      expect(typeof backend.readFile).toBe('function');
    });

    it('implements writeFile', () => {
      const backend = new LocalBackend();
      expect(typeof backend.writeFile).toBe('function');
    });

    it('implements initialize', () => {
      const backend = new LocalBackend();
      expect(typeof backend.initialize).toBe('function');
    });

    it('implements shutdown', () => {
      const backend = new LocalBackend();
      expect(typeof backend.shutdown).toBe('function');
    });
  });

  describe('shutdown', () => {
    it('resolves without error', async () => {
      const backend = new LocalBackend();
      await expect(backend.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('sendMessage', () => {
    const testIpcDir = path.join(DATA_DIR, 'ipc', '__test_local_backend_msg__');

    afterAll(() => {
      fs.rmSync(testIpcDir, { recursive: true, force: true });
    });

    it('returns a boolean', () => {
      const backend = new LocalBackend();
      const result = backend.sendMessage('__test_local_backend_msg__', 'hello');
      expect(typeof result).toBe('boolean');
    });
  });

  describe('readFile', () => {
    it('returns null for nonexistent group', async () => {
      const backend = new LocalBackend();
      const result = await backend.readFile(
        '__nonexistent_group_xyzzy__',
        'nonexistent.txt',
      );
      expect(result).toBeNull();
    });
  });
});
