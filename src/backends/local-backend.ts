/**
 * Local Backend for OmniClaw
 * Runs agents in Docker (via OrbStack on macOS) on the local machine.
 * Extracted from container-runner.ts.
 *
 * Apple Container was removed in May 2026 — it caused kernel panics on
 * macOS 26 and was a maintenance burden. OrbStack provides the same
 * Docker-compatible CLI with a much more reliable runtime.
 */

import { $ } from 'bun';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_MEMORY,
  CONTAINER_STARTUP_TIMEOUT,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  LOCAL_RUNTIME,
  SHARED_CLAUDE_VM,
  TIMEZONE,
} from '../config.js';
import { logger } from '../logger.js';
import { validateAdditionalMounts } from '../mount-security.js';
import { assertPathWithin } from '../path-security.js';
import { ContainerProcess } from '../types.js';
import { SharedVmManager } from './shared-vm.js';
import { StreamParser } from './stream-parser.js';
import {
  AgentBackend,
  AgentOrGroup,
  type AgentRuntime,
  ChannelInfo,
  ContainerInput,
  ContainerOutput,
  VolumeMount,
  getAgentRuntime,
  getContainerConfig,
  getFolder,
  getName,
  getServerFolder,
} from './types.js';

function getHomeDir(): string {
  const home = process.env.HOME || os.homedir();
  if (!home) {
    throw new Error(
      'Unable to determine home directory: HOME environment variable is not set and os.homedir() returned empty',
    );
  }
  return home;
}

function readGhAuthToken(): string | undefined {
  const result = Bun.spawnSync(['gh', 'auth', 'token'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) return undefined;
  const token = result.stdout.toString().trim();
  return token || undefined;
}

export function resolveGitHubTokenForContainer(
  env: NodeJS.ProcessEnv = process.env,
  fallback: () => string | undefined = readGhAuthToken,
): string | undefined {
  const directToken = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
  if (directToken) return directToken;

  try {
    return fallback()?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function getLatestMtimeMs(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let latest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const stat = fs.statSync(current);
    latest = Math.max(latest, stat.mtimeMs);
    if (!stat.isDirectory()) continue;
    for (const name of fs.readdirSync(current)) {
      stack.push(path.join(current, name));
    }
  }
  return latest;
}

function syncAgentRunnerSource(
  agentRunnerSrc: string,
  groupAgentRunnerDir: string,
): boolean {
  if (!fs.existsSync(agentRunnerSrc)) return false;

  const noAutoSyncMarker = path.join(
    groupAgentRunnerDir,
    '.omniclaw-no-autosync',
  );
  const syncMarker = path.join(groupAgentRunnerDir, '.omniclaw-source-sync');
  const hasGroupDir = fs.existsSync(groupAgentRunnerDir);

  if (!hasGroupDir) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    fs.writeFileSync(syncMarker, `${Date.now()}\n`, 'utf-8');
    return true;
  }

  // Allow manual per-agent runtime customization by opting out of auto-sync.
  if (fs.existsSync(noAutoSyncMarker)) {
    return true;
  }

  const srcLatestMtime = getLatestMtimeMs(agentRunnerSrc);
  const lastSyncedMtime = fs.existsSync(syncMarker)
    ? fs.statSync(syncMarker).mtimeMs
    : 0;
  if (srcLatestMtime <= lastSyncedMtime) {
    return true;
  }

  // Atomic replace: copy to temp dir then rename to avoid races when
  // two containers for the same group start simultaneously.
  const tmpDir = `${groupAgentRunnerDir}.tmp-${process.pid}`;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.cpSync(agentRunnerSrc, tmpDir, { recursive: true });
    fs.rmSync(groupAgentRunnerDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, groupAgentRunnerDir);
  } catch (err) {
    // Clean up temp dir on failure
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
  fs.writeFileSync(syncMarker, `${Date.now()}\n`, 'utf-8');
  logger.info({ groupAgentRunnerDir }, 'Refreshed cached agent-runner source');
  return true;
}

function syncOptionalFiles(
  sourceDir: string,
  targetDir: string,
  filenames: readonly string[],
): void {
  for (const filename of filenames) {
    const sourcePath = path.join(sourceDir, filename);
    const targetPath = path.join(targetDir, filename);
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, targetPath);
    } else {
      try {
        fs.unlinkSync(targetPath);
      } catch {
        /* ignore */
      }
    }
  }
}

