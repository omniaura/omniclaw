import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  B2_ACCESS_KEY_ID,
  B2_BUCKET,
  B2_ENDPOINT,
  B2_REGION,
  B2_SECRET_ACCESS_KEY,
  buildTriggerPattern,
  DATA_DIR,
  DISCORD_BOT_TOKEN,
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
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  expireStaleSessions,
  getAllAgents,
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
  setChannelRoute,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { getCloudAgentIds } from './agents.js';
import { resolveAgentForChannel, buildAgentToChannelsMap } from './channel-routes.js';
import { GroupQueue } from './group-queue.js';
import { consumeShareRequest, startIpcWatcher } from './ipc.js';
import { OmniClawS3 } from './s3/client.js';
import { startS3IpcPoller } from './s3/ipc-poller.js';
import { findChannel, formatMessages, formatOutbound, getAgentName } from './router.js';
import { reconcileHeartbeats, startSchedulerLoop } from './task-scheduler.js';
import { createThreadStreamer } from './thread-streaming.js';
import { Agent, BackendType, Channel, ChannelRoute, NewMessage, RegisteredGroup, registeredGroupToAgent, registeredGroupToRoute } from './types.js';
import { findMainGroupJid } from './group-helpers.js';
import { logger } from './logger.js';
import { Effect } from 'effect';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

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
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
let processedIds = new Set<string>(); // Deduplication for timestamp boundary messages

// Track consecutive errors per group to prevent infinite error loops.
// After MAX_CONSECUTIVE_ERRORS, the cursor advances past the failing batch
// so the system doesn't re-trigger the same error on every poll.
const consecutiveErrors: Record<string, number> = {};
const MAX_CONSECUTIVE_ERRORS = 3;

