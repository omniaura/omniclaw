import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, DISPATCH_RUNTIME_SEP, IPC_POLL_INTERVAL } from './config.js';
import { startIpcWatcher, type IpcDeps } from './ipc.js';
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

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
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
  });

  it('maps runtime folders to owners, cleans stale dispatch dirs, and quarantines rogue sources', async () => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const ownerFolder = `runtime-owner-${id}`;
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
});
