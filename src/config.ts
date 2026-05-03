import os from 'os';
import path from 'path';
import { z } from 'zod';

export type AgentRuntime = 'claude-agent-sdk' | 'opencode' | 'codex';

export interface DiscordBotConfig {
  id: string;
  token: string;
  runtime?: AgentRuntime;
  privilegedIntents: boolean;
}

export interface SlackBotConfig {
  id: string;
  token: string;
  appToken: string;
}

const AGENT_RUNTIME_VALUES = ['claude-agent-sdk', 'opencode', 'codex'] as const;

function parseBooleanString(value: unknown): unknown {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function parseIntegerString(value: unknown): unknown {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) {
    return value;
  }
  return Number.parseInt(value, 10);
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const configSchema = z
  .object({
    DISCORD_BOT_IDS: z.string().optional(),
    DISCORD_BOT_DEFAULT: z.string().optional(),
    DISCORD_BOT_TOKEN: z.string().optional(),
    TELEGRAM_BOT_TOKENS: z.string().optional(),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    SLACK_BOT_IDS: z.string().optional(),
    SLACK_BOT_DEFAULT: z.string().optional(),
    SLACK_BOT_TOKEN: z.string().optional(),
    SLACK_APP_TOKEN: z.string().optional(),
    PERSISTENT_TASK_STATE: z.preprocess(
      parseBooleanString,
      z.boolean().default(false),
    ),
    STARTUP_CONFIRMATIONS: z.preprocess(
      parseBooleanString,
      z.boolean().default(true),
    ),
    LOCAL_RUNTIME: z.string().default('container'),
    CONTAINER_IMAGE: z.string().default('omniclaw-agent:latest'),
    CONTAINER_MEMORY: z.string().default('4G'),
    SPLIT_EXECUTION: z.preprocess(
      parseBooleanString,
      z.boolean().default(false),
    ),
    SHARED_CLAUDE_VM: z.preprocess(
      parseBooleanString,
      z.boolean().default(false),
    ),
    SHARED_CLAUDE_VM_MEMORY: z.preprocess(
      optionalTrimmedString,
      z.string().default('16G'),
    ),
    EXEC_CONTAINER_MEMORY: z.string().optional(),
    CONTAINER_TIMEOUT: z.preprocess(
      parseIntegerString,
      z.number().int().positive().default(7200000),
    ),
    CONTAINER_MAX_OUTPUT_SIZE: z.preprocess(
      parseIntegerString,
      z.number().int().positive().default(10485760),
    ),
    IDLE_TIMEOUT: z.preprocess(
      parseIntegerString,
      z.number().int().positive().default(7200000),
    ),
    CONTAINER_STARTUP_TIMEOUT: z.preprocess(
      parseIntegerString,
      z.number().int().positive().default(120000),
    ),
    SESSION_MAX_AGE: z.preprocess(
      parseIntegerString,
      z.number().int().positive().default(14400000),
    ),
    ROSTER_REFRESH_INTERVAL: z.preprocess(
      parseIntegerString,
      z.number().int().positive().default(900000),
    ),
    CHANNEL_ROSTER_SCOPE: z.preprocess(
      (value) =>
        typeof value === 'string' ? value.trim().toLowerCase() : value,
      z.enum(['channel', 'guild']).default('channel'),
    ),
    CHANNEL_ROSTER_ROLE_FILTERS: z.string().optional(),
    CHANNEL_ROSTER_CACHE_TTL_MS: z.preprocess(
      parseIntegerString,
      z.number().int().nonnegative().default(300000),
    ),
    MAX_ACTIVE_CONTAINERS: z.preprocess(
      parseIntegerString,
      z.number().int().positive().optional(),
    ),
    MAX_CONCURRENT_CONTAINERS: z.preprocess(
      parseIntegerString,
      z.number().int().positive().optional(),
    ),
    MAX_IDLE_CONTAINERS: z.preprocess(
      parseIntegerString,
      z.number().int().nonnegative().default(0),
    ),
    MAX_TASK_CONTAINERS: z.preprocess(
      parseIntegerString,
      z.number().int().positive().optional(),
    ),
    ANTHROPIC_MODEL: z.preprocess(optionalTrimmedString, z.string().optional()),
    TZ: z.preprocess(optionalTrimmedString, z.string().optional()),
    GITHUB_WEBHOOK_SECRET: z.string().default(''),
    GITHUB_WEBHOOK_PORT: z.preprocess(
      parseIntegerString,
      z.number().int().nonnegative().default(0),
    ),
    GITHUB_WEBHOOK_PATH: z.string().default('/webhooks/github'),
    GITHUB_WEBHOOK_MAX_BODY_BYTES: z.preprocess(
      parseIntegerString,
      z.number().int().positive().default(262144),
    ),
    DISCOVERY_ENABLED: z.preprocess(
      parseBooleanString,
      z.boolean().default(false),
    ),
    INSTANCE_NAME: z.string().default(os.hostname()),
    DISCOVERY_TRUST_LAN_ADMIN: z.preprocess(
      parseBooleanString,
      z.boolean().default(false),
    ),
    WEB_UI_PORT: z.preprocess(
      parseIntegerString,
      z.number().int().min(1).max(65535).optional(),
    ),
    WEB_UI_USER: z.preprocess(optionalTrimmedString, z.string().optional()),
    WEB_UI_PASS: z.preprocess(optionalTrimmedString, z.string().optional()),
    WEB_PASSWORD: z.preprocess(optionalTrimmedString, z.string().optional()),
    WEB_UI_HOST: z.string().default('127.0.0.1'),
    WEB_UI_CORS_ORIGIN: z.preprocess(
      optionalTrimmedString,
      z.string().optional(),
    ),
  })
  .passthrough();

export function parseConfigEnv(
  env: NodeJS.ProcessEnv,
): z.infer<typeof configSchema> {
  const parsed = configSchema.safeParse(env);
  if (parsed.success) return parsed.data;

  const details = parsed.error.issues
    .map((issue) => {
      const key = issue.path.join('.') || 'config';
      return `${key}: ${issue.message}`;
    })
    .join('\n');
  throw new Error(`Invalid OmniClaw configuration:\n${details}`);
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
  if ((AGENT_RUNTIME_VALUES as readonly string[]).includes(value)) {
    return value as AgentRuntime;
  }
  return undefined;
}

function parseOptionalBooleanEnv(
  value: string | undefined,
): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
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
      if (!token) {
        throw new Error(
          `Invalid OmniClaw configuration:\nDISCORD_BOT_${id}_TOKEN: required when DISCORD_BOT_IDS includes ${id}`,
        );
      }
      const runtimeValue = env[`DISCORD_BOT_${id}_RUNTIME`]?.trim();
      const runtime = parseAgentRuntime(runtimeValue);
      if (runtimeValue && !runtime) {
        throw new Error(
          `Invalid OmniClaw configuration:\nDISCORD_BOT_${id}_RUNTIME: expected one of ${AGENT_RUNTIME_VALUES.join(', ')}`,
        );
      }
      const privilegedIntentsValue =
        env[`DISCORD_BOT_${id}_PRIVILEGED_INTENTS`]?.trim();
      const privilegedIntents = parseOptionalBooleanEnv(privilegedIntentsValue);
      if (privilegedIntentsValue && privilegedIntents === undefined) {
        throw new Error(
          `Invalid OmniClaw configuration:\nDISCORD_BOT_${id}_PRIVILEGED_INTENTS: expected boolean`,
        );
      }
      bots.push({
        id,
        token,
        runtime,
        privilegedIntents: privilegedIntents ?? true,
      });
    }
    const preferredDefault = sanitizeBotId(env.DISCORD_BOT_DEFAULT || '');
    const defaultBotId = bots.some((b) => b.id === preferredDefault)
      ? preferredDefault
      : bots[0].id;
    return { bots, defaultBotId };
  }

  const token = (env.DISCORD_BOT_TOKEN || '').trim();
  const bots = token
    ? [
        {
          id: 'PRIMARY',
          token,
          runtime: undefined as AgentRuntime | undefined,
          privilegedIntents: true,
        },
      ]
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

