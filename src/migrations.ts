import { Database } from 'bun:sqlite';

import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Migration framework types
// ---------------------------------------------------------------------------

export interface Migration {
  version: number;
  description: string;
  up: (db: Database) => void;
}

/**
 * The version that represents the latest schema. Existing databases that
 * predate the migration framework are advanced through every migration to this.
 */
export const BASELINE_VERSION = 3;

// ---------------------------------------------------------------------------
// Schema helpers (available for use in migrations)
// ---------------------------------------------------------------------------

/** Add a column to a table if it doesn't already exist. */
export function addColumnIfNotExists(
  database: Database,
  table: string,
  column: string,
  type: string,
  defaultValue?: string,
): void {
  try {
    const def = defaultValue !== undefined ? ` DEFAULT ${defaultValue}` : '';
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}${def}`);
  } catch (err) {
    const message = (
      err instanceof Error ? err.message : String(err)
    ).toLowerCase();
    if (
      message.includes('duplicate column name') ||
      message.includes('already exists')
    ) {
      return;
    }
    throw err;
  }
}

/** Drop a column from a table if it exists. */
export function dropColumnIfExists(
  database: Database,
  table: string,
  column: string,
): void {
  try {
    const rows = database.query(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (!rows.some((row) => row.name === column)) return;
    database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  } catch (err) {
    logger.warn(
      {
        table,
        column,
        err: err instanceof Error ? err.message : String(err),
      },
      'Failed to drop legacy column',
    );
  }
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/** Read the current schema version. Returns 0 if no tracking table exists. */
export function getSchemaVersion(database: Database): number {
  try {
    const row = database.prepare('SELECT version FROM schema_version').get() as
      | { version: number }
      | undefined;
    return row?.version ?? 0;
  } catch {
    return 0; // table doesn't exist yet
  }
}

function ensureVersionTable(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function setSchemaVersion(database: Database, version: number): void {
  database
    .prepare(
      `INSERT OR REPLACE INTO schema_version (id, version, updated_at)
     VALUES (1, ?, datetime('now'))`,
    )
    .run(version);
}

/**
 * Apply all pending migrations inside a single exclusive transaction. The
 * exclusive lock prevents concurrent processes from reading the same version
 * and both attempting the same migration. If any migration fails, the entire
 * batch is rolled back to the version before `runMigrations` was called.
 */
export function runMigrations(
  database: Database,
  migrations: Migration[],
): void {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  database.exec('BEGIN EXCLUSIVE');
  try {
    ensureVersionTable(database);
    const currentVersion = getSchemaVersion(database);

    const pending = sorted.filter((m) => m.version > currentVersion);
    if (pending.length === 0) {
      database.exec('COMMIT');
      return;
    }

    for (const m of pending) {
      logger.info(
        { version: m.version, description: m.description },
        'Applying database migration',
      );
      m.up(database);
      setSchemaVersion(database, m.version);
    }
    database.exec('COMMIT');
  } catch (e) {
    database.exec('ROLLBACK');
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Migration 1: Baseline — full current schema
// ---------------------------------------------------------------------------

/**
 * The baseline migration creates all tables with their full current column
 * sets (for fresh databases) and adds any missing columns to existing tables
 * (for databases that predate the migration framework). The
 * addColumnIfNotExists calls are no-ops on fresh databases since the columns
 * are already in the CREATE TABLE statements.
 */
const migration1: Migration = {
  version: 1,
  description: 'Baseline schema — all tables with current columns',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY,
        name TEXT,
        last_message_time TEXT,
        discord_guild_id TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT,
        chat_jid TEXT,
        sender TEXT,
        sender_name TEXT,
        content TEXT,
        timestamp TEXT,
        is_from_me INTEGER,
        sender_user_id TEXT,
        sender_platform TEXT,
        mentions TEXT,
        PRIMARY KEY (id, chat_jid),
        FOREIGN KEY (chat_jid) REFERENCES chats(jid)
      );
      CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

      CREATE TABLE IF NOT EXISTS guild_rosters (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        display_name TEXT NOT NULL,
        is_bot INTEGER NOT NULL DEFAULT 0,
        roles TEXT,
        last_synced TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_roster_guild ON guild_rosters(guild_id);

      CREATE TABLE IF NOT EXISTS guilds (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_id TEXT,
        member_count INTEGER,
        last_synced TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        group_folder TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        schedule_value TEXT NOT NULL,
        next_run TEXT,
        last_run TEXT,
        last_result TEXT,
        status TEXT DEFAULT 'active',
        created_at TEXT NOT NULL,
        context_mode TEXT DEFAULT 'isolated',
        executing_since TEXT,
        last_outcome_state TEXT,
        last_outcome_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
      CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

      CREATE TABLE IF NOT EXISTS task_run_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        run_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        outcome_state TEXT,
        outcome_reason TEXT,
        outcome_question TEXT,
        FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

      CREATE TABLE IF NOT EXISTS task_run_phase_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        run_at TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        phase TEXT NOT NULL,
        event_at TEXT NOT NULL,
        status TEXT NOT NULL,
        retryable INTEGER NOT NULL,
        error TEXT,
        FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_run_phase_events
        ON task_run_phase_events(task_id, run_at, sequence);

      CREATE TABLE IF NOT EXISTS router_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_github_webhook_deliveries_expires_at
        ON github_webhook_deliveries(expires_at);

      CREATE TABLE IF NOT EXISTS sessions (
        group_folder TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
        discord_bot_id TEXT,
        discord_guild_id TEXT,
        server_folder TEXT,
        backend TEXT,
        description TEXT,
        auto_respond_to_questions INTEGER DEFAULT 0,
        auto_respond_keywords TEXT
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        folder TEXT NOT NULL UNIQUE,
        backend TEXT NOT NULL DEFAULT 'apple-container',
        agent_runtime TEXT DEFAULT 'claude-agent-sdk',
        container_config TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0,
        server_folder TEXT,
        created_at TEXT NOT NULL,
        agent_context_folder TEXT,
        roster_role_filters TEXT,
        avatar_url TEXT,
        avatar_source TEXT
      );

      CREATE TABLE IF NOT EXISTS channel_routes (
        channel_jid TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        trigger_pattern TEXT NOT NULL,
        requires_trigger INTEGER NOT NULL DEFAULT 1,
        discord_bot_id TEXT,
        discord_guild_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_channel_routes_agent
        ON channel_routes(agent_id);

      CREATE TABLE IF NOT EXISTS channel_subscriptions (
        channel_jid TEXT NOT NULL,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        trigger_pattern TEXT NOT NULL,
        requires_trigger INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 100,
        is_primary INTEGER NOT NULL DEFAULT 0,
        discord_bot_id TEXT,
        discord_guild_id TEXT,
        created_at TEXT NOT NULL,
        channel_folder TEXT,
        category_folder TEXT,
        PRIMARY KEY (channel_jid, agent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_channel_subscriptions_channel
        ON channel_subscriptions(channel_jid, priority, created_at);
      CREATE INDEX IF NOT EXISTS idx_channel_subscriptions_agent
        ON channel_subscriptions(agent_id);

      CREATE TABLE IF NOT EXISTS agent_health (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        is_online INTEGER NOT NULL DEFAULT 0,
        last_heartbeat_at TEXT,
        updated_at TEXT NOT NULL,
        capabilities TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_health_updated_at
        ON agent_health(updated_at);

      CREATE TABLE IF NOT EXISTS discovery_peers (
        instance_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        shared_secret TEXT,
        status TEXT NOT NULL DEFAULT 'discovered',
        host TEXT,
        port INTEGER,
        approved_at TEXT,
        last_seen TEXT,
        created_at TEXT NOT NULL,
        pairing_token TEXT,
        pairing_private_key TEXT
      );

      CREATE TABLE IF NOT EXISTS pair_requests (
        id TEXT PRIMARY KEY,
        from_instance_id TEXT NOT NULL,
        from_name TEXT NOT NULL,
        from_host TEXT NOT NULL,
        from_port INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        shared_secret TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        callback_token TEXT,
        key_agreement_public_key TEXT
      );
    `);

    // --- Backward-compat column additions for existing databases ---
    // These are no-ops on fresh databases (columns already exist from
    // the CREATE TABLE statements above). On databases with old schemas,
    // they add any missing columns.

    // chats
    addColumnIfNotExists(db, 'chats', 'discord_guild_id', 'TEXT');

    // messages
    addColumnIfNotExists(db, 'messages', 'sender_user_id', 'TEXT');
    addColumnIfNotExists(db, 'messages', 'sender_platform', 'TEXT');
    addColumnIfNotExists(db, 'messages', 'mentions', 'TEXT');

    // sessions
    addColumnIfNotExists(
      db,
      'sessions',
      'created_at',
      'TEXT NOT NULL',
      "'1970-01-01 00:00:00'",
    );

    // scheduled_tasks
    addColumnIfNotExists(
      db,
      'scheduled_tasks',
      'context_mode',
      'TEXT',
      "'isolated'",
    );
    addColumnIfNotExists(db, 'scheduled_tasks', 'executing_since', 'TEXT');
    addColumnIfNotExists(db, 'scheduled_tasks', 'last_outcome_state', 'TEXT');
    addColumnIfNotExists(db, 'scheduled_tasks', 'last_outcome_reason', 'TEXT');

    // task_run_logs
    addColumnIfNotExists(db, 'task_run_logs', 'outcome_state', 'TEXT');
    addColumnIfNotExists(db, 'task_run_logs', 'outcome_reason', 'TEXT');
    addColumnIfNotExists(db, 'task_run_logs', 'outcome_question', 'TEXT');

    // registered_groups
    addColumnIfNotExists(db, 'registered_groups', 'heartbeat', 'TEXT');
    addColumnIfNotExists(db, 'registered_groups', 'discord_bot_id', 'TEXT');
    addColumnIfNotExists(db, 'registered_groups', 'discord_guild_id', 'TEXT');
    addColumnIfNotExists(db, 'registered_groups', 'server_folder', 'TEXT');
    addColumnIfNotExists(db, 'registered_groups', 'backend', 'TEXT');
    addColumnIfNotExists(db, 'registered_groups', 'description', 'TEXT');
    addColumnIfNotExists(
      db,
      'registered_groups',
      'auto_respond_to_questions',
      'INTEGER',
      '0',
    );
    addColumnIfNotExists(
      db,
      'registered_groups',
      'auto_respond_keywords',
      'TEXT',
    );
    dropColumnIfExists(db, 'registered_groups', 'stream_intermediates');

    // agents
    addColumnIfNotExists(
      db,
      'agents',
      'agent_runtime',
      'TEXT',
      "'claude-agent-sdk'",
    );
    addColumnIfNotExists(db, 'agents', 'agent_context_folder', 'TEXT');
    addColumnIfNotExists(db, 'agents', 'roster_role_filters', 'TEXT');
    addColumnIfNotExists(db, 'agents', 'avatar_url', 'TEXT');
    addColumnIfNotExists(db, 'agents', 'avatar_source', 'TEXT');

    // channel_routes
    addColumnIfNotExists(db, 'channel_routes', 'discord_bot_id', 'TEXT');

    // channel_subscriptions
    addColumnIfNotExists(db, 'channel_subscriptions', 'channel_folder', 'TEXT');
    addColumnIfNotExists(
      db,
      'channel_subscriptions',
      'category_folder',
      'TEXT',
    );

    // discovery_peers
    addColumnIfNotExists(db, 'discovery_peers', 'pairing_token', 'TEXT');
    addColumnIfNotExists(db, 'discovery_peers', 'pairing_private_key', 'TEXT');

    // pair_requests
    addColumnIfNotExists(db, 'pair_requests', 'callback_token', 'TEXT');
    addColumnIfNotExists(
      db,
      'pair_requests',
      'key_agreement_public_key',
      'TEXT',
    );

    // Heartbeat feature removed — clear any lingering config.
    // Split into separate try/catch blocks so an error on one table
    // doesn't mask a real error on the other.
    try {
      db.exec(
        `UPDATE registered_groups SET heartbeat = NULL WHERE heartbeat IS NOT NULL`,
      );
    } catch {
      // column may not exist on very old DBs
    }
    try {
      db.exec(`UPDATE agents SET heartbeat = NULL WHERE heartbeat IS NOT NULL`);
    } catch {
      // agents table never had heartbeat in the inline CREATE TABLE —
      // only pre-migration DBs have it, so this is expected on fresh DBs
    }
  },
};

