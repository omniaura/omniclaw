import { beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { _initTestDatabase, setRouterState } from './db.js';
import * as db from './db.js';
import { logger } from './logger.js';
import { readPersistentJson, writePersistentJson } from './persistent-state.js';

describe('persistent-state', () => {
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

  beforeEach(() => {
    _initTestDatabase();
  });

  it('reads back previously written JSON values', () => {
    const value = { enabled: true, retries: 2, tags: ['a'] };

    writePersistentJson('k1', value);
    const read = readPersistentJson<typeof value>('k1');

    expect(read).toEqual(value);
  });

  it('returns undefined when no key exists', () => {
    expect(readPersistentJson('missing')).toBeUndefined();
  });

  it('returns undefined and warns when db read throws', () => {
    const { messages, unsubscribe } = captureWarnMessages();
    const readSpy = spyOn(db, 'getRouterState').mockImplementation(() => {
      throw new Error('read failed');
    });

    const result = readPersistentJson('k2');

    expect(result).toBeUndefined();
    expect(messages).toEqual(['Failed to read persistent state']);

    readSpy.mockRestore();
    unsubscribe();
  });

  it('returns undefined and warns for invalid JSON payload', () => {
    const { messages, unsubscribe } = captureWarnMessages();
    setRouterState('k3', '{"broken":');

    const result = readPersistentJson('k3');

    expect(result).toBeUndefined();
    expect(messages).toEqual(['Failed to parse persistent state JSON']);

    unsubscribe();
  });

  it('swallows write errors and logs a warning', () => {
    const { messages, unsubscribe } = captureWarnMessages();
    const writeSpy = spyOn(db, 'setRouterState').mockImplementation(() => {
      throw new Error('write failed');
    });

    expect(() => writePersistentJson('k4', { ok: false })).not.toThrow();
    expect(messages).toEqual(['Failed to write persistent state']);

    writeSpy.mockRestore();
    unsubscribe();
  });
});