export function buildVolumeMounts(
  group: AgentOrGroup,
  isMain: boolean,
  isScheduledTask: boolean = false,
  runtimeFolder?: string,
  agentRuntime?: AgentRuntime,
  contextFolders?: {
    channelFolder?: string;
    categoryFolder?: string;
    agentContextFolder?: string;
  },
  pathOverrides?: {
    homeDir?: string;
    projectRoot?: string;
  },
  options?: {
    allowGcpCredentials?: boolean;
    /** Per-agent model override. Written to env file as the runtime's expected
     *  env var (CLAUDE_MODEL / OPENCODE_MODEL / CODEX_MODEL / CURSOR_AGENT_MODEL),
     *  taking precedence over any value from the host .env. */
    model?: string;
  },
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const homeDir = pathOverrides?.homeDir || getHomeDir();
  const projectRoot = pathOverrides?.projectRoot || process.cwd();

  const folder = getFolder(group);
  const runtimeFolderName = runtimeFolder || folder;
  const srvFolder = getServerFolder(group);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart. (Upstream PR #392)
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Mask .env inside the container to prevent secret leakage.
    // The project root mount above exposes .env to the agent (even read-only).
    // Secrets should only flow through the filtered env-dir mount (allowedVars).
    // Docker file-to-file bind mounts: bind /dev/null over .env.
    // (Upstream PR #419, Issue #40)
    const projectEnvFile = path.join(projectRoot, '.env');
    if (fs.existsSync(projectEnvFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main also gets its group folder as the working directory
    const groupPath = path.join(GROUPS_DIR, folder);
    assertPathWithin(groupPath, GROUPS_DIR, 'group folder');

    mounts.push({
      hostPath: groupPath,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Channel workspace: use channelFolder if set, otherwise fall back to groupFolder
    const workspaceFolder = contextFolders?.channelFolder || folder;
    const groupPath = path.join(GROUPS_DIR, workspaceFolder);
    assertPathWithin(groupPath, GROUPS_DIR, 'group folder');
    fs.mkdirSync(groupPath, { recursive: true });

    mounts.push({
      hostPath: groupPath,
      containerPath: '/workspace/group',
      readonly: false,
    });

    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }

    // Agent identity + global notes (read-write: agent can evolve its own identity)
    if (contextFolders?.agentContextFolder) {
      const agentDir = path.join(GROUPS_DIR, contextFolders.agentContextFolder);
      assertPathWithin(agentDir, GROUPS_DIR, 'agent context folder');
      fs.mkdirSync(agentDir, { recursive: true });
      mounts.push({
        hostPath: agentDir,
        containerPath: '/workspace/agent',
        readonly: false,
      });
    }

    // Category team workspace (read-write: agents share knowledge across channels)
    if (contextFolders?.categoryFolder) {
      const categoryDir = path.join(GROUPS_DIR, contextFolders.categoryFolder);
      assertPathWithin(categoryDir, GROUPS_DIR, 'category folder');
      fs.mkdirSync(categoryDir, { recursive: true });
      mounts.push({
        hostPath: categoryDir,
        containerPath: '/workspace/category',
        readonly: false,
      });
    }

    if (srvFolder) {
      const serverDir = path.join(GROUPS_DIR, srvFolder);
      assertPathWithin(serverDir, GROUPS_DIR, 'server folder');
      fs.mkdirSync(serverDir, { recursive: true });
      mounts.push({
        hostPath: serverDir,
        containerPath: '/workspace/server',
        readonly: false,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const sessionsBase = path.join(DATA_DIR, 'sessions');
  const groupSessionsDir = path.join(
    sessionsBase,
    runtimeFolderName,
    '.claude',
  );
  assertPathWithin(groupSessionsDir, sessionsBase, 'sessions directory');

  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/bun/.claude',
    readonly: false,
  });

  // Optional shared OpenCode auth from the host.
  // We copy only auth.json / mcp-auth.json into a per-group isolated dir so
  // the container inherits credentials without sharing the host opencode.db.
  // Mounting the whole host dir with readonly:false caused concurrent writes
  // to the same SQLite file and DB corruption.
  const hostOpenCodeDir = path.join(homeDir, '.local', 'share', 'opencode');
  if (fs.existsSync(hostOpenCodeDir)) {
    const openCodeDataBase = path.join(DATA_DIR, 'opencode-data');
    const containerOcDir = path.join(openCodeDataBase, runtimeFolderName);
    assertPathWithin(
      containerOcDir,
      openCodeDataBase,
      'opencode-data directory',
    );
    fs.mkdirSync(containerOcDir, { recursive: true });
    syncOptionalFiles(hostOpenCodeDir, containerOcDir, [
      'auth.json',
      'mcp-auth.json',
    ]);
    mounts.push({
      hostPath: containerOcDir,
      containerPath: '/home/bun/.local/share/opencode',
      readonly: false,
    });
  }

  if (agentRuntime === 'codex') {
    // Optional shared Codex login seed from the host.
    // We copy auth/config into a per-group isolated ~/.codex directory so the
    // container can inherit ChatGPT/API-key login without sharing host session
    // databases, history, or worktrees across agents.
    const hostCodexDir = path.join(homeDir, '.codex');
    const codexDataBase = path.join(DATA_DIR, 'codex-data');
    const containerCodexDir = path.join(codexDataBase, runtimeFolderName);
    assertPathWithin(containerCodexDir, codexDataBase, 'codex-data directory');
    fs.mkdirSync(containerCodexDir, { recursive: true });
    syncOptionalFiles(hostCodexDir, containerCodexDir, [
      'auth.json',
      'config.toml',
    ]);
    mounts.push({
      hostPath: containerCodexDir,
      containerPath: '/home/bun/.codex',
      readonly: false,
    });
  }

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const ipcBase = path.join(DATA_DIR, 'ipc');
  const groupIpcDir = path.join(ipcBase, runtimeFolderName);
  assertPathWithin(groupIpcDir, ipcBase, 'IPC directory');
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input-task'), { recursive: true });

  // Mount the full IPC directory. The agent-runner inside the container
  // selects the correct input subdirectory (input/ vs input-task/) based
  // on containerInput.isScheduledTask, so no mount overlay trick is needed.
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Environment file
  const envBase = path.join(DATA_DIR, 'env');
  const envDir = path.join(envBase, runtimeFolderName);
  assertPathWithin(envDir, envBase, 'env directory');
  fs.mkdirSync(envDir, { recursive: true });
  const envFile = path.join(projectRoot, '.env');
  const allowedVars = [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'CLAUDE_MODEL',
    'OPENCODE_MODEL',
    'OPENCODE_PROVIDER',
    'OPENCODE_MODEL_ID',
    ...(agentRuntime === 'codex'
      ? ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_MODEL']
      : []),
    ...(agentRuntime === 'cursor-sdk'
      ? [
          'CURSOR_API_KEY',
          'CURSOR_AGENT_MODEL',
          'CURSOR_AGENT_CLOUD_REPOS',
          'CURSOR_CLOUD_SKIP_REVIEWER_REQUEST',
        ]
      : []),
    ...(options?.allowGcpCredentials
      ? [
          'GOOGLE_APPLICATION_CREDENTIALS',
          'FIREBASE_PROJECT_ID',
          'FIREBASE_CLIENT_EMAIL',
          'FIREBASE_PRIVATE_KEY',
          'GCLOUD_PROJECT',
        ]
      : []),
  ];
  let filteredLines: string[] = [];
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    filteredLines = extractAllowedEnvBlocks(envContent, allowedVars);
  }
  const githubToken = resolveGitHubTokenForContainer();
  if (githubToken) {
    filteredLines = filteredLines.filter(
      (line) =>
        !line.startsWith('GITHUB_TOKEN=') && !line.startsWith('GH_TOKEN='),
    );
    filteredLines.push(
      `GITHUB_TOKEN=${githubToken}`,
      `GH_TOKEN=${githubToken}`,
    );
  }

  // Per-agent model override (from SQLite). Wins over any host .env value so
  // operators can configure model per agent without editing .env. Maps to the
  // runtime's expected env var; an empty string clears any inherited value.
  const modelOverride = options?.model?.trim();
  if (modelOverride) {
    const modelEnvVar = modelEnvVarForRuntime(agentRuntime);
    filteredLines = filteredLines.filter(
      (line) => !line.startsWith(`${modelEnvVar}=`),
    );
    filteredLines.push(`${modelEnvVar}=${modelOverride}`);
  }

  if (filteredLines.length > 0) {
    fs.writeFileSync(path.join(envDir, 'env'), filteredLines.join('\n') + '\n');
    mounts.push({
      hostPath: envDir,
      containerPath: '/workspace/env-dir',
      readonly: true,
    });
  } else {
    try {
      fs.unlinkSync(path.join(envDir, 'env'));
    } catch {
      /* ignore */
    }
  }

  // Agent-runner source: copy to per-group writable location so each group
  // can customize tools without modifying host code or affecting other groups.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    runtimeFolderName,
    'agent-runner-src',
  );
  assertPathWithin(
    groupAgentRunnerDir,
    sessionsBase,
    'agent runner source cache',
  );
  const hasGroupDir = syncAgentRunnerSource(
    agentRunnerSrc,
    groupAgentRunnerDir,
  );
  mounts.push({
    hostPath: hasGroupDir ? groupAgentRunnerDir : agentRunnerSrc,
    containerPath: '/app/src',
    readonly: !hasGroupDir,
  });

  // Additional mounts
  const containerCfg = getContainerConfig(group);
  if (containerCfg?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      containerCfg.additionalMounts,
      getName(group),
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/**
 * Map an agent runtime to the env var name its launcher reads for the model.
 * Used by buildVolumeMounts to inject the per-agent SQLite `model` override
 * into the container's env file, overriding any host .env value.
 */
export function modelEnvVarForRuntime(
  runtime: AgentRuntime | undefined,
): string {
  switch (runtime) {
    case 'opencode':
      return 'OPENCODE_MODEL';
    case 'codex':
      return 'CODEX_MODEL';
    case 'cursor-sdk':
      return 'CURSOR_AGENT_MODEL';
    case 'claude-agent-sdk':
    default:
      return 'CLAUDE_MODEL';
  }
}

function extractAllowedEnvBlocks(
  envContent: string,
  allowedVars: string[],
): string[] {
  const allowed = new Set(allowedVars);
  const lines = envContent.split('\n');
  const blocks: string[] = [];
  let currentKey: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentKey && allowed.has(currentKey) && currentLines.length > 0) {
      blocks.push(currentLines.join('\n'));
    }
    currentKey = null;
    currentLines = [];
  };

  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      flush();
      currentKey = match[1];
      currentLines = [line];
      continue;
    }

    if (!currentKey) continue;

    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    currentLines.push(line);
  }

  flush();
  return blocks;
}

function makeContainerName(baseFolder: string, runtimeFolder: string): string {
  const baseSafe = baseFolder.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 24);
  if (runtimeFolder === baseFolder) {
    return `omniclaw-${baseSafe}-${Date.now()}`;
  }
  const digest = createHash('sha1')
    .update(runtimeFolder)
    .digest('hex')
    .slice(0, 8);
  return `omniclaw-${baseSafe}-d${digest}-${Date.now()}`;
}

