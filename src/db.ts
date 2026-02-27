import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, STORE_DIR } from './config.js';
import { logger } from './logger.js';
import {
  Agent,
  ChannelRoute,
  ChannelSubscription,
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
  registeredGroupToAgent,
  registeredGroupToRoute,
} from './types.js';

let db: Database;

/** Row type for registered_groups table SELECT * queries */
interface RegisteredGroupRow {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  added_at: string;
  container_config: string | null;
  requires_trigger: number | null;
  discord_bot_id: string | null;
  discord_guild_id: string | null;
  server_folder: string | null;
  backend: string | null;
  description: string | null;
  auto_respond_to_questions: number | null;
  auto_respond_keywords: string | null;
  stream_intermediates: number | null;
}

/** Row type for agents table SELECT * queries */
interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  folder: string;
  backend: string;
  agent_runtime: string | null;
  container_config: string | null;
  is_admin: number;
  server_folder: string | null;
  created_at: string;
  agent_context_folder: string | null;
}

/** Row type for channel_routes table SELECT * queries */
interface ChannelRouteRow {
  channel_jid: string;
  agent_id: string;
  trigger_pattern: string;
  requires_trigger: number;
  discord_bot_id: string | null;
  discord_guild_id: string | null;
  created_at: string;
}

interface ChannelSubscriptionRow {
  channel_jid: string;
  agent_id: string;
  trigger_pattern: string;
  requires_trigger: number;
  priority: number;
  is_primary: number;
  discord_bot_id: string | null;
  discord_guild_id: string | null;
  created_at: string;
  channel_folder: string | null;
  category_folder: string | null;
}

/** Safely parse JSON, returning undefined on null input or parse error */
function safeJsonParse<T>(
  value: string | null,
  logContext: Record<string, string>,
  label: string,
): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    logger.warn(logContext, `Corrupt ${label} in DB, ignoring`);
    return undefined;
  }
}

const VALID_AGENT_RUNTIMES = new Set<Agent['agentRuntime']>([
  'claude-agent-sdk',
  'opencode',
]);

function normalizeAgentRuntime(
  value: string | null | undefined,
): Agent['agentRuntime'] {
  if (value && VALID_AGENT_RUNTIMES.has(value as Agent['agentRuntime'])) {
    return value as Agent['agentRuntime'];
  }
  return 'claude-agent-sdk';
}

/** Map a database row to a RegisteredGroup object (without jid field) */
function mapRowToRegisteredGroup(
  row: RegisteredGroupRow,
): Omit<RegisteredGroup, 'jid'> {
  return {
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: safeJsonParse(
      row.container_config,
      { jid: row.jid },
      'container_config',
    ),
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    discordBotId: row.discord_bot_id || undefined,
    discordGuildId: row.discord_guild_id || undefined,
    serverFolder: row.server_folder || undefined,
    backend: (row.backend as RegisteredGroup['backend']) || undefined,
    description: row.description || undefined,
    autoRespondToQuestions: row.auto_respond_to_questions === 1 || undefined,
    autoRespondKeywords: safeJsonParse<string[]>(
      row.auto_respond_keywords,
      { jid: row.jid },
      'auto_respond_keywords',
    ),
    streamIntermediates: row.stream_intermediates === 1 || undefined,
  };
}

/** Map a database row to an Agent object */
function mapRowToAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    description: row.description || undefined,
    folder: row.folder,
    backend: row.backend as Agent['backend'],
    agentRuntime: normalizeAgentRuntime(row.agent_runtime),
    containerConfig: safeJsonParse(
      row.container_config,
      { id: row.id },
      'agent container_config',
    ),
    isAdmin: row.is_admin === 1,
    serverFolder: row.server_folder || undefined,
    createdAt: row.created_at,
    agentContextFolder: row.agent_context_folder || undefined,
  };
}

