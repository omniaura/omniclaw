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
    const initializeProjectRoot = (projectRoot: string) => {
      const runnerSrc = path.join(
        projectRoot,
        'container',
        'agent-runner',
        'src',
      );
      fs.mkdirSync(runnerSrc, { recursive: true });
      fs.writeFileSync(path.join(runnerSrc, 'index.ts'), 'export {};\n');
    };

    const createFixture = () => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const runtimeFolder = `__test_codex_mount_runtime__-${id}`;
      const claudeRuntimeFolder = `__test_claude_mount_runtime__-${id}`;
      const nonCodexRuntimeFolder = `${runtimeFolder}-claude`;
      const groupFolder = `__test_codex_mount_group__-${id}`;
      const tempHome = path.join(DATA_DIR, `tmp-home-codex-mount-${id}`);
      const tempProjectRoot = path.join(
        DATA_DIR,
        `tmp-project-codex-mount-${id}`,
      );
      const hostCodexDir = path.join(tempHome, '.codex');
      const codexDataDir = path.join(DATA_DIR, 'codex-data', runtimeFolder);
      const codexEnvDir = path.join(DATA_DIR, 'env', runtimeFolder);
      const claudeEnvDir = path.join(DATA_DIR, 'env', claudeRuntimeFolder);
      const groupDir = path.join(GROUPS_DIR, groupFolder);
      const sessionDirs = [
        path.join(DATA_DIR, 'sessions', runtimeFolder),
        path.join(DATA_DIR, 'sessions', claudeRuntimeFolder),
        path.join(DATA_DIR, 'sessions', nonCodexRuntimeFolder),
      ];

      initializeProjectRoot(tempProjectRoot);

      return {
        runtimeFolder,
        claudeRuntimeFolder,
        nonCodexRuntimeFolder,
        groupFolder,
        tempHome,
        tempProjectRoot,
        hostCodexDir,
        codexDataDir,
        codexEnvDir,
        claudeEnvDir,
        pathOverrides: {
          homeDir: tempHome,
          projectRoot: tempProjectRoot,
        },
        cleanup() {
          fs.rmSync(tempHome, { recursive: true, force: true });
          fs.rmSync(tempProjectRoot, { recursive: true, force: true });
          fs.rmSync(codexDataDir, { recursive: true, force: true });
          fs.rmSync(codexEnvDir, { recursive: true, force: true });
          fs.rmSync(claudeEnvDir, { recursive: true, force: true });
          fs.rmSync(groupDir, { recursive: true, force: true });
          for (const dir of sessionDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        },
      };
    };

    it('creates an isolated codex state mount seeded from host auth files', () => {
      const fixture = createFixture();
      try {
        fs.mkdirSync(fixture.hostCodexDir, { recursive: true });
        fs.writeFileSync(
          path.join(fixture.hostCodexDir, 'auth.json'),
          '{"auth_mode":"chatgpt"}\n',
        );
        fs.writeFileSync(
          path.join(fixture.hostCodexDir, 'config.toml'),
          'model = "gpt-5"\n',
        );
        fs.writeFileSync(
          path.join(fixture.hostCodexDir, 'history.jsonl'),
          'sensitive\n',
        );

        const mounts = buildVolumeMounts(
          { folder: fixture.groupFolder, name: 'Codex Test' } as any,
          false,
          false,
          fixture.runtimeFolder,
          'codex',
          undefined,
          fixture.pathOverrides,
        );

        expect(
          mounts.some(
            (mount) =>
              mount.containerPath === '/home/bun/.codex' && !mount.readonly,
          ),
        ).toBe(true);
        expect(
          fs.existsSync(path.join(fixture.codexDataDir, 'auth.json')),
        ).toBe(true);
        expect(
          fs.existsSync(path.join(fixture.codexDataDir, 'config.toml')),
        ).toBe(true);
        expect(
          fs.existsSync(path.join(fixture.codexDataDir, 'history.jsonl')),
        ).toBe(false);
      } finally {
        fixture.cleanup();
      }
    });

    it('removes stale copied codex auth files when host login is removed', () => {
      const fixture = createFixture();
      try {
        fs.mkdirSync(fixture.hostCodexDir, { recursive: true });
        fs.writeFileSync(
          path.join(fixture.hostCodexDir, 'auth.json'),
          '{"auth_mode":"chatgpt"}\n',
        );
        fs.writeFileSync(
          path.join(fixture.hostCodexDir, 'config.toml'),
          'model = "gpt-5"\n',
        );

        buildVolumeMounts(
          { folder: fixture.groupFolder, name: 'Codex Test' } as any,
          false,
          false,
          fixture.runtimeFolder,
          'codex',
          undefined,
          fixture.pathOverrides,
        );

        fs.unlinkSync(path.join(fixture.hostCodexDir, 'auth.json'));
        fs.unlinkSync(path.join(fixture.hostCodexDir, 'config.toml'));

        buildVolumeMounts(
          { folder: fixture.groupFolder, name: 'Codex Test' } as any,
          false,
          false,
          fixture.runtimeFolder,
          'codex',
          undefined,
          fixture.pathOverrides,
        );

        expect(
          fs.existsSync(path.join(fixture.codexDataDir, 'auth.json')),
        ).toBe(false);
        expect(
          fs.existsSync(path.join(fixture.codexDataDir, 'config.toml')),
        ).toBe(false);
      } finally {
        fixture.cleanup();
      }
    });

    it('does not mount codex state for non-codex runtimes', () => {
      const fixture = createFixture();
      try {
        const mounts = buildVolumeMounts(
          { folder: fixture.groupFolder, name: 'Claude Test' } as any,
          false,
          false,
          fixture.nonCodexRuntimeFolder,
          'claude-agent-sdk',
          undefined,
          fixture.pathOverrides,
        );

        expect(
          mounts.some((mount) => mount.containerPath === '/home/bun/.codex'),
        ).toBe(false);
      } finally {
        fixture.cleanup();
      }
    });

    it('writes a runtime-scoped env mount and only includes codex vars for codex', () => {
      const fixture = createFixture();
      try {
        fs.writeFileSync(
          path.join(fixture.tempProjectRoot, '.env'),
          [
            'CLAUDE_CODE_OAUTH_TOKEN=claude-token',
            'ANTHROPIC_API_KEY=anthropic-key',
            'OPENAI_API_KEY=openai-key',
            'CODEX_API_KEY=codex-key',
            'CODEX_MODEL=gpt-5',
          ].join('\n') + '\n',
        );

        const codexMounts = buildVolumeMounts(
          { folder: fixture.groupFolder, name: 'Codex Test' } as any,
          false,
          false,
          fixture.runtimeFolder,
          'codex',
          undefined,
          fixture.pathOverrides,
        );
        const codexEnvMount = codexMounts.find(
          (mount) => mount.containerPath === '/workspace/env-dir',
        );
        expect(codexEnvMount?.hostPath).toBe(fixture.codexEnvDir);
        expect(
          fs.readFileSync(path.join(fixture.codexEnvDir, 'env'), 'utf-8'),
        ).toContain('OPENAI_API_KEY=openai-key');
        expect(
          fs.readFileSync(path.join(fixture.codexEnvDir, 'env'), 'utf-8'),
        ).toContain('CODEX_API_KEY=codex-key');

        const claudeMounts = buildVolumeMounts(
          { folder: fixture.groupFolder, name: 'Claude Test' } as any,
          false,
          false,
          fixture.claudeRuntimeFolder,
          'claude-agent-sdk',
          undefined,
          fixture.pathOverrides,
        );
        const claudeEnvMount = claudeMounts.find(
          (mount) => mount.containerPath === '/workspace/env-dir',
        );
        expect(claudeEnvMount?.hostPath).toBe(fixture.claudeEnvDir);

        const claudeEnv = fs.readFileSync(
          path.join(fixture.claudeEnvDir, 'env'),
          'utf-8',
        );
        expect(claudeEnv).toContain('CLAUDE_CODE_OAUTH_TOKEN=claude-token');
        expect(claudeEnv).not.toContain('OPENAI_API_KEY=openai-key');
        expect(claudeEnv).not.toContain('CODEX_API_KEY=codex-key');
        expect(claudeEnv).not.toContain('CODEX_MODEL=gpt-5');
      } finally {
        fixture.cleanup();
      }
    });
  });
});
