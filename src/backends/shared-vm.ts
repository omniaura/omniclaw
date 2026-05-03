/**
 * SharedVmManager — manages a single long-running Apple Container VM
 * that hosts multiple Claude agent-runner processes via `container exec`.
 *
 * The shared VM is started with broad parent mounts (groups/, data/)
 * so it doesn't need to be recreated when agents register/unregister.
 */

import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  DATA_DIR,
  GROUPS_DIR,
  LOCAL_RUNTIME,
  SHARED_CLAUDE_VM_MEMORY,
} from '../config.js';
import { logger } from '../logger.js';

const SHARED_VM_PREFIX = 'omniclaw-shared-claude';
function getExtraDir(): string {
  return process.env.OMNICLAW_EXTRA_DIR || '/workspace/extra';
}

export class SharedVmManager {
  private containerName: string | null = null;
  private starting: Promise<string> | null = null;

  /**
   * Ensure the shared VM is running. Returns the container name.
   * Safe to call concurrently — deduplicates start attempts.
   */
  async ensureRunning(): Promise<string> {
    if (this.containerName && (await this.isAlive(this.containerName))) {
      return this.containerName;
    }

    // Deduplicate concurrent start calls
    if (this.starting) return this.starting;
    this.starting = this.start();
    try {
      const name = await this.starting;
      return name;
    } finally {
      this.starting = null;
    }
  }

  getName(): string | null {
    return this.containerName;
  }

  async stop(): Promise<void> {
    if (!this.containerName) return;
    const name = this.containerName;
    this.containerName = null;
    try {
      const proc = Bun.spawn([LOCAL_RUNTIME, 'stop', name], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      await proc.exited;
      logger.info({ container: name }, 'Shared Claude VM stopped');
    } catch (err) {
      logger.warn({ err, container: name }, 'Failed to stop shared Claude VM');
    }
  }

  /** Stop any orphaned shared VMs from previous runs. */
  async cleanupOrphans(): Promise<void> {
    try {
      const lsResult = await Bun.$`${LOCAL_RUNTIME} ls --format json`.quiet();
      const containers: { status: string; configuration: { id: string } }[] =
        JSON.parse(lsResult.text() || '[]');
      const orphans = containers
        .filter(
          (c) =>
            c.status === 'running' &&
            c.configuration.id.startsWith(SHARED_VM_PREFIX) &&
            c.configuration.id !== this.containerName,
        )
        .map((c) => c.configuration.id);
      if (orphans.length > 0) {
        await Promise.all(
          orphans.map((name) => {
            const proc = Bun.spawn([LOCAL_RUNTIME, 'stop', name], {
              stdout: 'ignore',
              stderr: 'ignore',
            });
            return proc.exited;
          }),
        );
        logger.info(
          { count: orphans.length, names: orphans },
          'Stopped orphaned shared Claude VMs',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to clean up orphaned shared VMs');
    }
  }

  private async start(): Promise<string> {
    const name = `${SHARED_VM_PREFIX}-${Date.now()}`;
    const projectRoot = process.cwd();
    const extraDir = getExtraDir();

    // Ensure parent dirs exist
    fs.mkdirSync(GROUPS_DIR, { recursive: true });
    fs.mkdirSync(path.join(DATA_DIR, 'ipc'), { recursive: true });
    fs.mkdirSync(path.join(DATA_DIR, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(DATA_DIR, 'env'), { recursive: true });
    fs.mkdirSync(extraDir, { recursive: true });

    const args: string[] = [
      'run',
      '-d',
      '--memory',
      SHARED_CLAUDE_VM_MEMORY,
      '--name',
      name,
      // Broad parent mounts — all agents' subdirs are accessible
      '-v',
      `${GROUPS_DIR}:/workspace/groups`,
      '-v',
      `${path.join(DATA_DIR, 'ipc')}:/data/ipc`,
      '-v',
      `${path.join(DATA_DIR, 'sessions')}:/data/sessions`,
      '--mount',
      `type=bind,source=${path.join(DATA_DIR, 'env')},target=/data/env,readonly`,
      '-v',
      `${projectRoot}:/workspace/project:ro`,
      '-v',
      `${extraDir}:/workspace/extra:ro`,
      // Agent runner source (shared, read-only)
      '--mount',
      `type=bind,source=${path.join(projectRoot, 'container', 'agent-runner', 'src')},target=/app/src,readonly`,
      // OpenCode data (if exists)
      ...(fs.existsSync(path.join(DATA_DIR, 'opencode-data'))
        ? ['-v', `${path.join(DATA_DIR, 'opencode-data')}:/data/opencode-data`]
        : []),
      '--entrypoint',
      '/app/shared-entrypoint.sh',
      CONTAINER_IMAGE,
    ];

    logger.info(
      { container: name, memory: SHARED_CLAUDE_VM_MEMORY },
      'Starting shared Claude VM',
    );

    const proc = Bun.spawn([LOCAL_RUNTIME, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(
        `Failed to start shared Claude VM: exit ${exitCode}\n${stderr}`,
      );
    }

    this.containerName = name;
    logger.info({ container: name }, 'Shared Claude VM started');
    return name;
  }

  private async isAlive(name: string): Promise<boolean> {
    try {
      const lsResult = await Bun.$`${LOCAL_RUNTIME} ls --format json`.quiet();
      const containers: { status: string; configuration: { id: string } }[] =
        JSON.parse(lsResult.text() || '[]');
      return containers.some(
        (c) => c.configuration.id === name && c.status === 'running',
      );
    } catch {
      return false;
    }
  }
}
