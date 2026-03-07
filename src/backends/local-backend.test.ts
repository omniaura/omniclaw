import { describe, it, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { buildVolumeMounts, LocalBackend } from './local-backend.js';
import { DATA_DIR, GROUPS_DIR } from '../config.js';

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
  const originalHome = process.env.HOME;

  afterAll(() => {
    process.env.HOME = originalHome;
  });

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

  describe('buildVolumeMounts', () => {
    const runtimeFolder = '__test_codex_mount_runtime__';
    const groupFolder = '__test_codex_mount_group__';
    const tempHome = path.join(DATA_DIR, 'tmp-home-codex-mount');
    const hostCodexDir = path.join(tempHome, '.codex');
    const codexDataDir = path.join(DATA_DIR, 'codex-data', runtimeFolder);
    const groupDir = path.join(GROUPS_DIR, groupFolder);

    afterAll(() => {
      process.env.HOME = originalHome;
      fs.rmSync(tempHome, { recursive: true, force: true });
      fs.rmSync(codexDataDir, { recursive: true, force: true });
      fs.rmSync(groupDir, { recursive: true, force: true });
    });

    it('creates an isolated codex state mount seeded from host auth files', () => {
      fs.mkdirSync(hostCodexDir, { recursive: true });
      fs.writeFileSync(
        path.join(hostCodexDir, 'auth.json'),
        '{"auth_mode":"chatgpt"}\n',
      );
      fs.writeFileSync(path.join(hostCodexDir, 'config.toml'), 'model = "gpt-5"\n');
      fs.writeFileSync(path.join(hostCodexDir, 'history.jsonl'), 'sensitive\n');
      process.env.HOME = tempHome;

      const mounts = buildVolumeMounts(
        { folder: groupFolder, name: 'Codex Test' } as any,
        false,
        false,
        runtimeFolder,
        'codex',
      );

      expect(
        mounts.some(
          (mount) =>
            mount.containerPath === '/home/bun/.codex' && !mount.readonly,
        ),
      ).toBe(true);
      expect(fs.existsSync(path.join(codexDataDir, 'auth.json'))).toBe(true);
      expect(fs.existsSync(path.join(codexDataDir, 'config.toml'))).toBe(true);
      expect(fs.existsSync(path.join(codexDataDir, 'history.jsonl'))).toBe(
        false,
      );
    });

    it('does not mount codex state for non-codex runtimes', () => {
      process.env.HOME = tempHome;

      const mounts = buildVolumeMounts(
        { folder: groupFolder, name: 'Claude Test' } as any,
        false,
        false,
        `${runtimeFolder}-claude`,
        'claude-agent-sdk',
      );

      expect(
        mounts.some((mount) => mount.containerPath === '/home/bun/.codex'),
      ).toBe(false);
    });
  });
});
