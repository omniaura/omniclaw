import { describe, expect, it, mock } from 'bun:test';

import {
  createResumePositionStore,
  PersistentResumePositionStore,
} from './resume-position-store.js';

describe('resume position store', () => {
  it('keeps behavior inert when persistentTaskState is disabled', () => {
    const existingState: Record<string, string> = {
      main: 'cursor-1',
    };

    const store = createResumePositionStore({
      persistentTaskState: false,
      initialResumePositions: existingState,
    });

    expect(store.get('main')).toBe('cursor-1');

    store.set('main', 'cursor-2');
    expect(existingState.main).toBe('cursor-2');
  });

  it('falls back to empty state when persisted resume positions are missing', () => {
    const write = mock(() => {});
    const store = new PersistentResumePositionStore({
      stateAdapter: {
        read: () => undefined,
        write,
      },
    });

    expect(store.getAll()).toEqual({});

    store.set('group-a', 'cursor-a');
    expect(write).toHaveBeenCalledTimes(1);
    expect(store.get('group-a')).toBe('cursor-a');
  });

  it('falls back to empty state when persisted resume positions are unreadable', () => {
    const store = new PersistentResumePositionStore({
      stateAdapter: {
        read: () => {
          throw new Error('EACCES: permission denied');
        },
        write: () => {},
      },
    });

    expect(store.getAll()).toEqual({});

    store.set('group-b', 'cursor-b');
    expect(store.get('group-b')).toBe('cursor-b');
  });

  it('drops corrupted persisted entries and keeps valid values', () => {
    const store = new PersistentResumePositionStore({
      stateAdapter: {
        read: <T>() => ({
          valid: 'cursor-valid',
          invalid: 42,
        }) as T,
        write: () => {},
      },
    });

    expect(store.getAll()).toEqual({
      valid: 'cursor-valid',
    });
  });
});
