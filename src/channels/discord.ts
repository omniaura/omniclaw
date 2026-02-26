import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  Message,
  MessageReaction,
  PartialMessageReaction,
  User as DiscordUser,
  PartialUser,
  TextChannel,
  DMChannel,
  ChannelType,
  ThreadAutoArchiveDuration,
  type ThreadChannel,
} from 'discord.js';
import { RESTEvents } from '@discordjs/rest';

import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  buildTriggerPattern,
  DATA_DIR,
  GROUPS_DIR,
  TRIGGER_PATTERN,
} from '../config.js';
import {
  getAllRegisteredGroups,
  storeChatMetadata,
  storeMessage,
} from '../db.js';
import { logger } from '../logger.js';
import { assertPathWithin } from '../path-security.js';
import { Channel, RegisteredGroup } from '../types.js';
import { splitMessage } from './utils.js';

/**
 * Merge Discord user mention data into the shared user registry JSON.
 * Keyed by lowercase display name so the format_mention MCP tool can look users up.
 * Writes atomically (temp file + rename) to avoid partial reads.
 */
function updateUserRegistry(
  mentions: Array<{ id: string; name: string; platform: 'discord' }>,
): void {
  if (mentions.length === 0) return;
  const registryPath = path.join(DATA_DIR, 'ipc', 'user_registry.json');
  try {
    // Read existing registry or start fresh
    let registry: Record<
      string,
      { id: string; name: string; platform: string; lastSeen: string }
    > = {};
    if (fs.existsSync(registryPath)) {
      try {
        registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      } catch {
        // Corrupt file — start fresh
        registry = {};
      }
    }

    const now = new Date().toISOString();
    for (const { id, name, platform } of mentions) {
      const key = name.toLowerCase().trim();
      registry[key] = { id, name, platform, lastSeen: now };
    }

    // Atomic write: temp file then rename
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const tempPath = `${registryPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(registry, null, 2), 'utf-8');
    fs.renameSync(tempPath, registryPath);
  } catch (err) {
    logger.warn(
      { err },
      'Failed to update user registry from Discord mentions',
    );
  }
}

export interface DiscordChannelOpts {
  botId: string;
  token: string;
  multiBotMode?: boolean;
  onReaction?: (
    chatJid: string,
    messageId: string,
    emoji: string,
    userName: string,
  ) => void;
}

export class DiscordChannel implements Channel {
  name = 'discord';
  prefixAssistantName = false;
  readonly botId: string;

  private client: Client;
  private connected = false;
  private opts: DiscordChannelOpts;
  private ownedJids = new Set<string>();

  constructor(opts: DiscordChannelOpts) {
    this.opts = opts;
    this.botId = opts.botId;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, (readyClient) => {
        this.connected = true;
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id, botId: this.botId },
          'Discord bot connected',
        );
        logger.info({ tag: readyClient.user.tag }, 'Discord bot ready');
        resolve();
      });

      this.client.on(Events.MessageCreate, (message) => {
        this.handleMessage(message).catch((err) =>
          logger.error({ err }, 'Error handling Discord message'),
        );
      });

      this.client.on(Events.MessageReactionAdd, (reaction, user) => {
        this.handleReaction(reaction, user).catch((err) =>
          logger.error({ err }, 'Error handling Discord reaction'),
        );
      });

      this.client.on(Events.Error, (err) => {
        logger.error({ err }, 'Discord client error');
      });

      // Log when discord.js REST layer hits a Discord 429 rate limit.
      // The REST client retries automatically, but this gives us visibility
      // into whether our send pacing (300ms chunk delay, thread caps) is sufficient.
      this.client.rest.on(RESTEvents.RateLimited, (info) => {
        logger.warn(
          {
            route: info.route,
            method: info.method,
            retryAfterMs: info.retryAfter,
            limit: info.limit,
            global: info.global,
          },
          'Discord rate limited — REST client will auto-retry',
        );
      });

      this.client.login(this.opts.token).catch(reject);
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<string | void> {
    const channel = await resolveChannel(this.client, jid);
    if (!channel || !('send' in channel)) {
      logger.warn({ jid }, 'Discord channel not found or not sendable');
      return;
    }

    try {
      const chunks = splitMessage(text, 2000);
      let lastMessageId: string | undefined;
      for (let i = 0; i < chunks.length; i++) {
        // Delay between chunks to avoid Discord 429 rate limits (#130)
        if (i > 0) await delay(300);
        const opts =
          i === 0 && replyToMessageId
            ? {
                content: chunks[i],
                reply: { messageReference: replyToMessageId },
              }
            : chunks[i];
        const sent = await (channel as TextChannel | DMChannel).send(opts);
        lastMessageId = sent.id;
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
      this.ownedJids.add(jid);
      return lastMessageId;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    if (!jid.startsWith('dc:')) return false;
    // Backward-compatible single-bot behavior: one Discord client owns all dc: JIDs.
    if (!this.opts.multiBotMode) return true;
    return this.ownedJids.has(jid);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.client.destroy();
    logger.info('Discord bot disconnected');
  }

  /**
   * Resolve the Discord guild ID for a channel.
   * Used to backfill guildId for registered groups on startup.
   */
  async resolveGuildId(channelId: string): Promise<string | undefined> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'guildId' in channel) {
        return (channel as TextChannel).guildId || undefined;
      }
    } catch (err) {
      logger.debug({ channelId, err }, 'Failed to resolve guild ID');
    }
    return undefined;
  }

  /**
   * Resolve the guild name for a given guild ID.
   */
  async resolveGuildName(guildId: string): Promise<string | undefined> {
    try {
      const guild = await this.client.guilds.fetch(guildId);
      return guild?.name;
    } catch (err) {
      logger.debug({ guildId, err }, 'Failed to resolve guild name');
    }
    return undefined;
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return; // Discord typing auto-expires
    const channel = await resolveChannel(this.client, jid);
    if (!channel || !('sendTyping' in channel)) return;

    try {
      await (channel as TextChannel | DMChannel).sendTyping();
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }

  async createThread(
    jid: string,
    messageId: string,
    name: string,
  ): Promise<ThreadChannel | null> {
    // DMs don't support threads
    if (jid.startsWith('dc:dm:')) return null;

    const channelId = jidToChannelId(jid);
    if (!channelId) return null;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return null;

      const message = await (channel as TextChannel).messages.fetch(messageId);
      const thread = await message.startThread({
        name: name.slice(0, 100),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
      });
      return thread;
    } catch (err) {
      logger.warn({ jid, messageId, err }, 'Failed to create Discord thread');
      return null;
    }
  }

  async sendToThread(thread: ThreadChannel, text: string): Promise<void> {
    try {
      const chunks = splitMessage(text, 2000);
      for (let i = 0; i < chunks.length; i++) {
        // Delay between chunks to avoid Discord 429 rate limits (#130)
        if (i > 0) await delay(300);
        await thread.send(chunks[i]);
      }
    } catch (err) {
      logger.warn(
        { threadId: thread.id, err },
        'Failed to send to Discord thread',
      );
    }
  }

  async addReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const channelId = jidToChannelId(jid);
    if (!channelId) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const message = await (channel as TextChannel).messages.fetch(messageId);
      await message.react(emoji);
    } catch (err) {
      logger.warn(
        { jid, messageId, emoji, err },
        'Failed to add Discord reaction',
      );
    }
  }

  async removeReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const channelId = jidToChannelId(jid);
    if (!channelId) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const message = await (channel as TextChannel).messages.fetch(messageId);
      const botReaction = message.reactions.cache.find(
        (r) => r.emoji.name === emoji,
      );
      if (botReaction) await botReaction.users.remove(this.client.user!.id);
    } catch (err) {
      logger.warn(
        { jid, messageId, emoji, err },
        'Failed to remove Discord reaction',
      );
    }
  }

  /**
   * Check if message should auto-respond based on group config
   */
  shouldAutoRespond(content: string, group: RegisteredGroup): boolean {
    // Check for question ending with '?'
    if (group.autoRespondToQuestions && content.trim().endsWith('?')) {
      return true;
    }

    // Check for keywords with word-boundary matching (case-insensitive)
    // Uses \b to avoid matching substrings (e.g., "help" won't match "helper")
    if (group.autoRespondKeywords) {
      return group.autoRespondKeywords.some((keyword: string) => {
        // Escape special regex characters in the keyword
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
        return pattern.test(content);
      });
    }

    return false;
  }

  private async handleMessage(message: Message): Promise<void> {
    // Ignore own messages
    if (message.author.id === this.client.user?.id) return;

    let content = message.content;

    // Translate @bot mention into trigger format
    // FIX: Determine agent name from the channel's registered group, not global ASSISTANT_NAME
    const botId = this.client.user?.id;
    if (botId && content.includes(`<@${botId}>`)) {
      content = content.replace(new RegExp(`<@${botId}>`, 'g'), '').trim();
      if (!TRIGGER_PATTERN.test(content)) {
        // Get agent name from the group's trigger (e.g., "@OmarOmni" → "OmarOmni")
        const isDM = message.channel.type === ChannelType.DM;
        const chatJid = isDM
          ? `dc:dm:${message.author.id}`
          : `dc:${message.channelId}`;
        const registeredGroups = getAllRegisteredGroups();
        const group = registeredGroups[chatJid];
        const agentName = group?.trigger?.replace(/^@/, '') || ASSISTANT_NAME;
        content = `@${agentName} ${content}`;
      }
    }

    // Resolve all remaining <@USER_ID> mentions to display names so the agent
    // knows who is being referenced. Uses server nickname > global display name > username.
    // Also collect mention metadata for user registry (Issue #66)
    const mentions: Array<{ id: string; name: string; platform: 'discord' }> =
      [];

    if (message.mentions.members?.size) {
      for (const [id, member] of message.mentions.members) {
        if (id === botId) continue; // Already handled above
        const name =
          member.displayName || member.user.displayName || member.user.username;
        content = content.replace(new RegExp(`<@!?${id}>`, 'g'), `@${name}`);
        mentions.push({ id, name, platform: 'discord' });
      }
    } else if (message.mentions.users?.size) {
      // Fallback for DMs or when member data isn't available
      for (const [id, user] of message.mentions.users) {
        if (id === botId) continue;
        const name = user.displayName || user.username;
        content = content.replace(new RegExp(`<@!?${id}>`, 'g'), `@${name}`);
        mentions.push({ id, name, platform: 'discord' });
      }
    }
    // Persist mention metadata to user registry so format_mention MCP tool can look them up
    updateUserRegistry(mentions);
    // Resolve <@&ROLE_ID> role mentions and <#CHANNEL_ID> channel mentions
    if (message.mentions.roles?.size) {
      for (const [id, role] of message.mentions.roles) {
        content = content.replace(
          new RegExp(`<@&${id}>`, 'g'),
          `@${role.name}`,
        );
      }
    }
    if (message.mentions.channels?.size) {
      for (const [id, ch] of message.mentions.channels) {
        const name = 'name' in ch ? (ch as TextChannel).name : id;
        content = content.replace(new RegExp(`<#${id}>`, 'g'), `#${name}`);
      }
    }

    const isDM = message.channel.type === ChannelType.DM;

    // Detect thread messages: route via parent channel for group lookup
    const isThread = !isDM && message.channel.isThread();
    const threadParentId =
      isThread && message.channel.parent ? message.channel.parent.id : null;

    // Allow bot messages through only if they contain our trigger (agent-to-agent comms).
    // This prevents infinite loops — bots must explicitly @mention us.
    // Use per-channel trigger so agent-to-agent comms work across multi-agent servers.
    // For threads, resolve the parent channel's group for the trigger pattern.
    {
      const _chatJid = isDM
        ? `dc:dm:${message.author.id}`
        : isThread && threadParentId
          ? `dc:${threadParentId}`
          : `dc:${message.channelId}`;
      const _group = getAllRegisteredGroups()[_chatJid];
      const _triggerPattern = buildTriggerPattern(_group?.trigger);
      if (message.author.bot && !_triggerPattern.test(content)) return;
    }

    // In guild channels, only process messages that mention THIS bot OR reply to the bot.
    // Prevents responding when another agent (e.g. @PeytonOmni) is mentioned instead.
    const isReplyToBot = message.mentions.repliedUser?.id === botId;
    // Only block if message mentions other users but NOT this bot.
    // Messages with NO mentions pass through to auto-respond check below.
    // Guard botId != null so TypeScript is satisfied (Map.has requires a string).
    const mentionsOtherUsersOnly =
      botId != null &&
      message.mentions.users.size > 0 &&
      !message.mentions.users.has(botId) &&
      !isReplyToBot;
    if (!isDM && botId && mentionsOtherUsersOnly) {
      logger.debug(
        { chatJid: `dc:${message.channelId}`, sender: message.author.username },
        'Ignoring message mentioning other users',
      );
      return;
    }

    // Prepend reply context so the agent knows what's being replied to
    if (message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(
          message.reference.messageId,
        );
        const refAuthor =
          refMsg.member?.displayName ||
          refMsg.author.displayName ||
          refMsg.author.username;
        const refContent =
          refMsg.content.length > 200
            ? refMsg.content.slice(0, 200) + '…'
            : refMsg.content;
        if (refContent) {
          content = `[Replying to ${refAuthor}: "${refContent}"]\n${content}`;
        }
      } catch {
        /* deleted message — continue without context */
      }
    }

    // For thread messages, route via parent channel JID so we find the registered group.
    // Responses go to the parent channel (thread-reply routing is a future enhancement).
    const chatJid = isDM
      ? `dc:dm:${message.author.id}`
      : isThread && threadParentId
        ? `dc:${threadParentId}`
        : `dc:${message.channelId}`;

    const timestamp = message.createdAt.toISOString();
    const senderName =
      message.member?.displayName ||
      message.author.displayName ||
      message.author.username;
    const sender = message.author.id;
    const msgId = message.id;

    // DMs always trigger — prepend trigger if not present
    if (isDM && !TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    // Determine chat name
    const chatName = isDM
      ? senderName
      : (message.channel as TextChannel).name || chatJid;

    // Store chat metadata for discovery (include guild ID for server-level context)
    storeChatMetadata(
      chatJid,
      timestamp,
      chatName,
      message.guildId || undefined,
    );

    // Check if this chat is registered
    const registeredGroups = getAllRegisteredGroups();
    const group = registeredGroups[chatJid];

    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Discord chat',
      );
      return;
    }

    // Handle attachments (after group check so we know the folder for image downloads)
    if (message.attachments.size > 0) {
      const parts: string[] = [];
      for (const [, a] of message.attachments) {
        if (a.contentType?.startsWith('image/')) {
          try {
            const mediaDir = path.join(GROUPS_DIR, group.folder, 'media');
            fs.mkdirSync(mediaDir, { recursive: true });
            // Layer 1: Strip directory components to prevent path traversal
            // (e.g. "../../etc/cron.d/evil.png" → "evil.png")
            const safeName = path.basename(a.name || 'image.png');
            const filename = `${msgId}-${safeName}`;
            const filePath = path.join(mediaDir, filename);
            // Layer 2: Defense-in-depth — verify resolved path stays within mediaDir
            assertPathWithin(filePath, mediaDir, 'Discord image attachment');
            const resp = await fetch(a.url);
            fs.writeFileSync(filePath, Buffer.from(await resp.arrayBuffer()));
            parts.push(`[attachment:image file=${filename}]`);
          } catch (err) {
            logger.error(
              { err, url: a.url },
              'Failed to download Discord image',
            );
            parts.push('[Image]');
          }
        } else if (a.contentType?.startsWith('video/')) {
          parts.push('[Video]');
        } else if (a.contentType?.startsWith('audio/')) {
          parts.push('[Audio]');
        } else {
          // Attempt to inline text-based file attachments
          const TEXT_EXTENSIONS = new Set([
            '.txt',
            '.md',
            '.json',
            '.csv',
            '.log',
            '.xml',
            '.yaml',
            '.yml',
            '.toml',
            '.py',
            '.js',
            '.ts',
            '.html',
            '.css',
            '.sh',
            '.cfg',
            '.ini',
            '.sql',
            '.env.example',
          ]);
          const MAX_TEXT_SIZE = 100 * 1024; // 100 KB
          // Strip directory components from filename to prevent path traversal in metadata
          const safeName = path.basename(a.name || 'attachment');
          const ext = path.extname(safeName).toLowerCase();
          const fileName = safeName;

          if (
            TEXT_EXTENSIONS.has(ext) &&
            (a.size ?? Infinity) <= MAX_TEXT_SIZE
          ) {
            try {
              const resp = await fetch(a.url);
              const text = await resp.text();
              parts.push(
                `[attachment:file name=${fileName}]\n${text}\n[/attachment:file]`,
              );
            } catch (err) {
              logger.error(
                { err, url: a.url },
                'Failed to download Discord text attachment',
              );
              parts.push(`[File: ${fileName}]`);
            }
          } else {
            parts.push(`[File: ${fileName}]`);
          }
        }
      }
      const suffix = parts.join(' ');
      content = content ? `${content} ${suffix}` : suffix;
    }

    if (!content) return;

    // Smart auto-respond: check if we should respond without explicit mention
    const hasTrigger = TRIGGER_PATTERN.test(content);
    if (!hasTrigger && !isDM) {
      if (isReplyToBot) {
        // Reply to bot = treat as triggered
        logger.info(
          { chatJid, sender: senderName },
          'Reply to bot — treating as triggered',
        );
        content = `@${ASSISTANT_NAME} ${content}`;
      } else if (isThread && message.channel.ownerId === botId) {
        // Auto-trigger in threads created by this bot — no @mention needed.
        // Use per-group trigger name for consistency with multi-agent setups.
        const threadName = message.channel.name || 'thread';
        const agentName = group?.trigger?.replace(/^@/, '') || ASSISTANT_NAME;
        const groupTriggerPattern = buildTriggerPattern(group?.trigger);
        logger.info(
          {
            chatJid,
            threadId: message.channelId,
            threadName,
            sender: senderName,
          },
          'Auto-triggering in bot-created thread',
        );
        // Check original content before prepending thread context to avoid double trigger prefix
        const hasGroupTrigger = groupTriggerPattern.test(content);
        content = `[In thread: ${threadName}] ${content}`;
        if (!hasGroupTrigger) {
          content = `@${agentName} ${content}`;
        }
      } else if (this.shouldAutoRespond(content, group)) {
        logger.debug(
          {
            chatJid,
            autoRespondToQuestions: group.autoRespondToQuestions,
            autoRespondKeywords: group.autoRespondKeywords,
          },
          'Auto-responding based on group config',
        );
        // Prepend trigger so message gets processed
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // Clean up media files older than 24 hours
    this.cleanupOldMedia(group.folder);

    // Mark this JID as owned by this bot only after we accept/process the message.
    this.ownedJids.add(chatJid);

    // Store message — startMessageLoop() will pick it up
    storeMessage({
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      sender_user_id: sender, // Discord user ID
      mentions: mentions.length > 0 ? mentions : undefined,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Discord message stored',
    );
  }
  private async handleReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: DiscordUser | PartialUser,
  ): Promise<void> {
    // Ignore reactions from the bot itself
    if (user.id === this.client.user?.id) return;

    // Fetch partial reaction/message if needed
    if (reaction.partial) {
      try {
        reaction = await reaction.fetch();
      } catch (err) {
        logger.debug({ err }, 'Failed to fetch partial reaction');
        return;
      }
    }
    if (reaction.message.partial) {
      try {
        await reaction.message.fetch();
      } catch (err) {
        logger.debug({ err }, 'Failed to fetch partial message for reaction');
        return;
      }
    }

    // Only handle reactions on bot messages
    if (reaction.message.author?.id !== this.client.user?.id) return;

    const isDM = reaction.message.channel.type === ChannelType.DM;
    const chatJid = isDM
      ? `dc:dm:${user.id}`
      : `dc:${reaction.message.channelId}`;
    this.ownedJids.add(chatJid);
    const emoji = reaction.emoji.name || '';

    const userName = user.displayName || user.username || 'Someone';
    this.opts.onReaction?.(chatJid, reaction.message.id, emoji, userName);
  }

  private cleanupOldMedia(folder: string): void {
    try {
      const mediaDir = path.join(GROUPS_DIR, folder, 'media');
      if (!fs.existsSync(mediaDir)) return;
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours
      for (const file of fs.readdirSync(mediaDir)) {
        const filePath = path.join(mediaDir, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAge) {
          fs.unlinkSync(filePath);
        }
      }
    } catch {
      // Non-critical — ignore cleanup errors
    }
  }
}

/** Promisified setTimeout for rate-limit delays between chunk sends */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Convert a dc: JID to a Discord channel ID (guild channels only) */
export function jidToChannelId(jid: string): string | null {
  if (jid.startsWith('dc:dm:')) return null; // DMs use user ID, not channel ID
  if (jid.startsWith('dc:')) return jid.slice(3);
  return null;
}

/** Resolve a JID to a sendable Discord channel. For DMs (dc:dm:userId), fetches/creates DM channel. */
async function resolveChannel(
  client: Client,
  jid: string,
): Promise<TextChannel | DMChannel | null> {
  if (jid.startsWith('dc:dm:')) {
    const userId = jid.slice(6);
    try {
      const dmChannel = await client.users.createDM(userId);
      return dmChannel;
    } catch (err) {
      logger.warn({ jid, userId, err }, 'Failed to get Discord DM channel');
      return null;
    }
  }
  if (jid.startsWith('dc:')) {
    const channelId = jid.slice(3);
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel && ('send' in channel || 'sendTyping' in channel)) {
        return channel as TextChannel | DMChannel;
      }
    } catch (err) {
      logger.warn({ jid, channelId, err }, 'Failed to fetch Discord channel');
    }
    return null;
  }
  return null;
}