export function buildSlackBotConfigFromEnv(env: NodeJS.ProcessEnv): {
  bots: SlackBotConfig[];
  defaultBotId?: string;
} {
  const ids = [
    ...new Set(
      parseEnvList(env.SLACK_BOT_IDS)
        .map(sanitizeBotId)
        .filter((id) => id.length > 0),
    ),
  ];

  if (ids.length > 0) {
    const bots: SlackBotConfig[] = [];
    for (const id of ids) {
      const token = env[`SLACK_BOT_${id}_TOKEN`]?.trim();
      const appToken = env[`SLACK_BOT_${id}_APP_TOKEN`]?.trim();
      if (!token) {
        throw new Error(
          `Invalid OmniClaw configuration:\nSLACK_BOT_${id}_TOKEN: required when SLACK_BOT_IDS includes ${id}`,
        );
      }
      if (!appToken) {
        throw new Error(
          `Invalid OmniClaw configuration:\nSLACK_BOT_${id}_APP_TOKEN: required when SLACK_BOT_IDS includes ${id}`,
        );
      }
      bots.push({ id, token, appToken });
    }
    const preferredDefault = sanitizeBotId(env.SLACK_BOT_DEFAULT || '');
    const defaultBotId = bots.some((b) => b.id === preferredDefault)
      ? preferredDefault
      : bots[0].id;
    return { bots, defaultBotId };
  }

  const token = (env.SLACK_BOT_TOKEN || '').trim();
  const appToken = (env.SLACK_APP_TOKEN || '').trim();
  const bots = token && appToken ? [{ id: 'PRIMARY', token, appToken }] : [];
  return {
    bots,
    defaultBotId: bots[0]?.id,
  };
}

