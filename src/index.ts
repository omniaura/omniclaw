import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import {
  ASSISTANT_NAME,
  buildTriggerPattern,
  DATA_DIR,
  DISPATCH_RUNTIME_SEP,
  DISCORD_BOTS,
  DISCORD_DEFAULT_BOT_ID,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  SESSION_MAX_AGE,
  SLACK_APP_TOKEN,
  SLACK_BOT_TOKEN,
  TELEGRAM_BOT_TOKEN,
  TRIGGER_PATTERN,
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
  writeTasksSnapshot,
} from './ipc-snapshots.js';
import {
  expireStaleSessions,
  getAllAgents,
  getAllChannelSubscriptions,
  getAllChannelRoutes,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getChatGuildId,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setAgent,
  setChannelSubscription,
  setChannelRoute,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { buildAgentToChannelsMapFromSubscriptions } from './channel-routes.js';
import { GroupQueue } from './group-queue.js';
import { consumeShareRequest, startIpcWatcher } from './ipc.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  getAgentName,
} from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { createThreadStreamer } from './thread-streaming.js';
import {
  Agent,
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
import { findMainGroupJid } from './group-helpers.js';
import { logger } from './logger.js';
import { assertPathWithin } from './path-security.js';
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
// In-memory only: resume positions are an optimization to skip session replay.
// On host restart, full replay occurs once per group (acceptable trade-off).
let resumePositions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let agents: Record<string, Agent> = {};
let channelRoutes: Record<string, ChannelRoute> = {};
let channelSubscriptions: Record<string, ChannelSubscription[]> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

// Track consecutive errors per group to prevent infinite error loops.
// After MAX_CONSECUTIVE_ERRORS, the cursor advances past the failing batch
// so the system doesn't re-trigger the same error on every poll.
const consecutiveErrors: Record<string, number> = {};
const MAX_CONSECUTIVE_ERRORS = 3;

let whatsapp: WhatsAppChannel | null = null;
let channels: Channel[] = [];
const queue = new GroupQueue();

const MAX_CHANNEL_AGENT_FANOUT = 3;
const DISPATCH_KEY_SEP = '::agent::';

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
  return `${baseFolder}${DISPATCH_RUNTIME_SEP}${digest}`;
}

