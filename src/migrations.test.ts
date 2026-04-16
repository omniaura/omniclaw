import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';

import { logger } from './logger.js';
import {
  addColumnIfNotExists,
  allMigrations,
  BASELINE_VERSION,
  dropColumnIfExists,
  getSchemaVersion,
  runMigrations,
} from './migrations.js';

function getColumns(db: Database, table: string): string[] {
  return (
    db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((row) => row.name);
}

afterEach(() => {
  mock.restore();
});

describe('migration helpers', () => {
  it('adds missing columns with defaults for existing rows', () => {
    const db = new Database(':memory:');
    db.exec(
      'CREATE TABLE example (id INTEGER PRIMARY KEY, name TEXT NOT NULL)',
    );
    db.exec("INSERT INTO example (name) VALUES ('first')");

    addColumnIfNotExists(db, 'example', 'enabled', 'INTEGER NOT NULL', '1');

    const row = db
      .query('SELECT enabled FROM example WHERE name = ?')
      .get('first') as { enabled: number };

    expect(getColumns(db, 'example')).toContain('enabled');
    expect(row.enabled).toBe(1);

    db.close();
  });

  it('ignores duplicate-column errors but rethrows unrelated ones', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE example (id INTEGER PRIMARY KEY)');

    addColumnIfNotExists(db, 'example', 'enabled', 'INTEGER');
    expect(() =>
      addColumnIfNotExists(db, 'example', 'enabled', 'INTEGER'),
    ).not.toThrow();

    expect(() =>
      addColumnIfNotExists(db, 'missing_table', 'enabled', 'INTEGER'),
    ).toThrow('no such table');

    db.close();
  });

  it('drops existing columns and no-ops when the column is already absent', () => {
    const db = new Database(':memory:');
    db.exec(
      'CREATE TABLE example (id INTEGER PRIMARY KEY, legacy TEXT, name TEXT)',
    );

    dropColumnIfExists(db, 'example', 'legacy');
    expect(getColumns(db, 'example')).not.toContain('legacy');

    expect(() => dropColumnIfExists(db, 'example', 'legacy')).not.toThrow();

    db.close();
  });

  it('warns and continues when dropping a legacy column fails', () => {
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    const fakeDb = {
      query() {
        return {
          all() {
            return [{ name: 'legacy' }];
          },
        };
      },
      exec() {
        throw new Error('database is locked');
      },
    } as unknown as Database;

    expect(() => dropColumnIfExists(fakeDb, 'example', 'legacy')).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      { table: 'example', column: 'legacy', err: 'database is locked' },
      'Failed to drop legacy column',
    );
  });
});

describe('migration versioning', () => {
  it('returns version 0 when the schema_version table is missing', () => {
    const db = new Database(':memory:');

    expect(getSchemaVersion(db)).toBe(0);

    db.close();
  });

  it('clears legacy heartbeat state during the baseline migration', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL UNIQUE,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        heartbeat TEXT,
        stream_intermediates INTEGER DEFAULT 0
      );

      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL UNIQUE,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        heartbeat TEXT
      );
    `);

    db.exec(`
      INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, heartbeat)
      VALUES ('dc:test', 'Test Group', 'test-group', '@Test', '2026-01-01T00:00:00.000Z', '0 * * * *');
      INSERT INTO agents (id, name, folder, is_admin, created_at, heartbeat)
      VALUES ('agent-1', 'Agent 1', 'agent-1', 0, '2026-01-01T00:00:00.000Z', '*/5 * * * *');
    `);

    runMigrations(db, allMigrations);
    expect(getSchemaVersion(db)).toBe(BASELINE_VERSION);

    runMigrations(db, allMigrations);
    expect(getSchemaVersion(db)).toBe(BASELINE_VERSION);

    const groupRow = db
      .query('SELECT heartbeat FROM registered_groups WHERE jid = ?')
      .get('dc:test') as { heartbeat: string | null };
    const agentRow = db
      .query('SELECT heartbeat FROM agents WHERE id = ?')
      .get('agent-1') as { heartbeat: string | null };

    expect(groupRow.heartbeat).toBeNull();
    expect(agentRow.heartbeat).toBeNull();
    expect(getColumns(db, 'registered_groups')).not.toContain(
      'stream_intermediates',
    );

    db.close();
  });
});
