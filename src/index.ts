import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import { syncAvatars } from './avatar-sync.js';

import {
  ASSISTANT_NAME,
  buildTriggerPattern,
  CHANNEL_ROSTER_CACHE_TTL_MS,
  CHANNEL_ROSTER_ROLE_FILTERS,
  CHANNEL_ROSTER_SCOPE,
  DATA_DIR,
  DISPATCH_RUNTIME_SEP,
  DISCORD_BOTS,
  DISCORD_DEFAULT_BOT_ID,
  GITHUB_WEBHOOK_PATH,
  GITHUB_WEBHOOK_PORT,
  GITHUB_WEBHOOK_SECRET,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  PERSISTENT_TASK_STATE,
  POLL_INTERVAL,
  ROSTER_REFRESH_INTERVAL,
  SESSION_MAX_AGE,
  SLACK_BOTS,
  SLACK_DEFAULT_BOT_ID,
  TELEGRAM_BOT_TOKENS,
  TRIGGER_PATTERN,
  WEB_UI_PORT,
  WEB_UI_USER,
  WEB_UI_PASS,
  WEB_UI_HOST,
  WEB_UI_CORS_ORIGIN,
  DISCOVERY_ENABLED,
  DISCOVERY_TRUST_LAN_ADMIN,
  INSTANCE_NAME,
} from './config.js';
import { DiscordChannel } from './channels/discord.js';
import { SlackChannel } from './channels/slack.js';
import { TelegramChannel } from './channels/telegram.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import {
  initializeBackends,
  resolveBackend,
  shutdownBackends,
} from './backends/index.js';
import type { ChannelInfo, ContainerOutput } from './backends/types.js';
import {
  mapTasksForSnapshot,
  writeGroupsSnapshot,
  writeRostersSnapshot,
  writeTasksSnapshot,
} from './ipc-snapshots.js';
import {
  expireStaleSessions,
  getAllAgents,
  getAllAgentHealth,
  getAgentHealth,
  getAllChannelSubscriptions,
  getAllChannelRoutes,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getAllGuildRosters,
  getChatGuildId,
  getGuildRoster,
  getMessagesSince,
  storeGuildRoster,
  getNewMessages,
  getRouterState,
  getAgent,
  getTaskById,
  createTask as dbCreateTask,
  updateTask as dbUpdateTask,
  deleteTask as dbDeleteTask,
  initDatabase,
  setAgent,
  setAgentHealth,
  setChannelSubscription,
  setChannelRoute,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  getSubscriptionsForAgent,
  updateAgentAvatar,
  createTrustStore,
  getOrCreateDiscoveryInstanceId,
  getTaskRunLogs,
} from './db.js';
import {
  buildAgentToChannelsMapFromSubscriptions,
  buildSendToInstruction,
} from './channel-routes.js';
import { resolveContextLayers } from './context-layers.js';
import { parseScopedSlackJid } from './slack-jid.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  getAgentName,
} from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  Agent,
  AgentHealth,
  AgentRuntime,
  BackendType,
  Channel,
  ChannelRoute,
  ChannelSubscription,
  NewMessage,
  RegisteredGroup,
  registeredGroupToAgent,
  registeredGroupToRoute,
} from './types.js';
import { getGitHubContextForAgent } from './github.js';
import { fetchGitHubDelta } from './github-delta.js';
import { startGitHubWebhookServer } from './github-webhooks.js';
import type { GitHubWebhookNotification } from './github-webhooks.js';
import { calculateNextRun } from './schedule-utils.js';
import { logger } from './logger.js';
import { createResumePositionStore } from './resume-position-store.js';
import { assertPathWithin } from './path-security.js';
import { redactSensitiveData } from './security/redaction.js';
import { serveCachedRemoteImage } from './web/image-cache.js';
import {
  startWebServer,
  startLogStream,
  IpcEventBuffer,
  type IpcEventKind,
  type WebServerHandle,
} from './web/index.js';
import type { WebStateProvider } from './web/types.js';
import {
  detectCurrentNetwork,
  DiscoveryRuntimeController,
  startDiscovery,
  TrustStore,
  type DiscoveryHandle,
} from './discovery/index.js';
import { setDiscoveryContext } from './web/routes.js';
import { Effect } from 'effect';

// Global error handlers to prevent crashes from unhandled rejections/exceptions
// See: https://github.com/omniaura/omniclaw/issues/221
// Adopted from [Upstream PR #243] - Critical stability fix
process.on('unhandledRejection', (reason, promise) => {
  logger.error(
    { reason: reason instanceof Error ? reason.message : String(reason) },
    'Unhandled promise rejection - application will continue',
  );
  // Log the promise that was rejected for debugging
  if (promise && typeof promise.catch === 'function') {
    promise.catch((err) => {
      logger.error({ err }, 'Promise rejection details');
    });
  }
});

process.on('uncaughtException', (err) => {
  logger.error(
    { err: err.message, stack: err.stack },
    'Uncaught exception - attempting graceful shutdown',
  );
  // Attempt graceful shutdown before exiting
  shutdown().finally(() => {
    process.exit(1);
  });
});

// Top-level shutdown function for global error handlers
let shutdownFn: (() => Promise<void>) | null = null;
async function shutdown(): Promise<void> {
  if (shutdownFn) {
    await shutdownFn();
  } else {
    logger.warn('Shutdown called before initialization, forcing exit');
    process.exit(1);
  }
}

let lastTimestamp = '';
let sessions: Record<string, string> = {};
const resumePositionStore = createResumePositionStore({
  persistentTaskState: PERSISTENT_TASK_STATE,
  initialResumePositions: {},
});
let registeredGroups: Record<string, RegisteredGroup> = {};
let agents: Record<string, Agent> = {};
let channelRoutes: Record<string, ChannelRoute> = {};
let channelSubscriptions: Record<string, ChannelSubscription[]> = {};
let channelSubscriptionsDirty = true;
/** Runtime folders currently in use by the orchestrator (for IPC auth). */
const activeRuntimeFolders = new Set<string>();
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

// Attentive follow-up: when a bot is mentioned, it stays attentive for the
// next human message in that channel even without an explicit trigger.
// Maps chatJid → Set of agentIds that are attentive.
// Consumed (cleared) when the follow-up message is routed.
const attentiveAgents: Record<string, Set<string>> = {};

// Track consecutive errors per group to prevent infinite error loops.
// After MAX_CONSECUTIVE_ERRORS, the cursor advances past the failing batch
// so the system doesn't re-trigger the same error on every poll.
const consecutiveErrors: Record<string, number> = {};
const MAX_CONSECUTIVE_ERRORS = 3;

let whatsapp: WhatsAppChannel | null = null;
let channels: Channel[] = [];
const queue = new GroupQueue();
const ipcEvents = new IpcEventBuffer();
let githubWebhookServer: { stop: () => void } | null = null;

const MAX_CHANNEL_AGENT_FANOUT = parseInt(
  process.env.MAX_CHANNEL_AGENT_FANOUT || '3',
  10,
);
const DISPATCH_KEY_SEP = '::agent::';

interface ChannelRosterMemberView {
  userId: string;
  displayName: string;
  roles: string[];
}

interface ChannelRosterOptions {
  scope?: 'channel' | 'guild';
  roleFilters?: string[];
  discordBotId?: string;
  /** Agent folder (= agent ID) — used to load per-agent roster_role_filters from DB. */
  agentFolder?: string;
}

function formatChannelRosterNames(
  members: ChannelRosterMemberView[],
): string[] {
  return members.map((member) => {
    if (member.roles.length > 0) {
      return `${member.displayName} [${member.roles.join(', ')}]`;
    }
    return member.displayName;
  });
}

const channelRosterCache = new Map<
  string,
  {
    expiresAt: number;
    members: ChannelRosterMemberView[];
  }
>();

function makeDispatchKey(channelJid: string, agentId: string): string {
  return `${channelJid}${DISPATCH_KEY_SEP}${agentId}`;
}

function parseDispatchKey(key: string): {
  channelJid: string;
  agentId?: string;
} {
  const idx = key.indexOf(DISPATCH_KEY_SEP);
  if (idx === -1) return { channelJid: key };
  return {
    channelJid: key.slice(0, idx),
    agentId: key.slice(idx + DISPATCH_KEY_SEP.length),
  };
}

function getRuntimeGroupFolder(
  baseFolder: string,
  processKeyJid: string,
): string {
  const { agentId } = parseDispatchKey(processKeyJid);
  if (!agentId) return baseFolder;
  const digest = createHash('sha1')
    .update(processKeyJid)
    .digest('hex')
    .slice(0, 16);
  const runtimeFolder = `${baseFolder}${DISPATCH_RUNTIME_SEP}${digest}`;
  // Guard against path traversal from user-controlled baseFolder
  const ipcBase = path.join(DATA_DIR, 'ipc');
  assertPathWithin(
    path.join(ipcBase, runtimeFolder),
    ipcBase,
    'runtime group folder',
  );
  return runtimeFolder;
}

function getSubscriptionsForChannelInMemory(
  channelJid: string,
): ChannelSubscription[] {
  const exact = channelSubscriptions[channelJid];
  if (exact && exact.length > 0) return exact;
  const legacyJid = toLegacyTelegramJid(channelJid);
  if (legacyJid) return channelSubscriptions[legacyJid] || [];
  return [];
}

function buildRegisteredGroupFromSubscription(
  channelJid: string,
  sub: ChannelSubscription,
): RegisteredGroup | undefined {
  const agent = agents[sub.agentId];
  const fallback = registeredGroups[channelJid];
  if (!agent && !fallback) return undefined;

  const resolvedBotId = sub.discordBotId || fallback?.discordBotId;
  const runtimeDefault = getDiscordRuntimeDefault(resolvedBotId);
  const discordGuildId = sub.discordGuildId || fallback?.discordGuildId;
  const layers = resolveContextLayers({
    channelJid,
    discordGuildId,
    serverFolder: agent?.serverFolder || fallback?.serverFolder,
    categoryFolder: sub.categoryFolder || undefined,
    channelFolder: sub.channelFolder || undefined,
  });
  return {
    name: agent?.name || fallback?.name || sub.agentId,
    folder: agent?.folder || fallback?.folder || sub.agentId,
    trigger: sub.trigger,
    added_at: sub.createdAt,
    containerConfig: agent?.containerConfig || fallback?.containerConfig,
    requiresTrigger: sub.requiresTrigger,
    discordBotId: resolvedBotId,
    discordGuildId,
    serverFolder: layers.serverFolder,
    backend: agent?.backend || fallback?.backend || 'apple-container',
    agentRuntime:
      agent?.agentRuntime || fallback?.agentRuntime || runtimeDefault,
    description: agent?.description || fallback?.description,
    autoRespondToQuestions: fallback?.autoRespondToQuestions,
    autoRespondKeywords: fallback?.autoRespondKeywords,
    channelFolder: layers.channelFolder,
    categoryFolder: layers.categoryFolder,
    agentContextFolder: agent?.agentContextFolder || undefined,
  };
}

function getDiscordRuntimeDefault(botId?: string): AgentRuntime | undefined {
  if (!botId) return undefined;
  return DISCORD_BOTS.find((b) => b.id === botId)?.runtime;
}

function getDiscordBotIdForJid(jid: string): string | undefined {
  if (!jid.startsWith('dc:')) return undefined;
  const primarySub = (channelSubscriptions[jid] || []).find((s) => s.isPrimary);
  if (primarySub?.discordBotId) return primarySub.discordBotId;
  const routeBotId = channelRoutes[jid]?.discordBotId;
  if (routeBotId) return routeBotId;
  return DISCORD_DEFAULT_BOT_ID;
}

