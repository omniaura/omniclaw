import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';

import { mock as mockModule } from 'bun:test';

mockModule.module('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
}));

mockModule.module('fs', () => ({
  default: {
    mkdirSync: mock(),
    writeFileSync: mock(),
    renameSync: mock(),
  },
}));

import { GroupQueue } from './group-queue.js';

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    jest.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // --- Single group at a time ---

  it('only runs one container per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = mock(async (groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same group
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    // Advance timers to let the first process complete
    jest.advanceTimersByTime(200);
    await Bun.sleep(0);

    // Second enqueue should have been queued, not concurrent
    expect(maxConcurrent).toBe(1);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = mock(async (groupJid: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 groups (limit is 2)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

    // Let promises settle
    jest.advanceTimersByTime(10);
    await Bun.sleep(0);

    // Only 2 should be active (MAX_CONCURRENT_CONTAINERS = 2)
    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);

    // Complete one — third should start
    completionCallbacks[0]();
    jest.advanceTimersByTime(10);
    await Bun.sleep(0);

    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  // --- Tasks prioritized over messages ---

  it('drains tasks before messages for same group', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = mock(async (groupJid: string) => {
      if (executionOrder.length === 0) {
        // First call: block until we release it
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing messages (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    jest.advanceTimersByTime(10);
    await Bun.sleep(0);

    // While active, enqueue both a task and pending messages
    const taskFn = mock(async () => {
      executionOrder.push('task');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    queue.enqueueMessageCheck('group1@g.us');

    // Release the first processing
    resolveFirst!();
    jest.advanceTimersByTime(10);
    await Bun.sleep(0);

    // Task should have run before the second message check
    expect(executionOrder[0]).toBe('messages'); // first call
    expect(executionOrder[1]).toBe('task'); // task runs first in drain
    // Messages would run after task completes
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = mock(async () => {
      callCount++;
      return false; // failure
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call happens immediately
    jest.advanceTimersByTime(10);
    await Bun.sleep(0);
    expect(callCount).toBe(1);

    // First retry after 5000ms (BASE_RETRY_MS * 2^0)
    jest.advanceTimersByTime(5000);
    await Bun.sleep(0);
    jest.advanceTimersByTime(10);
    await Bun.sleep(0);
    expect(callCount).toBe(2);

    // Second retry after 10000ms (BASE_RETRY_MS * 2^1)
    jest.advanceTimersByTime(10000);
    await Bun.sleep(0);
    jest.advanceTimersByTime(10);
    await Bun.sleep(0);
    expect(callCount).toBe(3);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = mock(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us');
    jest.advanceTimersByTime(100);
    await Bun.sleep(0);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = mock(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // Run through all 5 retries (MAX_RETRIES = 5)
    // Initial call
    jest.advanceTimersByTime(10);
    await Bun.sleep(0);
    expect(callCount).toBe(1);

    // Retry 1: 5000ms, Retry 2: 10000ms, Retry 3: 20000ms, Retry 4: 40000ms, Retry 5: 80000ms
    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      jest.advanceTimersByTime(retryDelays[i] + 10);
      await Bun.sleep(0);
      expect(callCount).toBe(i + 2);
    }

    // After 5 retries (6 total calls), should stop — no more retries
    const countAfterMaxRetries = callCount;
    jest.advanceTimersByTime(200000); // Wait a long time
    await Bun.sleep(0);
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = mock(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    jest.advanceTimersByTime(10);
    await Bun.sleep(0);

    // Queue a third
    queue.enqueueMessageCheck('group3@g.us');
    jest.advanceTimersByTime(10);
    await Bun.sleep(0);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // Free up a slot
    completionCallbacks[0]();
    jest.advanceTimersByTime(10);
    await Bun.sleep(0);

    expect(processed).toContain('group3@g.us');
  });
});
