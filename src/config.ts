import os from 'os';
import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Omni';
export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
// Slack: bot token (xoxb-...) + app-level token for Socket Mode (xapp-...)
export const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
export const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || '';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

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
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const CONTAINER_STARTUP_TIMEOUT = parseInt(
  process.env.CONTAINER_STARTUP_TIMEOUT || '120000',
  10,
); // 2min — kill container if zero stderr output (stuck initialization)
export const SESSION_MAX_AGE = parseInt(
  process.env.SESSION_MAX_AGE || '14400000',
  10,
); // 4 hours — rotate sessions to prevent unbounded context growth
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '8', 10) || 8,
);
export const MAX_TASK_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_TASK_CONTAINERS || String(MAX_CONCURRENT_CONTAINERS - 1), 10),
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
