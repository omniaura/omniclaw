import { beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { _initTestDatabase } from './db.js';
import { logger } from './logger.js';
import {
  createResumePositionStore,
  MemoryResumePositionStore,
  PersistentResumePositionStore,
  type PersistentStateAdapter,
} from './resume-position-store.js';

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

  it('clears all tracked positions', () => {
    store.set('beta', '2026-03-02T00:00:00.000Z');

    store.clear();

    expect(store.getAll()).toEqual({});
  });
});

describe('PersistentResumePositionStore', () => {
  function captureWarnMessages(): {
    messages: string[];
    unsubscribe: () => void;
  } {
    const messages: string[] = [];
    const unsubscribe = logger.subscribe((record) => {
      if (record.level === 'warn' && typeof record.msg === 'string') {
        messages.push(record.msg);
      }
    });
    return { messages, unsubscribe };
  }

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
    const adapter: PersistentStateAdapter = {
      read: <T>() => ({ alpha: '2026-03-01T00:00:00.000Z' }) as T,
      write: (key, value) => {
        writes.push({ key, value: structuredClone(value) });
      },
    };
    const store = new PersistentResumePositionStore({ stateAdapter: adapter });

    store.set('beta', '2026-03-02T00:00:00.000Z');
    store.clear();

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

  it('warns and continues when initial load fails', () => {
    const { messages, unsubscribe } = captureWarnMessages();
    const store = new PersistentResumePositionStore({
      stateAdapter: {
        read: () => {
          throw new Error('boom');
        },
        write: () => {},
      },
    });

    expect(store.getAll()).toEqual({});
    expect(messages).toEqual(['Failed to load persisted resume positions']);

    unsubscribe();
  });

  it('warns and keeps in-memory state when persisting fails', () => {
    const { messages, unsubscribe } = captureWarnMessages();
    const store = new PersistentResumePositionStore({
      stateAdapter: {
        read: <T>() => ({}) as T,
        write: () => {
          throw new Error('disk full');
        },
      },
    });

    expect(() => {
      store.set('alpha', '2026-03-03T00:00:00.000Z');
    }).not.toThrow();
    expect(store.get('alpha')).toBe('2026-03-03T00:00:00.000Z');
    expect(messages).toEqual(['Failed to persist resume positions']);

    unsubscribe();
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