interface ContainerArgsOpts {
  mounts: VolumeMount[];
  containerName: string;
  isMain: boolean;
  networkMode?: 'full' | 'none';
  /** @deprecated Runtime is always docker — kept for backwards-compat with tests. */
  runtime?: string;
}

/** @internal Exported for testing */
export function buildContainerArgs({
  mounts,
  containerName,
  isMain,
  networkMode,
}: ContainerArgsOpts): string[] {
  const args: string[] = [
    'run',
    '-i',
    '--rm',
    '--memory',
    CONTAINER_MEMORY,
    '--name',
    containerName,
  ];

  args.push('--pids-limit', '256');
  args.push('--security-opt', 'no-new-privileges:true');

  // Network access: default to 'full' for both main and non-main containers.
  // Agents need outbound network for the LLM API (api.anthropic.com) and for
  // tool calls like WebFetch / WebSearch. Per-group override via
  // containerConfig.networkMode = 'none' opts back into isolation.
  const effectiveNetwork = networkMode ?? 'full';
  if (effectiveNetwork === 'none') {
    args.push('--network', 'none');
  }

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's bun user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/bun');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(
        '--mount',
        `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`,
      );
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);
  return args;
}

function isSharedVmEnabled(): boolean {
  return SHARED_CLAUDE_VM && LOCAL_RUNTIME !== 'docker';
}