function parseScopedTelegramJid(
  jid: string,
): { botId: string; chatId: string } | null {
  const m = /^tg:([^:]+):(-?\d+)$/.exec(jid);
  if (!m) return null;
  return { botId: m[1], chatId: m[2] };
}

function toLegacyTelegramJid(jid: string): string | undefined {
  const parsed = parseScopedTelegramJid(jid);
  return parsed ? `tg:${parsed.chatId}` : undefined;
}

function toLegacySlackJid(jid: string): string | undefined {
  const parsed = parseScopedSlackJid(jid);
  return parsed ? `slack:${parsed.channelId}` : undefined;
}

function getRegisteredGroupForJid(jid: string): RegisteredGroup | undefined {
  const exact = registeredGroups[jid];
  if (exact) return exact;
  const legacyTelegramJid = toLegacyTelegramJid(jid);
  if (legacyTelegramJid) return registeredGroups[legacyTelegramJid];
  const legacySlackJid = toLegacySlackJid(jid);
  if (legacySlackJid) return registeredGroups[legacySlackJid];
  return undefined;
}

function getPreferredChannelBotId(
  jid: string,
  discordBotId?: string,
): string | undefined {
  if (jid.startsWith('dc:')) return discordBotId || getDiscordBotIdForJid(jid);
  if (jid.startsWith('slack:')) {
    const scopedSlack = parseScopedSlackJid(jid);
    return scopedSlack?.botId || SLACK_DEFAULT_BOT_ID;
  }
  const scopedTelegram = parseScopedTelegramJid(jid);
  if (scopedTelegram) return scopedTelegram.botId;
  return undefined;
}

function findChannelForJid(
  jid: string,
  preferredBotId?: string,
): Channel | undefined {
  if (jid.startsWith('tg:') && preferredBotId) {
    const preferredTelegram = channels.find(
      (c) => c.name === 'telegram' && c.botId === preferredBotId,
    );
    if (preferredTelegram) return preferredTelegram;
  }

  if (jid.startsWith('slack:') && preferredBotId) {
    const preferredSlack = channels.find(
      (c) => c.name === 'slack' && c.botId === preferredBotId,
    );
    if (preferredSlack) return preferredSlack;
  }

  if (!jid.startsWith('dc:')) return findChannel(channels, jid);

  const botId = preferredBotId || getDiscordBotIdForJid(jid);
  if (botId) {
    const preferred = channels.find(
      (c) => c.name === 'discord' && (c as { botId?: string }).botId === botId,
    );
    if (preferred) return preferred;
  }

  return findChannel(channels, jid);
}

async function resolveChatImageUrl(chatJid: string): Promise<string | null> {
  const preferredBotId = getPreferredChannelBotId(chatJid);
  const channel = findChannelForJid(chatJid, preferredBotId);
  if (!channel?.getChatAvatarUrl) return null;
  return channel.getChatAvatarUrl(chatJid);
}

async function resolveDiscordGuildImageUrl(
  guildId: string,
  botId?: string,
): Promise<string | null> {
  const preferred = botId
    ? channels.find((c) => c.name === 'discord' && c.botId === botId)
    : channels.find((c) => c.name === 'discord');
  if (!preferred?.getServerIconUrl) return null;
  return preferred.getServerIconUrl(guildId);
}

function isTelegramChatJid(jid: string): boolean {
  return /^tg:(?:[^:]+:)?-?\d+$/.test(jid);
}

async function warmTopologyImageCache(): Promise<void> {
  const guildTargets = new Map<string, { guildId: string; botId?: string }>();
  const chatTargets = new Set<string>();

  for (const subs of Object.values(channelSubscriptions)) {
    for (const sub of subs) {
      if (sub.discordGuildId) {
        guildTargets.set(`${sub.discordGuildId}:${sub.discordBotId || ''}`, {
          guildId: sub.discordGuildId,
          botId: sub.discordBotId,
        });
      }
      if (isTelegramChatJid(sub.channelJid)) {
        chatTargets.add(sub.channelJid);
      }
    }
  }

  await Promise.allSettled([
    ...Array.from(guildTargets.values()).map((target) =>
      serveCachedRemoteImage(
        `discord-guild:${target.guildId}:${target.botId || ''}`,
        async () => resolveDiscordGuildImageUrl(target.guildId, target.botId),
      ),
    ),
    ...Array.from(chatTargets).map((chatJid) =>
      serveCachedRemoteImage(`chat:${chatJid}`, async () =>
        resolveChatImageUrl(chatJid),
      ),
    ),
  ]);
}

function backfillDiscordBotIds(): void {
  if (!DISCORD_DEFAULT_BOT_ID) return;

  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (!jid.startsWith('dc:')) continue;
    const routeBotId = channelRoutes[jid]?.discordBotId;
    const resolvedBotId =
      group.discordBotId || routeBotId || DISCORD_DEFAULT_BOT_ID;

    let updatedGroup = group;
    if (!updatedGroup.discordBotId && resolvedBotId) {
      updatedGroup = {
        ...updatedGroup,
        discordBotId: resolvedBotId,
      };
    }
    if (!updatedGroup.agentRuntime) {
      const runtimeDefault = getDiscordRuntimeDefault(
        updatedGroup.discordBotId,
      );
      if (runtimeDefault) {
        updatedGroup = { ...updatedGroup, agentRuntime: runtimeDefault };
      }
    }
    if (updatedGroup !== group) {
      registeredGroups[jid] = updatedGroup;
      setRegisteredGroup(jid, updatedGroup);
    }

    const route = channelRoutes[jid];
    if (route && !route.discordBotId) {
      const updatedRoute: ChannelRoute = {
        ...route,
        discordBotId: updatedGroup.discordBotId || DISCORD_DEFAULT_BOT_ID,
      };
      channelRoutes[jid] = updatedRoute;
      setChannelRoute(updatedRoute);
    }

    const subs = channelSubscriptions[jid] || [];
    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i];
      if (!sub.discordBotId) {
        const updatedSub: ChannelSubscription = {
          ...sub,
          discordBotId: updatedGroup.discordBotId || DISCORD_DEFAULT_BOT_ID,
        };
        subs[i] = updatedSub;
        setChannelSubscription(updatedSub);
      }
    }
    channelSubscriptions[jid] = subs;
  }
}

function refreshChannelSubscriptions(): void {
  if (!channelSubscriptionsDirty) return;
  channelSubscriptions = getAllChannelSubscriptions();
  channelSubscriptionsDirty = false;
}

/** Mark channel subscriptions as stale so the next loop tick re-reads from DB. */
function invalidateChannelSubscriptions(): void {
  channelSubscriptionsDirty = true;
  mentionPatternCache.clear();
}

function refreshRegisteredGroupsFromCanonicalState(): {
  synthesized: number;
  legacyOnly: number;
} {
  const legacyGroups = getAllRegisteredGroups();
  const nextGroups: Record<string, RegisteredGroup> = {};
  let synthesized = 0;
  let legacyOnly = 0;

  const allJids = new Set<string>([
    ...Object.keys(channelRoutes),
    ...Object.keys(channelSubscriptions),
  ]);

  for (const jid of allJids) {
    const subs = channelSubscriptions[jid] || [];
    const preferredSub = subs.find((s) => s.isPrimary) || subs[0];
    const route = channelRoutes[jid];
    const legacy = legacyGroups[jid];
    const agentId = preferredSub?.agentId || route?.agentId;
    const agent = agentId ? agents[agentId] : undefined;

    if (!agent && !legacy) continue;

    const discordBotId =
      preferredSub?.discordBotId || route?.discordBotId || legacy?.discordBotId;
    const runtimeDefault = getDiscordRuntimeDefault(discordBotId);
    const discordGuildId =
      preferredSub?.discordGuildId ||
      route?.discordGuildId ||
      legacy?.discordGuildId;
    const layers = resolveContextLayers({
      channelJid: jid,
      discordGuildId,
      serverFolder: agent?.serverFolder || legacy?.serverFolder,
      categoryFolder: preferredSub?.categoryFolder,
      channelFolder: preferredSub?.channelFolder,
    });
    nextGroups[jid] = {
      name: agent?.name || legacy?.name || agentId || jid,
      folder: agent?.folder || legacy?.folder || agentId || jid,
      trigger:
        preferredSub?.trigger ||
        route?.trigger ||
        legacy?.trigger ||
        `@${ASSISTANT_NAME}`,
      added_at:
        preferredSub?.createdAt ||
        route?.createdAt ||
        legacy?.added_at ||
        new Date().toISOString(),
      containerConfig: agent?.containerConfig || legacy?.containerConfig,
      requiresTrigger:
        preferredSub?.requiresTrigger ??
        route?.requiresTrigger ??
        legacy?.requiresTrigger ??
        true,
      discordBotId,
      discordGuildId,
      serverFolder: layers.serverFolder,
      backend: (agent?.backend ||
        legacy?.backend ||
        'apple-container') as BackendType,
      agentRuntime:
        agent?.agentRuntime || legacy?.agentRuntime || runtimeDefault,
      description: agent?.description || legacy?.description,
      autoRespondToQuestions: legacy?.autoRespondToQuestions,
      autoRespondKeywords: legacy?.autoRespondKeywords,
      channelFolder: layers.channelFolder,
      categoryFolder: layers.categoryFolder,
      agentContextFolder: agent?.agentContextFolder,
    };
    synthesized++;
  }

  // Keep legacy-only rows as a compatibility fallback while non-Discord channels
  // are still wired around registeredGroups.
  for (const [jid, group] of Object.entries(legacyGroups)) {
    if (nextGroups[jid]) continue;
    nextGroups[jid] = group;
    legacyOnly++;
  }

  registeredGroups = nextGroups;
  return { synthesized, legacyOnly };
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();

  // Load agent-channel decoupling state (auto-migrated from registered_groups)
  agents = getAllAgents();
  channelRoutes = getAllChannelRoutes();
  refreshChannelSubscriptions();
  const { synthesized, legacyOnly } =
    refreshRegisteredGroupsFromCanonicalState();

  // Register JID→folder mappings in the queue so multiple JIDs
  // for the same agent share one container (GroupState keyed by folder).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    queue.registerJidMapping(jid, group.folder);
  }
  backfillDiscordBotIds();

  logger.info(
    {
      groupCount: Object.keys(registeredGroups).length,
      agentCount: Object.keys(agents).length,
      routeCount: Object.keys(channelRoutes).length,
      subscriptionChannelCount: Object.keys(channelSubscriptions).length,
      synthesizedGroups: synthesized,
      legacyOnlyGroups: legacyOnly,
    },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  // Validate folder name to prevent path traversal attacks
  if (!/^[a-zA-Z0-9_-]+$/.test(group.folder)) {
    throw new Error(
      `Invalid group folder name: "${group.folder}". Only alphanumeric characters, hyphens, and underscores are allowed.`,
    );
  }

  const normalizedGroup: RegisteredGroup = { ...group };
  if (jid.startsWith('dc:') && !normalizedGroup.discordBotId) {
    normalizedGroup.discordBotId = DISCORD_DEFAULT_BOT_ID;
  }
  if (!normalizedGroup.agentRuntime && normalizedGroup.discordBotId) {
    normalizedGroup.agentRuntime = getDiscordRuntimeDefault(
      normalizedGroup.discordBotId,
    );
  }

  registeredGroups[jid] = normalizedGroup;
  setRegisteredGroup(jid, normalizedGroup);

  // Register JID→folder mapping for multi-channel container sharing
  queue.registerJidMapping(jid, group.folder);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);

  // Additional safety check: ensure the resolved path is within the groups directory
  const groupsRoot = path.resolve(path.join(DATA_DIR, '..', 'groups'));
  const resolvedGroupDir = path.resolve(groupDir);
  if (!resolvedGroupDir.startsWith(groupsRoot + path.sep)) {
    throw new Error(
      `Path traversal detected in group folder: "${group.folder}"`,
    );
  }

  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Seed CLAUDE.md for Discord groups with secondary-channel instructions
  if (jid.startsWith('dc:')) {
    const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      fs.writeFileSync(
        claudeMdPath,
        `## Channel: Discord (Secondary)
This group communicates via Discord, a secondary channel.
You can freely answer questions and have conversations here.
For significant actions (file changes, scheduled tasks, sending messages to other groups),
confirm intent with the current user in this chat before proceeding.

## Getting Context You Don't Have
When you need project context, repo access, credentials, or information that hasn't been shared with you:
- Ask in the current chat for anything missing.
- Be specific: describe exactly what you need and why.
- Check local docs and repo files first before asking.

## Working with Repos
You have \`git\` and \`GITHUB_TOKEN\` available in your environment.
When the admin shares a repo URL, clone it yourself:
\`\`\`bash
git clone https://github.com/org/repo.git /workspace/group/repos/repo
\`\`\`
Then read the code directly — don't ask the admin to copy files for you.
`,
      );
    }
  }

  // Create server-level directory for Discord groups with a serverFolder
  if (normalizedGroup.serverFolder) {
    ensureServerDirectory(normalizedGroup.serverFolder);
  }

  // Also create Agent and ChannelRoute entries
  const agent = registeredGroupToAgent(jid, normalizedGroup);
  agents[agent.id] = agent;
  setAgent(agent);

  const route = registeredGroupToRoute(jid, normalizedGroup);
  channelRoutes[jid] = route;
  setChannelRoute(route);

  const sub: ChannelSubscription = {
    channelJid: jid,
    agentId: agent.id,
    trigger: route.trigger,
    requiresTrigger: route.requiresTrigger,
    priority: 100,
    isPrimary: true,
    discordBotId: route.discordBotId,
    discordGuildId: route.discordGuildId,
    createdAt: route.createdAt,
  };
  const existing = channelSubscriptions[jid] || [];
  const filtered = existing.filter((s) => s.agentId !== agent.id);
  filtered.push(sub);
  channelSubscriptions[jid] = filtered;
  setChannelSubscription(sub);
  logger.info(
    {
      jid,
      name: normalizedGroup.name,
      folder: normalizedGroup.folder,
      serverFolder: normalizedGroup.serverFolder,
      discordBotId: normalizedGroup.discordBotId,
      agentRuntime: normalizedGroup.agentRuntime,
    },
    'Group registered',
  );
}

