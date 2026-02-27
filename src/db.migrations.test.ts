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
    expect(getTableColumns(db, 'channel_routes')).toContain('discord_bot_id');
    expect(getTableColumns(db, 'channel_subscriptions')).toContain(
      'channel_jid',
    );
    expect(getTableColumns(db, 'channel_subscriptions')).toContain('agent_id');

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
    expect(getTableColumns(db, 'channel_routes')).toContain('discord_bot_id');
    expect(getTableColumns(db, 'channel_subscriptions')).toContain(
      'channel_jid',
    );
    expect(getTableColumns(db, 'channel_subscriptions')).toContain('agent_id');

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
      'ditto-discord',
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
      'ditto-discord',
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
      'ditto-discord',
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
      'ditto-discord',
      'Ditto Discord',
      'discord agent',
      'ditto-discord',
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
      expect(row.agent_id).toBe('ditto-discord');
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
      'ditto-discord',
      'Ditto Discord',
      'frontend/backend',
      'ditto-discord',
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
      'ditto-discord',
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

    // channel_routes: ditto-discord owns 3 channels, landing-astro-discord owns 1
    const insertRoute = db.prepare(`
      INSERT INTO channel_routes (channel_jid, agent_id, trigger_pattern, requires_trigger, discord_guild_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertRoute.run(
      'dc:940321040482074705',
      'ditto-discord',
      '@PeytonOmni',
      1,
      GUILD,
      '2026-02-11T17:54:36.399Z',
    );
    insertRoute.run(
      'dc:1475568899452964874',
      'ditto-discord',
      '@PeytonOmni',
      1,
      GUILD,
      '2026-02-23 19:17:03',
    );
    insertRoute.run(
      'dc:1475601379400745101',
      'ditto-discord',
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
    expect(byChannel['dc:940321040482074705']).toBe('ditto-discord');
    expect(byChannel['dc:1475568899452964874']).toBe('ditto-discord');
    expect(byChannel['dc:1475601379400745101']).toBe('ditto-discord');
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