export const SHARED_VM_NETWORK_ISOLATION_ERROR_CODE =
  'SHARED_VM_NETWORK_ISOLATION_UNSUPPORTED';

export function sharedVmNetworkIsolationError(
  groupName: string,
): ContainerOutput {
  return {
    status: 'error',
    result: null,
    error: `${SHARED_VM_NETWORK_ISOLATION_ERROR_CODE}: Shared-VM mode does not enforce per-agent network isolation. Disable shared-VM mode for ${groupName} or remove containerConfig.networkMode='none' (default is 'full').`,
  };
}

export class LocalBackend implements AgentBackend {
  readonly name = 'docker';
  private sharedVm = new SharedVmManager();

  async runAgent(
    group: AgentOrGroup,
    input: ContainerInput,
    onProcess: (proc: ContainerProcess, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<ContainerOutput> {
    if (isSharedVmEnabled()) {
      return this.runAgentSharedVm(group, input, onProcess, onOutput);
    }
    const startTime = Date.now();
    const folder = getFolder(group);
    const runtimeFolder = input.runtimeFolder || folder;
    const groupName = getName(group);
    const containerCfg = getContainerConfig(group);

    const groupDir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(groupDir, { recursive: true });

    const mounts = buildVolumeMounts(
      group,
      input.isMain,
      input.isScheduledTask,
      runtimeFolder,
      input.agentRuntime || getAgentRuntime(group),
      {
        channelFolder: input.channelFolder,
        categoryFolder: input.categoryFolder,
        agentContextFolder: input.agentContextFolder,
      },
      undefined,
      {
        allowGcpCredentials: !!containerCfg?.allowGcpCredentials,
        model: input.model,
      },
    );
    const containerName = makeContainerName(folder, runtimeFolder);
    const effectiveNetwork = containerCfg?.networkMode ?? 'full';

    const containerArgs = buildContainerArgs({
      mounts,
      containerName,
      isMain: input.isMain,
      networkMode: effectiveNetwork,
    });
    const configTimeout = containerCfg?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const log = logger.child({
      op: 'containerSpawn',
      group: groupName,
      container: containerName,
      backend: this.name,
      mountCount: mounts.length,
    });

    log.debug(
      {
        mounts: mounts.map(
          (m) =>
            `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
        ),
        containerArgs: containerArgs.join(' '),
      },
      'Container mount configuration',
    );

    log.info({ isMain: input.isMain }, 'Spawning container agent');

    const logsDir = path.join(GROUPS_DIR, folder, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    let container: ReturnType<typeof Bun.spawn>;
    try {
      container = Bun.spawn([LOCAL_RUNTIME, ...containerArgs], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (err) {
      log.error({ err }, 'Container spawn error');
      return {
        status: 'error',
        result: null,
        error: `Container spawn error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    onProcess(container, containerName);

    // Write input and close stdin
    if (typeof container.stdin === 'number' || !container.stdin) {
      throw new Error('Container stdin is not a writable stream');
    }
    container.stdin.write(
      JSON.stringify({
        ...input,
        networkMode: effectiveNetwork,
      }),
    );
    container.stdin.end();

    const killOnTimeout = () => {
      log.error('Container timeout, stopping gracefully');
      const stopProc = Bun.spawn([LOCAL_RUNTIME, 'stop', containerName]);
      const killTimer = setTimeout(() => container.kill(9), 15000);
      stopProc.exited
        .then((code) => {
          if (code === 0) {
            clearTimeout(killTimer);
          } else {
            clearTimeout(killTimer);
            container.kill(9);
          }
        })
        .catch((err) => {
          log.debug({ err }, 'Graceful container stop failed, force killing');
          clearTimeout(killTimer);
          container.kill(9);
        });
    };

    const parser = new StreamParser({
      groupName: groupName,
      containerName,
      timeoutMs,
      startupTimeoutMs: CONTAINER_STARTUP_TIMEOUT,
      maxOutputSize: CONTAINER_MAX_OUTPUT_SIZE,
      onOutput,
      onTimeout: killOnTimeout,
    });

    // Read stderr concurrently
    if (typeof container.stderr === 'number' || !container.stderr) {
      throw new Error('Container stderr is not a readable stream');
    }
    const stderrReader = container.stderr.getReader();
    const stderrDecoder = new TextDecoder();
    const stderrPromise = (async () => {
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          const chunk = stderrDecoder.decode(value, { stream: true });
          parser.feedStderr(chunk);
        }
      } catch {
        // stream closed
      }
    })();

    // Read stdout
    if (typeof container.stdout === 'number' || !container.stdout) {
      throw new Error('Container stdout is not a readable stream');
    }
    const stdoutReader = container.stdout.getReader();
    const stdoutDecoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        const chunk = stdoutDecoder.decode(value, { stream: true });
        parser.feedStdout(chunk);
      }
    } catch {
      // stream closed
    }

    // Wait for process exit
    const exitCode = await container.exited;
    await stderrPromise;
    parser.cleanup();

    const duration = Date.now() - startTime;
    const state = parser.getState();
    const exitLog = log.child({
      op: 'containerExit',
      exitCode,
      durationMs: duration,
    });

    if (state.timedOut) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const timeoutLog = path.join(logsDir, `container-${ts}.log`);
      fs.writeFileSync(
        timeoutLog,
        [
          `=== Container Run Log (TIMEOUT) ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${groupName}`,
          `Container: ${containerName}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${exitCode}`,
          `Had Streaming Output: ${state.hadStreamingOutput}`,
        ].join('\n'),
      );

      if (state.hadStreamingOutput) {
        exitLog.info('Container timed out after output (idle cleanup)');
        await state.outputChain;
        return {
          status: 'success',
          result: null,
          newSessionId: state.newSessionId,
        };
      }

      exitLog.error({ timedOut: true }, 'Container timed out with no output');
      return {
        status: 'error',
        result: null,
        error: `Container timed out after ${configTimeout}ms`,
      };
    }

    // Write log file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(logsDir, `container-${timestamp}.log`);
    const isVerbose =
      process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

    const logLines = [
      `=== Container Run Log ===`,
      `Timestamp: ${new Date().toISOString()}`,
      `Group: ${groupName}`,
      `IsMain: ${input.isMain}`,
      `Duration: ${duration}ms`,
      `Exit Code: ${exitCode}`,
      `Stdout Truncated: ${state.stdoutTruncated}`,
      `Stderr Truncated: ${state.stderrTruncated}`,
      ``,
    ];

    const isError = exitCode !== 0;

    if (isVerbose || isError) {
      logLines.push(
        `=== Input ===`,
        JSON.stringify(input, null, 2),
        ``,
        `=== Container Args ===`,
        containerArgs.join(' '),
        ``,
        `=== Mounts ===`,
        mounts
          .map(
            (m) =>
              `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
          )
          .join('\n'),
        ``,
        `=== Stderr${state.stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
        state.stderr,
        ``,
        `=== Stdout${state.stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
        state.stdout,
      );
    } else {
      logLines.push(
        `=== Input Summary ===`,
        `Prompt length: ${input.prompt.length} chars`,
        `Session ID: ${input.sessionId || 'new'}`,
        ``,
        `=== Mounts ===`,
        mounts
          .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
          .join('\n'),
        ``,
      );
    }

    fs.writeFileSync(logFile, logLines.join('\n'));
    exitLog.debug({ logFile, verbose: isVerbose }, 'Container log written');

    if (exitCode !== 0) {
      exitLog.error(
        {
          stderr: state.stderr,
          stdout: state.stdout,
          logFile,
        },
        'Container exited with error',
      );
      return {
        status: 'error',
        result: null,
        error: `Container exited with code ${exitCode}: ${state.stderr.slice(-200)}`,
      };
    }

    // Streaming mode
    if (onOutput) {
      await state.outputChain;
      exitLog.info(
        { newSessionId: state.newSessionId },
        'Container completed (streaming mode)',
      );
      return {
        status: 'success',
        result: null,
        newSessionId: state.newSessionId,
      };
    }

    // Legacy mode: parse last output marker pair
    try {
      const output = parser.parseFinalOutput();
      exitLog.info(
        { status: output.status, hasResult: !!output.result },
        'Container completed',
      );
      return output;
    } catch (err) {
      exitLog.error(
        { stdout: state.stdout, stderr: state.stderr, err },
        'Failed to parse container output',
      );
      return {
        status: 'error',
        result: null,
        error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Run agent in the shared Claude VM via `docker exec`.
   *
   * Note: shared-VM mode is currently disabled because it was Apple-Container-
   * only (see `isSharedVmEnabled`). Kept here for a possible future revival on
   * docker — not on the live code path.
   * The shared VM is long-running with broad parent mounts;
   * each agent gets its own stdin/stdout pipe and isolated workspace paths.
   */
  private async runAgentSharedVm(
    group: AgentOrGroup,
    input: ContainerInput,
    onProcess: (proc: ContainerProcess, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<ContainerOutput> {
    const startTime = Date.now();
    const folder = getFolder(group);
    const runtimeFolder = input.runtimeFolder || folder;
    const groupName = getName(group);
    const containerCfg = getContainerConfig(group);

    const groupDir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(groupDir, { recursive: true });

    // Prepare agent directories (IPC, sessions, env) — same side effects as per-VM mode
    const mounts = buildVolumeMounts(
      group,
      input.isMain,
      input.isScheduledTask,
      runtimeFolder,
      input.agentRuntime || getAgentRuntime(group),
      {
        channelFolder: input.channelFolder,
        categoryFolder: input.categoryFolder,
        agentContextFolder: input.agentContextFolder,
      },
      undefined,
      {
        allowGcpCredentials: !!containerCfg?.allowGcpCredentials,
        model: input.model,
      },
    );

    const effectiveNetwork = containerCfg?.networkMode ?? 'full';
    if (effectiveNetwork === 'none') {
      logger.error(
        {
          code: SHARED_VM_NETWORK_ISOLATION_ERROR_CODE,
          group: groupName,
          runtimeFolder,
          backend: this.name,
        },
        'Refusing shared-VM agent run because network isolation cannot be enforced per exec',
      );
      return sharedVmNetworkIsolationError(groupName);
    }
    // Ensure shared VM is running
    const vmName = await this.sharedVm.ensureRunning();

    // Build `docker exec` args with per-agent env vars
    const workspaceFolder = input.channelFolder || folder;
    const execArgs: string[] = [
      'exec',
      '-i',
      '-w',
      `/workspace/groups/${workspaceFolder}`,
      '-e',
      `AGENT_WORKSPACE=/workspace/groups/${workspaceFolder}`,
      '-e',
      `AGENT_IPC_DIR=/data/ipc/${runtimeFolder}`,
      '-e',
      `AGENT_SESSION_DIR=/data/sessions/${runtimeFolder}/.claude`,
      '-e',
      `AGENT_GLOBAL_DIR=/workspace/groups/global`,
      '-e',
      `AGENT_ENV_DIR=/data/env/${runtimeFolder}`,
      '-e',
      `AGENT_PROJECT_DIR=/workspace/project`,
      '-e',
      `TZ=${TIMEZONE}`,
    ];

    // Optional context directories
    if (input.agentContextFolder) {
      execArgs.push(
        '-e',
        `AGENT_CONTEXT_DIR=/workspace/groups/${input.agentContextFolder}`,
      );
    }
    if (input.categoryFolder) {
      execArgs.push(
        '-e',
        `AGENT_CATEGORY_DIR=/workspace/groups/${input.categoryFolder}`,
      );
    }
    const srvFolder = getServerFolder(group);
    if (srvFolder) {
      execArgs.push('-e', `AGENT_SERVER_DIR=/workspace/groups/${srvFolder}`);
    }

    execArgs.push(vmName, '/app/agent-exec.sh');

    const configTimeout = containerCfg?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const log = logger.child({
      op: 'containerExec',
      group: groupName,
      sharedVm: vmName,
      backend: this.name,
    });

    log.info({ isMain: input.isMain }, 'Exec-ing agent in shared Claude VM');

    const logsDir = path.join(GROUPS_DIR, folder, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    let container: ReturnType<typeof Bun.spawn>;
    try {
      container = Bun.spawn([LOCAL_RUNTIME, ...execArgs], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (err) {
      log.error({ err }, 'Container exec spawn error');
      return {
        status: 'error',
        result: null,
        error: `Container exec spawn error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    onProcess(container, `${vmName}:${runtimeFolder}`);

    // Write input and close stdin
    if (typeof container.stdin === 'number' || !container.stdin) {
      throw new Error('Container stdin is not a writable stream');
    }
    container.stdin.write(
      JSON.stringify({
        ...input,
        networkMode: effectiveNetwork,
      }),
    );
    container.stdin.end();

    const killOnTimeout = () => {
      log.error('Agent exec timeout, killing process');
      container.kill(9);
    };

    const parser = new StreamParser({
      groupName,
      containerName: `${vmName}:${runtimeFolder}`,
      timeoutMs,
      startupTimeoutMs: CONTAINER_STARTUP_TIMEOUT,
      maxOutputSize: CONTAINER_MAX_OUTPUT_SIZE,
      onOutput,
      onTimeout: killOnTimeout,
    });

    // Read stderr concurrently
    if (typeof container.stderr === 'number' || !container.stderr) {
      throw new Error('Container stderr is not a readable stream');
    }
    const stderrReader = container.stderr.getReader();
    const stderrDecoder = new TextDecoder();
    const stderrPromise = (async () => {
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          const chunk = stderrDecoder.decode(value, { stream: true });
          parser.feedStderr(chunk);
        }
      } catch {
        // stream closed
      }
    })();

    // Read stdout
    if (typeof container.stdout === 'number' || !container.stdout) {
      throw new Error('Container stdout is not a readable stream');
    }
    const stdoutReader = container.stdout.getReader();
    const stdoutDecoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        const chunk = stdoutDecoder.decode(value, { stream: true });
        parser.feedStdout(chunk);
      }
    } catch {
      // stream closed
    }

    // Wait for process exit
    const exitCode = await container.exited;
    await stderrPromise;
    parser.cleanup();

    const duration = Date.now() - startTime;
    const state = parser.getState();
    const exitLog = log.child({
      op: 'containerExit',
      exitCode,
      durationMs: duration,
    });

    if (state.timedOut) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const timeoutLog = path.join(logsDir, `container-${ts}.log`);
      fs.writeFileSync(
        timeoutLog,
        [
          `=== Container Run Log (TIMEOUT) ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${groupName}`,
          `SharedVM: ${vmName}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${exitCode}`,
          `Had Streaming Output: ${state.hadStreamingOutput}`,
        ].join('\n'),
      );

      if (state.hadStreamingOutput) {
        exitLog.info('Agent exec timed out after output (idle cleanup)');
        await state.outputChain;
        return {
          status: 'success',
          result: null,
          newSessionId: state.newSessionId,
        };
      }

      exitLog.error({ timedOut: true }, 'Agent exec timed out with no output');
      return {
        status: 'error',
        result: null,
        error: `Agent exec timed out after ${configTimeout}ms`,
      };
    }

