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

import { LOCAL_RUNTIME, SHARED_CLAUDE_VM_MEMORY } from '../config.js';
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
});