/** Derive a server folder slug from a guild name */
function slugifyGuildName(guildName: string): string {
  return guildName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/** Ensure the server-level shared directory exists and has a CLAUDE.md */
function ensureServerDirectory(serverFolder: string): void {
  const groupsBase = path.join(DATA_DIR, '..', 'groups');
  const serverDir = path.join(groupsBase, serverFolder);
  assertPathWithin(serverDir, groupsBase, 'ensureServerDirectory');
  fs.mkdirSync(serverDir, { recursive: true });

  const claudeMdPath = path.join(serverDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(
      claudeMdPath,
      `# Server Shared Context

This file is shared across all channels in this Discord server.
Use it for team-level context: members, projects, repos, conventions.
Channel-specific notes should go in the channel's own CLAUDE.md.

## Getting Context You Don't Have
If you need project info, repo URLs, or credentials not listed here, ask directly in the current chat.
Be explicit about what you need and why.

## Working with Repos
You have \`git\` and \`GITHUB_TOKEN\` available. When given a repo URL, clone it:
\`\`\`bash
git clone https://github.com/org/repo.git /workspace/group/repos/repo
\`\`\`
`,
    );
    logger.info({ serverFolder }, 'Seeded server-level CLAUDE.md');
  }
}

/**
 * Backfill Discord guild IDs and server folders for registered groups.
 * Called once after Discord connects.
 */
async function backfillDiscordGuildIds(discord: DiscordChannel): Promise<void> {
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (!jid.startsWith('dc:') || jid.startsWith('dc:dm:')) continue;
    if (group.discordGuildId && group.serverFolder) continue;

    const channelId = jid.startsWith('dc:') ? jid.slice(3) : null;
    if (!channelId) continue;

    // Try to get from chat metadata first
    let guildId = group.discordGuildId || getChatGuildId(jid);

    // Fall back to Discord API
    if (!guildId) {
      guildId = await discord.resolveGuildId(channelId);
    }

    if (!guildId) {
      logger.warn(
        { jid, name: group.name },
        'Could not resolve Discord guild ID',
      );
      continue;
    }

    // Resolve guild name for the server folder slug
    let serverFolder = group.serverFolder;
    if (!serverFolder) {
      const guildName = await discord.resolveGuildName(guildId);
      const slug = guildName ? slugifyGuildName(guildName) : guildId;
      serverFolder = `servers/${slug}`;
    }

    // Update the group
    const updated: RegisteredGroup = {
      ...group,
      discordGuildId: guildId,
      serverFolder,
    };
    registeredGroups[jid] = updated;
    setRegisteredGroup(jid, updated);

    ensureServerDirectory(serverFolder);
    logger.info(
      { jid, name: group.name, guildId, serverFolder },
      'Backfilled Discord guild ID and server folder',
    );
  }
}

/**
 * Refresh Discord guild rosters by fetching members from all known guilds.
 * Stores results in SQLite and writes IPC snapshots for containers.
 */
async function refreshGuildRosters(
  discordChannels: DiscordChannel[],
): Promise<void> {
  if (discordChannels.length === 0) return;

  // Collect unique guild IDs from registered groups and channel subscriptions
  const guildIds = new Set<string>();
  for (const group of Object.values(registeredGroups)) {
    if (group.discordGuildId) guildIds.add(group.discordGuildId);
  }
  for (const subs of Object.values(channelSubscriptions)) {
    for (const sub of subs) {
      if (sub.discordGuildId) guildIds.add(sub.discordGuildId);
    }
  }

  if (guildIds.size === 0) return;

  const discord = discordChannels[0];
  let refreshed = 0;

  for (const guildId of guildIds) {
    const roster = await discord.fetchGuildRoster(guildId);
    if (!roster) continue;

    const members = [
      ...roster.humans.map((h) => ({
        userId: h.id,
        username: h.username,
        displayName: h.displayName,
        isBot: false,
        roles: h.roles,
      })),
      ...roster.bots.map((b) => ({
        userId: b.id,
        username: b.username,
        displayName: b.displayName,
        isBot: true,
        roles: b.roles,
      })),
    ];

    storeGuildRoster(guildId, roster.guildName, roster.ownerId, members);
    refreshed++;
  }

  if (refreshed > 0) {
    // Write roster snapshots to all agent IPC dirs
    const rosters = getAllGuildRosters();
    const ipcBase = path.join(DATA_DIR, 'ipc');
    if (fs.existsSync(ipcBase)) {
      for (const entry of fs.readdirSync(ipcBase, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'errors') continue;
        writeRostersSnapshot(entry.name, rosters);
      }
    }

    logger.info(
      {
        guilds: refreshed,
        totalMembers: rosters.reduce((n, r) => n + r.members.length, 0),
      },
      'Refreshed guild rosters',
    );
  }
}

