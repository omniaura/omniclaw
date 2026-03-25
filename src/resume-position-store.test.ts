import { beforeEach, describe, expect, it } from 'bun:test';

import { _initTestDatabase } from './db.js';
import { subscribeToLogs, type LogRecord } from './logger.js';
import {
  createResumePositionStore,
  MemoryResumePositionStore,
  PersistentResumePositionStore,
  type PersistentStateAdapter,
} from './resume-position-store.js';

function captureLogs(): { records: LogRecord[]; stop: () => void } {
  const records: LogRecord[] = [];
  const stop = subscribeToLogs((record) => {
    records.push(record);
  });
  return { records, stop };
}

describe('MemoryResumePositionStore', () => {
  let store: MemoryResumePositionStore;

  beforeEach(() => {
    store = new MemoryResumePositionStore({
      alpha: '2026-03-01T00:00:00.000Z',
    });
  });

  it('reads and updates in-memory resume positions', () => {
    expect(store.get('alpha')).toBe('2026-03-01T00:00:00.000Z');
    expect(store.get('missing')).toBeUndefined();

    store.set('beta', '2026-03-02T00:00:00.000Z');

    expect(store.getAll()).toEqual({
      alpha: '2026-03-01T00:00:00.000Z',
      beta: '2026-03-02T00:00:00.000Z',
    });
  });

  it('returns a defensive copy from getAll', () => {
    const snapshot = store.getAll();
    snapshot.alpha = 'mutated';

    expect(store.get('alpha')).toBe('2026-03-01T00:00:00.000Z');
  });

  it('clears all tracked positions', () => {
    store.set('beta', '2026-03-02T00:00:00.000Z');

    store.clear();

    expect(store.getAll()).toEqual({});
  });
});

