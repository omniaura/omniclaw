import {
  ANTHROPIC_MODEL,
  CHANNEL_ROSTER_CACHE_TTL_MS,
  CHANNEL_ROSTER_ROLE_FILTERS,
  CHANNEL_ROSTER_SCOPE,
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_MEMORY,
  CONTAINER_STARTUP_TIMEOUT,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  DISCORD_BOTS,
  DISCORD_DEFAULT_BOT_ID,
  DISCOVERY_ENABLED,
  DISCOVERY_TRUST_LAN_ADMIN,
  GITHUB_WEBHOOK_PATH,
  GITHUB_WEBHOOK_PORT,
  GITHUB_WEBHOOK_SECRET,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  INSTANCE_NAME,
  LOCAL_RUNTIME,
  MAX_ACTIVE_CONTAINERS,
  MAX_IDLE_CONTAINERS,
  MAX_TASK_CONTAINERS,
  PERSISTENT_TASK_STATE,
  ROSTER_REFRESH_INTERVAL,
  SCHEDULER_POLL_INTERVAL,
  SESSION_MAX_AGE,
  SLACK_BOTS,
  SLACK_DEFAULT_BOT_ID,
  STORE_DIR,
  TELEGRAM_BOT_TOKENS,
  TIMEZONE,
  WEB_UI_CORS_ORIGIN,
  WEB_UI_HOST,
  WEB_UI_PASS,
  WEB_UI_PORT,
  WEB_UI_USER,
} from '../config.js';
import { allPageScripts } from './page-scripts.js';
import { escapeHtml, renderShell } from './shared.js';

export interface SettingsData {
  general: {
    timezone: string;
    anthropicModel: string | null;
    localRuntime: string;
  };
  webUi: {
    port: number | null;
    hostname: string;
    authEnabled: boolean;
    corsOrigin: string | null;
  };
  containers: {
    image: string;
    memory: string;
    timeoutMs: number;
    startupTimeoutMs: number;
    idleTimeoutMs: number;
    maxOutputSize: number;
    maxActive: number;
    maxIdle: number;
    maxTask: number;
  };
  channels: {
    discordBots: number;
    discordBotIds: string[];
    discordDefaultBot: string | null;
    telegramBots: number;
    slackBots: number;
    slackDefaultBot: string | null;
  };
  scheduling: {
    sessionMaxAgeMs: number;
    persistentTaskState: boolean;
    pollIntervalMs: number;
  };
  roster: {
    scope: string;
    roleFilters: string[];
    cacheTtlMs: number;
    refreshIntervalMs: number;
  };
  discovery: {
    enabled: boolean;
    instanceName: string;
    trustLanAdmin: boolean;
  };
  github: {
    webhookPort: number;
    webhookPath: string;
    secretConfigured: boolean;
  };
  paths: {
    store: string;
    groups: string;
    data: string;
  };
}

