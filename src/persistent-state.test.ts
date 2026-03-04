import { beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { _initTestDatabase, setRouterState } from './db.js';
import * as db from './db.js';
import { logger } from './logger.js';
import { readPersistentJson, writePersistentJson } from './persistent-state.js';

describe('persistent-state', () => {
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
    const warnSpy = spyOn(logger, 'warn');
    const readSpy = spyOn(db, 'getRouterState').mockImplementation(() => {
      throw new Error('read failed');
    });

    const result = readPersistentJson('k2');

    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toBe('Failed to read persistent state');

    readSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('returns undefined and warns for invalid JSON payload', () => {
    const warnSpy = spyOn(logger, 'warn');
    setRouterState('k3', '{"broken":');

    const result = readPersistentJson('k3');

    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toBe('Failed to parse persistent state JSON');

    warnSpy.mockRestore();
  });

  it('swallows write errors and logs a warning', () => {
    const warnSpy = spyOn(logger, 'warn');
    const writeSpy = spyOn(db, 'setRouterState').mockImplementation(() => {
      throw new Error('write failed');
    });

    expect(() => writePersistentJson('k4', { ok: false })).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toBe('Failed to write persistent state');

    writeSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