async function getChannelRosterNames(
  chatJid: string,
  explicitGuildId?: string,
  options: ChannelRosterOptions = {},
): Promise<string[]> {
  const guildId = explicitGuildId || getChatGuildId(chatJid);
  const scope = options.scope || CHANNEL_ROSTER_SCOPE;
  const agentRoleFilters =
    options.agentFolder !== undefined
      ? getAgent(options.agentFolder)?.rosterRoleFilters
      : undefined;
  const roleFilters =
    options.roleFilters !== undefined
      ? options.roleFilters
      : agentRoleFilters !== undefined
        ? agentRoleFilters
        : CHANNEL_ROSTER_ROLE_FILTERS;
  const normalizedRoleFilters = roleFilters
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  const preferredBotId = getPreferredChannelBotId(
    chatJid,
    options.discordBotId,
  );

  const cacheKey = [
    guildId || '__no_guild__',
    chatJid,
    scope,
    preferredBotId || '',
    normalizedRoleFilters.join(','),
  ].join('::');
  const cached = channelRosterCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return formatChannelRosterNames(cached.members);
  }

  let members: ChannelRosterMemberView[] = [];

  if (!guildId) {
    const discord = findChannelForJid(chatJid, preferredBotId);
    if (discord instanceof DiscordChannel) {
      const visibleMembers = await discord.fetchChannelRoster(chatJid);
      if (visibleMembers && visibleMembers.length > 0) {
        members = visibleMembers.map((m) => ({
          userId: m.id,
          displayName: (m.displayName || m.username || '').trim(),
          roles: m.roles || [],
        }));
      }
    }
  }

  if (guildId && scope === 'channel' && chatJid.startsWith('dc:')) {
    const discord = findChannelForJid(chatJid, preferredBotId);
    if (discord instanceof DiscordChannel) {
      const visibleMembers = await discord.fetchChannelRoster(chatJid);
      if (visibleMembers && visibleMembers.length > 0) {
        members = visibleMembers.map((m) => ({
          userId: m.id,
          displayName: (m.displayName || m.username || '').trim(),
          roles: m.roles || [],
        }));
      }
    }
  }

  if (guildId && members.length === 0) {
    const preferredDiscord = findChannelForJid(chatJid, preferredBotId);
    if (preferredDiscord instanceof DiscordChannel) {
      const preferredRoster = await preferredDiscord.fetchGuildRoster(guildId);
      if (preferredRoster) {
        const preferredMembers = [
          ...preferredRoster.humans,
          ...preferredRoster.bots,
        ].map((member) => ({
          userId: member.id,
          displayName: (member.displayName || member.username || '').trim(),
          roles: member.roles || [],
        }));
        if (preferredMembers.length > 0) {
          members = preferredMembers;
        }
      }
    }
  }

  if (guildId && members.length === 0) {
    members = getGuildRoster(guildId).map((member) => ({
      userId: member.userId,
      displayName: (member.displayName || member.username || '').trim(),
      roles: member.roles || [],
    }));
  }

  const roleFilterSet = new Set(normalizedRoleFilters);
  const seen = new Set<string>();
  const filtered: ChannelRosterMemberView[] = [];

  for (const member of members) {
    if (!member.displayName) continue;
    if (seen.has(member.userId)) continue;
    seen.add(member.userId);

    if (roleFilterSet.size > 0) {
      const normalizedMemberRoles = (member.roles || []).map((r) =>
        r.toLowerCase(),
      );
      const hasMatchingRole = normalizedMemberRoles.some((role) =>
        roleFilterSet.has(role),
      );
      if (!hasMatchingRole) continue;
    }

    filtered.push(member);
  }

  channelRosterCache.set(cacheKey, {
    members: filtered,
    expiresAt: Date.now() + CHANNEL_ROSTER_CACHE_TTL_MS,
  });

  return formatChannelRosterNames(filtered);
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./ipc-snapshots.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set([
    ...Object.keys(registeredGroups),
    ...Object.keys(channelSubscriptions),
  ]);

  return chats
    .filter((c) => {
      if (c.jid === '__group_sync__') return false;
      // WhatsApp groups
      if (c.jid.endsWith('@g.us')) return true;
      // Discord channels (not DMs)
      if (c.jid.startsWith('dc:') && !c.jid.startsWith('dc:dm:')) return true;
      // Telegram groups
      if (c.jid.startsWith('tg:')) return true;
      return false;
    })
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered:
        registeredJids.has(c.jid) || getRegisteredGroupForJid(c.jid) != null,
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(dispatchJid: string): Promise<boolean> {
  const { channelJid: chatJid, agentId } = parseDispatchKey(dispatchJid);
  const sub = agentId
    ? getSubscriptionsForChannelInMemory(chatJid).find(
        (s) => s.agentId === agentId,
      )
    : undefined;
  const group = sub
    ? buildRegisteredGroupFromSubscription(chatJid, sub)
    : getRegisteredGroupForJid(chatJid);
  if (!group) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[dispatchJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp).filter(
    (m) =>
      m.content.trim().length > 0 &&
      // Skip IPC notify messages tagged as sent by this agent (self-echo prevention)
      (!agentId || m.sender !== `agent:${agentId}`),
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present.
  // Use buildTriggerPattern(group.trigger) so @PeytonOmni / @OmarOmni groups
  // aren't silently dropped by the global @Omni TRIGGER_PATTERN (mirrors the
  // same fix already applied in startMessageLoop by PR #138).
  // For dispatch-selected agent runs, trigger routing already happened in
  // selectSubscriptionsForMessage(). Don't re-apply trigger gating here.
  if (!agentId && !isMainGroup && group.requiresTrigger !== false) {
    const groupTriggerPattern = buildTriggerPattern(group.trigger);
    const hasTrigger = missedMessages.some((m) =>
      groupTriggerPattern.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const log = logger.child({
    op: 'agentRun',
    group: group.name,
    groupName: group.folder,
    chatJid,
    messageCount: missedMessages.length,
  });

  let prompt = formatMessages(missedMessages, {
    channelRosterNames: await getChannelRosterNames(
      chatJid,
      group.discordGuildId,
      {
        discordBotId: group.discordBotId,
        agentFolder: group.folder,
      },
    ),
    channelRosterHasRoleLabels: true,
  });

  // Inject context about active background tasks
  const activeTask = queue.getActiveTaskInfo(dispatchJid);
  if (activeTask) {
    const elapsed = Math.round((Date.now() - activeTask.startedAt) / 60000);
    prompt = `[Background Task Running: "${activeTask.promptPreview}" — started ${elapsed} min ago]\n\n${prompt}`;
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[dispatchJid] || '';
  lastAgentTimestamp[dispatchJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  log.info('Processing messages');

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log.debug('Idle timeout, closing container stdin');
      queue.closeStdin(dispatchJid, 'message');
    }, IDLE_TIMEOUT);
  };

  const channel = findChannelForJid(
    chatJid,
    getPreferredChannelBotId(chatJid, group.discordBotId),
  );

  // Keep the typing indicator alive for the agent run. Discord's indicator
  // expires after ~10 seconds; 15s refresh is sufficient with some overlap.
  // Cap at 20 refreshes (~5 min) to avoid excessive API calls on long tasks
  // and reduce risk of triggering Discord's abuse detection.
  const TYPING_REFRESH_MS = 15_000;
  const TYPING_MAX_REFRESHES = 20;
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  if (channel?.setTyping) {
    try {
      await channel.setTyping(chatJid, true);
      let typingCount = 0;
      typingInterval = setInterval(() => {
        typingCount++;
        if (typingCount >= TYPING_MAX_REFRESHES) {
          if (typingInterval) clearInterval(typingInterval);
          typingInterval = null;
          log.debug({ chatJid }, 'Typing indicator capped after max refreshes');
          return;
        }
        channel.setTyping!(chatJid, true).catch((err) => {
          log.debug(
            { err, chatJid, dispatchJid },
            'Typing indicator refresh failed (non-fatal)',
          );
        });
      }, TYPING_REFRESH_MS);
    } catch (err) {
      log.debug({ error: err }, 'Typing indicator failed to start');
    }
  }

  let hadError = false;
  let outputSentToUser = false;

  // Patterns that indicate system/auth errors — never send these to channels
  // Adopted from [Upstream PR #298] - Prevents infinite loops from auth failures
  const systemErrorPatterns = [
    /^Failed to authenticate\b/,
    /^API Error: \d{3}\b/,
    /authentication_error/,
    /Invalid (?:API key|bearer token)/,
    /rate_limit_error/,
  ];

  // Thread streaming via shared helper
  // Synthetic IDs (synth-*, react-*, notify-*) aren't real channel message IDs
  // and will cause Discord/Telegram API failures if passed as reply references.
  // Find the LAST message that triggered the agent (most recent @mention or reply-to-bot).
  // Messages are ordered oldest-first, so findLast() gives us the newest trigger.
  //
  // Two ways a message can be a trigger:
  // 1. mentions[] contains this bot's name — catches reply-to-bot messages where
  //    "[Replying to ...]" is prepended and ^-anchored regex won't match the start.
  // 2. content contains the trigger pattern anywhere — catches explicit @mentions
  //    and DM/auto-respond messages where "@Omni" is prepended to content.
  const agentName = (group.trigger ?? `@${ASSISTANT_NAME}`).replace(/^@/, '');
  const groupTriggerRe = new RegExp(
    `@${agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
    'i',
  );
  // Bot names to match in the mentions array: the per-group agent name AND the global
  // assistant name. Replies-to-bot store the bot's display name (ASSISTANT_NAME) in mentions.
  const botNames = new Set([
    agentName.toLowerCase(),
    ASSISTANT_NAME.toLowerCase(),
  ]);
  const isTriggerMessage = (m: {
    content: string;
    mentions?: Array<{ name: string }>;
  }): boolean =>
    groupTriggerRe.test(m.content) ||
    TRIGGER_PATTERN.test(m.content) ||
    (m.mentions?.some((mention) => botNames.has(mention.name.toLowerCase())) ??
      false);
  const triggeringMessage = missedMessages.findLast(isTriggerMessage);
  // Always reply to the last message in the batch, not the triggering message.
  // triggeringMessage is used to decide whether to process; the reply should
  // thread to what the user most recently said.
  const lastMessageId =
    missedMessages[missedMessages.length - 1]?.id ||
    triggeringMessage?.id ||
    null;
  const triggeringMessageId =
    lastMessageId && /^(synth|react|notify)-/.test(lastMessageId)
      ? null
      : lastMessageId;
  // Use reply threading only for the first outbound message in this run.
  // Subsequent outputs should not keep replying to the original trigger.
  let replyAnchorMessageId: string | null = triggeringMessageId;
  const lastContent = missedMessages[missedMessages.length - 1]?.content || '';
  let output: 'success' | 'error';
  try {
    output = await runAgent(
      group,
      prompt,
      chatJid,
      dispatchJid,
      async (result) => {
        // Wrap in try/catch to prevent unhandled rejections
        // Adopted from [Upstream PR #243] - Critical stability fix
        try {
          if (result.intermediate) {
            return;
          }

          // Final output — send to main channel as before
          if (result.result) {
            const raw =
              typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
            // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
            const text = raw
              .replace(/<internal>[\s\S]*?<\/internal>/g, '')
              .trim();
            log.info(`Agent output: ${raw.slice(0, 200)}`);

            // Suppress system/auth errors — log them but don't send to channels
            // This prevents infinite loops when auth fails (error echoed back → triggers agent → fails again)
            const isSystemError = systemErrorPatterns.some((p) => p.test(text));
            if (isSystemError) {
              const redactedText = redactSensitiveData(text.slice(0, 300));
              log.error(
                `Suppressed system error (not sent to user): ${redactedText}`,
              );
              hadError = true;
              // Skip sending to channel but continue processing
            } else if (text) {
              // Route to the chatJid from the container output (multi-channel support).
              // Falls back to the original launch chatJid for single-channel agents.
              const targetJid = parseDispatchKey(
                result.chatJid || chatJid,
              ).channelJid;
              const targetChannel =
                findChannelForJid(
                  targetJid,
                  getPreferredChannelBotId(targetJid, group.discordBotId),
                ) || channel;
              if (targetChannel) {
                const formatted = formatOutbound(
                  targetChannel,
                  text,
                  getAgentName(group),
                );
                if (formatted) {
                  // Don't use triggeringMessageId for cross-channel responses — it belongs to the original chat
                  const replyId =
                    targetJid === chatJid ? replyAnchorMessageId : null;
                  await targetChannel.sendMessage(
                    targetJid,
                    formatted,
                    replyId || undefined,
                  );
                  if (replyAnchorMessageId) replyAnchorMessageId = null;
                  outputSentToUser = true;
                  // Stop typing refresh — prevents the 8s interval from
                  // re-triggering typing AFTER the response is visible.
                  if (typingInterval) {
                    clearInterval(typingInterval);
                    typingInterval = null;
                  }
                }
              }
            }
            // Only reset idle timer on actual results, not session-update markers (result: null)
            resetIdleTimer();
          }

          // [Upstream PR #354] Mark container as idle when it finishes work
          // (status: success with null result = session-update marker = idle-waiting)
          if (result.status === 'success') {
            queue.notifyIdle(dispatchJid);
            // Stop typing indicator when agent goes idle — otherwise the 8s
            // refresh loop keeps the indicator alive until the container exits,
            // which can be minutes later. Fixes #9.
            if (typingInterval) {
              clearInterval(typingInterval);
              typingInterval = null;
            }
          }

          if (result.status === 'error') {
            hadError = true;
          }
        } catch (err) {
          log.error({ err }, 'Error in streaming output callback');
          hadError = true;
        }
      },
    );
  } finally {
    // Stop the typing keep-alive loop — must be in finally to prevent stuck
    // typing indicators when runAgent throws or the process is interrupted.
    if (typingInterval) clearInterval(typingInterval);
    if (channel?.setTyping)
      await channel.setTyping(chatJid, false).catch((err) => {
        logger.debug({ err, chatJid }, 'Failed to clear typing indicator');
      });
    if (idleTimer) clearTimeout(idleTimer);
  }

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      consecutiveErrors[dispatchJid] = 0;
      log.warn(
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }

    const errorCount = (consecutiveErrors[dispatchJid] || 0) + 1;
    consecutiveErrors[dispatchJid] = errorCount;

    if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
      // Too many consecutive failures — advance cursor to prevent a permanently
      // stuck queue where every future message re-triggers the same failing batch.
      log.error(
        { errorCount },
        'Max consecutive errors reached, advancing cursor past failing messages',
      );

      // Notify the user so the message isn't silently dropped (fixes #94)
      if (channel) {
        const errorMsg =
          "Sorry, I hit a server error a few times and couldn't process your message. Please try again.";
        const formatted = formatOutbound(
          channel,
          errorMsg,
          getAgentName(group),
        );
        if (formatted) {
          channel
            .sendMessage(chatJid, formatted, triggeringMessageId || undefined)
            .catch((err) => {
              log.warn({ err }, 'Failed to send error notification to user');
            });
        }
      }

      consecutiveErrors[dispatchJid] = 0;
      return false;
    }

    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[dispatchJid] = previousCursor;
    saveState();
    log.warn(
      { errorCount },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  consecutiveErrors[dispatchJid] = 0;
  return true;
}

/**
 * Build the channels array for a multi-channel agent ID.
 * Returns undefined if the agent only has one channel (no routing needed).
 */
/**
 * Resolve the RegisteredGroup for a scheduled task.
 * Prefers the channel subscription for (chatJid, agentFolder) so that
 * channelFolder/categoryFolder/agentContextFolder reflect the target channel's
 * 4-layer hierarchy rather than the agent's own primary channel.
 */
function getGroupForTask(
  chatJid: string,
  agentFolder: string,
): RegisteredGroup | undefined {
  const subs = channelSubscriptions[chatJid] || [];
  const matchingSub = subs.find((s) => {
    const agent = agents[s.agentId];
    return s.agentId === agentFolder || agent?.folder === agentFolder;
  });
  if (matchingSub) {
    return buildRegisteredGroupFromSubscription(chatJid, matchingSub);
  }
  // Fallback: direct lookup for agents without channel subscriptions
  return Object.values(registeredGroups).find((g) => g.folder === agentFolder);
}

function buildChannelsForAgent(agentId: string): ChannelInfo[] | undefined {
  const agentToChannels =
    buildAgentToChannelsMapFromSubscriptions(channelSubscriptions);
  const jids = agentToChannels.get(agentId);
  if (!jids || jids.length === 0) return undefined;

  // Build a JID→chatName map from the chats table (has real channel names)
  const chatNames = new Map(getAllChats().map((c) => [c.jid, c.name]));

  return jids.map((jid, i) => {
    const group = getRegisteredGroupForJid(jid);
    // Prefer chat metadata name (e.g. "MarketReaders") over registered group name
    // (which is the agent name, e.g. "LocalPeyton")
    const channelFolderName = group?.channelFolder
      ? group.channelFolder.split('/').pop()
      : undefined;
    const name = chatNames.get(jid) || channelFolderName || group?.name || jid;
    return { id: String(i + 1), jid, name };
  });
}

function buildAgentDiscoveryCapabilities(agent: Agent): string[] {
  const role = agent.isAdmin ? 'role:admin' : 'role:worker';
  return [
    `backend:${agent.backend}`,
    `runtime:${agent.agentRuntime}`,
    role,
    'capability:read-only-roster',
  ];
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  processKeyJid: string = chatJid,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const runtimeGroupFolder = getRuntimeGroupFolder(group.folder, processKeyJid);
  activeRuntimeFolders.add(runtimeGroupFolder);

  // Expire stale sessions before each run to prevent unbounded context growth
  const expired = expireStaleSessions(SESSION_MAX_AGE);
  if (expired.length > 0) {
    for (const folder of expired) {
      delete sessions[folder];
    }
    logger.info(
      { expired, trigger: group.folder },
      'Expired stale sessions before agent run',
    );
  }

  const sessionId = sessions[runtimeGroupFolder];

  // Update tasks snapshot for container to read (filtered by group)
  writeTasksSnapshot(
    runtimeGroupFolder,
    isMain,
    mapTasksForSnapshot(getAllTasks()),
    group.folder,
  );

  // Resolve agent ID early so we can compute subscribed channels for snapshots
  const { agentId: dispatchAgentId } = parseDispatchKey(processKeyJid);
  const agentId =
    dispatchAgentId ??
    (channelSubscriptions[chatJid] || [])[0]?.agentId ??
    Object.values(agents).find((a) => a.folder === group.folder)?.id ??
    group.folder;
  const discoveryAgent = agents[agentId];
  if (discoveryAgent) {
    const nowIso = new Date().toISOString();
    setAgentHealth({
      agentId,
      isOnline: true,
      lastHeartbeatAt: nowIso,
      updatedAt: nowIso,
      capabilities: buildAgentDiscoveryCapabilities(discoveryAgent),
    });
  }

  // Update available groups snapshot
  // Non-main agents can see their subscribed channels; main sees all
  const availableGroups = getAvailableGroups();
  const agentToChannels =
    buildAgentToChannelsMapFromSubscriptions(channelSubscriptions);
  const subscribedJids = new Set(agentToChannels.get(agentId) || []);
  writeGroupsSnapshot(
    runtimeGroupFolder,
    isMain,
    availableGroups,
    new Set([
      ...Object.keys(registeredGroups),
      ...Object.keys(channelSubscriptions),
    ]),
    subscribedJids,
  );

  // Update agent registry for all groups
  buildAgentRegistry([runtimeGroupFolder]);

  // Wrap onOutput to track session ID and resumeAt from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[runtimeGroupFolder] = output.newSessionId;
          setSession(runtimeGroupFolder, output.newSessionId);
        }
        if (output.resumeAt) {
          resumePositionStore.set(runtimeGroupFolder, output.resumeAt);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const backend = resolveBackend(group);
    // Use the dispatch key's agent ID (from processKeyJid) so that in multi-agent
    // channels each agent gets its own channel map, not the first subscription's.
    const agentChannels = buildChannelsForAgent(agentId);
    const currentChannelName =
      agentChannels?.find((ch) => ch.jid === chatJid)?.name ||
      availableGroups.find((g) => g.jid === chatJid)?.name;

    // Fetch GitHub context for this agent (cached, non-blocking on failure)
    let githubContext: string | undefined;
    let githubActivityDelta: string | undefined;
    try {
      // Fetch snapshot context and activity delta in parallel
      const [snapshotResult, deltaResult] = await Promise.allSettled([
        getGitHubContextForAgent(agentId),
        fetchGitHubDelta(chatJid, new Date().toISOString()),
      ]);
      if (snapshotResult.status === 'fulfilled') {
        githubContext = snapshotResult.value ?? undefined;
      } else {
        logger.warn(
          { err: snapshotResult.reason, agentId },
          'Failed to fetch GitHub context',
        );
      }
      if (deltaResult.status === 'fulfilled') {
        githubActivityDelta = deltaResult.value ?? undefined;
      } else {
        logger.warn(
          { err: deltaResult.reason, chatJid },
          'Failed to fetch GitHub delta context',
        );
      }
    } catch (err) {
      logger.warn({ err, agentId }, 'Failed to fetch GitHub context');
    }

    const output = await backend.runAgent(
      group,
      {
        prompt,
        sessionId,
        resumeAt: resumePositionStore.get(runtimeGroupFolder),
        groupFolder: group.folder,
        runtimeFolder: runtimeGroupFolder,
        chatJid,
        isMain,
        discordGuildId: group.discordGuildId,
        serverFolder: group.serverFolder,
        agentRuntime: group.agentRuntime,
        channels: agentChannels,
        currentChannelName,
        agentName: group.name,
        discordBotId: group.discordBotId,
        agentTrigger: group.trigger,
        channelFolder: group.channelFolder,
        categoryFolder: group.categoryFolder,
        agentContextFolder: group.agentContextFolder,
        githubContext,
        githubActivityDelta,
      },
      (proc, containerName) =>
        queue.registerProcess(
          processKeyJid,
          proc,
          containerName,
          runtimeGroupFolder,
          backend,
          'message',
        ),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[runtimeGroupFolder] = output.newSessionId;
      setSession(runtimeGroupFolder, output.newSessionId);
    }
    if (output.resumeAt) {
      resumePositionStore.set(runtimeGroupFolder, output.resumeAt);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  } finally {
    if (discoveryAgent) {
      const now = new Date().toISOString();
      const existing = getAgentHealth(agentId);
      setAgentHealth({
        agentId,
        isOnline: false,
        lastHeartbeatAt: existing?.lastHeartbeatAt || now,
        updatedAt: now,
        capabilities:
          existing?.capabilities ||
          buildAgentDiscoveryCapabilities(discoveryAgent),
      });
    }
    activeRuntimeFolders.delete(runtimeGroupFolder);
  }
}

/** Pre-compiled mention patterns per subscription, invalidated when subscriptions change. */
const mentionPatternCache = new Map<string, RegExp[]>();

function getMentionPatterns(sub: ChannelSubscription): RegExp[] {
  // Key by composite to handle same agent with different triggers/bots across channels
  const cacheKey = `${sub.agentId}|${sub.trigger}|${sub.discordBotId ?? ''}`;
  const cached = mentionPatternCache.get(cacheKey);
  if (cached) return cached;
  const agent = agents[sub.agentId];
  const triggerHandle = sub.trigger.replace(/^@/, '');
  const handles = [agent?.name, sub.discordBotId, triggerHandle]
    .filter((v): v is string => Boolean(v && v.trim()))
    .map((v) => v.trim().toLowerCase());
  const patterns = handles.map(
    (handle) =>
      new RegExp(
        `(^|\\s)@${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\b|\\s|$)`,
        'i',
      ),
  );
  mentionPatternCache.set(cacheKey, patterns);
  return patterns;
}

interface SubscriptionSelection {
  selected: ChannelSubscription[];
  /** True when agents were selected by explicit trigger/mention, not fallback. */
  selectedByTrigger: boolean;
}

/**
 * Check if a subscription is targeted by any of the given messages.
 * Returns true if messages contain @allagents, a direct bot mention,
 * or the subscription's trigger pattern.
 */
function messagesMatchSubscription(
  sub: ChannelSubscription,
  messages: NewMessage[],
): boolean {
  if (messages.some((m) => /@allagents/i.test(m.content))) return true;

  const mentionPatterns = getMentionPatterns(sub);
  if (mentionPatterns.length > 0) {
    const hasMention = messages.some((m) => {
      const text = m.content.toLowerCase();
      return mentionPatterns.some((p) => p.test(text));
    });
    if (hasMention) return true;
  }

  const triggerPattern = buildTriggerPattern(sub.trigger);
  return messages.some((m) => triggerPattern.test(m.content.trim()));
}

function selectSubscriptionsForMessage(
  chatJid: string,
  groupMessages: NewMessage[],
): SubscriptionSelection {
  const subs = getSubscriptionsForChannelInMemory(chatJid);
  if (subs.length === 0) return { selected: [], selectedByTrigger: false };

  // @allagents fan-out: regex check on stored message content — no Discord API call,
  // no GuildMembers privileged intent needed. Safe because it only reads already-stored text.
  const hasAllAgents = groupMessages.some((m) => /@allagents/i.test(m.content));
  const matched = subs.filter((sub) =>
    messagesMatchSubscription(sub, groupMessages),
  );

  let selected: ChannelSubscription[];
  let selectedByTrigger = false;
  if (hasAllAgents || matched.length > 0) {
    selected = hasAllAgents ? [...subs] : matched;
    selectedByTrigger = true;
  } else {
    const primaries = subs.filter((s) => s.isPrimary);
    selected = primaries.length > 0 ? primaries : [subs[0]];
    selected = selected.filter((s) => {
      const agent = agents[s.agentId];
      const isMain = agent?.isAdmin === true;
      return isMain || s.requiresTrigger === false;
    });
  }

  if (selected.length === 0) {
    logger.debug(
      { chatJid, subsCount: subs.length },
      'No agents selected after trigger filter — all candidates require explicit trigger',
    );
  }

  const sorted = selected
    .sort(
      (a, b) =>
        a.priority - b.priority || a.createdAt.localeCompare(b.createdAt),
    )
    .slice(0, MAX_CHANNEL_AGENT_FANOUT);
  return { selected: sorted, selectedByTrigger };
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`OmniClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      refreshChannelSubscriptions();
      const jids = Array.from(
        new Set([
          ...Object.keys(registeredGroups),
          ...Object.keys(channelSubscriptions),
        ]),
      );
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const { selected: triggerSelected, selectedByTrigger } =
            selectSubscriptionsForMessage(chatJid, groupMessages);
          let selectedSubs = triggerSelected;

          // Attentive follow-up: if agents were selected by explicit trigger/mention,
          // mark them attentive so the next human message is routed without a trigger.
          if (selectedByTrigger && selectedSubs.length > 0) {
            if (!attentiveAgents[chatJid]) attentiveAgents[chatJid] = new Set();
            for (const s of selectedSubs) {
              attentiveAgents[chatJid].add(s.agentId);
            }
          }

          // If no trigger match (or only fallback agents selected), check if
          // any agents are attentive from a recent mention — route the
          // follow-up message to them.
          if (!selectedByTrigger) {
            const attentive = attentiveAgents[chatJid];
            if (attentive && attentive.size > 0) {
              const subs = getSubscriptionsForChannelInMemory(chatJid);
              const attentiveSubs = subs.filter((s) =>
                attentive.has(s.agentId),
              );
              if (attentiveSubs.length > 0) {
                // Merge attentive agents into selection (alongside any fallback agents)
                const existing = new Set(selectedSubs.map((s) => s.agentId));
                for (const s of attentiveSubs) {
                  if (!existing.has(s.agentId)) {
                    selectedSubs = [...selectedSubs, s];
                  }
                }
                // Consume attentive state — one follow-up per mention
                for (const s of attentiveSubs) {
                  attentive.delete(s.agentId);
                }
                if (attentive.size === 0) delete attentiveAgents[chatJid];
                logger.debug(
                  { chatJid, agents: attentiveSubs.map((s) => s.agentId) },
                  'Follow-up message routed via attentive state',
                );
              }
            }
          }

          // Legacy fallback: one-to-one registered group handling
          if (selectedSubs.length === 0) {
            const group = getRegisteredGroupForJid(chatJid);
            if (!group) continue;

            const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
            const needsTrigger =
              !isMainGroup && group.requiresTrigger !== false;
            if (needsTrigger) {
              const groupTriggerPattern = buildTriggerPattern(group.trigger);
              const hasTrigger = groupMessages.some((m) =>
                groupTriggerPattern.test(m.content.trim()),
              );
              if (!hasTrigger) continue;
            }

            const allPending = getMessagesSince(
              chatJid,
              lastAgentTimestamp[chatJid] || '',
            );
            if (allPending.length === 0) continue;
            const messagesToSend = allPending;
            const formatted = formatMessages(messagesToSend, {
              channelRosterNames: await getChannelRosterNames(
                chatJid,
                group.discordGuildId,
                {
                  discordBotId: group.discordBotId,
                  agentFolder: group.folder,
                },
              ),
              channelRosterHasRoleLabels: true,
            });

            if (await queue.sendMessage(chatJid, formatted)) {
              logger.info(
                { chatJid, count: messagesToSend.length },
                'Piped messages to active container',
              );
              lastAgentTimestamp[chatJid] =
                messagesToSend[messagesToSend.length - 1].timestamp;
              saveState();
              const typingCh = findChannelForJid(
                chatJid,
                getPreferredChannelBotId(chatJid, group.discordBotId),
              );
              if (typingCh?.setTyping)
                typingCh
                  .setTyping(chatJid, true)
                  .catch((err) =>
                    logger.warn(
                      { chatJid, err },
                      'Failed to set typing indicator',
                    ),
                  );
            } else {
              logger.info(
                { chatJid, count: messagesToSend.length },
                'No active container, enqueuing for new one',
              );
              queue.enqueueMessageCheck(chatJid);
            }
            continue;
          }

          for (const sub of selectedSubs) {
            const dispatchJid = makeDispatchKey(chatJid, sub.agentId);
            const allPending = getMessagesSince(
              chatJid,
              lastAgentTimestamp[dispatchJid] || '',
            );
            // Filter out messages this agent sent via IPC (tagged sender: 'agent:<id>')
            // to prevent self-echo compute waste.
            const filteredPending = allPending.filter(
              (m) => m.sender !== `agent:${sub.agentId}`,
            );
            if (filteredPending.length === 0) continue;
            const messagesToSend = filteredPending;
            const formatted = formatMessages(messagesToSend, {
              channelRosterNames: await getChannelRosterNames(
                chatJid,
                sub.discordGuildId,
                {
                  discordBotId: sub.discordBotId,
                  agentFolder: sub.agentId,
                },
              ),
              channelRosterHasRoleLabels: true,
            });

            if (await queue.sendMessage(dispatchJid, formatted)) {
              logger.info(
                { chatJid, agentId: sub.agentId, count: messagesToSend.length },
                'Piped messages to active agent container',
              );
              lastAgentTimestamp[dispatchJid] =
                messagesToSend[messagesToSend.length - 1].timestamp;
              saveState();
              const typingCh = findChannelForJid(
                chatJid,
                getPreferredChannelBotId(chatJid, sub.discordBotId),
              );
              if (typingCh?.setTyping)
                typingCh
                  .setTyping(chatJid, true)
                  .catch((err) =>
                    logger.warn(
                      { chatJid, err },
                      'Failed to set typing indicator',
                    ),
                  );
            } else {
              logger.info(
                { chatJid, agentId: sub.agentId, count: messagesToSend.length },
                'No active agent container, enqueuing',
              );
              queue.enqueueMessageCheck(dispatchJid);
            }
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, subs] of Object.entries(channelSubscriptions)) {
    for (const sub of subs) {
      const dispatchJid = makeDispatchKey(chatJid, sub.agentId);
      const sinceTimestamp = lastAgentTimestamp[dispatchJid] || '';
      const pending = getMessagesSince(chatJid, sinceTimestamp);
      if (pending.length === 0) continue;

      // Apply the same trigger filtering as the normal message path —
      // don't dispatch an agent for messages that aren't addressed to it.
      if (!messagesMatchSubscription(sub, pending)) {
        logger.debug(
          { chatJid, agentId: sub.agentId, pendingCount: pending.length },
          'Recovery: skipping — pending messages do not match trigger',
        );
        continue;
      }

      logger.info(
        { chatJid, agentId: sub.agentId, pendingCount: pending.length },
        'Recovery: found unprocessed messages for subscription',
      );
      queue.enqueueMessageCheck(dispatchJid);
    }
  }

  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    if ((channelSubscriptions[chatJid] || []).length > 0) continue;
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

/**
 * Build agent registry and write it to all groups' IPC dirs.
 * Every agent can discover every other agent's name, purpose, backend, and dev URL.
 */
function buildAgentRegistry(extraFolders: string[] = []): void {
  // Build registry from agents (new system) with channel route info
  const agentToChannels =
    buildAgentToChannelsMapFromSubscriptions(channelSubscriptions);

  const registry = Object.values(agents).map((agent) => {
    const jids = agentToChannels.get(agent.id) || [];
    // Get trigger from first route for backwards compat
    const firstSub =
      jids.length > 0
        ? (channelSubscriptions[jids[0]] || []).find(
            (s) => s.agentId === agent.id,
          )
        : undefined;
    const primaryJid = jids[0] || agent.id;
    const trigger = firstSub?.trigger || `@${ASSISTANT_NAME}`;
    const requiresTrigger = firstSub?.requiresTrigger !== false;
    const sendTo = buildSendToInstruction(jids, trigger, requiresTrigger);
    return {
      id: agent.id,
      jid: primaryJid,
      jids, // All JIDs
      name: agent.name,
      description: agent.description || '',
      backend: agent.backend,
      agentRuntime: agent.agentRuntime,
      isMain: agent.isAdmin,
      trigger,
      sendTo, // How to reach this agent via send_message
      discoveryVersion: 1,
    };
  });

  // Fallback: also include registered groups not yet in agents table
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (!agents[group.folder]) {
      registry.push({
        id: group.folder,
        jid,
        jids: [jid],
        name: group.name,
        description: group.description || '',
        backend: group.backend || 'apple-container',
        agentRuntime: group.agentRuntime || 'claude-agent-sdk',
        isMain: group.folder === MAIN_GROUP_FOLDER,
        trigger: group.trigger,
        sendTo: buildSendToInstruction(
          [jid],
          group.trigger,
          group.requiresTrigger !== false,
        ),
        discoveryVersion: 1,
      });
    }
  }

  const registryJson = JSON.stringify(registry, null, 2);
  const healthByAgent = getAllAgentHealth();
  const health: AgentHealth[] = registry.map((entry) => {
    const existing = healthByAgent[entry.id];
    if (existing) return existing;
    const baseline = new Date(0).toISOString();
    return {
      agentId: entry.id,
      isOnline: false,
      lastHeartbeatAt: baseline,
      updatedAt: baseline,
      capabilities: ['capability:read-only-roster'],
    };
  });
  const discoveryJson = JSON.stringify(
    {
      version: 1,
      generatedAt: new Date().toISOString(),
      health,
    },
    null,
    2,
  );

  // Write to ALL agents' IPC dirs
  const folders = new Set<string>();
  for (const agent of Object.values(agents)) {
    folders.add(agent.folder);
  }
  for (const group of Object.values(registeredGroups)) {
    folders.add(group.folder);
  }
  for (const folder of extraFolders) {
    if (folder) folders.add(folder);
  }

  const ipcBase = path.join(DATA_DIR, 'ipc');
  for (const folder of folders) {
    const groupIpcDir = path.join(ipcBase, folder);
    assertPathWithin(groupIpcDir, ipcBase, 'agent registry target');
    fs.mkdirSync(groupIpcDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupIpcDir, 'agent_registry.json'),
      registryJson,
    );
    fs.writeFileSync(
      path.join(groupIpcDir, 'agent_discovery.json'),
      discoveryJson,
    );
  }
}

/**
 * Handle a reaction notification on a bot message (non-approval reactions).
 * Pipes to the active container or stores in DB and enqueues.
 */
async function handleReactionNotification(
  chatJid: string,
  messageId: string,
  emoji: string,
  userName: string,
  channelName: string,
  discordBotId?: string,
): Promise<void> {
  // For multi-agent Discord channels, route to the subscription whose bot
  // received the reaction rather than blindly using the primary registered group.
  // Without this, a reaction on OCPeyton's message routes to Ditto (the primary).
  let dispatchJid = chatJid;
  let group = getRegisteredGroupForJid(chatJid);
  const subs = getSubscriptionsForChannelInMemory(chatJid);
  if (discordBotId && subs.length > 0) {
    const matchingSub = subs.find((s) => s.discordBotId === discordBotId);
    if (matchingSub) {
      dispatchJid = makeDispatchKey(chatJid, matchingSub.agentId);
      group =
        buildRegisteredGroupFromSubscription(chatJid, matchingSub) ?? group;
    }
  }
  if (!group) return;

  logger.info(
    { chatJid, messageId, emoji, userName, group: group.name },
    `Reaction on bot message in ${channelName}`,
  );

  const reactionContent = `@${ASSISTANT_NAME} [${userName} reacted with ${emoji}]`;

  const reactionMessage = {
    id: `react-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chat_jid: chatJid,
    sender: 'system',
    sender_name: 'System',
    content: reactionContent,
    timestamp: new Date().toISOString(),
    is_from_me: false,
    sender_platform: 'system' as const,
  };

  const piped = await queue.sendMessage(
    dispatchJid,
    formatMessages([reactionMessage]),
  );
  if (!piped) {
    storeMessage(reactionMessage);
    queue.enqueueMessageCheck(dispatchJid);
  }
}

async function main(): Promise<void> {
  initDatabase();
  logger.info('Database initialized');
  loadState();

  const webState: WebStateProvider = {
    getAgents: () => agents,
    getChannelSubscriptions: () => channelSubscriptions,
    getTasks: () => getAllTasks(),
    getTaskById: (id) => getTaskById(id),
    getMessages: (chatJid, since, limit) => {
      const msgs = getMessagesSince(chatJid, since);
      return limit ? msgs.slice(0, limit) : msgs;
    },
    getChats: () => getAllChats(),
    getQueueStats: () => queue.getStats(),
    getQueueDetails: () => queue.getDetailedStats(),
    getIpcEvents: (count) => ipcEvents.recent(count),
    getTaskRunLogs: (taskId, limit) => getTaskRunLogs(taskId, limit),
    createTask: (task) => dbCreateTask(task),
    updateTask: (id, updates) => dbUpdateTask(id, updates),
    deleteTask: (id) => dbDeleteTask(id),
    calculateNextRun: (type, value) => calculateNextRun(type, value),
    readContextFile: (layerPath) => {
      const filePath = path.join(GROUPS_DIR, layerPath, 'CLAUDE.md');
      const resolved = path.resolve(filePath);
      try {
        assertPathWithin(resolved, GROUPS_DIR, 'readContextFile');
        return fs.readFileSync(resolved, 'utf-8');
      } catch {
        return null;
      }
    },
    writeContextFile: (layerPath, content) => {
      const filePath = path.join(GROUPS_DIR, layerPath, 'CLAUDE.md');
      const resolved = path.resolve(filePath);
      assertPathWithin(resolved, GROUPS_DIR, 'writeContextFile');
      const dir = path.dirname(resolved);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(resolved, content, 'utf-8');
    },
    updateAgentAvatar: (agentId, url, source) => {
      updateAgentAvatar(agentId, url, source);
      if (agents[agentId]) {
        agents[agentId].avatarUrl = url || undefined;
        agents[agentId].avatarSource =
          (source as Agent['avatarSource']) || undefined;
      }
    },
    resolveChatImage: (chatJid) => resolveChatImageUrl(chatJid),
    resolveDiscordGuildImage: (guildId, botId) =>
      resolveDiscordGuildImageUrl(guildId, botId),
  };

  // Expire stale sessions on startup to prevent unbounded context growth
  const expired = expireStaleSessions(SESSION_MAX_AGE);
  if (expired.length > 0) {
    for (const folder of expired) {
      delete sessions[folder];
    }
    logger.info({ expired }, 'Expired stale sessions on startup');
  }

  // --- Web UI (opt-in via WEB_UI_PORT env var) ---
  let webServer: WebServerHandle | undefined;
  let stopLogStream: (() => void) | undefined;
  let trustStore: TrustStore | undefined;
  if (WEB_UI_PORT) {
    const isPublic = WEB_UI_HOST !== '127.0.0.1' && WEB_UI_HOST !== 'localhost';
    const allowUnauthedPublicWebUiForTrustedLan =
      isPublic && DISCOVERY_TRUST_LAN_ADMIN;
    if (
      isPublic &&
      !allowUnauthedPublicWebUiForTrustedLan &&
      (!WEB_UI_USER || !WEB_UI_PASS)
    ) {
      logger.error(
        'WEB_UI_HOST is set to a public interface but WEB_UI_USER and/or WEB_UI_PASS are missing. ' +
          'Refusing to start unauthenticated Web UI. Set both credentials or unset WEB_UI_PORT.',
      );
      process.exit(1);
    }
    if (
      allowUnauthedPublicWebUiForTrustedLan &&
      (!WEB_UI_USER || !WEB_UI_PASS)
    ) {
      logger.warn(
        'Starting Web UI on a non-loopback interface without WEB_UI_USER/WEB_UI_PASS because DISCOVERY_TRUST_LAN_ADMIN=true. Only do this on a trusted private LAN.',
      );
    }
    const webAuth =
      WEB_UI_USER && WEB_UI_PASS
        ? { username: WEB_UI_USER, password: WEB_UI_PASS }
        : undefined;
    trustStore = createTrustStore();
    webServer = startWebServer(
      {
        port: WEB_UI_PORT,
        auth: webAuth,
        hostname: WEB_UI_HOST,
        corsOrigin: WEB_UI_CORS_ORIGIN,
        trustLanDiscoveryAdmin: DISCOVERY_TRUST_LAN_ADMIN,
      },
      webState,
      trustStore,
    );
    stopLogStream = startLogStream(webServer);
  }

  // --- Network Discovery (runtime toggle + trusted Wi-Fi support) ---
  let discoveryHandle: DiscoveryHandle | undefined;
  let discoveryRuntime: DiscoveryRuntimeController | undefined;
  if (webServer) {
    const instanceId = getOrCreateDiscoveryInstanceId();
    const version = '1.0.0';

    const buildPeers = () => {
      const discovered = discoveryHandle?.getPeers() ?? new Map();
      const stored = trustStore!.getAllPeers();
      const storedMap = new Map(stored.map((p) => [p.instanceId, p]));
      const result: Array<any> = [];

      for (const [id, disc] of discovered) {
        const st = storedMap.get(id);
        result.push({
          instanceId: id,
          name: disc.name,
          host: disc.host,
          port: disc.port,
          addresses: disc.addresses,
          status: st?.status ?? 'discovered',
          online: true,
          approvedAt: st?.approvedAt ?? null,
          lastSeen: st?.lastSeen ?? null,
        });
        storedMap.delete(id);
      }

      for (const st of storedMap.values()) {
        if (st.status === 'revoked') continue;
        result.push({
          instanceId: st.instanceId,
          name: st.name,
          host: st.host ?? '',
          port: st.port ?? 0,
          addresses: [],
          status: st.status,
          online: false,
          approvedAt: st.approvedAt,
          lastSeen: st.lastSeen,
        });
      }

      return result;
    };

    const buildNetworkPageState = () => {
      const runtime = discoveryRuntime?.getSnapshot() ?? {
        enabled: DISCOVERY_ENABLED,
        active: false,
        currentNetwork: null,
        trustedNetworks: [],
      };

      return {
        instanceId,
        instanceName: INSTANCE_NAME,
        discoveryAvailable: true,
        discoveryEnabled: runtime.active,
        runtime,
        peers: buildPeers(),
        pendingRequests: trustStore!.getPendingRequests(),
      };
    };

    const discoveryContext = {
      instanceId,
      instanceName: INSTANCE_NAME,
      version,
      trustStore: trustStore!,
      discovery: null as DiscoveryHandle | null,
      state: webState,
      runtime: undefined as DiscoveryRuntimeController | undefined,
      broadcast: (event: unknown) => webServer!.broadcast(event as any),
    };

    const startDiscoveryIfNeeded = () => {
      if (discoveryHandle || !discoveryRuntime?.isRemoteAccessAllowed()) return;

      discoveryHandle = startDiscovery({
        instanceId,
        instanceName: INSTANCE_NAME,
        port: webServer.port,
        version,
        onPeerFound: (peer) => {
          trustStore!.upsertPeer(
            peer.instanceId,
            peer.name,
            peer.host,
            peer.port,
          );
          webServer!.broadcast({
            type: 'peer_discovered',
            data: peer,
            timestamp: new Date().toISOString(),
          });
        },
        onPeerLost: (peerInstanceId) => {
          webServer!.broadcast({
            type: 'peer_lost',
            data: { instanceId: peerInstanceId },
            timestamp: new Date().toISOString(),
          });
        },
      });

      discoveryContext.discovery = discoveryHandle;
      logger.info(
        { instanceId, instanceName: INSTANCE_NAME },
        'Network discovery enabled',
      );
    };

    const stopDiscoveryIfRunning = () => {
      if (!discoveryHandle) return;
      discoveryHandle.stop();
      discoveryHandle = undefined;
      discoveryContext.discovery = null;
      webServer.broadcast({
        type: 'peer_lost',
        data: { instanceId: '*' },
        timestamp: new Date().toISOString(),
      });
      logger.info(
        { instanceId, instanceName: INSTANCE_NAME },
        'Network discovery disabled',
      );
    };

    discoveryRuntime = new DiscoveryRuntimeController({
      initialEnabled: DISCOVERY_ENABLED,
      detectCurrentNetwork,
      onActiveChange: (active) => {
        if (active) startDiscoveryIfNeeded();
        else stopDiscoveryIfRunning();
        webServer!.broadcast({
          type: 'peer_lost',
          data: { instanceId: '__runtime__' },
          timestamp: new Date().toISOString(),
        });
      },
    });

    discoveryContext.runtime = discoveryRuntime;
    setDiscoveryContext(discoveryContext, buildNetworkPageState);
    webServer.setNetworkPageState(buildNetworkPageState);

    const snapshot = await discoveryRuntime.refresh();
    discoveryRuntime.start();
    if (snapshot.active) startDiscoveryIfNeeded();
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    if (discoveryRuntime) discoveryRuntime.stop();
    if (discoveryHandle) discoveryHandle.stop();
    if (githubWebhookServer) {
      githubWebhookServer.stop();
      githubWebhookServer = null;
    }
    if (stopLogStream) stopLogStream();
    if (webServer) await webServer.stop();
    await queue.shutdown(10000);
    await shutdownBackends();
    for (const ch of channels) {
      await ch.disconnect();
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Register shutdown function for global error handlers
  shutdownFn = () => shutdown('SHUTDOWN_SIGNAL');

  // --- Startup: initialize backends first, then start message loop, then connect channels ---
  const startupT0 = Date.now();

  if (GITHUB_WEBHOOK_PORT > 0 && GITHUB_WEBHOOK_SECRET) {
    const dispatchGitHubWebhook = async (
      notification: GitHubWebhookNotification,
    ): Promise<void> => {
      const targets = Object.entries(channelSubscriptions).flatMap(
        ([chatJid, subs]) => {
          const matches = subs.filter((s) =>
            notification.agentIds.includes(s.agentId),
          );
          return matches
            .sort(
              (a, b) =>
                Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)),
            )
            .map((sub) => ({ chatJid, sub }));
        },
      );

      // Route one notification per agent to avoid flooding multi-channel agents.
      const delivered = new Set<string>();
      for (const { chatJid, sub } of targets) {
        if (delivered.has(sub.agentId)) continue;
        const group = buildRegisteredGroupFromSubscription(chatJid, sub);
        if (!group) continue;
        const trigger = group.trigger || `@${ASSISTANT_NAME}`;
        const withLink = notification.url
          ? `${notification.summary}\n${notification.url}`
          : notification.summary;
        storeMessage({
          id: `ghhook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: chatJid,
          sender: 'system',
          sender_name: 'GitHub Webhook',
          content: `${trigger} ${withLink}`,
          timestamp: new Date().toISOString(),
          is_from_me: false,
          sender_platform: 'system',
        });
        queue.enqueueMessageCheck(makeDispatchKey(chatJid, sub.agentId));
        delivered.add(sub.agentId);
      }
    };

    githubWebhookServer = startGitHubWebhookServer({
      secret: GITHUB_WEBHOOK_SECRET,
      port: GITHUB_WEBHOOK_PORT,
      path: GITHUB_WEBHOOK_PATH,
      onNotification: dispatchGitHubWebhook,
    });
  } else if (GITHUB_WEBHOOK_PORT > 0 && !GITHUB_WEBHOOK_SECRET) {
    logger.warn(
      { port: GITHUB_WEBHOOK_PORT },
      'GITHUB_WEBHOOK_PORT set without GITHUB_WEBHOOK_SECRET; webhook server disabled',
    );
  }

  // Backends MUST be initialized before the message loop starts, because
  // processGroupMessages → runAgent → resolveBackend() needs them.
  await initializeBackends(registeredGroups);
  logger.info({ durationMs: Date.now() - startupT0 }, 'Backends initialized');

  const WHATSAPP_RETRY_INTERVAL_MS = 60_000; // 1 minute between retries
  const WHATSAPP_MAX_RETRIES = 30; // give up after ~30 minutes

  const createWhatsAppChannel = () =>
    new WhatsAppChannel({
      onMessage: (chatJid, msg) => storeMessage(msg),
      onChatMetadata: (chatJid, timestamp) =>
        storeChatMetadata(chatJid, timestamp),
      registeredGroups: () => registeredGroups,
      onReaction: () => {},
    });

  /** Retry WhatsApp connection in the background with backoff */
  const scheduleWhatsAppRetry = (attempt = 1) => {
    if (attempt > WHATSAPP_MAX_RETRIES) {
      logger.error(
        { attempts: attempt - 1 },
        'WhatsApp retry limit reached — giving up. Restart the service to try again.',
      );
      return;
    }
    const delayMs = Math.min(WHATSAPP_RETRY_INTERVAL_MS * attempt, 5 * 60_000); // cap at 5 min
    logger.info(
      { attempt, delayMs, maxRetries: WHATSAPP_MAX_RETRIES },
      `Scheduling WhatsApp reconnect in ${Math.round(delayMs / 1000)}s`,
    );
    setTimeout(async () => {
      try {
        const wa = createWhatsAppChannel();
        await wa.connect();
        whatsapp = wa;
        channels.push(wa);
        logger.info('WhatsApp connected on retry — channel is now active');
      } catch (err) {
        logger.warn({ err, attempt }, 'WhatsApp retry failed');
        scheduleWhatsAppRetry(attempt + 1);
      }
    }, delayMs);
  };

  // Skip WhatsApp entirely if no auth store exists (Discord/Telegram-only setup)
  const hasWhatsAppAuth = fs.existsSync(
    path.join(process.cwd(), 'store', 'auth', 'creds.json'),
  );
  const connectWhatsApp = hasWhatsAppAuth
    ? Effect.gen(function* () {
        const wa = createWhatsAppChannel();
        yield* Effect.tryPromise(() => wa.connect());
        return wa;
      }).pipe(
        Effect.catchAll((err) => {
          logger.error(
            { err },
            'Failed to connect WhatsApp (continuing without WhatsApp)',
          );
          scheduleWhatsAppRetry();
          return Effect.succeed(null);
        }),
      )
    : Effect.sync(() => {
        logger.info(
          'WhatsApp auth not found — skipping WhatsApp connection (Discord/Telegram-only mode)',
        );
        return null;
      });

  const connectDiscord =
    DISCORD_BOTS.length > 0
      ? Effect.forEach(
          DISCORD_BOTS,
          (bot, idx) =>
            Effect.gen(function* () {
              const discord = new DiscordChannel({
                botId: bot.id,
                token: bot.token,
                multiBotMode: DISCORD_BOTS.length > 1,
                onReaction: async (chatJid, messageId, emoji, userName) => {
                  await handleReactionNotification(
                    chatJid,
                    messageId,
                    emoji,
                    userName,
                    'Discord',
                    bot.id,
                  );
                },
              });
              yield* Effect.tryPromise(() => discord.connect());
              return discord;
            }).pipe(
              Effect.catchAll((err) => {
                logger.error(
                  {
                    err,
                    index: idx + 1,
                    total: DISCORD_BOTS.length,
                    botId: bot.id,
                  },
                  'Failed to connect Discord bot token (continuing with remaining Discord bots)',
                );
                return Effect.succeed(null);
              }),
            ),
          { concurrency: 'unbounded' },
        ).pipe(
          Effect.map((connected) =>
            connected.filter((ch): ch is DiscordChannel => ch !== null),
          ),
        )
      : Effect.succeed([] as DiscordChannel[]);

  const connectTelegram =
    TELEGRAM_BOT_TOKENS.length > 0
      ? Effect.forEach(
          TELEGRAM_BOT_TOKENS,
          (token, idx) =>
            Effect.gen(function* () {
              const telegram = new TelegramChannel(token, {
                onMessage: (chatJid, msg) => storeMessage(msg),
                onChatMetadata: (chatJid, timestamp, name) =>
                  storeChatMetadata(chatJid, timestamp, name),
                registeredGroups: () => registeredGroups,
                allowLegacyJidRouting: TELEGRAM_BOT_TOKENS.length <= 1,
              });
              yield* Effect.tryPromise(() => telegram.connect());
              return telegram;
            }).pipe(
              Effect.catchAll((err) => {
                logger.error(
                  {
                    err,
                    index: idx + 1,
                    total: TELEGRAM_BOT_TOKENS.length,
                  },
                  'Failed to connect Telegram bot token (continuing with remaining Telegram bots)',
                );
                return Effect.succeed(null);
              }),
            ),
          { concurrency: 'unbounded' },
        ).pipe(
          Effect.map((connected) =>
            connected.filter((ch): ch is TelegramChannel => ch !== null),
          ),
        )
      : Effect.succeed([] as TelegramChannel[]);

  const connectSlack =
    SLACK_BOTS.length > 0
      ? Effect.forEach(
          SLACK_BOTS,
          (bot, idx) =>
            Effect.gen(function* () {
              const slack = new SlackChannel({
                botId: bot.id,
                token: bot.token,
                appToken: bot.appToken,
                multiBotMode: SLACK_BOTS.length > 1,
                allowLegacyJidRouting:
                  SLACK_BOTS.length <= 1 || bot.id === SLACK_DEFAULT_BOT_ID,
                onMessage: (chatJid, msg) => storeMessage(msg),
                onChatMetadata: (chatJid, timestamp, name) =>
                  storeChatMetadata(chatJid, timestamp, name),
                registeredGroups: () => registeredGroups,
                onReaction: async (chatJid, messageId, emoji, userName) => {
                  await handleReactionNotification(
                    chatJid,
                    messageId,
                    emoji,
                    userName,
                    'Slack',
                  );
                },
              });
              yield* Effect.tryPromise(() => slack.connect());
              return slack;
            }).pipe(
              Effect.catchAll((err) => {
                logger.error(
                  {
                    err,
                    index: idx + 1,
                    total: SLACK_BOTS.length,
                    botId: bot.id,
                  },
                  'Failed to connect Slack bot (continuing with remaining Slack bots)',
                );
                return Effect.succeed(null);
              }),
            ),
          { concurrency: 'unbounded' },
        ).pipe(
          Effect.map((connected) =>
            connected.filter((ch): ch is SlackChannel => ch !== null),
          ),
        )
      : Effect.succeed([] as SlackChannel[]);

  // Start message loop BEFORE connecting channels — the loop polls the DB
  // and spawns containers, which only needs backends (initialized above).
  // Channel connections can take 30s+ (WhatsApp TLS handshake, Discord gateway)
  // and should NOT block message processing for IPC/scheduled messages.
  // See: https://github.com/qwibitai/nanoclaw/issues/553
  queue.setProcessMessagesFn(processGroupMessages);
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });

  // Connect channels concurrently in the background — don't block the message loop.
  // Channels are only needed for sending responses and typing indicators;
  // the message loop reads from the DB and works without them.
  const connectChannels = async () => {
    const [wa, discordChannels, telegramChannels, slackChannels] =
      await Effect.runPromise(
        Effect.all(
          [connectWhatsApp, connectDiscord, connectTelegram, connectSlack],
          {
            concurrency: 'unbounded',
          },
        ),
      );

    whatsapp = wa;
    if (whatsapp) channels.push(whatsapp);
    channels.push(...discordChannels);
    if (discordChannels.length > 0) {
      const defaultDiscord =
        (DISCORD_DEFAULT_BOT_ID
          ? discordChannels.find((ch) => ch.botId === DISCORD_DEFAULT_BOT_ID)
          : undefined) || discordChannels[0];
      await backfillDiscordGuildIds(defaultDiscord);

      // Fetch guild rosters on startup and schedule periodic refresh
      refreshGuildRosters(discordChannels).catch((err) => {
        logger.warn({ err }, 'Initial guild roster refresh failed');
      });
      setInterval(() => {
        refreshGuildRosters(discordChannels).catch((err) => {
          logger.warn({ err }, 'Periodic guild roster refresh failed');
        });
      }, ROSTER_REFRESH_INTERVAL);
    }
    channels.push(...telegramChannels);
    channels.push(...slackChannels);

    logger.info(
      {
        op: 'startup',
        durationMs: Date.now() - startupT0,
        channelCount: channels.length,
      },
      'Channel connections complete',
    );

    // Recover pending messages AFTER channels are connected so that
    // findChannel() can route recovered output to the correct channel.
    // (startMessageLoop already runs above for IPC/scheduled task responsiveness.)
    recoverPendingMessages();

    // Sync agent avatars from platform APIs (non-blocking)
    syncAvatars(agents, channels, (agentId) =>
      getSubscriptionsForAgent(agentId),
    ).catch((err) => {
      logger.warn({ err }, 'Avatar sync failed (non-critical)');
    });
    warmTopologyImageCache().catch((err) => {
      logger.warn({ err }, 'Topology image cache warmup failed (non-critical)');
    });
  };

  // Fire-and-forget: channels connect in background while message loop already runs
  connectChannels().catch((err) => {
    logger.error({ err }, 'Channel connection failed');
  });

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getGroupForTask,
    getSessions: () => sessions,
    resumePositionStore,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder, lane) =>
      queue.registerProcess(
        groupJid,
        proc,
        containerName,
        groupFolder,
        undefined,
        lane,
      ),
    sendMessage: async (jid, rawText, discordBotId) => {
      const ch = findChannelForJid(
        jid,
        getPreferredChannelBotId(jid, discordBotId),
      );
      if (!ch) {
        logger.warn({ jid }, 'No channel found for scheduled message');
        return;
      }
      const group = getRegisteredGroupForJid(jid);
      const text = formatOutbound(
        ch,
        rawText,
        group ? getAgentName(group) : undefined,
      );
      if (text) {
        const msgId = await ch.sendMessage(jid, text);
        return msgId ? String(msgId) : undefined;
      }
    },
    findChannel: (jid, discordBotId) =>
      findChannelForJid(jid, getPreferredChannelBotId(jid, discordBotId)),
  });
  startIpcWatcher({
    sendMessage: async (jid, rawText, discordBotId) => {
      const ch = findChannelForJid(
        jid,
        getPreferredChannelBotId(jid, discordBotId),
      );
      if (!ch) {
        logger.warn({ jid }, 'No channel found for IPC message');
        return;
      }
      const group = getRegisteredGroupForJid(jid);
      const text = formatOutbound(
        ch,
        rawText,
        group ? getAgentName(group) : undefined,
      );
      if (text) return await ch.sendMessage(jid, text);
    },
    notifyGroup: (jid, text, sourceFolder?) => {
      // Prefix with the group's trigger so it passes requiresTrigger filter
      const group = getRegisteredGroupForJid(jid);
      const trigger = group?.trigger || `@${ASSISTANT_NAME}`;
      storeMessage({
        id: `notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chat_jid: jid,
        // Tag with source agent so routing skips echoing back to it
        sender: sourceFolder ? `agent:${sourceFolder}` : 'system',
        sender_name: 'Omni (Main)',
        content: `${trigger} ${text}`,
        timestamp: new Date().toISOString(),
        is_from_me: false,
        sender_platform: 'ipc',
      });
      queue.enqueueMessageCheck(jid);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    updateGroup: (jid, group) => {
      registeredGroups[jid] = group;
      setRegisteredGroup(jid, group);
    },
    syncGroupMetadata: (force) =>
      whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    findChannel: (jid) => findChannelForJid(jid, getPreferredChannelBotId(jid)),
    writeTasksSnapshot: (groupFolder, isMainGroup) => {
      writeTasksSnapshot(
        groupFolder,
        isMainGroup,
        mapTasksForSnapshot(getAllTasks()),
      );
    },
    onSubscriptionChanged: invalidateChannelSubscriptions,
    activeRuntimeFolders: () => activeRuntimeFolders,
    agentFolders: () => new Set(Object.values(agents).map((a) => a.folder)),
    getSubscriptions: (jid) => {
      refreshChannelSubscriptions();
      return (channelSubscriptions[jid] ?? []).map((s) => ({
        agentId: s.agentId,
        agentFolder: agents[s.agentId]?.folder ?? s.agentId,
      }));
    },
    onIpcEvent: (kind: IpcEventKind, sourceGroup, summary, details) => {
      const event = ipcEvents.push(kind, sourceGroup, summary, details);
      webServer?.broadcast({
        type: 'ipc_event',
        data: event,
        timestamp: event.timestamp,
      });
    },
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start OmniClaw');
    process.exit(1);
  });
}