    // Write log file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(logsDir, `container-${timestamp}.log`);
    const isVerbose =
      process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';
    const logLines = [
      `=== Container Exec Log ===`,
      `Timestamp: ${new Date().toISOString()}`,
      `Group: ${groupName}`,
      `SharedVM: ${vmName}`,
      `IsMain: ${input.isMain}`,
      `Duration: ${duration}ms`,
      `Exit Code: ${exitCode}`,
    ];
    if (isVerbose || exitCode !== 0) {
      logLines.push(
        ``,
        `=== Stderr ===`,
        state.stderr,
        ``,
        `=== Stdout ===`,
        state.stdout,
      );
    }
    fs.writeFileSync(logFile, logLines.join('\n'));

    if (exitCode !== 0) {
      exitLog.error(
        { stderr: state.stderr, logFile },
        'Agent exec exited with error',
      );
      return {
        status: 'error',
        result: null,
        error: `Agent exec exited with code ${exitCode}: ${state.stderr.slice(-200)}`,
      };
    }

    // Streaming mode
    if (onOutput) {
      await state.outputChain;
      exitLog.info(
        { newSessionId: state.newSessionId },
        'Agent exec completed (streaming mode)',
      );
      return {
        status: 'success',
        result: null,
        newSessionId: state.newSessionId,
      };
    }

