import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';

interface DbModule {
  initDatabase: () => void;
  _initTestDatabase: () => void;
  getAllAgents: () => Record<string, any>;
  setAgent: (agent: any) => void;
}

function makeTempProjectRoot(tag: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `omniclaw-db-${tag}-`));
  fs.mkdirSync(path.join(root, 'store'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  return root;
}

async function importDbModuleForRoot(root: string, tag: string): Promise<DbModule> {
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    return await import(`./db.ts?migration_${tag}_${Date.now()}_${Math.random()}`) as DbModule;
  } finally {
    process.chdir(previousCwd);
  }
}

/**
 * Legacy fixture modeled from the user's current local DB shape:
 * - agents table has is_local and no agent_runtime column
 * - registered_groups/channel_routes already exist
 */
function seedLegacyObservedSchema(dbPath: string): void {
  const db = new Database(dbPath);

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

  db.close();
}

function getAgentColumns(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  const columns = db.query('PRAGMA table_info(agents)').all() as Array<{ name: string }>;
  db.close();
  return columns.map((c) => c.name);
}

describe('db migrations (bun:sqlite)', () => {
  it('migrates legacy observed agents schema and keeps rows readable/writable', async () => {
    const root = makeTempProjectRoot('legacy');
    const dbPath = path.join(root, 'store', 'messages.db');

    try {
      seedLegacyObservedSchema(dbPath);
      const dbModule = await importDbModuleForRoot(root, 'legacy');

      dbModule.initDatabase();

      const columns = getAgentColumns(dbPath);
      expect(columns).toContain('agent_runtime');
      expect(columns).toContain('is_local'); // legacy column remains; should not break app writes

      const agentsAfterMigration = dbModule.getAllAgents();
      expect(agentsAfterMigration.main.agentRuntime).toBe('claude-agent-sdk');
      expect(agentsAfterMigration.worker.agentRuntime).toBe('claude-agent-sdk');

      // Validate write-path normalization too.
      dbModule.setAgent({
        ...agentsAfterMigration.worker,
        agentRuntime: 'not-a-real-runtime',
      });
      const persisted = dbModule.getAllAgents();
      expect(persisted.worker.agentRuntime).toBe('claude-agent-sdk');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates fresh schema and supports opencode runtime writes/reads', async () => {
    const root = makeTempProjectRoot('fresh');
    try {
      // Same module instance is fine here; _initTestDatabase exercises fresh schema creation.
      const dbModule = await importDbModuleForRoot(root, 'fresh');
      dbModule._initTestDatabase();

      dbModule.setAgent({
        id: 'new-agent',
        name: 'New Agent',
        folder: 'new-agent',
        backend: 'apple-container',
        agentRuntime: 'opencode',
        isAdmin: false,
        createdAt: '2026-01-03T00:00:00.000Z',
      });

      const agents = dbModule.getAllAgents();
      expect(agents['new-agent'].agentRuntime).toBe('opencode');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