describe('PersistentResumePositionStore', () => {
  it('loads only string resume positions from persisted state', () => {
    const adapter: PersistentStateAdapter = {
      read: <T>() =>
        ({
          alpha: '2026-03-01T00:00:00.000Z',
          beta: 123,
          gamma: null,
        }) as T,
      write: () => {},
    };

    const store = new PersistentResumePositionStore({ stateAdapter: adapter });

    expect(store.getAll()).toEqual({
      alpha: '2026-03-01T00:00:00.000Z',
    });
  });

  it('falls back to an empty state when persisted data is not an object', () => {
    const arrayStore = new PersistentResumePositionStore({
      stateAdapter: {
        read: <T>() => ['bad'] as T,
        write: () => {},
      },
    });
    const nullStore = new PersistentResumePositionStore({
      stateAdapter: {
        read: <T>() => null as T,
        write: () => {},
      },
    });

    expect(arrayStore.getAll()).toEqual({});
    expect(nullStore.getAll()).toEqual({});
  });

  it('persists updates and clears through the adapter', () => {
    const writes: Array<{ key: string; value: unknown }> = [];
    const scheduled: Array<() => void> = [];
    const adapter: PersistentStateAdapter = {
      read: <T>() => ({ alpha: '2026-03-01T00:00:00.000Z' }) as T,
      write: (key, value) => {
        writes.push({ key, value: structuredClone(value) });
      },
    };
    const store = new PersistentResumePositionStore({
      stateAdapter: adapter,
      schedulePersist: (flush) => {
        scheduled.push(flush);
      },
    });

    store.set('beta', '2026-03-02T00:00:00.000Z');
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    store.clear();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();

    expect(writes).toEqual([
      {
        key: 'resume_positions',
        value: {
          alpha: '2026-03-01T00:00:00.000Z',
          beta: '2026-03-02T00:00:00.000Z',
        },
      },
      {
        key: 'resume_positions',
        value: {},
      },
    ]);
  });

  it('coalesces multiple writes scheduled in the same tick', () => {
    const writes: Array<{ key: string; value: unknown }> = [];
    const scheduled: Array<() => void> = [];
    const store = new PersistentResumePositionStore({
      stateAdapter: {
        read: <T>() => ({}) as T,
        write: (key, value) => {
          writes.push({ key, value: structuredClone(value) });
        },
      },
      schedulePersist: (flush) => {
        scheduled.push(flush);
      },
    });

    store.set('alpha', 'one');
    store.set('beta', 'two');
    store.set('beta', 'three');

    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();

    expect(writes).toEqual([
      {
        key: 'resume_positions',
        value: {
          alpha: 'one',
          beta: 'three',
        },
      },
    ]);
  });

  it('does not persist when setting an unchanged value', () => {
    const writes: Array<{ key: string; value: unknown }> = [];
    const scheduled: Array<() => void> = [];
    const store = new PersistentResumePositionStore({
      stateAdapter: {
        read: <T>() => ({ alpha: '2026-03-01T00:00:00.000Z' }) as T,
        write: (key, value) => {
          writes.push({ key, value: structuredClone(value) });
        },
      },
      schedulePersist: (flush) => {
        scheduled.push(flush);
      },
    });

    store.set('alpha', '2026-03-01T00:00:00.000Z');

    expect(scheduled).toHaveLength(0);
    expect(writes).toEqual([]);
  });

  it('returns a defensive copy from persistent getAll', () => {
    const store = new PersistentResumePositionStore({
      stateAdapter: {
        read: <T>() => ({ alpha: '2026-03-01T00:00:00.000Z' }) as T,
        write: () => {},
      },
    });

    const snapshot = store.getAll();
    snapshot.alpha = 'mutated';

    expect(store.get('alpha')).toBe('2026-03-01T00:00:00.000Z');
  });

  it('warns and continues when initial load fails', () => {
    const { records, stop } = captureLogs();

    try {
      const store = new PersistentResumePositionStore({
        stateAdapter: {
          read: () => {
            throw new Error('boom');
          },
          write: () => {},
        },
      });

      expect(store.getAll()).toEqual({});
      expect(records).toHaveLength(1);
      expect(records[0]?.msg).toBe('Failed to load persisted resume positions');
    } finally {
      stop();
    }
  });

  it('warns and keeps in-memory state when persisting fails', () => {
    const { records, stop } = captureLogs();

    try {
      const store = new PersistentResumePositionStore({
        stateAdapter: {
          read: <T>() => ({}) as T,
          write: () => {
            throw new Error('disk full');
          },
        },
        schedulePersist: (flush) => {
          flush();
        },
      });

      expect(() => {
        store.set('alpha', '2026-03-03T00:00:00.000Z');
      }).not.toThrow();
      expect(store.get('alpha')).toBe('2026-03-03T00:00:00.000Z');
      expect(records).toHaveLength(1);
      expect(records[0]?.msg).toBe('Failed to persist resume positions');

      expect(() => {
        store.clear();
      }).not.toThrow();
      expect(store.getAll()).toEqual({});

      expect(records).toHaveLength(2);
      expect(records[1]?.msg).toBe('Failed to persist resume positions');
    } finally {
      stop();
    }
  });

  it('clears persisted state fully after flush', () => {
    const writes: Array<{ key: string; value: unknown }> = [];
    const scheduled: Array<() => void> = [];
    const store = new PersistentResumePositionStore({
      stateAdapter: {
        read: <T>() => ({ alpha: '2026-03-01T00:00:00.000Z' }) as T,
        write: (key, value) => {
          writes.push({ key, value: structuredClone(value) });
        },
      },
      schedulePersist: (flush) => {
        scheduled.push(flush);
      },
    });

    store.clear();
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();

    expect(store.getAll()).toEqual({});
    expect(writes).toEqual([
      {
        key: 'resume_positions',
        value: {},
      },
    ]);
  });
});

describe('createResumePositionStore', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('returns a memory-backed store when persistence is disabled', () => {
    const store = createResumePositionStore({
      persistentTaskState: false,
      initialResumePositions: { alpha: '2026-03-01T00:00:00.000Z' },
    });

    expect(store).toBeInstanceOf(MemoryResumePositionStore);
    expect(store.get('alpha')).toBe('2026-03-01T00:00:00.000Z');
  });

  it('returns a persistent store when persistence is enabled', () => {
    const store = createResumePositionStore({
      persistentTaskState: true,
      initialResumePositions: { alpha: 'ignored' },
    });

    expect(store).toBeInstanceOf(PersistentResumePositionStore);
  });
});
