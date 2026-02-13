/**
 * Daytona IPC Poller for NanoClaw
 * Polls IPC directories on Daytona sandboxes for messages and tasks,
 * analogous to sprites-ipc-poller.ts but using the Daytona SDK.
 *
 * Uses relative paths (resolved from sandbox workdir by the FS API).
 */

import { type Sandbox } from '@daytonaio/sdk';

import { IPC_POLL_INTERVAL } from '../config.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
import { DaytonaBackend } from './daytona-backend.js';

interface DaytonaIpcPollerDeps {
  daytonaBackend: DaytonaBackend;
  registeredGroups: () => Record<string, RegisteredGroup>;
  processMessage: (sourceGroup: string, data: any) => Promise<void>;
  processTask: (sourceGroup: string, isMain: boolean, data: any) => Promise<void>;
}

let pollerRunning = false;

/**
 * Start polling Daytona-backed groups for IPC output.
 * Reads workspace/ipc/messages/ and workspace/ipc/tasks/ via Daytona SDK filesystem.
 */
export function startDaytonaIpcPoller(deps: DaytonaIpcPollerDeps): void {
  if (pollerRunning) return;
  pollerRunning = true;

  const poll = async () => {
    const groups = deps.registeredGroups();

    const daytonaGroups = Object.entries(groups).filter(
      ([, g]) => g.backend === 'daytona',
    );

    if (daytonaGroups.length === 0) {
      setTimeout(poll, IPC_POLL_INTERVAL);
      return;
    }

    for (const [jid, group] of daytonaGroups) {
      const sandbox = deps.daytonaBackend.getSandboxForGroup(group.folder);
      if (!sandbox) continue; // Sandbox not started yet

      const isMain = group.folder === 'main';

      try {
        // Poll messages directory (relative path)
        await pollDirectory(sandbox, 'workspace/ipc/messages', async (filename, content) => {
          const data = JSON.parse(content);
          await deps.processMessage(group.folder, data);
        });

        // Poll tasks directory (relative path)
        await pollDirectory(sandbox, 'workspace/ipc/tasks', async (filename, content) => {
          const data = JSON.parse(content);
          await deps.processTask(group.folder, isMain, data);
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('404') && !msg.includes('not found')) {
          logger.warn(
            { group: group.folder, error: msg },
            'Error polling Daytona IPC',
          );
        }
      }
    }

    setTimeout(poll, IPC_POLL_INTERVAL);
  };

  poll();
  logger.info('Daytona IPC poller started');
}

/**
 * List JSON files in a remote directory, process each one, then delete it.
 */
async function pollDirectory(
  sandbox: Sandbox,
  dirPath: string,
  handler: (filename: string, content: string) => Promise<void>,
): Promise<void> {
  let entries;
  try {
    entries = await sandbox.fs.listFiles(dirPath);
  } catch {
    return; // Directory doesn't exist yet
  }

  const jsonFiles = entries.filter((e: any) => !e.isDir && e.name.endsWith('.json'));

  for (const entry of jsonFiles) {
    const filePath = `${dirPath}/${entry.name}`;

    try {
      const buf = await sandbox.fs.downloadFile(filePath);
      const content = buf.toString('utf-8');

      await handler(entry.name, content);

      // Delete after successful processing
      await sandbox.fs.deleteFile(filePath);
    } catch (err) {
      logger.warn(
        { file: filePath, error: err },
        'Error processing Daytona IPC file',
      );
    }
  }
}
