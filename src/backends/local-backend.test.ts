import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import {
  buildContainerArgs,
  buildExecInvocationArgs,
  buildExecutionContainerArgs,
  buildVolumeMounts,
  ExecBrokerOutputLimitError,
  LocalBackend,
  parseExecRequest,
  readExecBrokerText,
  resolveGitHubTokenForContainer,
} from './local-backend.js';

function uniqueId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function initializeProjectRoot(projectRoot: string): void {
  const runnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  const skillsDir = path.join(
    projectRoot,
    'container',
    'skills',
    'sample-skill',
  );
  fs.mkdirSync(runnerSrc, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(
    path.join(runnerSrc, 'index.ts'),
    'export const version = 1;\n',
  );
  fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), 'sample\n');
}

function createFixture() {
  const id = uniqueId();
  const runtimeFolder = `__test_local_backend_runtime__-${id}`;
  const altRuntimeFolder = `__test_local_backend_alt__-${id}`;
  const groupFolder = `__test_local_backend_group__-${id}`;
  const channelFolder = `__test_local_backend_channel__-${id}`;
  const agentContextFolder = `__test_local_backend_agent__-${id}`;
  const categoryFolder = `__test_local_backend_category__-${id}`;
  const serverFolder = `__test_local_backend_server__-${id}`;
  const tempHome = path.join(DATA_DIR, `tmp-home-local-backend-${id}`);
  const tempProjectRoot = path.join(
    DATA_DIR,
    `tmp-project-local-backend-${id}`,
  );
  const hostCodexDir = path.join(tempHome, '.codex');
  const hostOpenCodeDir = path.join(tempHome, '.local', 'share', 'opencode');
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  const channelDir = path.join(GROUPS_DIR, channelFolder);
  const agentDir = path.join(GROUPS_DIR, agentContextFolder);
  const categoryDir = path.join(GROUPS_DIR, categoryFolder);
  const serverDir = path.join(GROUPS_DIR, serverFolder);
  const globalDir = path.join(GROUPS_DIR, 'global');
  const globalDirPreexisted = fs.existsSync(globalDir);
  const codexDataDir = path.join(DATA_DIR, 'codex-data', runtimeFolder);
  const openCodeDataDir = path.join(DATA_DIR, 'opencode-data', runtimeFolder);
  const envDir = path.join(DATA_DIR, 'env', runtimeFolder);
  const altEnvDir = path.join(DATA_DIR, 'env', altRuntimeFolder);
  const sessionDir = path.join(DATA_DIR, 'sessions', runtimeFolder);
  const altSessionDir = path.join(DATA_DIR, 'sessions', altRuntimeFolder);
  const ipcDir = path.join(DATA_DIR, 'ipc', runtimeFolder);
  const altIpcDir = path.join(DATA_DIR, 'ipc', altRuntimeFolder);

  initializeProjectRoot(tempProjectRoot);

  return {
    runtimeFolder,
    altRuntimeFolder,
    groupFolder,
    channelFolder,
    agentContextFolder,
    categoryFolder,
    serverFolder,
    tempHome,
    tempProjectRoot,
    hostCodexDir,
    hostOpenCodeDir,
    groupDir,
    channelDir,
    agentDir,
    categoryDir,
    serverDir,
    globalDir,
    codexDataDir,
    openCodeDataDir,
    envDir,
    altEnvDir,
    sessionDir,
    altSessionDir,
    ipcDir,
    altIpcDir,
    pathOverrides: {
      homeDir: tempHome,
      projectRoot: tempProjectRoot,
    },
    cleanup() {
      for (const dir of [
        tempHome,
        tempProjectRoot,
        groupDir,
        channelDir,
        agentDir,
        categoryDir,
        serverDir,
        codexDataDir,
        openCodeDataDir,
        envDir,
        altEnvDir,
        sessionDir,
        altSessionDir,
        ipcDir,
        altIpcDir,
      ]) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      if (!globalDirPreexisted) {
        fs.rmSync(globalDir, { recursive: true, force: true });
      }
    },
  };
}

function findMount(
  mounts: ReturnType<typeof buildVolumeMounts>,
  containerPath: string,
) {
  return mounts.find((mount) => mount.containerPath === containerPath);
}

