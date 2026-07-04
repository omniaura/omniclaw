import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, LOCAL_RUNTIME, SHARED_CLAUDE_VM_MEMORY } from '../config.js';
import { SharedVmManager } from './shared-vm.js';

function makeProcess(
  exitCode: number,
  stderr = '',
): ReturnType<typeof Bun.spawn> {
  return {
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        if (stderr) controller.enqueue(new TextEncoder().encode(stderr));
        controller.close();
      },
    }),
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    exited: Promise.resolve(exitCode),
    kill: mock(() => {}),
  } as unknown as ReturnType<typeof Bun.spawn>;
}

function mockContainerList(containers: unknown[]) {
  return spyOn(Bun, '$').mockImplementation((() => ({
    quiet: async () => ({
      text: () => JSON.stringify(containers),
    }),
  })) as unknown as typeof Bun.$);
}

describe('SharedVmManager', () => {
  const originalExtraDir = process.env.OMNICLAW_EXTRA_DIR;
  let extraDir = '';

  beforeEach(() => {
    extraDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclaw-extra-'));
    process.env.OMNICLAW_EXTRA_DIR = extraDir;
  });

  afterEach(() => {
    mock.restore();
    if (originalExtraDir === undefined) {
      delete process.env.OMNICLAW_EXTRA_DIR;
    } else {
      process.env.OMNICLAW_EXTRA_DIR = originalExtraDir;
    }
    fs.rmSync(extraDir, { recursive: true, force: true });
    fs.rmSync(path.join(DATA_DIR, 'opencode-data'), {
      recursive: true,
      force: true,
    });
  });

  it('returns an existing live container without spawning a new one', async () => {
    const manager = new SharedVmManager();
    (manager as any).containerName = 'omniclaw-shared-claude-existing';
    (manager as any).isAlive = mock(async () => true);
    const spawnSpy = spyOn(Bun, 'spawn');

    await expect(manager.ensureRunning()).resolves.toBe(
      'omniclaw-shared-claude-existing',
    );
    expect((manager as any).isAlive).toHaveBeenCalledWith(
      'omniclaw-shared-claude-existing',
    );
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent starts and uses deterministic container args', async () => {
    const manager = new SharedVmManager();
    const nowSpy = spyOn(Date, 'now').mockReturnValue(1234567890);
    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation((() =>
      makeProcess(0)) as unknown as typeof Bun.spawn);

    try {
      const [first, second] = await Promise.all([
        manager.ensureRunning(),
        manager.ensureRunning(),
      ]);

      expect(first).toBe('omniclaw-shared-claude-1234567890');
      expect(second).toBe(first);
      expect(manager.getName()).toBe(first);
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(spawnSpy.mock.calls[0]?.[0]).toEqual(
        expect.arrayContaining([
          LOCAL_RUNTIME,
          'run',
          '-d',
          '--memory',
          SHARED_CLAUDE_VM_MEMORY,
          '--name',
          first,
          '--entrypoint',
          '/app/shared-entrypoint.sh',
        ]),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('includes the optional OpenCode data mount when runtime data exists', async () => {
    const manager = new SharedVmManager();
    const opencodeDataDir = path.join(DATA_DIR, 'opencode-data');
    fs.mkdirSync(opencodeDataDir, { recursive: true });
    const nowSpy = spyOn(Date, 'now').mockReturnValue(987654321);
    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation((() =>
      makeProcess(0)) as unknown as typeof Bun.spawn);

    try {
      await expect(manager.ensureRunning()).resolves.toBe(
        'omniclaw-shared-claude-987654321',
      );

      expect(spawnSpy.mock.calls[0]?.[0]).toContain(
        `${opencodeDataDir}:/data/opencode-data`,
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('clears failed startup state so a later ensureRunning can retry', async () => {
    const manager = new SharedVmManager();
    const nowSpy = spyOn(Date, 'now').mockReturnValue(222);
    const spawnSpy = spyOn(Bun, 'spawn')
      .mockImplementationOnce((() =>
        makeProcess(
          2,
          'container runtime failed',
        )) as unknown as typeof Bun.spawn)
      .mockImplementationOnce((() =>
        makeProcess(0)) as unknown as typeof Bun.spawn);

    try {
      await expect(manager.ensureRunning()).rejects.toThrow(
        'container runtime failed',
      );
      await expect(manager.ensureRunning()).resolves.toBe(
        'omniclaw-shared-claude-222',
      );
      expect(spawnSpy).toHaveBeenCalledTimes(2);
      expect(manager.getName()).toBe('omniclaw-shared-claude-222');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('stops the current container once and clears its name before awaiting exit', async () => {
    const manager = new SharedVmManager();
    (manager as any).containerName = 'omniclaw-shared-claude-stop-me';
    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation((() => {
      expect(manager.getName()).toBeNull();
      return makeProcess(0);
    }) as unknown as typeof Bun.spawn);

    await expect(manager.stop()).resolves.toBeUndefined();
    await expect(manager.stop()).resolves.toBeUndefined();

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy.mock.calls[0]?.[0]).toEqual([
      LOCAL_RUNTIME,
      'stop',
      'omniclaw-shared-claude-stop-me',
    ]);
  });

  it('stops only running orphan shared VMs', async () => {
    const manager = new SharedVmManager();
    (manager as any).containerName = 'omniclaw-shared-claude-current';
    mockContainerList([
      {
        status: 'running',
        configuration: { id: 'omniclaw-shared-claude-current' },
      },
      {
        status: 'running',
        configuration: { id: 'omniclaw-shared-claude-orphan-a' },
      },
      {
        status: 'stopped',
        configuration: { id: 'omniclaw-shared-claude-stopped' },
      },
      { status: 'running', configuration: { id: 'unrelated-container' } },
      {
        status: 'running',
        configuration: { id: 'omniclaw-shared-claude-orphan-b' },
      },
    ]);
    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation((() =>
      makeProcess(0)) as unknown as typeof Bun.spawn);

    await expect(manager.cleanupOrphans()).resolves.toBeUndefined();

    expect(spawnSpy).toHaveBeenCalledTimes(2);
    expect(spawnSpy.mock.calls.map((call) => call[0])).toEqual([
      [LOCAL_RUNTIME, 'stop', 'omniclaw-shared-claude-orphan-a'],
      [LOCAL_RUNTIME, 'stop', 'omniclaw-shared-claude-orphan-b'],
    ]);
  });

  it('does not throw when orphan cleanup cannot list containers', async () => {
    const manager = new SharedVmManager();
    spyOn(Bun, '$').mockImplementation((() => ({
      quiet: async () => {
        throw new Error('runtime unavailable');
      },
    })) as unknown as typeof Bun.$);
    const spawnSpy = spyOn(Bun, 'spawn');

    await expect(manager.cleanupOrphans()).resolves.toBeUndefined();

    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('reports liveness from runtime list output and treats parse failures as dead', async () => {
    const manager = new SharedVmManager();
    const listSpy = mockContainerList([
      {
        status: 'exited',
        configuration: { id: 'omniclaw-shared-claude-stopped' },
      },
      {
        status: 'running',
        configuration: { id: 'omniclaw-shared-claude-live' },
      },
    ]);

    await expect(
      (manager as any).isAlive('omniclaw-shared-claude-live'),
    ).resolves.toBe(true);
    await expect(
      (manager as any).isAlive('omniclaw-shared-claude-stopped'),
    ).resolves.toBe(false);

    listSpy.mockImplementation((() => ({
      quiet: async () => ({ text: () => 'not json' }),
    })) as unknown as typeof Bun.$);
    await expect(
      (manager as any).isAlive('omniclaw-shared-claude-live'),
    ).resolves.toBe(false);
  });
});