const CONFIG = parseConfigEnv(process.env);

const discordEnv = buildDiscordBotConfigFromEnv(process.env);
export const DISCORD_BOTS = discordEnv.bots;
export const DISCORD_DEFAULT_BOT_ID = discordEnv.defaultBotId;
export const DISCORD_BOT_IDS = DISCORD_BOTS.map((b) => b.id);
export const DISCORD_BOT_TOKEN = DISCORD_BOTS[0]?.token || '';
export const TELEGRAM_BOT_TOKENS = buildTelegramBotTokensFromEnv(process.env);
export const TELEGRAM_BOT_TOKEN = TELEGRAM_BOT_TOKENS[0] || '';
const slackEnv = buildSlackBotConfigFromEnv(process.env);
export const SLACK_BOTS = slackEnv.bots;
export const SLACK_DEFAULT_BOT_ID = slackEnv.defaultBotId;
// Legacy compatibility exports (first configured bot).
export const SLACK_BOT_TOKEN = SLACK_BOTS[0]?.token || '';
export const SLACK_APP_TOKEN = SLACK_BOTS[0]?.appToken || '';
export const POLL_INTERVAL = 2000;
export const DISCOVERY_POLL_INTERVAL = 10000;

/** Separator used in runtime group folders to isolate multi-agent dispatch state. */
export const DISPATCH_RUNTIME_SEP = '__dispatch__';
export const SCHEDULER_POLL_INTERVAL = 60000;
export const PERSISTENT_TASK_STATE = CONFIG.PERSISTENT_TASK_STATE;

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

export const LOCAL_RUNTIME = CONFIG.LOCAL_RUNTIME;
export const STARTUP_CONFIRMATIONS = CONFIG.STARTUP_CONFIRMATIONS;
export const CONTAINER_IMAGE = CONFIG.CONTAINER_IMAGE;
export const CONTAINER_MEMORY = CONFIG.CONTAINER_MEMORY;
export const SPLIT_EXECUTION = CONFIG.SPLIT_EXECUTION;
export const SHARED_CLAUDE_VM = CONFIG.SHARED_CLAUDE_VM;
export const SHARED_CLAUDE_VM_MEMORY = CONFIG.SHARED_CLAUDE_VM_MEMORY;
export const EXEC_CONTAINER_MEMORY =
  CONFIG.EXEC_CONTAINER_MEMORY || CONTAINER_MEMORY;
export const CONTAINER_TIMEOUT = CONFIG.CONTAINER_TIMEOUT; // 2h default — inactivity timeout for agent output (tool calls, results, text)
export const CONTAINER_MAX_OUTPUT_SIZE = CONFIG.CONTAINER_MAX_OUTPUT_SIZE; // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = CONFIG.IDLE_TIMEOUT; // 2h default — how long to keep container alive after last result
export const CONTAINER_STARTUP_TIMEOUT = CONFIG.CONTAINER_STARTUP_TIMEOUT; // 2min — kill container if zero stderr output (stuck initialization)
export const SESSION_MAX_AGE = CONFIG.SESSION_MAX_AGE; // 4 hours — rotate sessions to prevent unbounded context growth
export const ROSTER_REFRESH_INTERVAL = CONFIG.ROSTER_REFRESH_INTERVAL; // 15min default — how often to refresh Discord guild rosters