    // Legacy mode
    try {
      const output = parser.parseFinalOutput();
      exitLog.info(
        { status: output.status, hasResult: !!output.result },
        'Agent exec completed',
      );
      return output;
    } catch (err) {
      exitLog.error(
        { stdout: state.stdout, stderr: state.stderr, err },
        'Failed to parse agent exec output',
      );
      return {
        status: 'error',
        result: null,
        error: `Failed to parse agent exec output: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  sendMessage(
    groupFolder: string,
    text: string,
    opts?: { chatJid?: string },
  ): boolean {
    const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
    assertPathWithin(inputDir, path.join(DATA_DIR, 'ipc'), 'sendMessage');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(
        tempPath,
        JSON.stringify({
          type: 'message',
          text,
          ...(opts?.chatJid ? { chatJid: opts.chatJid } : {}),
        }),
      );
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  closeStdin(groupFolder: string, inputSubdir: string = 'input'): void {
    const ipcBase = path.join(DATA_DIR, 'ipc');
    const inputDir = path.join(ipcBase, groupFolder, inputSubdir);
    assertPathWithin(inputDir, ipcBase, 'closeStdin');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      // Write a shutdown IPC message (atomic via .tmp rename) instead of the
      // legacy _close sentinel file. The agent-runner drains this like any
      // other .json IPC file, eliminating the race condition where _close
      // could be missed between poll cycles.
      const filename = `_shutdown-${Date.now()}.json`;
      const filePath = path.join(inputDir, filename);
      const tempPath = `${filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'shutdown' }));
      fs.renameSync(tempPath, filePath);
    } catch {
      // ignore
    }
  }

  writeIpcData(groupFolder: string, filename: string, data: string): void {
    const ipcBase = path.join(DATA_DIR, 'ipc');
    const groupIpcDir = path.join(ipcBase, groupFolder);
    assertPathWithin(groupIpcDir, ipcBase, 'writeIpcData');
    const filePath = path.join(groupIpcDir, filename);
    assertPathWithin(filePath, groupIpcDir, 'writeIpcData filename');
    fs.mkdirSync(groupIpcDir, { recursive: true });
    fs.writeFileSync(filePath, data);
  }

  async readFile(
    groupFolder: string,
    relativePath: string,
  ): Promise<Buffer | null> {
    const groupDir = path.join(GROUPS_DIR, groupFolder);
    const fullPath = path.join(groupDir, relativePath);
    assertPathWithin(fullPath, groupDir, 'readFile');
    try {
      return fs.readFileSync(fullPath);
    } catch {
      return null;
    }
  }

  async writeFile(
    groupFolder: string,
    relativePath: string,
    content: Buffer | string,
  ): Promise<void> {
    const groupDir = path.join(GROUPS_DIR, groupFolder);
    const fullPath = path.join(groupDir, relativePath);
    assertPathWithin(fullPath, groupDir, 'writeFile');
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  async initialize(): Promise<void> {
    // Probe to verify Docker is reachable and the image exists.
    // On macOS, the user must launch OrbStack.app once after install; after that
    // the docker daemon runs as a background service.
    const probeProc = Bun.spawn(
      [
        LOCAL_RUNTIME,
        'run',
        '--rm',
        '--entrypoint',
        '/bin/echo',
        CONTAINER_IMAGE,
        'ok',
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const probeStdout = await new Response(probeProc.stdout).text();
    const probeStderr = await new Response(probeProc.stderr).text();
    const probeExitCode = await probeProc.exited;

    if (probeExitCode === 0 && probeStdout.trim() === 'ok') {
      logger.info('Docker runtime ready (probe passed)');
      await this.cleanupOrphanedContainers();
      return;
    }

    logger.error(
      {
        exitCode: probeExitCode,
        stdout: probeStdout.trim(),
        stderr: probeStderr.trim(),
      },
      'Docker container probe failed',
    );
    this.printDockerError();
    throw new Error(
      'Docker container probe failed — check that OrbStack/Docker is running and the omniclaw-agent image is built',
    );
  }

  private printDockerError(): void {
    logger.error(
      'FATAL: Docker (via OrbStack on macOS) is required but not reachable. ' +
        'On macOS, open OrbStack.app once after install; after that docker works ' +
        'forever as a background service. On Linux, ensure the docker daemon is ' +
        'running (`sudo systemctl start docker`). Then rebuild the agent image ' +
        'with `bash container/build.sh` and restart OmniClaw.',
    );
  }

  private async cleanupOrphanedContainers(): Promise<void> {
    try {
      const lsResult =
        await $`docker ps --filter name=omniclaw- --format {{.Names}}`.quiet();
      const orphans = lsResult
        .text()
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      // Validate container names before passing to Bun.spawn.
      // Names come from runtime output — reject any that don't match the
      // expected omniclaw-<safeName>-<hex/timestamp> format to prevent
      // CLI flag injection (e.g. a name like "--all").
      const SAFE_CONTAINER_NAME =
        /^omniclaw-[a-zA-Z0-9_-]+-[a-f0-9-]+(-exec)?$/;
      // Don't kill the shared Claude VM — it's managed separately
      const sharedVmName = this.sharedVm.getName();
      const safeOrphans = orphans.filter((name) => {
        if (name === sharedVmName) return false;
        if (name.startsWith('omniclaw-shared-claude-')) return false;
        if (!SAFE_CONTAINER_NAME.test(name)) {
          logger.warn(
            { name },
            'Skipping orphan with unexpected container name',
          );
          return false;
        }
        return true;
      });
      await Promise.all(
        safeOrphans.map((name) => {
          const proc = Bun.spawn([LOCAL_RUNTIME, 'stop', name], {
            stdout: 'ignore',
            stderr: 'ignore',
          });
          return proc.exited;
        }),
      );
      if (safeOrphans.length > 0) {
        logger.info(
          { count: safeOrphans.length, names: safeOrphans },
          'Stopped orphaned containers',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to clean up orphaned containers');
    }
  }

  async shutdown(): Promise<void> {
    // Stop shared Claude VM if running
    await this.sharedVm.stop();
  }
}
