import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { createSchema } from './db.js';

/**
 * Legacy fixture modeled from the user's current local DB shape:
 * - agents table has is_local and no agent_runtime column
 * - registered_groups/channel_routes already exist
 */
function seedLegacyObservedSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      folder TEXT NOT NULL UNIQUE,
      backend TEXT NOT NULL DEFAULT 'apple-container',
      container_config TEXT,
      heartbeat TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_local INTEGER NOT NULL DEFAULT 1,
      server_folder TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1,
      heartbeat TEXT,
      discord_guild_id TEXT,
      server_folder TEXT,
      backend TEXT,
      description TEXT,
      auto_respond_to_questions INTEGER DEFAULT 0,
      auto_respond_keywords TEXT,
      stream_intermediates INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS channel_routes (
      channel_jid TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      trigger_pattern TEXT NOT NULL,
      requires_trigger INTEGER NOT NULL DEFAULT 1,
      discord_guild_id TEXT,
      created_at TEXT NOT NULL
    );
  `);

  db.query(`
    INSERT INTO agents (id, name, description, folder, backend, container_config, heartbeat, is_admin, is_local, server_folder, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'main',
    'Main Agent',
    'admin',
    'main',
    'apple-container',
    null,
    null,
    1,
    1,
    null,
    '2026-01-01T00:00:00.000Z',
  );

  db.query(`
    INSERT INTO agents (id, name, description, folder, backend, container_config, heartbeat, is_admin, is_local, server_folder, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'worker',
    'Worker Agent',
    'worker',
    'worker',
    'docker',
    null,
    null,
    0,
    1,
    null,
    '2026-01-02T00:00:00.000Z',
  );
}

function getAgentColumns(db: Database): string[] {
  const columns = db.query('PRAGMA table_info(agents)').all() as Array<{ name: string }>;
  return columns.map((c) => c.name);
}

describe('db migrations (bun:sqlite)', () => {
  it('migrates legacy observed agents schema and keeps rows readable/writable', () => {
    // Use in-memory DB to avoid file system and module caching issues.
    // createSchema() runs the same migration as initDatabase() (addColumnIfNotExists).
    const db = new Database(':memory:');

    seedLegacyObservedSchema(db);

    // Verify legacy schema does NOT have agent_runtime
    const columnsBefore = getAgentColumns(db);
    expect(columnsBefore).not.toContain('agent_runtime');
    expect(columnsBefore).toContain('is_local');

    // Run createSchema — should add agent_runtime via ALTER TABLE
    createSchema(db);

    const columns = getAgentColumns(db);
    expect(columns).toContain('agent_runtime');
    expect(columns).toContain('is_local'); // legacy column remains

    // Verify default values applied to existing rows
    const agents = db.query('SELECT id, agent_runtime FROM agents ORDER BY id').all() as Array<{ id: string; agent_runtime: string | null }>;
    expect(agents.length).toBe(2);
    for (const agent of agents) {
      expect(agent.agent_runtime).toBe('claude-agent-sdk');
    }

    db.close();
  });

  it('creates fresh schema with agent_runtime column', () => {
    const db = new Database(':memory:');
    createSchema(db);

    const columns = getAgentColumns(db);
    expect(columns).toContain('agent_runtime');

    // Write an agent with opencode runtime
    db.query(`
      INSERT INTO agents (id, name, folder, backend, agent_runtime, is_admin, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('test', 'Test Agent', 'test', 'apple-container', 'opencode', 0, '2026-01-01T00:00:00.000Z');

    const row = db.query('SELECT agent_runtime FROM agents WHERE id = ?').get('test') as { agent_runtime: string };
    expect(row.agent_runtime).toBe('opencode');

    db.close();
  });
});