export type ChannelRosterScope = 'channel' | 'guild';

export const CHANNEL_ROSTER_SCOPE = CONFIG.CHANNEL_ROSTER_SCOPE;

export const CHANNEL_ROSTER_ROLE_FILTERS = parseEnvList(
  CONFIG.CHANNEL_ROSTER_ROLE_FILTERS,
).map((role) => role.toLowerCase());
export const CHANNEL_ROSTER_CACHE_TTL_MS = CONFIG.CHANNEL_ROSTER_CACHE_TTL_MS;
/** Max containers actively processing messages or tasks. */
export const MAX_ACTIVE_CONTAINERS = Math.max(
  1,
  CONFIG.MAX_ACTIVE_CONTAINERS ?? CONFIG.MAX_CONCURRENT_CONTAINERS ?? 8,
);
/** Max warm containers sitting idle, waiting for the next message. Defaults to 0 to prefer session resume over resident containers. */
export const MAX_IDLE_CONTAINERS = Math.max(0, CONFIG.MAX_IDLE_CONTAINERS);
/** Backward-compat alias. */
export const MAX_CONCURRENT_CONTAINERS = MAX_ACTIVE_CONTAINERS;
export const MAX_TASK_CONTAINERS = Math.max(
  1,
  CONFIG.MAX_TASK_CONTAINERS ?? MAX_ACTIVE_CONTAINERS - 1,
);

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a trigger regex for a specific group's trigger string (e.g. "@Clayton").
 * Returns a never-match regex when no trigger is provided — all agents should
 * have explicit triggers in the channel_subscriptions table.
 */
export function buildTriggerPattern(trigger?: string): RegExp {
  if (!trigger) return /(?!)/;
  const name = trigger.replace(/^@/, '');
  return new RegExp(`^@${escapeRegex(name)}\\b`, 'i');
}

// Allow overriding the Anthropic model (e.g. switch to cheaper model)
export const ANTHROPIC_MODEL = CONFIG.ANTHROPIC_MODEL;

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  CONFIG.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

export const GITHUB_WEBHOOK_SECRET = CONFIG.GITHUB_WEBHOOK_SECRET;
export const GITHUB_WEBHOOK_PORT = CONFIG.GITHUB_WEBHOOK_PORT;
export const GITHUB_WEBHOOK_PATH = CONFIG.GITHUB_WEBHOOK_PATH;
export const GITHUB_WEBHOOK_MAX_BODY_BYTES =
  CONFIG.GITHUB_WEBHOOK_MAX_BODY_BYTES;

// --- Network Discovery ---
// Set DISCOVERY_ENABLED=true to advertise this instance on the LAN via mDNS.
export const DISCOVERY_ENABLED = CONFIG.DISCOVERY_ENABLED;
export const INSTANCE_NAME = CONFIG.INSTANCE_NAME;
// Opt-in: allow discovery admin actions from loopback/private LAN without Web UI Basic Auth.
export const DISCOVERY_TRUST_LAN_ADMIN = CONFIG.DISCOVERY_TRUST_LAN_ADMIN;

// --- Web UI ---
// Set WEB_UI_PORT to enable the web dashboard. Unset = disabled.
export const WEB_UI_PORT = CONFIG.WEB_UI_PORT;
export const WEB_UI_USER = CONFIG.WEB_UI_USER;
export const WEB_UI_PASS = CONFIG.WEB_UI_PASS;
// Session-based password auth: when set, the web UI shows a login page instead of Basic Auth.
export const WEB_PASSWORD = CONFIG.WEB_PASSWORD;
// Bind hostname: defaults to loopback (127.0.0.1) for security.
// Set WEB_UI_HOST=0.0.0.0 to expose on all interfaces (e.g. behind a reverse proxy).
export const WEB_UI_HOST = CONFIG.WEB_UI_HOST;
// CORS: explicit allowed origin. Defaults to empty (CORS disabled).
// Set WEB_UI_CORS_ORIGIN to allow cross-origin requests from a specific origin.
export const WEB_UI_CORS_ORIGIN = CONFIG.WEB_UI_CORS_ORIGIN;
