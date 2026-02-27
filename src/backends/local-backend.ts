/**
 * Local Backend for OmniClaw
 * Runs agents in Apple Container (or Docker) on the local machine.
 * Extracted from container-runner.ts.
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
  TIMEZONE,
} from '../config.js';
import { logger } from '../logger.js';
import { validateAdditionalMounts } from '../mount-security.js';
import { assertPathWithin } from '../path-security.js';
import { ContainerProcess } from '../types.js';
import { StreamParser } from './stream-parser.js';
import {
  AgentBackend,
  AgentOrGroup,
  ChannelInfo,
  ContainerInput,
  ContainerOutput,
  VolumeMount,
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

  fs.rmSync(groupAgentRunnerDir, { recursive: true, force: true });
  fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  fs.writeFileSync(syncMarker, `${Date.now()}\n`, 'utf-8');
  logger.info({ groupAgentRunnerDir }, 'Refreshed cached agent-runner source');
  return true;
}

function buildVolumeMounts(
  group: AgentOrGroup,
  isMain: boolean,
  isScheduledTask: boolean = false,
  runtimeFolder?: string,
  contextFolders?: {
    channelFolder?: string;
    categoryFolder?: string;
    agentContextFolder?: string;
  },
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const homeDir = getHomeDir();
  const projectRoot = process.cwd();

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
    // Docker: bind-mount /dev/null over .env (file-to-file mounts work in Docker).
    // Apple Container: only supports directory mounts — rely on hook-level protections instead.
    // (Upstream PR #419, Issue #40)
    const projectEnvFile = path.join(projectRoot, '.env');
    if (fs.existsSync(projectEnvFile) && LOCAL_RUNTIME === 'docker') {
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
      if (fs.existsSync(serverDir)) {
        mounts.push({
          hostPath: serverDir,
          containerPath: '/workspace/server',
          readonly: false,
        });
      }
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
    for (const authFile of ['auth.json', 'mcp-auth.json']) {
      const src = path.join(hostOpenCodeDir, authFile);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(containerOcDir, authFile));
      }
    }
    mounts.push({
      hostPath: containerOcDir,
      containerPath: '/home/bun/.local/share/opencode',
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
  const envDir = path.join(DATA_DIR, 'env');
  fs.mkdirSync(envDir, { recursive: true });
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    const allowedVars = [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_MODEL',
      'GITHUB_TOKEN',
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'CLAUDE_MODEL',
      'OPENCODE_MODEL',
      'OPENCODE_PROVIDER',
      'OPENCODE_MODEL_ID',
    ];
    const filteredLines = envContent.split('\n').filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return false;
      return allowedVars.some((v) => trimmed.startsWith(`${v}=`));
    });

    if (filteredLines.length > 0) {
      fs.writeFileSync(
        path.join(envDir, 'env'),
        filteredLines.join('\n') + '\n',
      );
      mounts.push({
        hostPath: envDir,
        containerPath: '/workspace/env-dir',
        readonly: true,
      });
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
}

/** @internal Exported for testing */
export function buildContainerArgs({
  mounts,
  containerName,
  isMain,
  networkMode,
}: ContainerArgsOpts): string[] {
  const isDocker = LOCAL_RUNTIME === 'docker';
  const args: string[] = [
    'run',
    '-i',
    '--rm',
    '--memory',
    CONTAINER_MEMORY,
    '--name',
    containerName,
  ];

  if (isDocker) {
    args.push('--pids-limit', '256');
    args.push('--security-opt', 'no-new-privileges:true');

    // Network isolation: non-main containers have no network access by default.
    // Main containers retain full network (needed for WebFetch/WebSearch).
    // Per-group override via containerConfig.networkMode.
    const effectiveNetwork = networkMode ?? (isMain ? 'full' : 'none');
    if (effectiveNetwork === 'none') {
      args.push('--network', 'none');
    }
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

export class LocalBackend implements AgentBackend {
  readonly name = LOCAL_RUNTIME === 'docker' ? 'docker' : 'apple-container';

  async runAgent(
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

    const mounts = buildVolumeMounts(
      group,
      input.isMain,
      input.isScheduledTask,
      runtimeFolder,
      {
        channelFolder: input.channelFolder,
        categoryFolder: input.categoryFolder,
        agentContextFolder: input.agentContextFolder,
      },
    );
    const containerName = makeContainerName(folder, runtimeFolder);
    const containerArgs = buildContainerArgs({
      mounts,
      containerName,
      isMain: input.isMain,
      networkMode: containerCfg?.networkMode,
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
    container.stdin.write(JSON.stringify(input));
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
      fs.writeFileSync(path.join(inputDir, '_close'), '');
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
    const isDocker = LOCAL_RUNTIME === 'docker';

    if (!isDocker) {
      // Kill any orphaned OmniClaw containers from a previous run (Apple Container only)
      await $`pkill -f 'container run.*omniclaw-'`.quiet().nothrow();

      // Idempotent start — fast no-op if already running
      logger.info('Starting Apple Container system...');
      const start = await $`container system start`.quiet().nothrow();
      if (start.exitCode !== 0) {
        logger.error(
          { stderr: start.stderr.toString() },
          'Failed to start Apple Container system',
        );
        this.printContainerSystemError();
        throw new Error(
          'Apple Container system is required but failed to start',
        );
      }
    }

    // Probe to verify containers actually work
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
    const probeExitCode = await probeProc.exited;
    const probe = { exitCode: probeExitCode, text: () => probeStdout };
    if (probe.exitCode === 0 && probe.text().trim() === 'ok') {
      logger.info('Container system ready (probe passed)');
      await this.cleanupOrphanedContainers();
      return;
    }

    if (isDocker) {
      // Docker daemon is always running; a failed probe is a hard error
      logger.error(
        { exitCode: probe.exitCode, output: probe.text().trim() },
        'Docker container probe failed',
      );
      throw new Error(
        'Docker container probe failed — check that the image exists and Docker is running',
      );
    }

    // Probe failed — fall back to full stop/sleep/start cycle (Apple Container only)
    logger.warn(
      { exitCode: probe.exitCode, output: probe.text().trim() },
      'Container probe failed, performing full restart cycle...',
    );
    await $`container system stop`.quiet().nothrow();
    await Bun.sleep(3000);

    const retry = await $`container system start`.quiet().nothrow();
    if (retry.exitCode !== 0) {
      logger.error(
        { stderr: retry.stderr.toString() },
        'Failed to start Apple Container system on retry',
      );
      this.printContainerSystemError();
      throw new Error('Apple Container system failed to start on retry');
    }

    const probe2Proc = Bun.spawn(
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
    const probe2Stdout = await new Response(probe2Proc.stdout).text();
    const probe2ExitCode = await probe2Proc.exited;
    const probe2 = { exitCode: probe2ExitCode, text: () => probe2Stdout };
    if (probe2.exitCode !== 0 || probe2.text().trim() !== 'ok') {
      logger.error('Container probe still failing after full restart');
      this.printContainerSystemError();
      throw new Error('Container system probe failed after restart');
    } else {
      logger.info('Container probe succeeded after full restart');
    }

    await this.cleanupOrphanedContainers();
  }

  private printContainerSystemError(): void {
    logger.error(
      'FATAL: Container system failed to start. Run `container system start` and restart the application. See the project README for installation instructions.',
    );
  }

  private async cleanupOrphanedContainers(): Promise<void> {
    try {
      let orphans: string[];
      if (LOCAL_RUNTIME === 'docker') {
        const lsResult =
          await $`docker ps --filter name=omniclaw- --format {{.Names}}`.quiet();
        orphans = lsResult
          .text()
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        const lsResult = await $`container ls --format json`.quiet();
        const containers: { status: string; configuration: { id: string } }[] =
          JSON.parse(lsResult.text() || '[]');
        orphans = containers
          .filter(
            (c) =>
              c.status === 'running' &&
              c.configuration.id.startsWith('omniclaw-'),
          )
          .map((c) => c.configuration.id);
      }
      await Promise.all(
        orphans.map((name) => {
          const proc = Bun.spawn([LOCAL_RUNTIME, 'stop', name], {
            stdout: 'ignore',
            stderr: 'ignore',
          });
          return proc.exited;
        }),
      );
      if (orphans.length > 0) {
        logger.info(
          { count: orphans.length, names: orphans },
          'Stopped orphaned containers',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to clean up orphaned containers');
    }
  }

  async shutdown(): Promise<void> {
    // Containers clean themselves up via --rm flag
  }
}
