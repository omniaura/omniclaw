import { beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { _initTestDatabase, setRouterState } from './db.js';
import * as db from './db.js';
import { subscribeToLogs, type LogRecord } from './logger.js';
import { readPersistentJson, writePersistentJson } from './persistent-state.js';

function captureLogs(): { records: LogRecord[]; stop: () => void } {
  const records: LogRecord[] = [];
  const stop = subscribeToLogs((record) => {
    records.push(record);
  });
  return { records, stop };
}

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
    const { records, stop } = captureLogs();
    const readSpy = spyOn(db, 'getRouterState').mockImplementation(() => {
      throw new Error('read failed');
    });

    const result = readPersistentJson('k2');

    expect(result).toBeUndefined();
    expect(records).toHaveLength(1);
    expect(records[0].msg).toBe('Failed to read persistent state');

    readSpy.mockRestore();
    stop();
  });

  it('returns undefined and warns for invalid JSON payload', () => {
    const { records, stop } = captureLogs();
    setRouterState('k3', '{"broken":');

    const result = readPersistentJson('k3');

    expect(result).toBeUndefined();
    expect(records).toHaveLength(1);
    expect(records[0].msg).toBe('Failed to parse persistent state JSON');

    stop();
  });

  it('swallows write errors and logs a warning', () => {
    const { records, stop } = captureLogs();
    const writeSpy = spyOn(db, 'setRouterState').mockImplementation(() => {
      throw new Error('write failed');
    });

    expect(() => writePersistentJson('k4', { ok: false })).not.toThrow();
    expect(records).toHaveLength(1);
    expect(records[0].msg).toBe('Failed to write persistent state');

    writeSpy.mockRestore();
    stop();
  });
});
