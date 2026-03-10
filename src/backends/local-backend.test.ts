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
  const originalCwd = process.cwd();

  afterAll(() => {
    process.env.HOME = originalHome;
    process.chdir(originalCwd);
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
    const claudeRuntimeFolder = '__test_claude_mount_runtime__';
    const groupFolder = '__test_codex_mount_group__';
    const tempHome = path.join(DATA_DIR, 'tmp-home-codex-mount');
    const tempProjectRoot = path.join(DATA_DIR, 'tmp-project-codex-mount');
    const hostCodexDir = path.join(tempHome, '.codex');
    const codexDataDir = path.join(DATA_DIR, 'codex-data', runtimeFolder);
    const codexEnvDir = path.join(DATA_DIR, 'env', runtimeFolder);
    const claudeEnvDir = path.join(DATA_DIR, 'env', claudeRuntimeFolder);
    const groupDir = path.join(GROUPS_DIR, groupFolder);

    afterAll(() => {
      process.env.HOME = originalHome;
      process.chdir(originalCwd);
      fs.rmSync(tempHome, { recursive: true, force: true });
      fs.rmSync(tempProjectRoot, { recursive: true, force: true });
      fs.rmSync(codexDataDir, { recursive: true, force: true });
      fs.rmSync(codexEnvDir, { recursive: true, force: true });
      fs.rmSync(claudeEnvDir, { recursive: true, force: true });
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

    it('removes stale copied codex auth files when host login is removed', () => {
      fs.mkdirSync(hostCodexDir, { recursive: true });
      fs.writeFileSync(
        path.join(hostCodexDir, 'auth.json'),
        '{"auth_mode":"chatgpt"}\n',
      );
      fs.writeFileSync(path.join(hostCodexDir, 'config.toml'), 'model = "gpt-5"\n');
      process.env.HOME = tempHome;

      buildVolumeMounts(
        { folder: groupFolder, name: 'Codex Test' } as any,
        false,
        false,
        runtimeFolder,
        'codex',
      );

      fs.unlinkSync(path.join(hostCodexDir, 'auth.json'));
      fs.unlinkSync(path.join(hostCodexDir, 'config.toml'));

      buildVolumeMounts(
        { folder: groupFolder, name: 'Codex Test' } as any,
        false,
        false,
        runtimeFolder,
        'codex',
      );

      expect(fs.existsSync(path.join(codexDataDir, 'auth.json'))).toBe(false);
      expect(fs.existsSync(path.join(codexDataDir, 'config.toml'))).toBe(false);
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

    it('writes a runtime-scoped env mount and only includes codex vars for codex', () => {
      const runnerSrc = path.join(
        tempProjectRoot,
        'container',
        'agent-runner',
        'src',
      );
      fs.mkdirSync(runnerSrc, { recursive: true });
      fs.writeFileSync(path.join(runnerSrc, 'index.ts'), 'export {};\n');
      fs.writeFileSync(
        path.join(tempProjectRoot, '.env'),
        [
          'CLAUDE_CODE_OAUTH_TOKEN=claude-token',
          'ANTHROPIC_API_KEY=anthropic-key',
          'OPENAI_API_KEY=openai-key',
          'CODEX_API_KEY=codex-key',
          'CODEX_MODEL=gpt-5',
        ].join('\n') + '\n',
      );
      process.chdir(tempProjectRoot);

      const codexMounts = buildVolumeMounts(
        { folder: groupFolder, name: 'Codex Test' } as any,
        false,
        false,
        runtimeFolder,
        'codex',
      );
      const codexEnvMount = codexMounts.find(
        (mount) => mount.containerPath === '/workspace/env-dir',
      );
      expect(codexEnvMount?.hostPath).toBe(codexEnvDir);
      expect(fs.readFileSync(path.join(codexEnvDir, 'env'), 'utf-8')).toContain(
        'OPENAI_API_KEY=openai-key',
      );
      expect(fs.readFileSync(path.join(codexEnvDir, 'env'), 'utf-8')).toContain(
        'CODEX_API_KEY=codex-key',
      );

      const claudeMounts = buildVolumeMounts(
        { folder: groupFolder, name: 'Claude Test' } as any,
        false,
        false,
        claudeRuntimeFolder,
        'claude-agent-sdk',
      );
      const claudeEnvMount = claudeMounts.find(
        (mount) => mount.containerPath === '/workspace/env-dir',
      );
      expect(claudeEnvMount?.hostPath).toBe(claudeEnvDir);

      const claudeEnv = fs.readFileSync(path.join(claudeEnvDir, 'env'), 'utf-8');
      expect(claudeEnv).toContain('CLAUDE_CODE_OAUTH_TOKEN=claude-token');
      expect(claudeEnv).not.toContain('OPENAI_API_KEY=openai-key');
      expect(claudeEnv).not.toContain('CODEX_API_KEY=codex-key');
      expect(claudeEnv).not.toContain('CODEX_MODEL=gpt-5');
    });
  });
});