const migration2: Migration = {
  version: 2,
  description: 'Persist per-agent Discord command filters',
  up: (db) => {
    addColumnIfNotExists(db, 'registered_groups', 'discord_commands', 'TEXT');
  },
};

const migration3: Migration = {
  version: 3,
  description: 'Persist factory workflow handoffs and active claims',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS factory_handoff_records (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        source_issue TEXT,
        source_pr TEXT,
        phase TEXT NOT NULL,
        owner_agent_id TEXT NOT NULL,
        driver TEXT NOT NULL,
        intent TEXT NOT NULL,
        summary TEXT NOT NULL,
        body TEXT NOT NULL,
        decisions_json TEXT NOT NULL DEFAULT '[]',
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        blockers_json TEXT NOT NULL DEFAULT '[]',
        next_driver TEXT,
        next_scope TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_factory_handoffs_workflow
        ON factory_handoff_records(workflow_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_factory_handoffs_repo_issue
        ON factory_handoff_records(repo, source_issue, created_at DESC);

      CREATE TABLE IF NOT EXISTS factory_workflow_claims (
        workflow_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        owner_agent_id TEXT NOT NULL,
        owner_run_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_factory_claims_expires_at
        ON factory_workflow_claims(expires_at);
      CREATE INDEX IF NOT EXISTS idx_factory_claims_repo
        ON factory_workflow_claims(repo);
    `);
  },
};

// ---------------------------------------------------------------------------
// Migration registry
// ---------------------------------------------------------------------------

/**
 * All migrations in order. Future schema changes are added here as new
 * entries with incrementing version numbers. Each migration's `up` function
 * can use plain `ALTER TABLE` without try/catch — the version tracker
 * guarantees each migration runs exactly once.
 */
export const allMigrations: Migration[] = [migration1, migration2, migration3];