let whatsapp: WhatsAppChannel | null = null;
let channels: Channel[] = [];
let s3: OmniClawS3 | null = null;
const queue = new GroupQueue();

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
  registeredGroups = getAllRegisteredGroups();

  // Load agent-channel decoupling state (auto-migrated from registered_groups)
  agents = getAllAgents();
  channelRoutes = getAllChannelRoutes();

  // Backfill registeredGroups from channel_routes + agents.
  // The registered_groups table has UNIQUE(folder), so it can only hold one JID
  // per agent. But agents can have multiple channel routes (e.g. DM + group).
  // Merge any missing JIDs so message routing works for all channels.
  let backfilled = 0;
  for (const [jid, route] of Object.entries(channelRoutes)) {
    if (!registeredGroups[jid]) {
      const agent = agents[route.agentId];
      if (agent) {
        registeredGroups[jid] = {
          name: agent.name,
          folder: agent.folder,
          trigger: route.trigger,
          added_at: route.createdAt,
          containerConfig: agent.containerConfig,
          requiresTrigger: route.requiresTrigger,
          backend: agent.backend as BackendType,
          description: agent.description,
          discordGuildId: route.discordGuildId,
          serverFolder: agent.serverFolder,
          heartbeat: agent.heartbeat,
        };
        backfilled++;
      }
    }
  }

  // Register JID→folder mappings in the queue so multiple JIDs
  // for the same agent share one container (GroupState keyed by folder).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    queue.registerJidMapping(jid, group.folder);
  }

  logger.info(
    {
      groupCount: Object.keys(registeredGroups).length,
      agentCount: Object.keys(agents).length,
      routeCount: Object.keys(channelRoutes).length,
      backfilled,
    },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  // Validate folder name to prevent path traversal attacks
  if (!/^[a-zA-Z0-9_-]+$/.test(group.folder)) {
    throw new Error(
      `Invalid group folder name: "${group.folder}". Only alphanumeric characters, hyphens, and underscores are allowed.`,
    );
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

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
  if (group.serverFolder) {
    ensureServerDirectory(group.serverFolder);
  }

  // Also create Agent and ChannelRoute entries
  const agent = registeredGroupToAgent(jid, group);
  agents[agent.id] = agent;
  setAgent(agent);

  const route = registeredGroupToRoute(jid, group);
  channelRoutes[jid] = route;
  setChannelRoute(route);

  logger.info(
    { jid, name: group.name, folder: group.folder, serverFolder: group.serverFolder },
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
  const serverDir = path.join(DATA_DIR, '..', 'groups', serverFolder);
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
      logger.warn({ jid, name: group.name }, 'Could not resolve Discord guild ID');
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
    const updated: RegisteredGroup = { ...group, discordGuildId: guildId, serverFolder };
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
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

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
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
  ).filter((m) => m.content.trim().length > 0);

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present.
  // Use buildTriggerPattern(group.trigger) so @PeytonOmni / @OmarOmni groups
  // aren't silently dropped by the global @Omni TRIGGER_PATTERN (mirrors the
  // same fix already applied in startMessageLoop by PR #138).
  if (!isMainGroup && group.requiresTrigger !== false) {
    const groupTriggerPattern = buildTriggerPattern(group.trigger);
    const hasTrigger = missedMessages.some((m) =>
      groupTriggerPattern.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  let prompt = formatMessages(missedMessages);

  // Inject context about active background tasks
  const activeTask = queue.getActiveTaskInfo(chatJid);
  if (activeTask) {
    const elapsed = Math.round((Date.now() - activeTask.startedAt) / 60000);
    prompt = `[Background Task Running: "${activeTask.promptPreview}" — started ${elapsed} min ago]\n\n${prompt}`;
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid, 'message');
    }, IDLE_TIMEOUT);
  };

  const channel = findChannel(channels, chatJid);

  // Keep the typing indicator alive for the entire agent run.
  // Discord's typing indicator expires after ~10 seconds, so we refresh
  // every 8 seconds until the agent finishes. Other channels (Telegram,
  // WhatsApp) send a one-shot update and ignore subsequent calls gracefully.
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  if (channel?.setTyping) {
    try {
      await channel.setTyping(chatJid, true);
      typingInterval = setInterval(() => {
        channel.setTyping!(chatJid, true).catch(() => {
          // Non-fatal — typing indicator is best-effort
        });
      }, 8_000);
    } catch (err) {
      logger.debug(
        { group: group.name, error: err },
        'Typing indicator failed to start',
      );
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
    return text
      // Redact bearer tokens
      .replace(/Bearer\s+[A-Za-z0-9_\-\.]{20,}/gi, 'Bearer [REDACTED]')
      // Redact API keys (common patterns: sk-..., key_..., etc.)
      .replace(/\b(?:sk|key|api)[_-][A-Za-z0-9_\-]{16,}/gi, '[API_KEY_REDACTED]')
      // Redact long hex strings (likely tokens/secrets)
      .replace(/\b[a-f0-9]{32,}\b/gi, '[HEX_TOKEN_REDACTED]')
      // Redact JWT tokens
      .replace(/eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, '[JWT_REDACTED]')
      // Redact common password/secret field values in JSON
      .replace(/"(?:password|secret|token|apikey)":\s*"[^"]+"/gi, '"$1":"[REDACTED]"');
  }

  // Thread streaming via shared helper
  // Synthetic IDs (synth-*, react-*, notify-*, s3-*) aren't real channel message IDs
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
  const groupTriggerRe = new RegExp(`@${agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  // Bot names to match in the mentions array: the per-group agent name AND the global
  // assistant name. Replies-to-bot store the bot's display name (ASSISTANT_NAME) in mentions.
  const botNames = new Set([agentName.toLowerCase(), ASSISTANT_NAME.toLowerCase()]);
  const isTriggerMessage = (m: { content: string; mentions?: Array<{ name: string }> }): boolean =>
    groupTriggerRe.test(m.content) ||
    TRIGGER_PATTERN.test(m.content) ||
    (m.mentions?.some((mention) => botNames.has(mention.name.toLowerCase())) ?? false);
  const triggeringMessage = missedMessages.findLast(isTriggerMessage);
  // Always reply to the last message in the batch, not the triggering message.
  // triggeringMessage is used to decide whether to process; the reply should
  // thread to what the user most recently said.
  const lastMessageId = missedMessages[missedMessages.length - 1]?.id || triggeringMessage?.id || null;
  const triggeringMessageId = lastMessageId && /^(synth|react|notify|s3)-/.test(lastMessageId) ? null : lastMessageId;
  const lastContent = missedMessages[missedMessages.length - 1]?.content || '';
  const threadName = lastContent
    .replace(TRIGGER_PATTERN, '').trim().slice(0, 80) || 'Agent working...';

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
    output = await runAgent(group, prompt, chatJid, async (result) => {
      // Wrap in try/catch to prevent unhandled rejections
      // Adopted from [Upstream PR #243] - Critical stability fix
      try {
        if (result.intermediate && result.result) {
          const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
          await streamer.handleIntermediate(raw);
          return;
        }

        // Final output — send to main channel as before
        if (result.result) {
          const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
          // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
          const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
          logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);

          // Suppress system/auth errors — log them but don't send to channels
          // This prevents infinite loops when auth fails (error echoed back → triggers agent → fails again)
          const isSystemError = systemErrorPatterns.some((p) => p.test(text));
          if (isSystemError) {
            const redactedText = redactSensitiveData(text.slice(0, 300));
            logger.error({ group: group.name }, `Suppressed system error (not sent to user): ${redactedText}`);
            hadError = true;
            // Skip sending to channel but continue processing
          } else if (text) {
            // Route to the chatJid from the container output (multi-channel support).
            // Falls back to the original launch chatJid for single-channel agents.
            const targetJid = result.chatJid || chatJid;
            const targetChannel = findChannel(channels, targetJid) || channel;
            if (targetChannel) {
              const formatted = formatOutbound(targetChannel, text, getAgentName(group));
              if (formatted) {
                // Don't use triggeringMessageId for cross-channel responses — it belongs to the original chat
                const replyId = targetJid === chatJid ? triggeringMessageId : null;
                await targetChannel.sendMessage(targetJid, formatted, replyId || undefined);
                outputSentToUser = true;
              }
            }
          }
          // Only reset idle timer on actual results, not session-update markers (result: null)
          resetIdleTimer();
        }

        // [Upstream PR #354] Mark container as idle when it finishes work
        // (status: success with null result = session-update marker = idle-waiting)
        if (result.status === 'success') {
          queue.notifyIdle(chatJid);
        }

        if (result.status === 'error') {
          hadError = true;
        }
      } catch (err) {
        logger.error({ group: group.name, err }, 'Error in streaming output callback');
        hadError = true;
      }
    });
  } finally {
    // Stop the typing keep-alive loop — must be in finally to prevent stuck
    // typing indicators when runAgent throws or the process is interrupted.
    if (typingInterval) clearInterval(typingInterval);
    if (channel?.setTyping) await channel.setTyping(chatJid, false).catch(() => {});
    if (idleTimer) clearTimeout(idleTimer);
  }

  streamer.writeThoughtLog();

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      consecutiveErrors[chatJid] = 0;
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }

    const errorCount = (consecutiveErrors[chatJid] || 0) + 1;
    consecutiveErrors[chatJid] = errorCount;

    if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
      // Too many consecutive failures — advance cursor to prevent a permanently
      // stuck queue where every future message re-triggers the same failing batch.
      logger.error(
        { group: group.name, errorCount },
        'Max consecutive errors reached, advancing cursor past failing messages',
      );
      consecutiveErrors[chatJid] = 0;
      return false;
    }

    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name, errorCount }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  consecutiveErrors[chatJid] = 0;
  return true;
}

/**
 * Build the channels array for multi-channel agents.
 * Returns undefined if the agent only has one channel (no routing needed).
 */
function buildChannelsForAgent(agentFolder: string): ChannelInfo[] | undefined {
  const agentToChannels = buildAgentToChannelsMap(channelRoutes);
  const jids = agentToChannels.get(agentFolder);
  if (!jids || jids.length <= 1) return undefined;

  return jids.map((jid, i) => {
    const group = registeredGroups[jid];
    // Generate a human-readable name: use chat metadata or fall back to JID
    const name = group?.name || jid;
    return { id: String(i + 1), jid, name };
  });
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;

  // Expire stale sessions before each run to prevent unbounded context growth
  const expired = expireStaleSessions(SESSION_MAX_AGE);
  if (expired.length > 0) {
    for (const folder of expired) {
      delete sessions[folder];
    }
    logger.info({ expired, trigger: group.folder }, 'Expired stale sessions before agent run');
  }

  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Update agent registry for all groups
  buildAgentRegistry();

  // Wrap onOutput to track session ID and resumeAt from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        if (output.resumeAt) {
          resumePositions[group.folder] = output.resumeAt;
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const backend = resolveBackend(group);
    const agentChannels = buildChannelsForAgent(group.folder);
    const output = await backend.runAgent(
      group,
      {
        prompt,
        sessionId,
        resumeAt: resumePositions[group.folder],
        groupFolder: group.folder,
        chatJid,
        isMain,
        discordGuildId: group.discordGuildId,
        serverFolder: group.serverFolder,
        channels: agentChannels,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder, backend, 'message'),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }
    if (output.resumeAt) {
      resumePositions[group.folder] = output.resumeAt;
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

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`OmniClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
      );

      // Clear processedIds when timestamp advances (prevents memory growth)
      if (newTimestamp > lastTimestamp) {
        processedIds.clear();
      }

      // Filter out already-processed messages (deduplication at timestamp boundaries)
      const uniqueMessages = messages.filter((msg) => {
        if (processedIds.has(msg.id)) return false;
        processedIds.add(msg.id);
        return true;
      });

      if (uniqueMessages.length > 0) {
        logger.info({ count: uniqueMessages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of uniqueMessages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            // Use per-group trigger pattern so @PeytonOmni channels aren't
            // silently dropped by the global @Omni TRIGGER_PATTERN.
            const groupTriggerPattern = buildTriggerPattern(group.trigger);
            const hasTrigger = groupMessages.some((m) =>
              groupTriggerPattern.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
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
            // Show typing indicator while the container processes the piped message
            const typingCh = findChannel(channels, chatJid);
            if (typingCh?.setTyping) typingCh.setTyping(chatJid, true).catch((err) =>
              logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
            );
          } else {
            // No active container — enqueue for a new one
            logger.info({ chatJid, count: messagesToSend.length }, 'No active container, enqueuing for new one');
            queue.enqueueMessageCheck(chatJid);
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
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
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
function buildAgentRegistry(): void {
  // Build registry from agents (new system) with channel route info
  const agentToChannels = buildAgentToChannelsMap(channelRoutes);

  const registry = Object.values(agents).map((agent) => {
    const jids = agentToChannels.get(agent.id) || [];
    // Get trigger from first route for backwards compat
    const firstRoute = jids.length > 0 ? channelRoutes[jids[0]] : undefined;
    return {
      id: agent.id,
      jid: jids[0] || agent.id, // Primary JID
      jids, // All JIDs
      name: agent.name,
      description: agent.description || '',
      backend: agent.backend,
      isMain: agent.isAdmin,
      isLocal: agent.isLocal,
      trigger: firstRoute?.trigger || `@${ASSISTANT_NAME}`,
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
        isMain: group.folder === MAIN_GROUP_FOLDER,
        isLocal: !group.backend || group.backend === 'apple-container' || group.backend === 'docker',
        trigger: group.trigger,
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

  for (const folder of folders) {
    const groupIpcDir = path.join(DATA_DIR, 'ipc', folder);
    fs.mkdirSync(groupIpcDir, { recursive: true });
    fs.writeFileSync(path.join(groupIpcDir, 'agent_registry.json'), registryJson);
  }
}

async function main(): Promise<void> {
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Initialize S3 client if B2 is configured
  if (B2_ENDPOINT) {
    s3 = new OmniClawS3({
      endpoint: B2_ENDPOINT,
      accessKeyId: B2_ACCESS_KEY_ID,
      secretAccessKey: B2_SECRET_ACCESS_KEY,
      bucket: B2_BUCKET,
      region: B2_REGION,
    });
    logger.info('B2 S3 client initialized');
  }

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

  // --- Parallel startup: backends + channels concurrently ---
  const startupT0 = Date.now();

  const initBackends = Effect.promise(() => initializeBackends(registeredGroups));

  const WHATSAPP_RETRY_INTERVAL_MS = 60_000; // 1 minute between retries
  const WHATSAPP_MAX_RETRIES = 30; // give up after ~30 minutes

  const createWhatsAppChannel = () => new WhatsAppChannel({
    onMessage: (chatJid, msg) => storeMessage(msg),
    onChatMetadata: (chatJid, timestamp) => storeChatMetadata(chatJid, timestamp),
    registeredGroups: () => registeredGroups,
    onReaction: (chatJid, messageId, emoji) => {
      // Only handle approval emojis
      if (!emoji.startsWith('👍') && emoji !== '❤️' && emoji !== '✅') return;

      const request = consumeShareRequest(messageId);
      if (!request) return; // Not a tracked share request

      // Find the main group's JID
      const mainJid = findMainGroupJid(registeredGroups);
      if (!mainJid) return;

      logger.info(
        { messageId, emoji, sourceGroup: request.sourceGroup, sourceName: request.sourceName },
        'Share request approved via reaction',
      );

      // Inject synthetic message into main group DB
      const writePaths = request.serverFolder
        ? `groups/${request.sourceGroup}/CLAUDE.md and/or groups/${request.serverFolder}/CLAUDE.md`
        : `groups/${request.sourceGroup}/CLAUDE.md`;
      const syntheticContent = [
        `Share request APPROVED from ${request.sourceName} (${request.sourceJid}):`,
        ``,
        `${request.description}`,
        ``,
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

      // Wake up the main agent
      queue.enqueueMessageCheck(mainJid);
    },
  });

  /** Retry WhatsApp connection in the background with backoff */
  const scheduleWhatsAppRetry = (attempt = 1) => {
    if (attempt > WHATSAPP_MAX_RETRIES) {
      logger.error({ attempts: attempt - 1 }, 'WhatsApp retry limit reached — giving up. Restart the service to try again.');
      return;
    }
    const delayMs = Math.min(WHATSAPP_RETRY_INTERVAL_MS * attempt, 5 * 60_000); // cap at 5 min
    logger.info({ attempt, delayMs, maxRetries: WHATSAPP_MAX_RETRIES }, `Scheduling WhatsApp reconnect in ${Math.round(delayMs / 1000)}s`);
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
  }).pipe(Effect.catchAll((err) => {
    logger.error({ err }, 'Failed to connect WhatsApp (continuing without WhatsApp)');
    scheduleWhatsAppRetry();
    return Effect.succeed(null);
  }));

  const connectDiscord = DISCORD_BOT_TOKEN
    ? Effect.gen(function* () {
        const discord = new DiscordChannel({
          token: DISCORD_BOT_TOKEN,
          onReaction: async (chatJid, messageId, emoji, userName) => {
            // 1. Check for share_request approval first (only approval emojis)
            if (emoji.startsWith('👍') || emoji === '❤️' || emoji === '✅') {
              const request = consumeShareRequest(messageId);
              if (request) {
                const mainJid = Object.entries(registeredGroups).find(
                  ([, g]) => g.folder === MAIN_GROUP_FOLDER,
                )?.[0];
                if (!mainJid) return;

                logger.info(
                  { messageId, emoji, sourceGroup: request.sourceGroup, sourceName: request.sourceName },
                  'Share request approved via Discord reaction',
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
                return;
              }
            }

            // 2. Context-aware reaction notification: include emoji and reactor name
            const group = registeredGroups[chatJid];
            if (!group) return;

            logger.info(
              { chatJid, messageId, emoji, userName, group: group.name },
              'Reaction on bot message in Discord',
            );

            const reactionContent = `@${ASSISTANT_NAME} [${userName} reacted with ${emoji}]`;

            // Try to pipe directly to active container
            const piped = await queue.sendMessage(chatJid, formatMessages([{
              id: `react-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              chat_jid: chatJid,
              sender: 'system',
              sender_name: 'System',
              content: reactionContent,
              timestamp: new Date().toISOString(),
            }]));
            if (!piped) {
              // No active container — store in DB and enqueue
              storeMessage({
                id: `react-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                chat_jid: chatJid,
                sender: 'system',
                sender_name: 'System',
                content: reactionContent,
                timestamp: new Date().toISOString(),
                is_from_me: false,
              });
              queue.enqueueMessageCheck(chatJid);
            }
          },
        });
        yield* Effect.tryPromise(() => discord.connect());
        yield* Effect.tryPromise(() => backfillDiscordGuildIds(discord));
        return discord as Channel;
      }).pipe(Effect.catchAll((err) => {
        logger.error({ err }, 'Failed to connect Discord bot (continuing without Discord)');
        return Effect.succeed(null);
      }))
    : Effect.succeed(null);

  const connectTelegram = TELEGRAM_BOT_TOKEN
    ? Effect.gen(function* () {
        const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, {
          onMessage: (chatJid, msg) => storeMessage(msg),
          onChatMetadata: (chatJid, timestamp, name) => storeChatMetadata(chatJid, timestamp, name),
          registeredGroups: () => registeredGroups,
        });
        yield* Effect.tryPromise(() => telegram.connect());
        return telegram as Channel;
      }).pipe(Effect.catchAll((err) => {
        logger.error({ err }, 'Failed to connect Telegram bot (continuing without Telegram)');
        return Effect.succeed(null);
      }))
    : Effect.succeed(null);

  const [, wa, discord, telegram] = await Effect.runPromise(
    Effect.all([initBackends, connectWhatsApp, connectDiscord, connectTelegram], { concurrency: 'unbounded' }),
  );

  whatsapp = wa;
  if (whatsapp) channels.push(whatsapp);
  if (discord) channels.push(discord);
  if (telegram) channels.push(telegram);

  logger.info({ durationMs: Date.now() - startupT0 }, 'Startup complete');

  // Conditionally connect Slack (requires both bot token and app-level socket-mode token)
  if (SLACK_BOT_TOKEN && SLACK_APP_TOKEN) {
    try {
      const slack = new SlackChannel({
        token: SLACK_BOT_TOKEN,
        appToken: SLACK_APP_TOKEN,
        onMessage: (chatJid, msg) => storeMessage(msg),
        onChatMetadata: (chatJid, timestamp, name) => storeChatMetadata(chatJid, timestamp, name),
        registeredGroups: () => registeredGroups,
        onReaction: async (chatJid, messageId, emoji, userName) => {
          // Share-request approval via thumbs-up / heart / check
          if (emoji === ':thumbsup:' || emoji === ':+1:' || emoji === ':heart:' || emoji === ':white_check_mark:') {
            const request = consumeShareRequest(messageId);
            if (request) {
              const mainJid = Object.entries(registeredGroups).find(
                ([, g]) => g.folder === MAIN_GROUP_FOLDER,
              )?.[0];
              if (!mainJid) return;

              logger.info(
                { messageId, emoji, sourceGroup: request.sourceGroup, sourceName: request.sourceName },
                'Share request approved via Slack reaction',
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
              return;
            }
          }

          // General reaction notification for registered groups
          const group = registeredGroups[chatJid];
          if (!group) return;

          logger.info(
            { chatJid, messageId, emoji, userName, group: group.name },
            'Reaction on bot message in Slack',
          );

          const reactionContent = `@${ASSISTANT_NAME} [${userName} reacted with ${emoji}]`;
          const piped = await queue.sendMessage(chatJid, formatMessages([{
            id: `react-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            chat_jid: chatJid,
            sender: 'system',
            sender_name: 'System',
            content: reactionContent,
            timestamp: new Date().toISOString(),
          }]));
          if (!piped) {
            storeMessage({
              id: `react-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              chat_jid: chatJid,
              sender: 'system',
              sender_name: 'System',
              content: reactionContent,
              timestamp: new Date().toISOString(),
              is_from_me: false,
            });
            queue.enqueueMessageCheck(chatJid);
          }
        },
      });
      await slack.connect();
      channels.push(slack);
    } catch (err) {
      logger.error({ err }, 'Failed to connect Slack bot (continuing without Slack)');
    }
  }

  // Reconcile heartbeat tasks with group config before starting scheduler
  reconcileHeartbeats(registeredGroups);

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    getResumePositions: () => resumePositions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder, lane) => queue.registerProcess(groupJid, proc, containerName, groupFolder, undefined, lane),
    sendMessage: async (jid, rawText) => {
      const ch = findChannel(channels, jid);
      if (!ch) {
        logger.warn({ jid }, 'No channel found for scheduled message');
        return;
      }
      const group = registeredGroups[jid];
      const text = formatOutbound(ch, rawText, group ? getAgentName(group) : undefined);
      if (text) {
        const msgId = await ch.sendMessage(jid, text);
        return msgId ? String(msgId) : undefined;
      }
    },
    findChannel: (jid) => findChannel(channels, jid),
  });
  startIpcWatcher({
    sendMessage: async (jid, rawText) => {
      const ch = findChannel(channels, jid);
      if (!ch) {
        logger.warn({ jid }, 'No channel found for IPC message');
        return;
      }
      const group = registeredGroups[jid];
      const text = formatOutbound(ch, rawText, group ? getAgentName(group) : undefined);
      if (text) return await ch.sendMessage(jid, text);
    },
    notifyGroup: (jid, text) => {
      // Prefix with the group's trigger so it passes requiresTrigger filter
      const group = registeredGroups[jid];
      const trigger = group?.trigger || `@${ASSISTANT_NAME}`;
      storeMessage({
        id: `notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chat_jid: jid,
        sender: 'system',
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
    syncGroupMetadata: (force) => whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
    findChannel: (jid) => findChannel(channels, jid),
  });
  // Start S3 IPC poller for cloud agents (if B2 is configured)
  if (s3) {
    startS3IpcPoller({
      s3,
      getCloudAgentIds,
      processOutput: async (agentId, output) => {
        // Find the channel route(s) for this agent
        const agentToChannels = buildAgentToChannelsMap(channelRoutes);
        const jids = agentToChannels.get(agentId) || [];
        const targetJid = output.targetChannelJid || jids[0];

        if (targetJid && output.result) {
          const ch = findChannel(channels, targetJid);
          if (ch) {
            const agent = agents[agentId];
            const text = formatOutbound(ch, output.result, agent?.name);
            if (text) await ch.sendMessage(targetJid, text);
          }
        }

        if (output.newSessionId) {
          sessions[agentId] = output.newSessionId;
          setSession(agentId, output.newSessionId);
        }
      },
      processMessage: async (sourceAgentId, data) => {
        if (data.type === 'message' && data.chatJid && data.text) {
          const targetGroup = registeredGroups[data.chatJid];
          const isRegisteredTarget = !!targetGroup;
          const isMain = sourceAgentId === MAIN_GROUP_FOLDER;
          if (isMain || isRegisteredTarget) {
            const ch = findChannel(channels, data.chatJid);
            if (ch) {
              const agent = agents[sourceAgentId];
              const text = formatOutbound(ch, data.text, agent?.name);
              if (text) await ch.sendMessage(data.chatJid, text);
            }
            // Cross-agent: wake up the target agent
            if (targetGroup && targetGroup.folder !== sourceAgentId) {
              const trigger = targetGroup.trigger || `@${ASSISTANT_NAME}`;
              storeMessage({
                id: `s3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                chat_jid: data.chatJid,
                sender: 'system',
                sender_name: `${agents[sourceAgentId]?.name || sourceAgentId}`,
                content: `${trigger} ${data.text}`,
                timestamp: new Date().toISOString(),
                is_from_me: false,
              });
              queue.enqueueMessageCheck(data.chatJid);
            }
          }
        }
      },
      processTask: async (sourceAgentId, isAdmin, data) => {
        const { processTaskIpc } = await import('./ipc.js');
        await processTaskIpc(data, sourceAgentId, isAdmin, {
          sendMessage: async (jid, rawText) => {
            const ch = findChannel(channels, jid);
            if (!ch) return;
            const agent = agents[sourceAgentId];
            const text = formatOutbound(ch, rawText, agent?.name);
            if (text) return await ch.sendMessage(jid, text);
          },
          notifyGroup: (jid, text) => {
            const group = registeredGroups[jid];
            const trigger = group?.trigger || `@${ASSISTANT_NAME}`;
            storeMessage({
              id: `notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              chat_jid: jid,
              sender: 'system',
              sender_name: `${agents[sourceAgentId]?.name || sourceAgentId}`,
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
          syncGroupMetadata: (force) => whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
          getAvailableGroups,
          writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
        });
      },
      isAdmin: (agentId) => agents[agentId]?.isAdmin ?? false,
    });
  }

  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start OmniClaw');
    process.exit(1);
  });
}