describe('LocalBackend', () => {
  it('exposes the expected public methods', () => {
    const backend = new LocalBackend();
    expect(['docker', 'apple-container']).toContain(backend.name);
    expect(typeof backend.runAgent).toBe('function');
    expect(typeof backend.sendMessage).toBe('function');
    expect(typeof backend.closeStdin).toBe('function');
    expect(typeof backend.writeIpcData).toBe('function');
    expect(typeof backend.readFile).toBe('function');
    expect(typeof backend.writeFile).toBe('function');
    expect(typeof backend.initialize).toBe('function');
    expect(typeof backend.shutdown).toBe('function');
  });

  it('returns null when reading a file from a missing group', async () => {
    const backend = new LocalBackend();
    const result = await backend.readFile(
      '__missing_local_backend_group__',
      'missing.txt',
    );
    expect(result).toBeNull();
  });

  describe('buildVolumeMounts', () => {
    it('prefers GITHUB_TOKEN, then GH_TOKEN, then gh auth fallback for env mounts', () => {
      expect(
        resolveGitHubTokenForContainer(
          { GITHUB_TOKEN: 'github-token', GH_TOKEN: 'gh-token' },
          () => 'fallback-token',
        ),
      ).toBe('github-token');
      expect(
        resolveGitHubTokenForContainer(
          { GH_TOKEN: 'gh-token' },
          () => 'fallback-token',
        ),
      ).toBe('gh-token');
      expect(resolveGitHubTokenForContainer({}, () => 'fallback-token')).toBe(
        'fallback-token',
      );
      expect(
        resolveGitHubTokenForContainer({}, () => undefined),
      ).toBeUndefined();
    });

    it('mounts channel, global, agent, category, and server workspaces for non-main agents', () => {
      const fixture = createFixture();
      try {
        fs.mkdirSync(fixture.globalDir, { recursive: true });

        const mounts = buildVolumeMounts(
          {
            folder: fixture.groupFolder,
            name: 'Workspace Test',
            serverFolder: fixture.serverFolder,
          } as any,
          false,
          false,
          fixture.runtimeFolder,
          'claude-agent-sdk',
          {
            channelFolder: fixture.channelFolder,
            categoryFolder: fixture.categoryFolder,
            agentContextFolder: fixture.agentContextFolder,
          },
          fixture.pathOverrides,
        );

        expect(findMount(mounts, '/workspace/group')).toEqual({
          hostPath: fixture.channelDir,
          containerPath: '/workspace/group',
          readonly: false,
        });
        expect(findMount(mounts, '/workspace/global')).toEqual({
          hostPath: fixture.globalDir,
          containerPath: '/workspace/global',
          readonly: true,
        });
        expect(findMount(mounts, '/workspace/agent')).toEqual({
          hostPath: fixture.agentDir,
          containerPath: '/workspace/agent',
          readonly: false,
        });
        expect(findMount(mounts, '/workspace/category')).toEqual({
          hostPath: fixture.categoryDir,
          containerPath: '/workspace/category',
          readonly: false,
        });
        expect(findMount(mounts, '/workspace/server')).toEqual({
          hostPath: fixture.serverDir,
          containerPath: '/workspace/server',
          readonly: false,
        });

        expect(fs.existsSync(fixture.channelDir)).toBe(true);
        expect(fs.existsSync(fixture.agentDir)).toBe(true);
        expect(fs.existsSync(fixture.categoryDir)).toBe(true);
        expect(fs.existsSync(fixture.serverDir)).toBe(true);
      } finally {
        fixture.cleanup();
      }
    });

    it('creates exec broker directories inside the runtime IPC mount', () => {
      const fixture = createFixture();
      try {
        buildVolumeMounts(
          { folder: fixture.groupFolder, name: 'Exec Broker Test' } as any,
          false,
          false,
          fixture.runtimeFolder,
          'claude-agent-sdk',
          undefined,
          fixture.pathOverrides,
        );

        expect(fs.existsSync(path.join(fixture.ipcDir, 'exec-requests'))).toBe(
          true,
        );
        expect(fs.existsSync(path.join(fixture.ipcDir, 'exec-responses'))).toBe(
          true,
        );
      } finally {
        fixture.cleanup();
      }
    });

    it('seeds isolated codex auth files without copying unrelated history', () => {
      const fixture = createFixture();
      try {
        fs.mkdirSync(fixture.hostCodexDir, { recursive: true });
        fs.writeFileSync(
          path.join(fixture.hostCodexDir, 'auth.json'),
          '{"mode":"chatgpt"}\n',
        );
        fs.writeFileSync(
          path.join(fixture.hostCodexDir, 'config.toml'),
          'model = "gpt-5"\n',
        );
        fs.writeFileSync(
          path.join(fixture.hostCodexDir, 'history.jsonl'),
          'secret\n',
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

        expect(findMount(mounts, '/home/bun/.codex')).toEqual({
          hostPath: fixture.codexDataDir,
          containerPath: '/home/bun/.codex',
          readonly: false,
        });
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

    it('removes stale copied codex auth files after host logout', () => {
      const fixture = createFixture();
      try {
        fs.mkdirSync(fixture.hostCodexDir, { recursive: true });
        fs.writeFileSync(
          path.join(fixture.hostCodexDir, 'auth.json'),
          '{"mode":"chatgpt"}\n',
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

    it('copies only allowed env vars into runtime-scoped env mounts', () => {
      const fixture = createFixture();
      const originalGithubToken = process.env.GITHUB_TOKEN;
      const originalGhToken = process.env.GH_TOKEN;
      try {
        delete process.env.GITHUB_TOKEN;
        process.env.GH_TOKEN = 'gh-alias-token';
        fs.writeFileSync(
          path.join(fixture.tempProjectRoot, '.env'),
          [
            'CLAUDE_CODE_OAUTH_TOKEN=claude-token',
            'ANTHROPIC_API_KEY=anthropic-key',
            'OPENAI_API_KEY=openai-key',
            'CODEX_API_KEY=codex-key',
            'CODEX_MODEL=gpt-5',
            'UNRELATED_SECRET=blocked',
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
        expect(findMount(codexMounts, '/workspace/env-dir')).toEqual({
          hostPath: fixture.envDir,
          containerPath: '/workspace/env-dir',
          readonly: true,
        });

        const codexEnv = fs.readFileSync(
          path.join(fixture.envDir, 'env'),
          'utf-8',
        );
        expect(codexEnv).toContain('OPENAI_API_KEY=openai-key');
        expect(codexEnv).toContain('CODEX_API_KEY=codex-key');
        expect(codexEnv).toContain('CODEX_MODEL=gpt-5');
        expect(codexEnv).toContain('GITHUB_TOKEN=gh-alias-token');
        expect(codexEnv).toContain('GH_TOKEN=gh-alias-token');
        expect(codexEnv).not.toContain('UNRELATED_SECRET=blocked');

        const claudeMounts = buildVolumeMounts(
          { folder: fixture.groupFolder, name: 'Claude Test' } as any,
          false,
          false,
          fixture.altRuntimeFolder,
          'claude-agent-sdk',
          undefined,
          fixture.pathOverrides,
        );
        expect(findMount(claudeMounts, '/workspace/env-dir')).toEqual({
          hostPath: fixture.altEnvDir,
          containerPath: '/workspace/env-dir',
          readonly: true,
        });

        const claudeEnv = fs.readFileSync(
          path.join(fixture.altEnvDir, 'env'),
          'utf-8',
        );
        expect(claudeEnv).toContain('CLAUDE_CODE_OAUTH_TOKEN=claude-token');
        expect(claudeEnv).toContain('ANTHROPIC_API_KEY=anthropic-key');
        expect(claudeEnv).toContain('GITHUB_TOKEN=gh-alias-token');
        expect(claudeEnv).toContain('GH_TOKEN=gh-alias-token');
        expect(claudeEnv).not.toContain('OPENAI_API_KEY=openai-key');
        expect(claudeEnv).not.toContain('CODEX_API_KEY=codex-key');
        expect(claudeEnv).not.toContain('UNRELATED_SECRET=blocked');
      } finally {
        if (originalGithubToken === undefined) {
          delete process.env.GITHUB_TOKEN;
        } else {
          process.env.GITHUB_TOKEN = originalGithubToken;
        }
        if (originalGhToken === undefined) {
          delete process.env.GH_TOKEN;
        } else {
          process.env.GH_TOKEN = originalGhToken;
        }
        fixture.cleanup();
      }
    });

    it('strips comments and blank lines from exported env mounts', () => {
      const fixture = createFixture();
      try {
        fs.writeFileSync(
          path.join(fixture.tempProjectRoot, '.env'),
          [
            '# top-level comment',
            'CLAUDE_MODEL=claude-opus-4-6',
            '  # Bot identity map',
            '',
            'OPENCODE_MODEL=openai/gpt-5.4',
            '',
            'UNRELATED_SECRET=blocked',
          ].join('\n') + '\n',
        );

        buildVolumeMounts(
          { folder: fixture.groupFolder, name: 'Claude Test' } as any,
          false,
          false,
          fixture.altRuntimeFolder,
          'claude-agent-sdk',
          undefined,
          fixture.pathOverrides,
        );

        const claudeEnv = fs.readFileSync(
          path.join(fixture.altEnvDir, 'env'),
          'utf-8',
        );
        expect(claudeEnv).toContain('CLAUDE_MODEL=claude-opus-4-6');
        expect(claudeEnv).toContain('OPENCODE_MODEL=openai/gpt-5.4');
        expect(claudeEnv).not.toContain('# Bot identity map');
        expect(claudeEnv).not.toContain('UNRELATED_SECRET=blocked');
      } finally {
        fixture.cleanup();
      }
    });

    it('refreshes the cached agent-runner source when the source tree changes', () => {
      const fixture = createFixture();
      try {
        buildVolumeMounts(
          { folder: fixture.groupFolder, name: 'Runner Sync Test' } as any,
          false,
          false,
          fixture.runtimeFolder,
          'claude-agent-sdk',
          undefined,
          fixture.pathOverrides,
        );

        const syncedIndex = path.join(
          fixture.sessionDir,
          'agent-runner-src',
          'index.ts',
        );
        expect(fs.readFileSync(syncedIndex, 'utf-8')).toContain('version = 1');

        const sourceIndex = path.join(
          fixture.tempProjectRoot,
          'container',
          'agent-runner',
          'src',
          'index.ts',
        );
        fs.writeFileSync(sourceIndex, 'export const version = 2;\n');
        const future = new Date(Date.now() + 10_000);
        fs.utimesSync(sourceIndex, future, future);

        buildVolumeMounts(
          { folder: fixture.groupFolder, name: 'Runner Sync Test' } as any,
          false,
          false,
          fixture.runtimeFolder,
          'claude-agent-sdk',
          undefined,
          fixture.pathOverrides,
        );

        expect(fs.readFileSync(syncedIndex, 'utf-8')).toContain('version = 2');
      } finally {
        fixture.cleanup();
      }
    });

    it('preserves customized agent-runner copies when auto-sync is disabled', () => {
      const fixture = createFixture();
      try {
        buildVolumeMounts(
          { folder: fixture.groupFolder, name: 'Runner Sync Test' } as any,
          false,
          false,
          fixture.runtimeFolder,
          'claude-agent-sdk',
          undefined,
          fixture.pathOverrides,
        );

        const cachedRunnerDir = path.join(
          fixture.sessionDir,
          'agent-runner-src',
        );
        const syncedIndex = path.join(cachedRunnerDir, 'index.ts');
        const optOutMarker = path.join(
          cachedRunnerDir,
          '.omniclaw-no-autosync',
        );
        fs.writeFileSync(syncedIndex, 'export const version = 99;\n');
        fs.writeFileSync(optOutMarker, '1\n');

        const sourceIndex = path.join(
          fixture.tempProjectRoot,
          'container',
          'agent-runner',
          'src',
          'index.ts',
        );
        fs.writeFileSync(sourceIndex, 'export const version = 3;\n');
        const future = new Date(Date.now() + 10_000);
        fs.utimesSync(sourceIndex, future, future);

        buildVolumeMounts(
          { folder: fixture.groupFolder, name: 'Runner Sync Test' } as any,
          false,
          false,
          fixture.runtimeFolder,
          'claude-agent-sdk',
          undefined,
          fixture.pathOverrides,
        );

        expect(fs.readFileSync(syncedIndex, 'utf-8')).toContain('version = 99');
      } finally {
        fixture.cleanup();
      }
    });

    it('copies only shared OpenCode auth files into isolated runtime state', () => {
      const fixture = createFixture();
      try {
        fs.mkdirSync(fixture.hostOpenCodeDir, { recursive: true });
        fs.writeFileSync(
          path.join(fixture.hostOpenCodeDir, 'auth.json'),
          '{"token":"abc"}\n',
        );
        fs.writeFileSync(
          path.join(fixture.hostOpenCodeDir, 'mcp-auth.json'),
          '{"token":"def"}\n',
        );
        fs.writeFileSync(
          path.join(fixture.hostOpenCodeDir, 'opencode.db'),
          'sqlite',
        );

        const mounts = buildVolumeMounts(
          { folder: fixture.groupFolder, name: 'OpenCode Test' } as any,
          false,
          false,
          fixture.runtimeFolder,
          'opencode',
          undefined,
          fixture.pathOverrides,
        );

        expect(findMount(mounts, '/home/bun/.local/share/opencode')).toEqual({
          hostPath: fixture.openCodeDataDir,
          containerPath: '/home/bun/.local/share/opencode',
          readonly: false,
        });
        expect(
          fs.existsSync(path.join(fixture.openCodeDataDir, 'auth.json')),
        ).toBe(true);
        expect(
          fs.existsSync(path.join(fixture.openCodeDataDir, 'mcp-auth.json')),
        ).toBe(true);
        expect(
          fs.existsSync(path.join(fixture.openCodeDataDir, 'opencode.db')),
        ).toBe(false);
      } finally {
        fixture.cleanup();
      }
    });
  });

  describe('buildContainerArgs', () => {
    const originalGetuid = process.getuid;
    const originalGetgid = process.getgid;
    const mutableFs = fs as { statSync: typeof fs.statSync };
    const originalStatSync = fs.statSync;

    afterEach(() => {
      process.getuid = originalGetuid;
      process.getgid = originalGetgid;
      mutableFs.statSync = originalStatSync;
    });

    it('renders readonly and read-write mounts with the expected flags', () => {
      const args = buildContainerArgs({
        mounts: [
          {
            hostPath: '/host/read-only',
            containerPath: '/container/read-only',
            readonly: true,
          },
          {
            hostPath: '/host/read-write',
            containerPath: '/container/read-write',
            readonly: false,
          },
        ],
        containerName: 'mount-args-test',
        isMain: false,
        runtime: 'docker',
      });

      expect(args).toContain('--mount');
      expect(args).toContain(
        'type=bind,source=/host/read-only,target=/container/read-only,readonly',
      );
      expect(args).toContain('-v');
      expect(args).toContain('/host/read-write:/container/read-write');
    });

    it('adds host user mapping when the process is not root or bun', () => {
      process.getuid = () => 501;
      process.getgid = () => 20;

      const args = buildContainerArgs({
        mounts: [],
        containerName: 'user-args-test',
        isMain: false,
        runtime: 'docker',
      });

      expect(args).toContain('--user');
      expect(args).toContain('501:20');
      expect(args).toContain('-e');
      expect(args).toContain('HOME=/home/bun');
    });

    it('adds split-execution env and docker socket group access', () => {
      mutableFs.statSync = ((target: fs.PathLike) => {
        if (target === '/var/run/docker.sock') {
          return { gid: 123 } as fs.Stats;
        }
        return originalStatSync(target);
      }) as typeof fs.statSync;

      const args = buildContainerArgs({
        mounts: [],
        containerName: 'exec-args-test',
        isMain: false,
        runtime: 'docker',
        execContainerName: 'exec-sidecar',
      });

      expect(args).toContain('EXEC_CONTAINER_NAME=exec-sidecar');
      expect(args).toContain('EXEC_RUNTIME=docker');
      expect(args).toContain(
        'EXEC_BROKER_REQUEST_DIR=/workspace/ipc/exec-requests',
      );
      expect(args).toContain(
        'EXEC_BROKER_RESPONSE_DIR=/workspace/ipc/exec-responses',
      );
      expect(args).toContain('--group-add');
      const groupAddIdx = args.indexOf('--group-add');
      expect(args[groupAddIdx + 1]).toBe('123');
    });

    it('skips docker socket group access when the socket metadata is unavailable', () => {
      mutableFs.statSync = (() => {
        throw new Error('missing docker socket');
      }) as typeof fs.statSync;

      const args = buildContainerArgs({
        mounts: [],
        containerName: 'exec-args-test',
        isMain: false,
        runtime: 'docker',
        execContainerName: 'exec-sidecar',
      });

      expect(args).toContain('EXEC_CONTAINER_NAME=exec-sidecar');
      expect(args).toContain('EXEC_RUNTIME=docker');
      expect(args).not.toContain('--group-add');
    });

    it('adds Apple split-execution env without docker socket group access', () => {
      const args = buildContainerArgs({
        mounts: [],
        containerName: 'exec-args-test',
        isMain: false,
        runtime: 'container',
        execContainerName: 'exec-sidecar',
      });

      expect(args).toContain('EXEC_CONTAINER_NAME=exec-sidecar');
      expect(args).toContain('EXEC_RUNTIME=apple-container');
      expect(args).toContain(
        'EXEC_BROKER_REQUEST_DIR=/workspace/ipc/exec-requests',
      );
      expect(args).toContain(
        'EXEC_BROKER_RESPONSE_DIR=/workspace/ipc/exec-responses',
      );
      expect(args).not.toContain('--group-add');
    });
  });

  describe('buildExecInvocationArgs', () => {
    const request = {
      id: 'exec-req-1',
      cwd: '/workspace/group',
      args: ['-lc', 'pwd'],
      env: {
        HOME: '/home/bun',
        TZ: 'America/New_York',
      },
    };

    it('builds Apple Container exec args', () => {
      const args = buildExecInvocationArgs(
        request,
        'exec-sidecar',
        'container',
      );

      expect(args).toEqual([
        'exec',
        '-i',
        '-w',
        '/workspace/group',
        '-e',
        'HOME=/home/bun',
        '-e',
        'TZ=America/New_York',
        'exec-sidecar',
        '/bin/bash.real',
        '-lc',
        'pwd',
      ]);
    });

    it('builds Docker exec args', () => {
      const args = buildExecInvocationArgs(request, 'exec-sidecar', 'docker');

      expect(args).toEqual([
        'exec',
        '-i',
        '-w',
        '/workspace/group',
        '-e',
        'HOME=/home/bun',
        '-e',
        'TZ=America/New_York',
        'exec-sidecar',
        '/bin/bash.real',
        '-lc',
        'pwd',
      ]);
    });
  });

  describe('execution broker parsing', () => {
    const log = {
      warn() {},
    } as any;

    it('rejects oversized execution request files before parsing JSON', () => {
      const fixture = createFixture();
      try {
        fs.mkdirSync(fixture.ipcDir, { recursive: true });
        const requestPath = path.join(fixture.ipcDir, 'oversized.json');
        fs.writeFileSync(requestPath, 'x'.repeat(64 * 1024 + 1));

        expect(parseExecRequest(requestPath, log)).toBeNull();
      } finally {
        fixture.cleanup();
      }
    });

    it('limits execution broker stream capture', async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024 + 1));
          controller.close();
        },
      });

      await expect(readExecBrokerText(stream, 'stdout')).rejects.toThrow(
        ExecBrokerOutputLimitError,
      );
    });
  });

  describe('buildExecutionContainerArgs', () => {
    it('uses a portable long-lived process for Apple sidecars', () => {
      const args = buildExecutionContainerArgs({
        mounts: [],
        execContainerName: 'exec-sidecar',
        networkMode: 'none',
        runtime: 'container',
      });

      expect(args).not.toContain('--rm');
      expect(args).toContain('--entrypoint');
      expect(args).toContain('/bin/bash.real');
      expect(args).toContain('exec-sidecar');
      expect(args.at(-1)).toContain('while true; do sleep 3600; done');
      expect(args.at(-1)).not.toContain('exec sleep infinity');
      expect(args.at(-1)).toContain('export GITHUB_TOKEN="$GH_TOKEN"');
      expect(args.at(-1)).toContain('export GH_TOKEN="$GITHUB_TOKEN"');
    });
  });
});
