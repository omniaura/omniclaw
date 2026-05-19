import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, DISPATCH_RUNTIME_SEP, IPC_POLL_INTERVAL } from './config.js';
import {
  MAX_IPC_FILES_PER_POLL,
  MAX_IPC_FILES_PER_SOURCE_PER_POLL,
  resetIpcWatcherForTests,
  startIpcWatcher,
  type IpcDeps,
} from './ipc.js';
import type { RegisteredGroup } from './types.js';

const IPC_BASE_DIR = path.join(DATA_DIR, 'ipc');

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('startIpcWatcher', () => {
  const originalSetTimeout = globalThis.setTimeout;
  let staleRuntimeFolder: string | undefined;
  let rogueErrorDir: string | undefined;
  const cleanupDirs: string[] = [];

  const waitFor = async (
    predicate: () => boolean,
    timeoutMs = 1000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for IPC watcher test condition');
      }
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
  };

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
    resetIpcWatcherForTests();
    if (staleRuntimeFolder) {
      fs.rmSync(path.join(IPC_BASE_DIR, staleRuntimeFolder), {
        recursive: true,
        force: true,
      });
      staleRuntimeFolder = undefined;
    }
    if (rogueErrorDir) {
      fs.rmSync(rogueErrorDir, { recursive: true, force: true });
      rogueErrorDir = undefined;
    }
    for (const dir of cleanupDirs.splice(0)) {
      fs.rmSync(path.join(IPC_BASE_DIR, dir), {
        recursive: true,
        force: true,
      });
    }
  });

  it('maps runtime folders to owners, cleans stale dispatch dirs, and quarantines rogue sources', async () => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const ownerFolder = `runtime-owner-${id}`;
    cleanupDirs.push('main');
    staleRuntimeFolder = `${ownerFolder}${DISPATCH_RUNTIME_SEP}0123456789abcdef`;
    const rogueFolder = `rogue-source-${id}`;
    const malformedRuntimeFolder = `${ownerFolder}${DISPATCH_RUNTIME_SEP}not-a-digest`;
    rogueErrorDir = path.join(IPC_BASE_DIR, 'errors', rogueFolder);
    const malformedRuntimeErrorDir = path.join(
      IPC_BASE_DIR,
      'errors',
      malformedRuntimeFolder,
    );
    const malformedMessageFile = `malformed-${id}.json`;
    const malformedTaskFile = `malformed-task-${id}.json`;
    const failingTaskFile = `failing-task-${id}.json`;

    fs.rmSync(path.join(IPC_BASE_DIR, staleRuntimeFolder), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(IPC_BASE_DIR, rogueFolder), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(IPC_BASE_DIR, malformedRuntimeFolder), {
      recursive: true,
      force: true,
    });
    fs.rmSync(rogueErrorDir, { recursive: true, force: true });
    fs.rmSync(malformedRuntimeErrorDir, { recursive: true, force: true });

    fs.mkdirSync(path.join(IPC_BASE_DIR, staleRuntimeFolder, 'messages'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(IPC_BASE_DIR, rogueFolder, 'messages'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(IPC_BASE_DIR, malformedRuntimeFolder, 'messages'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(IPC_BASE_DIR, 'main', 'messages'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(IPC_BASE_DIR, 'main', 'tasks'), {
      recursive: true,
    });

    fs.writeFileSync(
      path.join(IPC_BASE_DIR, staleRuntimeFolder, 'messages', 'message.json'),
      JSON.stringify({
        type: 'message',
        chatJid: 'main@g.us',
        text: 'hello from runtime',
      }),
    );
    fs.writeFileSync(
      path.join(IPC_BASE_DIR, rogueFolder, 'messages', 'message.json'),
      JSON.stringify({
        type: 'message',
        chatJid: 'main@g.us',
        text: 'should never be processed',
      }),
    );
    fs.writeFileSync(
      path.join(
        IPC_BASE_DIR,
        malformedRuntimeFolder,
        'messages',
        'message.json',
      ),
      JSON.stringify({
        type: 'message',
        chatJid: 'main@g.us',
        text: 'malformed runtime should never be processed',
      }),
    );
    fs.writeFileSync(
      path.join(IPC_BASE_DIR, 'main', 'messages', malformedMessageFile),
      '{"type":',
    );
    fs.writeFileSync(
      path.join(IPC_BASE_DIR, 'main', 'tasks', malformedTaskFile),
      '{"type":',
    );
    fs.writeFileSync(
      path.join(IPC_BASE_DIR, 'main', 'tasks', failingTaskFile),
      JSON.stringify({ type: 'refresh_groups' }),
    );

    const otherGroup: RegisteredGroup = {
      name: 'Other',
      folder: ownerFolder,
      trigger: '@Bot',
      added_at: '2024-01-01T00:00:00.000Z',
    };

    const groups: Record<string, RegisteredGroup> = {
      'main@g.us': MAIN_GROUP,
      'other@g.us': otherGroup,
    };

    const sendCalls: Array<{
      jid: string;
      text: string;
      discordBotId?: string;
    }> = [];
    const notifyCalls: Array<{
      jid: string;
      text: string;
      sourceFolder?: string;
    }> = [];
    const events: Array<{ kind: string; sourceGroup: string }> = [];
    const scheduledDelays: number[] = [];

    globalThis.setTimeout = ((
      _fn: Parameters<typeof setTimeout>[0],
      delay?: number,
      ..._args: unknown[]
    ) => {
      scheduledDelays.push(delay ?? 0);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    const deps: IpcDeps = {
      sendMessage: async (jid, text, discordBotId) => {
        sendCalls.push({ jid, text, discordBotId });
        return 'sent-1';
      },
      notifyGroup: (jid, text, sourceFolder) => {
        notifyCalls.push({ jid, text, sourceFolder });
      },
      registeredGroups: () => groups,
      registerGroup: () => {},
      updateGroup: () => {},
      syncGroupMetadata: async () => {
        throw new Error('sync exploded');
      },
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
      activeRuntimeFolders: () => new Set<string>(),
      agentFolders: () => new Set<string>([ownerFolder]),
      onIpcEvent: (kind, sourceGroup) => {
        events.push({ kind, sourceGroup });
      },
    };

    startIpcWatcher(deps);
    // The mock records the next poll interval without executing another loop,
    // so this assertion exercises the synchronous first scan only.
    await flushMicrotasks();

    expect(sendCalls).toMatchObject([
      { jid: 'main@g.us', text: 'hello from runtime' },
    ]);
    expect(notifyCalls).toEqual([
      {
        jid: 'main@g.us',
        text: 'hello from runtime',
        sourceFolder: ownerFolder,
      },
    ]);
    expect(events).toContainEqual({
      kind: 'message_sent',
      sourceGroup: ownerFolder,
    });
    expect(fs.existsSync(path.join(IPC_BASE_DIR, staleRuntimeFolder))).toBe(
      false,
    );
    expect(fs.existsSync(rogueErrorDir)).toBe(true);
    expect(fs.existsSync(malformedRuntimeErrorDir)).toBe(true);
    expect(fs.existsSync(path.join(IPC_BASE_DIR, rogueFolder))).toBe(false);
    const quarantinedFiles = fs.readdirSync(path.join(IPC_BASE_DIR, 'errors'));
    expect(
      quarantinedFiles.some(
        (file) => file.includes(`main-`) && file.endsWith(malformedMessageFile),
      ),
    ).toBe(true);
    expect(
      quarantinedFiles.some(
        (file) => file.includes(`main-`) && file.endsWith(malformedTaskFile),
      ),
    ).toBe(true);
    expect(
      quarantinedFiles.some(
        (file) => file.includes(`main-`) && file.endsWith(failingTaskFile),
      ),
    ).toBe(true);
    expect(scheduledDelays).toEqual([IPC_POLL_INTERVAL]);

    startIpcWatcher(deps);
    expect(scheduledDelays).toEqual([IPC_POLL_INTERVAL]);
    fs.rmSync(
      path.join(IPC_BASE_DIR, 'main', 'messages', malformedMessageFile),
      {
        force: true,
      },
    );
    fs.rmSync(path.join(IPC_BASE_DIR, 'main', 'tasks', malformedTaskFile), {
      force: true,
    });
    fs.rmSync(path.join(IPC_BASE_DIR, 'main', 'tasks', failingTaskFile), {
      force: true,
    });
    for (const file of quarantinedFiles) {
      if (
        file.endsWith(malformedMessageFile) ||
        file.endsWith(malformedTaskFile) ||
        file.endsWith(failingTaskFile)
      ) {
        fs.rmSync(path.join(IPC_BASE_DIR, 'errors', file), { force: true });
      }
    }
  });

  it('caps valid IPC files per source and leaves overflow for a later poll', async () => {
    const id = `budget-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const sourceFolder = `${id}-source`;
    cleanupDirs.push(sourceFolder);
    const messagesDir = path.join(IPC_BASE_DIR, sourceFolder, 'messages');
    fs.mkdirSync(messagesDir, { recursive: true });

    const targetJid = `${id}@g.us`;
    const fileCount = MAX_IPC_FILES_PER_SOURCE_PER_POLL + 1;
    for (let i = 0; i < fileCount; i += 1) {
      const filePath = path.join(
        messagesDir,
        `${String(i).padStart(3, '0')}.json`,
      );
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          type: 'message',
          chatJid: targetJid,
          text: `message-${i}`,
        }),
      );
      const mtime = new Date(1_700_000_000_000 + i);
      fs.utimesSync(filePath, mtime, mtime);
    }

    const sentTexts: string[] = [];
    const events: Array<{
      kind: string;
      sourceGroup: string;
      details?: Record<string, unknown>;
    }> = [];

    globalThis.setTimeout = ((
      _fn: Parameters<typeof setTimeout>[0],
      _delay?: number,
      ..._args: unknown[]
    ) => 1 as unknown as ReturnType<typeof setTimeout>) as typeof setTimeout;

    const deps: IpcDeps = {
      sendMessage: async (_jid, text) => {
        sentTexts.push(text);
      },
      notifyGroup: () => {},
      registeredGroups: () => ({
        [targetJid]: {
          name: 'Budget Source',
          folder: sourceFolder,
          trigger: 'always',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
      registerGroup: () => {},
      updateGroup: () => {},
      syncGroupMetadata: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
      onIpcEvent: (kind, sourceGroup, _summary, details) => {
        events.push({ kind, sourceGroup, details });
      },
    };

    startIpcWatcher(deps);
    await waitFor(() => sentTexts.length === MAX_IPC_FILES_PER_SOURCE_PER_POLL);
    await flushMicrotasks();

    expect(sentTexts).toHaveLength(MAX_IPC_FILES_PER_SOURCE_PER_POLL);
    expect(sentTexts.at(0)).toBe('message-0');
    expect(sentTexts.at(-1)).toBe(
      `message-${MAX_IPC_FILES_PER_SOURCE_PER_POLL - 1}`,
    );
    expect(fs.readdirSync(messagesDir).sort()).toEqual([
      `${String(MAX_IPC_FILES_PER_SOURCE_PER_POLL).padStart(3, '0')}.json`,
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'ipc_error',
        sourceGroup: sourceFolder,
        details: expect.objectContaining({
          reason: 'ipc_backpressure',
          sourceKind: 'messages',
          deferredCount: 1,
          perSourceLimit: MAX_IPC_FILES_PER_SOURCE_PER_POLL,
        }),
      }),
    );
  });

  it('applies source caps fairly before the global poll cap', async () => {
    const id = `global-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const sourceFolders = Array.from(
      {
        length: MAX_IPC_FILES_PER_POLL / MAX_IPC_FILES_PER_SOURCE_PER_POLL + 1,
      },
      (_, index) => `${id}-source-${String(index).padStart(2, '0')}`,
    );
    cleanupDirs.push(...sourceFolders);

    const groups: Record<string, RegisteredGroup> = {};
    for (const [sourceIndex, sourceFolder] of sourceFolders.entries()) {
      const targetJid = `${sourceFolder}@g.us`;
      groups[targetJid] = {
        name: sourceFolder,
        folder: sourceFolder,
        trigger: 'always',
        added_at: '2024-01-01T00:00:00.000Z',
      };
      const messagesDir = path.join(IPC_BASE_DIR, sourceFolder, 'messages');
      fs.mkdirSync(messagesDir, { recursive: true });
      for (let i = 0; i < MAX_IPC_FILES_PER_SOURCE_PER_POLL; i += 1) {
        const filePath = path.join(
          messagesDir,
          `${String(i).padStart(3, '0')}.json`,
        );
        fs.writeFileSync(
          filePath,
          JSON.stringify({
            type: 'message',
            chatJid: targetJid,
            text: `${sourceFolder}-message-${i}`,
          }),
        );
        const mtime = new Date(1_700_000_100_000 + sourceIndex * 1000 + i);
        fs.utimesSync(filePath, mtime, mtime);
      }
    }

    const sentBySource = new Map<string, number>();
    const events: Array<{ kind: string; sourceGroup: string }> = [];

    globalThis.setTimeout = ((
      _fn: Parameters<typeof setTimeout>[0],
      _delay?: number,
      ..._args: unknown[]
    ) => 1 as unknown as ReturnType<typeof setTimeout>) as typeof setTimeout;

    const deps: IpcDeps = {
      sendMessage: async (jid) => {
        const folder = groups[jid]!.folder;
        sentBySource.set(folder, (sentBySource.get(folder) ?? 0) + 1);
      },
      notifyGroup: () => {},
      registeredGroups: () => groups,
      registerGroup: () => {},
      updateGroup: () => {},
      syncGroupMetadata: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
      onIpcEvent: (kind, sourceGroup) => {
        events.push({ kind, sourceGroup });
      },
    };

    startIpcWatcher(deps);
    await waitFor(() => {
      const processedTotal = Array.from(sentBySource.values()).reduce(
        (sum, count) => sum + count,
        0,
      );
      return processedTotal === MAX_IPC_FILES_PER_POLL;
    });
    await flushMicrotasks();

    const processedTotal = Array.from(sentBySource.values()).reduce(
      (sum, count) => sum + count,
      0,
    );
    expect(processedTotal).toBe(MAX_IPC_FILES_PER_POLL);
    for (const sourceFolder of sourceFolders.slice(0, -1)) {
      expect(sentBySource.get(sourceFolder)).toBe(
        MAX_IPC_FILES_PER_SOURCE_PER_POLL,
      );
      expect(
        fs.readdirSync(path.join(IPC_BASE_DIR, sourceFolder, 'messages')),
      ).toHaveLength(0);
    }

    const deferredSource = sourceFolders.at(-1)!;
    expect(sentBySource.get(deferredSource)).toBeUndefined();
    expect(
      fs.readdirSync(path.join(IPC_BASE_DIR, deferredSource, 'messages')),
    ).toHaveLength(MAX_IPC_FILES_PER_SOURCE_PER_POLL);
    expect(events).toContainEqual({
      kind: 'ipc_error',
      sourceGroup: deferredSource,
    });
  });
});
