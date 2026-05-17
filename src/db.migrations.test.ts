import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { createSchema } from './db.js';
import {
  allMigrations,
  BASELINE_VERSION,
  getSchemaVersion,
  runMigrations,
  type Migration,
} from './migrations.js';

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

  db.query(
    `
    INSERT INTO agents (id, name, description, folder, backend, container_config, heartbeat, is_admin, is_local, server_folder, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
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

  db.query(
    `
    INSERT INTO agents (id, name, description, folder, backend, container_config, heartbeat, is_admin, is_local, server_folder, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
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
  const columns = db.query('PRAGMA table_info(agents)').all() as Array<{
    name: string;
  }>;
  return columns.map((c) => c.name);
}

function getTableColumns(db: Database, table: string): string[] {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
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
    expect(getTableColumns(db, 'registered_groups')).toContain(
      'discord_bot_id',
    );
    expect(getTableColumns(db, 'registered_groups')).not.toContain(
      'stream_intermediates',
    );
    expect(getTableColumns(db, 'channel_routes')).toContain('discord_bot_id');
    expect(getTableColumns(db, 'channel_subscriptions')).toContain(
      'channel_jid',
    );
    expect(getTableColumns(db, 'channel_subscriptions')).toContain('agent_id');
    expect(getTableColumns(db, 'agent_health')).toContain('agent_id');
    expect(getTableColumns(db, 'agent_health')).toContain('is_online');
    expect(getTableColumns(db, 'agent_health')).toContain('capabilities');
    expect(getTableColumns(db, 'pending_session_intents')).toContain(
      'group_folder',
    );
    expect(getTableColumns(db, 'pending_session_intents')).toContain(
      'fork_from',
    );
    expect(getTableColumns(db, 'pending_session_intents')).toContain('name');

    // Verify default values applied to existing rows
    const agents = db
      .query('SELECT id, agent_runtime FROM agents ORDER BY id')
      .all() as Array<{ id: string; agent_runtime: string | null }>;
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
    expect(getTableColumns(db, 'registered_groups')).toContain(
      'discord_bot_id',
    );
    expect(getTableColumns(db, 'registered_groups')).not.toContain(
      'stream_intermediates',
    );
    expect(getTableColumns(db, 'channel_routes')).toContain('discord_bot_id');
    expect(getTableColumns(db, 'channel_subscriptions')).toContain(
      'channel_jid',
    );
    expect(getTableColumns(db, 'channel_subscriptions')).toContain('agent_id');
    expect(getTableColumns(db, 'agent_health')).toContain('agent_id');
    expect(getTableColumns(db, 'agent_health')).toContain('is_online');
    expect(getTableColumns(db, 'agent_health')).toContain('capabilities');
    expect(getTableColumns(db, 'pending_session_intents')).toContain(
      'group_folder',
    );
    expect(getTableColumns(db, 'pending_session_intents')).toContain(
      'fork_from',
    );
    expect(getTableColumns(db, 'pending_session_intents')).toContain('name');

    // Write an agent with opencode runtime
    db.query(
      `
      INSERT INTO agents (id, name, folder, backend, agent_runtime, is_admin, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'test',
      'Test Agent',
      'test',
      'apple-container',
      'opencode',
      0,
      '2026-01-01T00:00:00.000Z',
    );

    const row = db
      .query('SELECT agent_runtime FROM agents WHERE id = ?')
      .get('test') as { agent_runtime: string };
    expect(row.agent_runtime).toBe('opencode');

    db.close();
  });

  it('migrates existing channel_routes into channel_subscriptions idempotently', () => {
    const db = new Database(':memory:');
    seedLegacyObservedSchema(db);

    // Seed routes that reflect local observed state shape:
    // single-agent routes with Discord guild IDs and mixed timestamps.
    db.query(
      `
      INSERT INTO channel_routes (channel_jid, agent_id, trigger_pattern, requires_trigger, discord_guild_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'dc:940321040482074705',
      'clayton-discord',
      '@Omni',
      1,
      '753336633083953213',
      '2026-02-11T17:54:36.399Z',
    );
    db.query(
      `
      INSERT INTO channel_routes (channel_jid, agent_id, trigger_pattern, requires_trigger, discord_guild_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'dc:1475568899452964874',
      'clayton-discord',
      '@Omni',
      1,
      '753336633083953213',
      '2026-02-23 19:17:03',
    );
    db.query(
      `
      INSERT INTO channel_routes (channel_jid, agent_id, trigger_pattern, requires_trigger, discord_guild_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'dc:1475601379400745101',
      'clayton-discord',
      '@Omni',
      1,
      '753336633083953213',
      '2026-02-23 21:15:03',
    );

    // Seed matching agent id so FK exists in migrated table.
    db.query(
      `
      INSERT INTO agents (id, name, description, folder, backend, container_config, heartbeat, is_admin, is_local, server_folder, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'clayton-discord',
      'Ditto Discord',
      'discord agent',
      'clayton-discord',
      'apple-container',
      null,
      null,
      0,
      1,
      null,
      '2026-02-11T17:54:36.399Z',
    );

    createSchema(db);

    const migratedRows = db
      .query(
        `
      SELECT channel_jid, agent_id, trigger_pattern, requires_trigger, priority, is_primary, discord_guild_id
      FROM channel_subscriptions
      ORDER BY channel_jid
    `,
      )
      .all() as Array<{
      channel_jid: string;
      agent_id: string;
      trigger_pattern: string;
      requires_trigger: number;
      priority: number;
      is_primary: number;
      discord_guild_id: string | null;
    }>;

    expect(migratedRows).toHaveLength(3);
    for (const row of migratedRows) {
      expect(row.agent_id).toBe('clayton-discord');
      expect(row.trigger_pattern).toBe('@Omni');
      expect(row.requires_trigger).toBe(1);
      expect(row.priority).toBe(100);
      expect(row.is_primary).toBe(1);
      expect(row.discord_guild_id).toBe('753336633083953213');
    }

    const marker = db
      .query(
        `
      SELECT value FROM router_state WHERE key = 'channel_subscriptions_migrated'
    `,
      )
      .get() as { value: string };
    expect(marker.value).toBe('1');

    // Idempotency: running migration again should not duplicate subscription rows.
    createSchema(db);
    const countAfterSecondRun = db
      .query(
        `
      SELECT COUNT(*) AS cnt FROM channel_subscriptions
    `,
      )
      .get() as { cnt: number };
    expect(countAfterSecondRun.cnt).toBe(3);

    db.close();
  });

  it('adds agent_context_folder to agents and channel_folder/category_folder to channel_subscriptions', () => {
    const db = new Database(':memory:');
    seedLegacyObservedSchema(db);

    // Verify legacy schema does NOT have the new columns
    const agentColsBefore = getAgentColumns(db);
    expect(agentColsBefore).not.toContain('agent_context_folder');

    // Run migration
    createSchema(db);

    // agents table should have agent_context_folder
    const agentCols = getAgentColumns(db);
    expect(agentCols).toContain('agent_context_folder');

    // channel_subscriptions should have channel_folder and category_folder
    const subCols = getTableColumns(db, 'channel_subscriptions');
    expect(subCols).toContain('channel_folder');
    expect(subCols).toContain('category_folder');

    // New columns should default to NULL for existing rows
    const agents = db
      .query('SELECT id, agent_context_folder FROM agents ORDER BY id')
      .all() as Array<{ id: string; agent_context_folder: string | null }>;
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(agent.agent_context_folder).toBeNull();
    }

    db.close();
  });

  it('persists and reads back new context folder fields', () => {
    const db = new Database(':memory:');
    createSchema(db);

    // Insert an agent with agent_context_folder
    db.query(
      `INSERT INTO agents (id, name, folder, backend, agent_runtime, is_admin, created_at, agent_context_folder)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'peytonomi-discord',
      'PeytonOmni',
      'peytonomi-discord',
      'apple-container',
      'claude-agent-sdk',
      0,
      '2026-01-01T00:00:00.000Z',
      'agents/peytonomi',
    );

    const agentRow = db
      .query('SELECT agent_context_folder FROM agents WHERE id = ?')
      .get('peytonomi-discord') as { agent_context_folder: string | null };
    expect(agentRow.agent_context_folder).toBe('agents/peytonomi');

    // Insert a subscription with channel_folder and category_folder
    db.query(
      `INSERT INTO channel_subscriptions
       (channel_jid, agent_id, trigger_pattern, requires_trigger, priority, is_primary, created_at, channel_folder, category_folder)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'dc:111222333',
      'peytonomi-discord',
      '@PeytonOmni',
      1,
      100,
      1,
      '2026-01-01T00:00:00.000Z',
      'servers/omni-aura/ditto-assistant/spec',
      'servers/omni-aura/ditto-assistant',
    );

    const subRow = db
      .query(
        'SELECT channel_folder, category_folder FROM channel_subscriptions WHERE channel_jid = ?',
      )
      .get('dc:111222333') as {
      channel_folder: string | null;
      category_folder: string | null;
    };
    expect(subRow.channel_folder).toBe(
      'servers/omni-aura/ditto-assistant/spec',
    );
    expect(subRow.category_folder).toBe('servers/omni-aura/ditto-assistant');

    // Verify NULL is accepted (backward compat)
    db.query(
      `INSERT INTO channel_subscriptions
       (channel_jid, agent_id, trigger_pattern, requires_trigger, priority, is_primary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'dc:444555666',
      'peytonomi-discord',
      '@PeytonOmni',
      1,
      100,
      0,
      '2026-01-01T00:00:00.000Z',
    );

    const nullRow = db
      .query(
        'SELECT channel_folder, category_folder FROM channel_subscriptions WHERE channel_jid = ?',
      )
      .get('dc:444555666') as {
      channel_folder: string | null;
      category_folder: string | null;
    };
    expect(nullRow.channel_folder).toBeNull();
    expect(nullRow.category_folder).toBeNull();

    db.close();
  });

  it('migrates a realistic multi-agent multi-channel setup', () => {
    // Mirrors the real upgrade scenario: one Discord bot with several channels
    // spread across two agents, plus several legacy-only registered_groups that
    // have no channel_routes entry (manual/older channels never routed through
    // the new system). After migration every channel_route should become a
    // channel_subscription; legacy-only channels must not appear.
    const db = new Database(':memory:');
    seedLegacyObservedSchema(db);

    // Two agents in the agents table
    const insertAgent = db.prepare(`
      INSERT INTO agents (id, name, description, folder, backend, container_config, heartbeat, is_admin, is_local, server_folder, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertAgent.run(
      'clayton-discord',
      'Ditto Discord',
      'frontend/backend',
      'clayton-discord',
      'apple-container',
      null,
      null,
      0,
      1,
      'servers/omni-aura',
      '2026-02-11T17:54:36.399Z',
    );
    insertAgent.run(
      'landing-astro-discord',
      'Landing Astro',
      '',
      'landing-astro-discord',
      'apple-container',
      null,
      null,
      0,
      1,
      'servers/omni-aura',
      '2026-02-20T00:00:00.000Z',
    );

    // Seven registered_groups — the full legacy table a typical upgrader would have.
    // Some have channel_routes; others are legacy-only (no routes).
    // discord_bot_id doesn't exist yet — it's added by the migration itself
    const insertGroup = db.prepare(`
      INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger, discord_guild_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const GUILD = '753336633083953213';
    // Channels that DO have routes
    insertGroup.run(
      'dc:940321040482074705',
      'Ditto Discord',
      'clayton-discord',
      '@PeytonOmni',
      '2026-02-11T00:00:00.000Z',
      1,
      GUILD,
    );
    insertGroup.run(
      'dc:1475568899452964874',
      'Spec',
      'spec-discord',
      '@PeytonOmni',
      '2026-02-20T00:00:00.000Z',
      1,
      GUILD,
    );
    insertGroup.run(
      'dc:1475601379400745101',
      'Backend',
      'backend-discord',
      '@PeytonOmni',
      '2026-02-20T00:00:00.000Z',
      1,
      GUILD,
    );
    insertGroup.run(
      'dc:1475576563176181964',
      'Landing Astro',
      'landing-astro-discord',
      '@PeytonOmni',
      '2026-02-20T00:00:00.000Z',
      1,
      GUILD,
    );
    // Channels with NO routes (legacy-only, never migrated)
    insertGroup.run(
      'dc:1474995286903361772',
      'Agentflow',
      'agentflow-discord',
      '@PeytonOmni',
      '2026-02-15T00:00:00.000Z',
      1,
      GUILD,
    );
    insertGroup.run(
      'dc:1475009887846010963',
      'OmniClaw',
      'omniclaw-discord',
      '@PeytonOmni',
      '2026-02-15T00:00:00.000Z',
      1,
      GUILD,
    );
    insertGroup.run(
      'dc:1475934713461080116',
      'Solid Grab',
      'solid-grab-discord',
      '@PeytonOmni',
      '2026-02-15T00:00:00.000Z',
      1,
      GUILD,
    );

    // channel_routes: clayton-discord owns 3 channels, landing-astro-discord owns 1
    const insertRoute = db.prepare(`
      INSERT INTO channel_routes (channel_jid, agent_id, trigger_pattern, requires_trigger, discord_guild_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertRoute.run(
      'dc:940321040482074705',
      'clayton-discord',
      '@PeytonOmni',
      1,
      GUILD,
      '2026-02-11T17:54:36.399Z',
    );
    insertRoute.run(
      'dc:1475568899452964874',
      'clayton-discord',
      '@PeytonOmni',
      1,
      GUILD,
      '2026-02-23 19:17:03',
    );
    insertRoute.run(
      'dc:1475601379400745101',
      'clayton-discord',
      '@PeytonOmni',
      1,
      GUILD,
      '2026-02-23 21:15:03',
    );
    insertRoute.run(
      'dc:1475576563176181964',
      'landing-astro-discord',
      '@PeytonOmni',
      1,
      GUILD,
      '2026-02-24 00:00:00',
    );

    createSchema(db);

    type SubRow = {
      channel_jid: string;
      agent_id: string;
      trigger_pattern: string;
      requires_trigger: number;
      priority: number;
      is_primary: number;
      discord_guild_id: string | null;
    };

    const subs = db
      .query(
        `
        SELECT channel_jid, agent_id, trigger_pattern, requires_trigger, priority, is_primary, discord_guild_id
        FROM channel_subscriptions
        ORDER BY channel_jid, agent_id
      `,
      )
      .all() as SubRow[];

    // Exactly 4 rows — one per route. Legacy-only channels must not appear.
    expect(subs).toHaveLength(4);

    // Every migrated row should be marked primary with correct defaults
    for (const row of subs) {
      expect(row.trigger_pattern).toBe('@PeytonOmni');
      expect(row.requires_trigger).toBe(1);
      expect(row.priority).toBe(100);
      expect(row.is_primary).toBe(1);
      expect(row.discord_guild_id).toBe(GUILD);
    }

    // Each agent owns the right channels
    const byChannel = Object.fromEntries(
      subs.map((r) => [r.channel_jid, r.agent_id]),
    );
    expect(byChannel['dc:940321040482074705']).toBe('clayton-discord');
    expect(byChannel['dc:1475568899452964874']).toBe('clayton-discord');
    expect(byChannel['dc:1475601379400745101']).toBe('clayton-discord');
    expect(byChannel['dc:1475576563176181964']).toBe('landing-astro-discord');

    // Legacy-only channels must NOT have leaked into channel_subscriptions
    const legacyJids = [
      'dc:1474995286903361772',
      'dc:1475009887846010963',
      'dc:1475934713461080116',
    ];
    for (const jid of legacyJids) {
      expect(byChannel[jid]).toBeUndefined();
    }

    // Migration marker set
    const marker = db
      .query(
        `SELECT value FROM router_state WHERE key = 'channel_subscriptions_migrated'`,
      )
      .get() as { value: string };
    expect(marker.value).toBe('1');

    // Idempotency
    createSchema(db);
    const count = db
      .query('SELECT COUNT(*) AS cnt FROM channel_subscriptions')
      .get() as { cnt: number };
    expect(count.cnt).toBe(4);

    db.close();
  });
});

describe('versioned migration framework', () => {
  it('stamps schema_version on fresh database', () => {
    const db = new Database(':memory:');
    runMigrations(db, allMigrations);

    const version = getSchemaVersion(db);
    expect(version).toBe(BASELINE_VERSION);

    // Verify the schema_version table has exactly one row
    const row = db.prepare('SELECT * FROM schema_version').get() as {
      id: number;
      version: number;
    };
    expect(row.id).toBe(1);
    expect(row.version).toBe(BASELINE_VERSION);

    db.close();
  });

  it('handles existing DB with old schema — adds missing columns', () => {
    const db = new Database(':memory:');

    // Simulate existing DB with old schema (missing agent_runtime, etc.)
    db.exec(`
      CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT);
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        folder TEXT NOT NULL UNIQUE, backend TEXT NOT NULL DEFAULT 'apple-container',
        container_config TEXT, is_admin INTEGER NOT NULL DEFAULT 0,
        server_folder TEXT, created_at TEXT NOT NULL
      );
    `);

    // Insert data to prove it survives
    db.exec(
      "INSERT INTO router_state (key, value) VALUES ('test_key', 'test_val')",
    );
    db.exec(
      "INSERT INTO agents (id, name, folder, backend, is_admin, created_at) VALUES ('a1', 'Agent', 'a1', 'apple-container', 0, '2026-01-01')",
    );

    runMigrations(db, allMigrations);

    // Should be at baseline version
    expect(getSchemaVersion(db)).toBe(BASELINE_VERSION);

    // Existing data should survive
    const row = db
      .prepare("SELECT value FROM router_state WHERE key = 'test_key'")
      .get() as { value: string };
    expect(row.value).toBe('test_val');

    // Missing columns should have been added
    const agentCols = db.query('PRAGMA table_info(agents)').all() as Array<{
      name: string;
    }>;
    const colNames = agentCols.map((c) => c.name);
    expect(colNames).toContain('agent_runtime');
    expect(colNames).toContain('agent_context_folder');
    expect(colNames).toContain('avatar_url');

    // Chats should have discord_guild_id added
    const chatCols = db.query('PRAGMA table_info(chats)').all() as Array<{
      name: string;
    }>;
    expect(chatCols.map((c) => c.name)).toContain('discord_guild_id');

    db.close();
  });

  it('runs only pending migrations on stamped DB', () => {
    const db = new Database(':memory:');
    runMigrations(db, allMigrations);
    expect(getSchemaVersion(db)).toBe(BASELINE_VERSION);

    // Define a new migration beyond baseline
    const extraMigration: Migration = {
      version: BASELINE_VERSION + 1,
      description: 'Add test_column to chats',
      up: (d) => {
        d.exec('ALTER TABLE chats ADD COLUMN test_col TEXT');
      },
    };

    runMigrations(db, [...allMigrations, extraMigration]);
    expect(getSchemaVersion(db)).toBe(BASELINE_VERSION + 1);

    // Verify column was added
    const cols = db.query('PRAGMA table_info(chats)').all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toContain('test_col');

    db.close();
  });

  it('adds preprocess_script to databases already stamped at version 4', () => {
    const db = new Database(':memory:');
    runMigrations(
      db,
      allMigrations.filter((migration) => migration.version <= 4),
    );
    db.exec('ALTER TABLE scheduled_tasks DROP COLUMN preprocess_script');
    expect(getSchemaVersion(db)).toBe(4);

    const beforeCols = db
      .query('PRAGMA table_info(scheduled_tasks)')
      .all() as Array<{
      name: string;
    }>;
    expect(beforeCols.map((c) => c.name)).not.toContain('preprocess_script');

    runMigrations(db, allMigrations);

    const afterCols = db
      .query('PRAGMA table_info(scheduled_tasks)')
      .all() as Array<{
      name: string;
    }>;
    expect(getSchemaVersion(db)).toBe(BASELINE_VERSION);
    expect(afterCols.map((c) => c.name)).toContain('preprocess_script');

    db.close();
  });

  it('is idempotent — running twice is safe', () => {
    const db = new Database(':memory:');
    runMigrations(db, allMigrations);
    const v1 = getSchemaVersion(db);

    runMigrations(db, allMigrations);
    const v2 = getSchemaVersion(db);

    expect(v1).toBe(v2);
    expect(v2).toBe(BASELINE_VERSION);

    db.close();
  });

  it('creates all expected tables on fresh DB', () => {
    const db = new Database(':memory:');
    runMigrations(db, allMigrations);

    const tables = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    const expected = [
      'agent_health',
      'agents',
      'channel_routes',
      'channel_subscriptions',
      'chats',
      'discovery_peers',
      'github_webhook_deliveries',
      'guild_rosters',
      'guilds',
      'messages',
      'pair_requests',
      'registered_groups',
      'router_state',
      'scheduled_tasks',
      'schema_version',
      'sessions',
      'task_run_logs',
      'task_run_phase_events',
    ];

    for (const name of expected) {
      expect(tableNames).toContain(name);
    }

    db.close();
  });

  it('applies migrations in version order regardless of input order', () => {
    const db = new Database(':memory:');

    let executionOrder: number[] = [];
    const m1: Migration = {
      version: 1,
      description: 'First',
      up: () => {
        executionOrder.push(1);
      },
    };
    const m2: Migration = {
      version: 2,
      description: 'Second',
      up: (d) => {
        executionOrder.push(2);
        d.exec(
          'CREATE TABLE IF NOT EXISTS test_order (id INTEGER PRIMARY KEY)',
        );
      },
    };
    const m3: Migration = {
      version: 3,
      description: 'Third',
      up: () => {
        executionOrder.push(3);
      },
    };

    // Pass in reverse order — runner should sort them
    runMigrations(db, [m3, m1, m2]);

    expect(executionOrder).toEqual([1, 2, 3]);
    expect(getSchemaVersion(db)).toBe(3);

    db.close();
  });

  it('rolls back entire batch when a migration fails', () => {
    const db = new Database(':memory:');

    // First, apply baseline so we have tables to work with
    runMigrations(db, allMigrations);
    expect(getSchemaVersion(db)).toBe(BASELINE_VERSION);

    const failingMigration: Migration = {
      version: BASELINE_VERSION + 1,
      description: 'Add good_col to chats',
      up: (d) => {
        d.exec('ALTER TABLE chats ADD COLUMN good_col TEXT');
      },
    };
    const crashingMigration: Migration = {
      version: BASELINE_VERSION + 2,
      description: 'This one throws',
      up: () => {
        throw new Error('intentional test failure');
      },
    };

    expect(() =>
      runMigrations(db, [
        ...allMigrations,
        failingMigration,
        crashingMigration,
      ]),
    ).toThrow('intentional test failure');

    // Version should remain at baseline — the entire batch rolled back
    expect(getSchemaVersion(db)).toBe(BASELINE_VERSION);

    // good_col should NOT exist (rolled back)
    const cols = db.query('PRAGMA table_info(chats)').all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).not.toContain('good_col');

    db.close();
  });

  it('skips already-applied migrations', () => {
    const db = new Database(':memory:');

    // Run baseline + extra migration
    const extraMigration: Migration = {
      version: BASELINE_VERSION + 1,
      description: 'Add extra_col to chats',
      up: (d) => {
        d.exec('ALTER TABLE chats ADD COLUMN extra_col TEXT');
      },
    };
    const allWithExtra = [...allMigrations, extraMigration];
    runMigrations(db, allWithExtra);
    expect(getSchemaVersion(db)).toBe(BASELINE_VERSION + 1);

    // Running again should not fail (migration already applied)
    runMigrations(db, allWithExtra);
    expect(getSchemaVersion(db)).toBe(BASELINE_VERSION + 1);

    db.close();
  });
});