/** Map a database row to a ChannelRoute object */
function mapRowToChannelRoute(row: ChannelRouteRow): ChannelRoute {
  return {
    channelJid: row.channel_jid,
    agentId: row.agent_id,
    trigger: row.trigger_pattern,
    requiresTrigger: row.requires_trigger === 1,
    discordBotId: row.discord_bot_id || undefined,
    discordGuildId: row.discord_guild_id || undefined,
    createdAt: row.created_at,
  };
}

function mapRowToChannelSubscription(
  row: ChannelSubscriptionRow,
): ChannelSubscription {
  return {
    channelJid: row.channel_jid,
    agentId: row.agent_id,
    trigger: row.trigger_pattern,
    requiresTrigger: row.requires_trigger === 1,
    priority: row.priority,
    isPrimary: row.is_primary === 1,
    discordBotId: row.discord_bot_id || undefined,
    discordGuildId: row.discord_guild_id || undefined,
    createdAt: row.created_at,
    channelFolder: row.channel_folder || undefined,
    categoryFolder: row.category_folder || undefined,
  };
}

/** Add a column to a table if it doesn't already exist (migration helper) */
function addColumnIfNotExists(
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

/** @internal exported for migration tests */
export function createSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

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
      created_at TEXT NOT NULL
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
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
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
      requires_trigger INTEGER DEFAULT 1
    );
  `);

  // Column migrations for existing DBs (addColumnIfNotExists is a no-op if column exists)
  addColumnIfNotExists(
    database,
    'scheduled_tasks',
    'context_mode',
    'TEXT',
    "'isolated'",
  );
  addColumnIfNotExists(database, 'registered_groups', 'heartbeat', 'TEXT');
  addColumnIfNotExists(database, 'registered_groups', 'discord_bot_id', 'TEXT');
  addColumnIfNotExists(
    database,
    'registered_groups',
    'discord_guild_id',
    'TEXT',
  );
  addColumnIfNotExists(database, 'registered_groups', 'server_folder', 'TEXT');
  addColumnIfNotExists(database, 'messages', 'sender_user_id', 'TEXT');
  addColumnIfNotExists(database, 'messages', 'mentions', 'TEXT');
  addColumnIfNotExists(database, 'chats', 'discord_guild_id', 'TEXT');
  // Note: SQLite ALTER TABLE requires constant defaults; new sessions get datetime('now') via INSERT in setSession().
  addColumnIfNotExists(
    database,
    'sessions',
    'created_at',
    'TEXT NOT NULL',
    "'1970-01-01 00:00:00'",
  );
  addColumnIfNotExists(database, 'registered_groups', 'backend', 'TEXT');
  addColumnIfNotExists(database, 'registered_groups', 'description', 'TEXT');
  addColumnIfNotExists(
    database,
    'registered_groups',
    'auto_respond_to_questions',
    'INTEGER',
    '0',
  );
  addColumnIfNotExists(
    database,
    'registered_groups',
    'auto_respond_keywords',
    'TEXT',
  );
  addColumnIfNotExists(
    database,
    'registered_groups',
    'stream_intermediates',
    'INTEGER',
    '0',
  );

  // Heartbeat feature removed — clear any existing heartbeat config so it doesn't
  // get re-created on startup (reconcileHeartbeats is also removed).
  try {
    database.exec(`
      UPDATE registered_groups SET heartbeat = NULL WHERE heartbeat IS NOT NULL;
      UPDATE agents SET heartbeat = NULL WHERE heartbeat IS NOT NULL;
    `);
  } catch {
    // columns may not exist on very old DBs — harmless
  }

  // --- Agent-Channel Decoupling tables ---
  database.exec(`
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
      created_at TEXT NOT NULL
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
    CREATE INDEX IF NOT EXISTS idx_channel_routes_agent ON channel_routes(agent_id);

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
      PRIMARY KEY (channel_jid, agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_subscriptions_channel
      ON channel_subscriptions(channel_jid, priority, created_at);
    CREATE INDEX IF NOT EXISTS idx_channel_subscriptions_agent
      ON channel_subscriptions(agent_id);
  `);

  addColumnIfNotExists(database, 'channel_routes', 'discord_bot_id', 'TEXT');

  // Migrate agents table for existing DBs
  addColumnIfNotExists(
    database,
    'agents',
    'agent_runtime',
    'TEXT',
    "'claude-agent-sdk'",
  );

  // New context layer columns (agent/server/category/channel architecture)
  addColumnIfNotExists(database, 'agents', 'agent_context_folder', 'TEXT');
  addColumnIfNotExists(
    database,
    'channel_subscriptions',
    'channel_folder',
    'TEXT',
  );
  addColumnIfNotExists(
    database,
    'channel_subscriptions',
    'category_folder',
    'TEXT',
  );

  // Auto-migrate from registered_groups → agents + channel_routes
  migrateRegisteredGroupsToAgents(database);
  migrateRoutesToSubscriptions(database);
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. Backdates a session's created_at timestamp. */
export function _backdateSessionForTest(
  groupJid: string,
  isoTimestamp: string,
): void {
  db.prepare('UPDATE sessions SET created_at = ? WHERE group_folder = ?').run(
    isoTimestamp,
    groupJid,
  );
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  discordGuildId?: string,
): void {
  // When name is provided, update it on conflict; otherwise preserve existing name
  const nameClause = name ? 'name = excluded.name,' : '';
  db.query(
    `
    INSERT INTO chats (jid, name, last_message_time, discord_guild_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET
      ${nameClause}
      last_message_time = MAX(last_message_time, excluded.last_message_time),
      discord_guild_id = COALESCE(excluded.discord_guild_id, discord_guild_id)
  `,
  ).run(chatJid, name || chatJid, timestamp, discordGuildId || null);
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.query(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get the Discord guild ID for a chat JID from stored metadata.
 */
export function getChatGuildId(chatJid: string): string | undefined {
  const row = db
    .prepare('SELECT discord_guild_id FROM chats WHERE jid = ?')
    .get(chatJid) as { discord_guild_id: string | null } | undefined;
  return row?.discord_guild_id || undefined;
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.query(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.query(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, sender_user_id, mentions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.sender_user_id ?? null,
    msg.mentions ? JSON.stringify(msg.mentions) : null,
  );
}

/** DB row type with nullable JSON fields that need conversion to NewMessage */
type MessageRow = NewMessage & {
  mentions: string | null;
  sender_user_id: string | null;
};

/** Convert a raw DB message row to a NewMessage (parse mentions JSON, null→undefined) */
function mapMessageRow(row: MessageRow): NewMessage {
  return {
    ...row,
    sender_user_id: row.sender_user_id ?? undefined,
    mentions: row.mentions ? JSON.parse(row.mentions) : undefined,
  };
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter out bot's own messages using is_from_me field
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, sender_user_id, mentions
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders}) AND (is_from_me IS NULL OR is_from_me = 0)
    ORDER BY timestamp
  `;

  const rows = db.prepare(sql).all(lastTimestamp, ...jids) as MessageRow[];

  let newTimestamp = lastTimestamp;
  const messages: NewMessage[] = rows.map((row) => {
    if (new Date(row.timestamp) > new Date(newTimestamp))
      newTimestamp = row.timestamp;
    return mapMessageRow(row);
  });

  return { messages, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
): NewMessage[] {
  // Filter out bot's own messages using is_from_me field
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, sender_user_id, mentions
    FROM messages
    WHERE chat_jid = ? AND timestamp > ? AND (is_from_me IS NULL OR is_from_me = 0)
    ORDER BY timestamp
  `;
  const rows = db.prepare(sql).all(chatJid, sinceTimestamp) as MessageRow[];
  return rows.map(mapMessageRow);
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.query(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.query('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  // SECURITY NOTE: Field names are hardcoded below (not user-controlled), making this safe from SQL injection.
  // All values use parameterized queries (?). If this logic changes to allow dynamic field selection,
  // ensure field names are validated against an allowlist.
  const fields: string[] = [];
  const values: (string | null)[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.query(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  // Wrap in transaction to ensure both deletes succeed or both roll back
  const transaction = db.transaction(() => {
    db.query('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
    db.query('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  });

  transaction();
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

/** Advance next_run without touching last_run/last_result (used before enqueue). */
export function advanceTaskNextRun(id: string, nextRun: string | null): void {
  db.query(
    `UPDATE scheduled_tasks SET next_run = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END WHERE id = ?`,
  ).run(nextRun, nextRun, id);
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.query(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  // Use SELECT ... WHERE EXISTS to skip gracefully if the task was deleted while running.
  db.query(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM scheduled_tasks WHERE id = ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
    log.task_id,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.query(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  // Only update created_at when the session ID actually changes (new session)
  const existing = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;

  if (existing && existing.session_id === sessionId) {
    return; // Same session, no update needed
  }

  db.query(
    "INSERT OR REPLACE INTO sessions (group_folder, session_id, created_at) VALUES (?, ?, datetime('now'))",
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

/**
 * Expire sessions older than maxAgeMs. Returns the folders that were expired.
 */
export function expireStaleSessions(maxAgeMs: number): string[] {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const stale = db
    .prepare('SELECT group_folder FROM sessions WHERE created_at < ?')
    .all(cutoff) as Array<{ group_folder: string }>;
  if (stale.length > 0) {
    db.query('DELETE FROM sessions WHERE created_at < ?').run(cutoff);
  }
  return stale.map((r) => r.group_folder);
}

// --- Registered group accessors ---

/** Look up a registered group by JID, with folder-name validation against path traversal. */
export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as RegisteredGroupRow | undefined;
  if (!row) return undefined;

  // Validate folder name against traversal attacks
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(row.folder)) {
    logger.warn(
      { jid, folder: row.folder },
      'Invalid folder name in database for registered group',
    );
    return undefined;
  }

  return { jid: row.jid, ...mapRowToRegisteredGroup(row) };
}

/** Insert or replace a registered group entry. */
export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  db.query(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, discord_bot_id, discord_guild_id, server_folder, backend, description, auto_respond_to_questions, auto_respond_keywords, stream_intermediates)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.discordBotId || null,
    group.discordGuildId || null,
    group.serverFolder || null,
    group.backend || null,
    group.description || null,
    group.autoRespondToQuestions ? 1 : 0,
    group.autoRespondKeywords
      ? JSON.stringify(group.autoRespondKeywords)
      : null,
    group.streamIntermediates ? 1 : 0,
  );
}

/** Return all registered groups keyed by JID, skipping entries with invalid folder names. */
export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db
    .prepare('SELECT * FROM registered_groups')
    .all() as RegisteredGroupRow[];
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    // Validate folder name against traversal attacks
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Invalid folder name in database for registered group',
      );
      continue;
    }

    result[row.jid] = mapRowToRegisteredGroup(row);
  }
  return result;
}

// --- Agent + ChannelRoute CRUD ---

function migrateRegisteredGroupsToAgents(database: Database): void {
  const migrationKey = 'registered_groups_to_agents_migrated';
  const migrationRow = database
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(migrationKey) as { value: string } | undefined;
  if (migrationRow?.value === '1') return;

  const agentCount = database
    .prepare('SELECT COUNT(*) as cnt FROM agents')
    .get() as { cnt: number };
  const routeCount = database
    .prepare('SELECT COUNT(*) as cnt FROM channel_routes')
    .get() as { cnt: number };

  // If both new tables already have data, treat legacy migration as complete.
  // This prevents legacy registered_groups rows from being re-imported into
  // already-migrated multi-channel setups.
  if (agentCount.cnt > 0 && routeCount.cnt > 0) {
    database
      .prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)')
      .run(migrationKey, '1');
    return;
  }

  // Read all registered_groups
  const rows = database
    .prepare('SELECT * FROM registered_groups')
    .all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    discord_bot_id: string | null;
    discord_guild_id: string | null;
    server_folder: string | null;
    backend: string | null;
    description: string | null;
  }>;

  if (rows.length === 0) {
    database
      .prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)')
      .run(migrationKey, '1');
    return;
  }

  const validRows = rows.filter((row) => {
    if (/^[a-z0-9][a-z0-9_-]*$/i.test(row.folder)) {
      return true;
    }
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping legacy migration row with invalid folder name',
    );
    return false;
  });

  // Group rows by folder to deduplicate (multiple JIDs can map to same folder)
  const agentsByFolder = new Map<string, (typeof rows)[number]>();
  for (const row of validRows) {
    if (!agentsByFolder.has(row.folder)) {
      agentsByFolder.set(row.folder, row);
    }
  }

  const insertAgent = database.prepare(`
    INSERT OR IGNORE INTO agents (id, name, description, folder, backend, agent_runtime, container_config, is_admin, server_folder, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertRoute = database.prepare(`
    INSERT OR IGNORE INTO channel_routes (channel_jid, agent_id, trigger_pattern, requires_trigger, discord_bot_id, discord_guild_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const [folder, row] of agentsByFolder) {
    const isMain = folder === 'main';
    const backend = row.backend || 'apple-container';

    insertAgent.run(
      folder, // id
      row.name,
      row.description,
      folder,
      backend,
      'claude-agent-sdk', // agent_runtime (default for migration)
      row.container_config,
      isMain ? 1 : 0, // is_admin
      row.server_folder,
      row.added_at,
    );
  }

  // Insert all routes (including multiple JIDs per agent)
  for (const row of validRows) {
    insertRoute.run(
      row.jid,
      row.folder, // agent_id = folder
      row.trigger_pattern,
      row.requires_trigger === null ? 1 : row.requires_trigger,
      row.discord_bot_id,
      row.discord_guild_id,
      row.added_at,
    );
  }

  database
    .prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)')
    .run(migrationKey, '1');
}

function migrateRoutesToSubscriptions(database: Database): void {
  const migrated = database
    .prepare(
      "SELECT value FROM router_state WHERE key = 'channel_subscriptions_migrated'",
    )
    .get() as { value: string } | undefined;
  if (migrated?.value === '1') return;

  const rows = database
    .prepare('SELECT * FROM channel_routes')
    .all() as ChannelRouteRow[];
  if (rows.length > 0) {
    const insertSub = database.prepare(`
      INSERT OR IGNORE INTO channel_subscriptions
      (channel_jid, agent_id, trigger_pattern, requires_trigger, priority, is_primary, discord_bot_id, discord_guild_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insertSub.run(
        row.channel_jid,
        row.agent_id,
        row.trigger_pattern,
        row.requires_trigger,
        100,
        1,
        row.discord_bot_id,
        row.discord_guild_id,
        row.created_at,
      );
    }
  }
  database
    .prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)')
    .run('channel_subscriptions_migrated', '1');
}

/** Look up an agent by ID, returning undefined if not found. */
export function getAgent(id: string): Agent | undefined {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as
    | AgentRow
    | undefined;
  if (!row) return undefined;
  return mapRowToAgent(row);
}

/** Return all agents keyed by agent ID. */
export function getAllAgents(): Record<string, Agent> {
  const rows = db.prepare('SELECT * FROM agents').all() as AgentRow[];
  const result: Record<string, Agent> = {};
  for (const row of rows) {
    result[row.id] = mapRowToAgent(row);
  }
  return result;
}

/** Insert or replace an agent record. */
export function setAgent(agent: Agent): void {
  db.query(
    `
    INSERT OR REPLACE INTO agents (id, name, description, folder, backend, agent_runtime, container_config, is_admin, server_folder, created_at, agent_context_folder)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    agent.id,
    agent.name,
    agent.description || null,
    agent.folder,
    agent.backend,
    normalizeAgentRuntime(agent.agentRuntime),
    agent.containerConfig ? JSON.stringify(agent.containerConfig) : null,
    agent.isAdmin ? 1 : 0,
    agent.serverFolder || null,
    agent.createdAt,
    agent.agentContextFolder || null,
  );
}

/** Look up a channel route by JID, returning undefined if not found. */
export function getChannelRoute(channelJid: string): ChannelRoute | undefined {
  const row = db
    .prepare('SELECT * FROM channel_routes WHERE channel_jid = ?')
    .get(channelJid) as ChannelRouteRow | undefined;
  if (!row) return undefined;
  return mapRowToChannelRoute(row);
}

/** Return all channel routes keyed by channel JID. */
export function getAllChannelRoutes(): Record<string, ChannelRoute> {
  const rows = db
    .prepare('SELECT * FROM channel_routes')
    .all() as ChannelRouteRow[];
  const result: Record<string, ChannelRoute> = {};
  for (const row of rows) {
    result[row.channel_jid] = mapRowToChannelRoute(row);
  }
  return result;
}

/** Insert or replace a channel route record. */
export function setChannelRoute(route: ChannelRoute): void {
  db.query(
    `
    INSERT OR REPLACE INTO channel_routes (channel_jid, agent_id, trigger_pattern, requires_trigger, discord_bot_id, discord_guild_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    route.channelJid,
    route.agentId,
    route.trigger,
    route.requiresTrigger ? 1 : 0,
    route.discordBotId || null,
    route.discordGuildId || null,
    route.createdAt,
  );
}

/** Return all channel routes associated with a given agent ID. */
export function getRoutesForAgent(agentId: string): ChannelRoute[] {
  const rows = db
    .prepare('SELECT * FROM channel_routes WHERE agent_id = ?')
    .all(agentId) as ChannelRouteRow[];
  return rows.map(mapRowToChannelRoute);
}

export function getSubscriptionsForChannel(
  channelJid: string,
): ChannelSubscription[] {
  const rows = db
    .prepare(
      'SELECT * FROM channel_subscriptions WHERE channel_jid = ? ORDER BY priority ASC, created_at ASC',
    )
    .all(channelJid) as ChannelSubscriptionRow[];
  return rows.map(mapRowToChannelSubscription);
}

export function getSubscriptionsForAgent(
  agentId: string,
): ChannelSubscription[] {
  const rows = db
    .prepare(
      'SELECT * FROM channel_subscriptions WHERE agent_id = ? ORDER BY priority ASC, created_at ASC',
    )
    .all(agentId) as ChannelSubscriptionRow[];
  return rows.map(mapRowToChannelSubscription);
}

export function getAllChannelSubscriptions(): Record<
  string,
  ChannelSubscription[]
> {
  const rows = db
    .prepare(
      'SELECT * FROM channel_subscriptions ORDER BY channel_jid ASC, priority ASC, created_at ASC',
    )
    .all() as ChannelSubscriptionRow[];
  const result: Record<string, ChannelSubscription[]> = {};
  for (const row of rows) {
    const sub = mapRowToChannelSubscription(row);
    if (!result[sub.channelJid]) result[sub.channelJid] = [];
    result[sub.channelJid].push(sub);
  }
  return result;
}

export function setChannelSubscription(sub: ChannelSubscription): void {
  db.query(
    `
    INSERT OR REPLACE INTO channel_subscriptions
    (channel_jid, agent_id, trigger_pattern, requires_trigger, priority, is_primary, discord_bot_id, discord_guild_id, created_at, channel_folder, category_folder)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    sub.channelJid,
    sub.agentId,
    sub.trigger,
    sub.requiresTrigger ? 1 : 0,
    sub.priority,
    sub.isPrimary ? 1 : 0,
    sub.discordBotId || null,
    sub.discordGuildId || null,
    sub.createdAt,
    sub.channelFolder || null,
    sub.categoryFolder || null,
  );
}

export function removeChannelSubscription(
  channelJid: string,
  agentId: string,
): void {
  db.query(
    'DELETE FROM channel_subscriptions WHERE channel_jid = ? AND agent_id = ?',
  ).run(channelJid, agentId);
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.unlinkSync(filePath);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      setRegisteredGroup(jid, group);
    }
  }
}
