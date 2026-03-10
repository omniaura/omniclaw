import os from 'os';
import path from 'path';

export type AgentRuntime = 'claude-agent-sdk' | 'opencode' | 'codex';

export interface DiscordBotConfig {
  id: string;
  token: string;
  runtime?: AgentRuntime;
}

export function parseEnvList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function parseAgentRuntime(
  value: string | undefined,
): AgentRuntime | undefined {
  if (!value) return undefined;
  if (value === 'claude-agent-sdk' || value === 'opencode' || value === 'codex')
    return value;
  return undefined;
}

function sanitizeBotId(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function buildDiscordBotConfigFromEnv(env: NodeJS.ProcessEnv): {
  bots: DiscordBotConfig[];
  defaultBotId?: string;
} {
  const ids = parseEnvList(env.DISCORD_BOT_IDS)
    .map(sanitizeBotId)
    .filter((id) => id.length > 0);

  if (ids.length > 0) {
    const bots: DiscordBotConfig[] = [];
    for (const id of ids) {
      const token = env[`DISCORD_BOT_${id}_TOKEN`]?.trim();
      if (!token) continue;
      const runtime = parseAgentRuntime(env[`DISCORD_BOT_${id}_RUNTIME`]);
      bots.push({ id, token, runtime });
    }
    if (bots.length === 0) return { bots: [] };
    const preferredDefault = sanitizeBotId(env.DISCORD_BOT_DEFAULT || '');
    const defaultBotId = bots.some((b) => b.id === preferredDefault)
      ? preferredDefault
      : bots[0].id;
    return { bots, defaultBotId };
  }

  const token = (env.DISCORD_BOT_TOKEN || '').trim();
  const bots = token
    ? [{ id: 'PRIMARY', token, runtime: undefined as AgentRuntime | undefined }]
    : [];
  return {
    bots,
    defaultBotId: bots[0]?.id,
  };
}

export function buildTelegramBotTokensFromEnv(
  env: NodeJS.ProcessEnv,
): string[] {
  const configured = parseEnvList(env.TELEGRAM_BOT_TOKENS).filter(
    (token) => token.length > 0,
  );
  if (configured.length > 0) return [...new Set(configured)];

  const legacyToken = (env.TELEGRAM_BOT_TOKEN || '').trim();
  return legacyToken ? [legacyToken] : [];
}

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Omni';
const discordEnv = buildDiscordBotConfigFromEnv(process.env);
export const DISCORD_BOTS = discordEnv.bots;
export const DISCORD_DEFAULT_BOT_ID = discordEnv.defaultBotId;
export const DISCORD_BOT_IDS = DISCORD_BOTS.map((b) => b.id);
export const DISCORD_BOT_TOKEN = DISCORD_BOTS[0]?.token || '';
export const TELEGRAM_BOT_TOKENS = buildTelegramBotTokensFromEnv(process.env);
export const TELEGRAM_BOT_TOKEN = TELEGRAM_BOT_TOKENS[0] || '';
// Slack: bot token (xoxb-...) + app-level token for Socket Mode (xapp-...)
export const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
export const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || '';
export const POLL_INTERVAL = 2000;
export const DISCOVERY_POLL_INTERVAL = parseInt(
  process.env.DISCOVERY_POLL_INTERVAL || '10000',
  10,
);

/** Separator used in runtime group folders to isolate multi-agent dispatch state. */
export const DISPATCH_RUNTIME_SEP = '__dispatch__';
export const SCHEDULER_POLL_INTERVAL = 60000;
export const PERSISTENT_TASK_STATE =
  process.env.PERSISTENT_TASK_STATE === 'true';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'omniclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const LOCAL_RUNTIME = process.env.LOCAL_RUNTIME || 'container';
export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'omniclaw-agent:latest';
export const CONTAINER_MEMORY = process.env.CONTAINER_MEMORY || '4G';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const CONTAINER_STARTUP_TIMEOUT = parseInt(
  process.env.CONTAINER_STARTUP_TIMEOUT || '120000',
  10,
); // 2min — kill container if zero stderr output (stuck initialization)
export const SESSION_MAX_AGE = parseInt(
  process.env.SESSION_MAX_AGE || '14400000',
  10,
); // 4 hours — rotate sessions to prevent unbounded context growth
export const ROSTER_REFRESH_INTERVAL = parseInt(
  process.env.ROSTER_REFRESH_INTERVAL || '900000',
  10,
); // 15min default — how often to refresh Discord guild rosters

export type ChannelRosterScope = 'channel' | 'guild';

function parseChannelRosterScope(
  value: string | undefined,
): ChannelRosterScope {
  return value?.toLowerCase() === 'guild' ? 'guild' : 'channel';
}

export const CHANNEL_ROSTER_SCOPE = parseChannelRosterScope(
  process.env.CHANNEL_ROSTER_SCOPE,
);

export const CHANNEL_ROSTER_ROLE_FILTERS = parseEnvList(
  process.env.CHANNEL_ROSTER_ROLE_FILTERS,
).map((role) => role.toLowerCase());
export const CHANNEL_ROSTER_CACHE_TTL_MS = parseInt(
  process.env.CHANNEL_ROSTER_CACHE_TTL_MS || '300000',
  10,
);
/** Max containers actively processing messages or tasks. */
export const MAX_ACTIVE_CONTAINERS = Math.max(
  1,
  parseInt(
    process.env.MAX_ACTIVE_CONTAINERS ||
      process.env.MAX_CONCURRENT_CONTAINERS ||
      '8',
    10,
  ) || 8,
);
/** Max warm containers sitting idle, waiting for the next message. */
export const MAX_IDLE_CONTAINERS = Math.max(
  0,
  parseInt(process.env.MAX_IDLE_CONTAINERS || '4', 10) || 4,
);
/** Backward-compat alias. */
export const MAX_CONCURRENT_CONTAINERS = MAX_ACTIVE_CONTAINERS;
export const MAX_TASK_CONTAINERS = Math.max(
  1,
  parseInt(
    process.env.MAX_TASK_CONTAINERS || String(MAX_ACTIVE_CONTAINERS - 1),
    10,
  ),
);

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

/**
 * Build a trigger regex for a specific group's trigger string (e.g. "@OmarOmni").
 * Falls back to the global TRIGGER_PATTERN if no trigger is provided.
 */
export function buildTriggerPattern(trigger?: string): RegExp {
  if (!trigger) return TRIGGER_PATTERN;
  const name = trigger.replace(/^@/, '');
  return new RegExp(`^@${escapeRegex(name)}\\b`, 'i');
}

// Allow overriding the Anthropic model (e.g. switch to cheaper model)
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || undefined;

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

export const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';
export const GITHUB_WEBHOOK_PORT = parseInt(
  process.env.GITHUB_WEBHOOK_PORT || '0',
  10,
);
export const GITHUB_WEBHOOK_PATH =
  process.env.GITHUB_WEBHOOK_PATH || '/webhooks/github';

// --- Network Discovery ---
// Set DISCOVERY_ENABLED=true to advertise this instance on the LAN via mDNS.
export const DISCOVERY_ENABLED = process.env.DISCOVERY_ENABLED === 'true';
export const INSTANCE_NAME = process.env.INSTANCE_NAME || os.hostname();

// --- Web UI ---
// Set WEB_UI_PORT to enable the web dashboard. Unset = disabled.
export const WEB_UI_PORT = process.env.WEB_UI_PORT
  ? parseInt(process.env.WEB_UI_PORT, 10)
  : undefined;
export const WEB_UI_USER = process.env.WEB_UI_USER || undefined;
export const WEB_UI_PASS = process.env.WEB_UI_PASS || undefined;
// Bind hostname: defaults to loopback (127.0.0.1) for security.
// Set WEB_UI_HOST=0.0.0.0 to expose on all interfaces (e.g. behind a reverse proxy).
export const WEB_UI_HOST = process.env.WEB_UI_HOST || '127.0.0.1';
// CORS: explicit allowed origin. Defaults to empty (CORS disabled).
// Set WEB_UI_CORS_ORIGIN to allow cross-origin requests from a specific origin.
export const WEB_UI_CORS_ORIGIN = process.env.WEB_UI_CORS_ORIGIN || undefined;