export function buildSettingsData(): SettingsData {
  return {
    general: {
      timezone: TIMEZONE,
      anthropicModel: ANTHROPIC_MODEL || null,
      localRuntime: LOCAL_RUNTIME,
    },
    webUi: {
      port: WEB_UI_PORT ?? null,
      hostname: WEB_UI_HOST,
      authEnabled: !!(WEB_UI_USER && WEB_UI_PASS),
      corsOrigin: WEB_UI_CORS_ORIGIN || null,
    },
    containers: {
      image: CONTAINER_IMAGE,
      memory: CONTAINER_MEMORY,
      timeoutMs: CONTAINER_TIMEOUT,
      startupTimeoutMs: CONTAINER_STARTUP_TIMEOUT,
      idleTimeoutMs: IDLE_TIMEOUT,
      maxOutputSize: CONTAINER_MAX_OUTPUT_SIZE,
      maxActive: MAX_ACTIVE_CONTAINERS,
      maxIdle: MAX_IDLE_CONTAINERS,
      maxTask: MAX_TASK_CONTAINERS,
    },
    channels: {
      discordBots: DISCORD_BOTS.length,
      discordBotIds: DISCORD_BOTS.map((b) => b.id),
      discordDefaultBot: DISCORD_DEFAULT_BOT_ID || null,
      telegramBots: TELEGRAM_BOT_TOKENS.length,
      slackBots: SLACK_BOTS.length,
      slackDefaultBot: SLACK_DEFAULT_BOT_ID || null,
    },
    scheduling: {
      sessionMaxAgeMs: SESSION_MAX_AGE,
      persistentTaskState: PERSISTENT_TASK_STATE,
      pollIntervalMs: SCHEDULER_POLL_INTERVAL,
    },
    roster: {
      scope: CHANNEL_ROSTER_SCOPE,
      roleFilters: [...CHANNEL_ROSTER_ROLE_FILTERS],
      cacheTtlMs: CHANNEL_ROSTER_CACHE_TTL_MS,
      refreshIntervalMs: ROSTER_REFRESH_INTERVAL,
    },
    discovery: {
      enabled: DISCOVERY_ENABLED,
      instanceName: INSTANCE_NAME,
      trustLanAdmin: DISCOVERY_TRUST_LAN_ADMIN,
    },
    github: {
      webhookPort: GITHUB_WEBHOOK_PORT,
      webhookPath: GITHUB_WEBHOOK_PATH,
      secretConfigured: GITHUB_WEBHOOK_SECRET.length > 0,
    },
    paths: {
      store: STORE_DIR,
      groups: GROUPS_DIR,
      data: DATA_DIR,
    },
  };
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  return `${Math.round(hours * 10) / 10}h`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${Math.round(mb * 10) / 10} MB`;
}

function settingRow(label: string, value: string, id?: string): string {
  const idAttr = id ? ` id="${escapeHtml(id)}"` : '';
  return (
    `<div class="metric-row">` +
    `<span class="metric-label">${escapeHtml(label)}</span>` +
    `<span class="metric-value"${idAttr}>${escapeHtml(value)}</span>` +
    `</div>`
  );
}

function settingCard(title: string, rows: string): string {
  return (
    `<div class="metric-card">` +
    `<div class="metric-card-title">${escapeHtml(title)}</div>` +
    `${rows}` +
    `</div>`
  );
}

function badge(text: string, variant: 'on' | 'off'): string {
  const cls = variant === 'on' ? 'badge-on' : 'badge-off';
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

/** Render the settings page content (no shell wrapper). */
export function renderSettingsContent(data?: SettingsData): string {
  const settings = data ?? buildSettingsData();

  return (
    `<div class="system-page" data-init="window.__initPage && window.__initPage('settings')">` +
    `<div class="system-header">` +
    `<h2>settings</h2>` +
    `<span class="health-badge">read-only</span>` +
    `</div>` +
    `<div class="system-grid">` +
    // General
    settingCard(
      'general',
      settingRow('timezone', settings.general.timezone) +
        settingRow(
          'model override',
          settings.general.anthropicModel || 'default',
        ) +
        settingRow('local runtime', settings.general.localRuntime),
    ) +
    // Web UI
    settingCard(
      'web ui',
      settingRow(
        'port',
        settings.webUi.port != null ? String(settings.webUi.port) : 'disabled',
      ) +
        settingRow('hostname', settings.webUi.hostname) +
        `<div class="metric-row">` +
        `<span class="metric-label">auth</span>` +
        `<span class="metric-value">${badge(settings.webUi.authEnabled ? 'enabled' : 'disabled', settings.webUi.authEnabled ? 'on' : 'off')}</span>` +
        `</div>` +
        settingRow('cors origin', settings.webUi.corsOrigin || 'disabled'),
    ) +
    // Containers
    settingCard(
      'containers',
      settingRow('image', settings.containers.image) +
        settingRow('memory', settings.containers.memory) +
        settingRow('timeout', formatMs(settings.containers.timeoutMs)) +
        settingRow(
          'startup timeout',
          formatMs(settings.containers.startupTimeoutMs),
        ) +
        settingRow(
          'idle timeout',
          formatMs(settings.containers.idleTimeoutMs),
        ) +
        settingRow(
          'max output',
          formatBytes(settings.containers.maxOutputSize),
        ) +
        settingRow('max active', String(settings.containers.maxActive)) +
        settingRow('max idle', String(settings.containers.maxIdle)) +
        settingRow('max task', String(settings.containers.maxTask)),
    ) +
    // Channels
    settingCard(
      'channels',
      settingRow('discord bots', String(settings.channels.discordBots)) +
        (settings.channels.discordBotIds.length > 0
          ? settingRow(
              'discord bot ids',
              settings.channels.discordBotIds.join(', '),
            )
          : '') +
        (settings.channels.discordDefaultBot
          ? settingRow('discord default', settings.channels.discordDefaultBot)
          : '') +
        settingRow('telegram bots', String(settings.channels.telegramBots)) +
        settingRow('slack bots', String(settings.channels.slackBots)) +
        (settings.channels.slackDefaultBot
          ? settingRow('slack default', settings.channels.slackDefaultBot)
          : ''),
    ) +
    // Scheduling
    settingCard(
      'scheduling',
      settingRow(
        'session max age',
        formatMs(settings.scheduling.sessionMaxAgeMs),
      ) +
        `<div class="metric-row">` +
        `<span class="metric-label">persistent state</span>` +
        `<span class="metric-value">${badge(settings.scheduling.persistentTaskState ? 'on' : 'off', settings.scheduling.persistentTaskState ? 'on' : 'off')}</span>` +
        `</div>` +
        settingRow(
          'poll interval',
          formatMs(settings.scheduling.pollIntervalMs),
        ),
    ) +
    // Roster
    settingCard(
      'roster',
      settingRow('scope', settings.roster.scope) +
        settingRow(
          'role filters',
          settings.roster.roleFilters.length > 0
            ? settings.roster.roleFilters.join(', ')
            : 'none',
        ) +
        settingRow('cache ttl', formatMs(settings.roster.cacheTtlMs)) +
        settingRow(
          'refresh interval',
          formatMs(settings.roster.refreshIntervalMs),
        ),
    ) +
    // Discovery
    settingCard(
      'discovery',
      `<div class="metric-row">` +
        `<span class="metric-label">enabled</span>` +
        `<span class="metric-value">${badge(settings.discovery.enabled ? 'yes' : 'no', settings.discovery.enabled ? 'on' : 'off')}</span>` +
        `</div>` +
        settingRow('instance name', settings.discovery.instanceName) +
        `<div class="metric-row">` +
        `<span class="metric-label">trust lan admin</span>` +
        `<span class="metric-value">${badge(settings.discovery.trustLanAdmin ? 'yes' : 'no', settings.discovery.trustLanAdmin ? 'on' : 'off')}</span>` +
        `</div>`,
    ) +
    // GitHub
    settingCard(
      'github',
      settingRow(
        'webhook port',
        settings.github.webhookPort > 0
          ? String(settings.github.webhookPort)
          : 'disabled',
      ) +
        settingRow('webhook path', settings.github.webhookPath) +
        `<div class="metric-row">` +
        `<span class="metric-label">webhook secret</span>` +
        `<span class="metric-value">${badge(settings.github.secretConfigured ? 'configured' : 'not set', settings.github.secretConfigured ? 'on' : 'off')}</span>` +
        `</div>`,
    ) +
    // Paths
    settingCard(
      'paths',
      settingRow('store', settings.paths.store) +
        settingRow('groups', settings.paths.groups) +
        settingRow('data', settings.paths.data),
    ) +
    `</div>` +
    `</div>`
  );
}

/** Full settings page with SPA shell. */
export function renderSettings(): string {
  return renderShell(
    '/settings',
    'Settings',
    renderSettingsContent(),
    allPageScripts(),
  );
}