function getSubscriptionsForChannelInMemory(
  channelJid: string,
): ChannelSubscription[] {
  return channelSubscriptions[channelJid] || [];
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
  return {
    name: agent?.name || fallback?.name || sub.agentId,
    folder: agent?.folder || fallback?.folder || sub.agentId,
    trigger: sub.trigger,
    added_at: sub.createdAt,
    containerConfig: agent?.containerConfig || fallback?.containerConfig,
    requiresTrigger: sub.requiresTrigger,
    discordBotId: resolvedBotId,
    discordGuildId: sub.discordGuildId || fallback?.discordGuildId,
    serverFolder: agent?.serverFolder || fallback?.serverFolder,
    backend: agent?.backend || fallback?.backend || 'apple-container',
    agentRuntime:
      agent?.agentRuntime || fallback?.agentRuntime || runtimeDefault,
    description: agent?.description || fallback?.description,
    autoRespondToQuestions: fallback?.autoRespondToQuestions,
    autoRespondKeywords: fallback?.autoRespondKeywords,
    streamIntermediates: fallback?.streamIntermediates,
    channelFolder: sub.channelFolder || undefined,
    categoryFolder: sub.categoryFolder || undefined,
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

function findChannelForJid(
  jid: string,
  preferredBotId?: string,
): Channel | undefined {
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
  channelSubscriptions = getAllChannelSubscriptions();
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
      discordGuildId:
        preferredSub?.discordGuildId ||
        route?.discordGuildId ||
        legacy?.discordGuildId,
      serverFolder: agent?.serverFolder || legacy?.serverFolder,
      backend: (agent?.backend ||
        legacy?.backend ||
        'apple-container') as BackendType,
      agentRuntime:
        agent?.agentRuntime || legacy?.agentRuntime || runtimeDefault,
      description: agent?.description || legacy?.description,
      autoRespondToQuestions: legacy?.autoRespondToQuestions,
      autoRespondKeywords: legacy?.autoRespondKeywords,
      streamIntermediates: legacy?.streamIntermediates,
      channelFolder: preferredSub?.channelFolder,
      categoryFolder: preferredSub?.categoryFolder,
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
check with the admin on WhatsApp first via the send_message tool to the main group.
Over time, the admin will tell you which actions are always okay.

## Getting Context You Don't Have
When you need project context, repo access, credentials, or information that hasn't been shared with you:
- **Use \`share_request\` immediately** — do NOT ask the user directly for info the admin should provide.
- \`share_request\` sends your request to the admin on WhatsApp. They will share context and notify you when it's ready.
- Be specific in your request: describe exactly what you need and why.

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
If you need project info, repo URLs, or credentials not listed here, use \`share_request\` to ask the admin.
Don't ask users in Discord for info the admin should provide — use the tool and it will be routed to WhatsApp.

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
      isRegistered: registeredJids.has(c.jid),
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
    : registeredGroups[chatJid];
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

  let prompt = formatMessages(missedMessages);

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

  const channel = findChannelForJid(chatJid, group.discordBotId);

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

  // Redact sensitive data from error messages before logging
  function redactSensitiveData(text: string): string {
    return (
      text
        // Redact bearer tokens
        .replace(/Bearer\s+[A-Za-z0-9_\-\.]{20,}/gi, 'Bearer [REDACTED]')
        // Redact API keys (common patterns: sk-..., key_..., etc.)
        .replace(
          /\b(?:sk|key|api)[_-][A-Za-z0-9_\-]{16,}/gi,
          '[API_KEY_REDACTED]',
        )
        // Redact long hex strings (likely tokens/secrets)
        .replace(/\b[a-f0-9]{32,}\b/gi, '[HEX_TOKEN_REDACTED]')
        // Redact JWT tokens
        .replace(
          /eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g,
          '[JWT_REDACTED]',
        )
        // Redact common password/secret field values in JSON
        .replace(
          /"(?:password|secret|token|apikey)":\s*"[^"]+"/gi,
          '"$1":"[REDACTED]"',
        )
    );
  }

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
  const threadName =
    lastContent.replace(TRIGGER_PATTERN, '').trim().slice(0, 80) ||
    'Agent working...';

  const streamer = createThreadStreamer(
    {
      channel,
      chatJid,
      streamIntermediates: !!group.streamIntermediates,
      groupName: group.name,
      groupFolder: group.folder,
      label: lastContent.replace(TRIGGER_PATTERN, '').trim(),
    },
    triggeringMessageId,
    threadName,
  );

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
          if (result.intermediate && result.result) {
            const raw =
              typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
            await streamer.handleIntermediate(raw);
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
                findChannelForJid(targetJid, group.discordBotId) || channel;
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

  streamer.writeThoughtLog();

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
function buildChannelsForAgent(agentId: string): ChannelInfo[] | undefined {
  const agentToChannels =
    buildAgentToChannelsMapFromSubscriptions(channelSubscriptions);
  const jids = agentToChannels.get(agentId);
  if (!jids || jids.length <= 1) return undefined;

  return jids.map((jid, i) => {
    const group = registeredGroups[jid];
    // Derive human-readable name: use last segment of channelFolder if available,
    // otherwise fall back to group name or JID
    const channelFolderName = group?.channelFolder
      ? group.channelFolder.split('/').pop()
      : undefined;
    const name = channelFolderName || group?.name || jid;
    return { id: String(i + 1), jid, name };
  });
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

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    runtimeGroupFolder,
    isMain,
    availableGroups,
    new Set([
      ...Object.keys(registeredGroups),
      ...Object.keys(channelSubscriptions),
    ]),
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
          resumePositions[runtimeGroupFolder] = output.resumeAt;
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const backend = resolveBackend(group);
    const subAgentId = (channelSubscriptions[chatJid] || [])[0]?.agentId;
    // Prefer the canonical agent ID from subscriptions. Fall back to looking up
    // the agent by folder, so this stays correct even if agent.id diverges from folder.
    const agentId = subAgentId
      ?? Object.values(agents).find((a) => a.folder === group.folder)?.id
      ?? group.folder;
    const agentChannels = buildChannelsForAgent(agentId);
    const output = await backend.runAgent(
      group,
      {
        prompt,
        sessionId,
        resumeAt: resumePositions[runtimeGroupFolder],
        groupFolder: group.folder,
        runtimeFolder: runtimeGroupFolder,
        chatJid,
        isMain,
        discordGuildId: group.discordGuildId,
        serverFolder: group.serverFolder,
        agentRuntime: group.agentRuntime,
        channels: agentChannels,
        agentName: group.name,
        discordBotId: group.discordBotId,
        agentTrigger: group.trigger,
        channelFolder: group.channelFolder,
        categoryFolder: group.categoryFolder,
        agentContextFolder: group.agentContextFolder,
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
      resumePositions[runtimeGroupFolder] = output.resumeAt;
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
  }
}

function selectSubscriptionsForMessage(
  chatJid: string,
  groupMessages: NewMessage[],
): ChannelSubscription[] {
  const subs = getSubscriptionsForChannelInMemory(chatJid);
  if (subs.length === 0) return [];

  // @allagents fan-out: regex check on stored message content — no Discord API call,
  // no GuildMembers privileged intent needed. Safe because it only reads already-stored text.
  const hasAllAgents = groupMessages.some((m) => /@allagents/i.test(m.content));
  const directBotMentions = subs.filter((sub) => {
    const agent = agents[sub.agentId];
    const triggerHandle = sub.trigger.replace(/^@/, '');
    const handles = [agent?.name, sub.discordBotId, triggerHandle]
      .filter((v): v is string => Boolean(v && v.trim()))
      .map((v) => v.trim().toLowerCase());
    if (handles.length === 0) return false;

    return groupMessages.some((m) => {
      const text = m.content.toLowerCase();
      return handles.some((handle) => {
        const mentionPattern = new RegExp(
          `(^|\\s)@${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\b|\\s|$)`,
          'i',
        );
        return mentionPattern.test(text);
      });
    });
  });
  const explicitMatches = subs.filter((sub) => {
    const triggerPattern = buildTriggerPattern(sub.trigger);
    return groupMessages.some((m) => triggerPattern.test(m.content.trim()));
  });

  let selected: ChannelSubscription[];
  if (hasAllAgents) {
    selected = [...subs];
  } else if (directBotMentions.length > 0) {
    selected = directBotMentions;
  } else if (explicitMatches.length > 0) {
    selected = explicitMatches;
  } else {
    const primaries = subs.filter((s) => s.isPrimary);
    selected = primaries.length > 0 ? primaries : [subs[0]];
    selected = selected.filter((s) => {
      const agent = agents[s.agentId];
      const isMain = agent?.isAdmin === true;
      return isMain || s.requiresTrigger === false;
    });
    if (selected.length === 0) {
      logger.debug(
        { chatJid, subCount: subs.length },
        'All primary agents require trigger — no agents selected for untriggered message',
      );
    }
  }

  return selected
    .sort(
      (a, b) =>
        a.priority - b.priority || a.createdAt.localeCompare(b.createdAt),
    )
    .slice(0, MAX_CHANNEL_AGENT_FANOUT);
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
          const selectedSubs = selectSubscriptionsForMessage(
            chatJid,
            groupMessages,
          );

          // Legacy fallback: one-to-one registered group handling
          if (selectedSubs.length === 0) {
            const group = registeredGroups[chatJid];
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
            const messagesToSend =
              allPending.length > 0 ? allPending : groupMessages;
            const formatted = formatMessages(messagesToSend);

            if (await queue.sendMessage(chatJid, formatted)) {
              logger.info(
                { chatJid, count: messagesToSend.length },
                'Piped messages to active container',
              );
              lastAgentTimestamp[chatJid] =
                messagesToSend[messagesToSend.length - 1].timestamp;
              saveState();
              const typingCh = findChannelForJid(chatJid, group.discordBotId);
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
            const formatted = formatMessages(messagesToSend);

            if (await queue.sendMessage(dispatchJid, formatted)) {
              logger.info(
                { chatJid, agentId: sub.agentId, count: messagesToSend.length },
                'Piped messages to active agent container',
              );
              lastAgentTimestamp[dispatchJid] =
                messagesToSend[messagesToSend.length - 1].timestamp;
              saveState();
              const typingCh = findChannelForJid(chatJid, sub.discordBotId);
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
      if (pending.length > 0) {
        logger.info(
          { chatJid, agentId: sub.agentId, pendingCount: pending.length },
          'Recovery: found unprocessed messages for subscription',
        );
        queue.enqueueMessageCheck(dispatchJid);
      }
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
    // Pre-computed send instructions so agents don't have to guess how to
    // reach each other. Sending to a shared channel with the wrong target_jid
    // or without the trigger silently routes to the wrong agent.
    const sendTo = requiresTrigger
      ? `target_jid="${primaryJid}", text must start with "${trigger} "`
      : `target_jid="${primaryJid}"`;
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
        sendTo:
          group.requiresTrigger !== false
            ? `target_jid="${jid}", text must start with "${group.trigger} "`
            : `target_jid="${jid}"`,
      });
    }
  }

  const registryJson = JSON.stringify(registry, null, 2);

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

  for (const folder of folders) {
    const groupIpcDir = path.join(DATA_DIR, 'ipc', folder);
    fs.mkdirSync(groupIpcDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupIpcDir, 'agent_registry.json'),
      registryJson,
    );
  }
}

/**
 * Handle share-request approval via reaction emoji.
 * Returns true if the reaction was consumed (was a tracked share request).
 */
function handleShareRequestApproval(
  messageId: string,
  emoji: string,
  channelName: string,
): boolean {
  const request = consumeShareRequest(messageId);
  if (!request) return false;

  const mainJid = findMainGroupJid(registeredGroups);
  if (!mainJid) return false;

  logger.info(
    {
      messageId,
      emoji,
      sourceGroup: request.sourceGroup,
      sourceName: request.sourceName,
    },
    `Share request approved via ${channelName} reaction`,
  );

  const writePaths = request.serverFolder
    ? `groups/${request.sourceGroup}/CLAUDE.md and/or groups/${request.serverFolder}/CLAUDE.md`
    : `groups/${request.sourceGroup}/CLAUDE.md`;
  const syntheticContent = [
    `Share request APPROVED from ${request.sourceName} (${request.sourceJid}):`,
    '',
    `${request.description}`,
    '',
    `Fulfill this request — write context to ${writePaths}, clone repos if needed.`,
    `When done, use send_message to ${request.sourceJid} to notify them: "Your context request has been fulfilled! [brief summary] — check your CLAUDE.md and workspace for updates."`,
  ].join('\n');

  storeMessage({
    id: `synth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chat_jid: mainJid,
    sender: 'system',
    sender_name: 'System',
    content: syntheticContent,
    timestamp: new Date().toISOString(),
    is_from_me: false,
  });

  queue.enqueueMessageCheck(mainJid);
  return true;
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
  let group = registeredGroups[chatJid];
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

  // Expire stale sessions on startup to prevent unbounded context growth
  const expired = expireStaleSessions(SESSION_MAX_AGE);
  if (expired.length > 0) {
    for (const folder of expired) {
      delete sessions[folder];
    }
    logger.info({ expired }, 'Expired stale sessions on startup');
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
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
      onReaction: (chatJid, messageId, emoji) => {
        if (!emoji.startsWith('👍') && emoji !== '❤️' && emoji !== '✅') return;
        handleShareRequestApproval(messageId, emoji, 'WhatsApp');
      },
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

  const connectWhatsApp = Effect.gen(function* () {
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
  );

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
                  if (
                    emoji.startsWith('👍') ||
                    emoji === '❤️' ||
                    emoji === '✅'
                  ) {
                    if (handleShareRequestApproval(messageId, emoji, 'Discord'))
                      return;
                  }
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

  const connectTelegram = TELEGRAM_BOT_TOKEN
    ? Effect.gen(function* () {
        const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, {
          onMessage: (chatJid, msg) => storeMessage(msg),
          onChatMetadata: (chatJid, timestamp, name) =>
            storeChatMetadata(chatJid, timestamp, name),
          registeredGroups: () => registeredGroups,
        });
        yield* Effect.tryPromise(() => telegram.connect());
        return telegram as Channel;
      }).pipe(
        Effect.catchAll((err) => {
          logger.error(
            { err },
            'Failed to connect Telegram bot (continuing without Telegram)',
          );
          return Effect.succeed(null);
        }),
      )
    : Effect.succeed(null);

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
    const [wa, discordChannels, telegram] = await Effect.runPromise(
      Effect.all([connectWhatsApp, connectDiscord, connectTelegram], {
        concurrency: 'unbounded',
      }),
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
    }
    if (telegram) channels.push(telegram);

    // Conditionally connect Slack (requires both bot token and app-level socket-mode token)
    if (SLACK_BOT_TOKEN && SLACK_APP_TOKEN) {
      try {
        const slack = new SlackChannel({
          token: SLACK_BOT_TOKEN,
          appToken: SLACK_APP_TOKEN,
          onMessage: (chatJid, msg) => storeMessage(msg),
          onChatMetadata: (chatJid, timestamp, name) =>
            storeChatMetadata(chatJid, timestamp, name),
          registeredGroups: () => registeredGroups,
          onReaction: async (chatJid, messageId, emoji, userName) => {
            if (
              emoji === ':thumbsup:' ||
              emoji === ':+1:' ||
              emoji === ':heart:' ||
              emoji === ':white_check_mark:'
            ) {
              if (handleShareRequestApproval(messageId, emoji, 'Slack')) return;
            }
            await handleReactionNotification(
              chatJid,
              messageId,
              emoji,
              userName,
              'Slack',
            );
          },
        });
        await slack.connect();
        channels.push(slack);
      } catch (err) {
        logger.error(
          { err },
          'Failed to connect Slack bot (continuing without Slack)',
        );
      }
    }

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
  };

  // Fire-and-forget: channels connect in background while message loop already runs
  connectChannels().catch((err) => {
    logger.error({ err }, 'Channel connection failed');
  });

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    getResumePositions: () => resumePositions,
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
    sendMessage: async (jid, rawText) => {
      const ch = findChannelForJid(jid);
      if (!ch) {
        logger.warn({ jid }, 'No channel found for scheduled message');
        return;
      }
      const group = registeredGroups[jid];
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
    findChannel: (jid) => findChannelForJid(jid),
  });
  startIpcWatcher({
    sendMessage: async (jid, rawText) => {
      const ch = findChannelForJid(jid);
      if (!ch) {
        logger.warn({ jid }, 'No channel found for IPC message');
        return;
      }
      const group = registeredGroups[jid];
      const text = formatOutbound(
        ch,
        rawText,
        group ? getAgentName(group) : undefined,
      );
      if (text) return await ch.sendMessage(jid, text);
    },
    notifyGroup: (jid, text, sourceFolder?) => {
      // Prefix with the group's trigger so it passes requiresTrigger filter
      const group = registeredGroups[jid];
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
    findChannel: (jid) => findChannelForJid(jid),
    writeTasksSnapshot: (groupFolder, isMainGroup) => {
      writeTasksSnapshot(
        groupFolder,
        isMainGroup,
        mapTasksForSnapshot(getAllTasks()),
      );
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
