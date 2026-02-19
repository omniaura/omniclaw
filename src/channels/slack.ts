import { App } from '@slack/bolt';
import { WebClient } from '@slack/web-api';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

// JID format: "slack:{channelId}" for channels/DMs
// e.g. "slack:C12345678" for a channel, "slack:D12345678" for a DM

function jidToChannelId(jid: string): string | null {
  if (!jid.startsWith('slack:')) return null;
  return jid.slice('slack:'.length);
}

function channelIdToJid(channelId: string): string {
  return `slack:${channelId}`;
}

/** Split text at Slack's 4000-char message limit */
function splitMessage(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

/** Resolve <@USERID> Slack mentions into display names. */
async function resolveMentions(
  text: string,
  client: WebClient,
): Promise<{ text: string; mentions: Array<{ id: string; name: string }> }> {
  const mentionRegex = /<@([A-Z0-9]+)>/g;
  const userIds = [...new Set([...text.matchAll(mentionRegex)].map((m) => m[1]))];
  const mentions: Array<{ id: string; name: string }> = [];

  for (const userId of userIds) {
    try {
      const info = await client.users.info({ user: userId });
      const displayName =
        info.user?.profile?.display_name ||
        info.user?.profile?.real_name ||
        info.user?.name ||
        userId;
      mentions.push({ id: userId, name: displayName });
      text = text.replace(new RegExp(`<@${userId}>`, 'g'), `@${displayName}`);
    } catch {
      // If lookup fails, leave the raw mention
    }
  }

  return { text, mentions };
}

export interface SlackChannelOpts {
  token: string;        // Bot token (xoxb-...)
  appToken: string;     // App-level token for Socket Mode (xapp-...)
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onReaction?: (chatJid: string, messageId: string, emoji: string, userName: string) => void;
}

export class SlackChannel implements Channel {
  name = 'slack';
  prefixAssistantName = true;

  private app: App;
  private client: WebClient;
  private botUserId: string | null = null;
  private connected = false;
  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    this.app = new App({
      token: opts.token,
      appToken: opts.appToken,
      socketMode: true,
    });

    // Shared WebClient for direct API calls (reactions, sends, etc.)
    this.client = new WebClient(opts.token);
  }

  async connect(): Promise<void> {
    // Register message handler
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.app.message(async ({ message }: { message: any }) => {
      await this.handleMessage(message).catch((err: unknown) =>
        logger.error({ err }, 'Error handling Slack message'),
      );
    });

    // Register reaction handler (for share-request approvals etc.)
    this.app.event('reaction_added', async ({ event }) => {
      const channelId = event.item.type === 'message' ? (event.item as any).channel : null;
      if (!channelId) return;

      const chatJid = channelIdToJid(channelId);
      const messageId = event.item.type === 'message' ? (event.item as any).ts : null;
      if (!messageId) return;

      const emoji = `:${event.reaction}:`;

      let userName = event.user;
      try {
        const info = await this.client.users.info({ user: event.user });
        userName =
          info.user?.profile?.display_name ||
          info.user?.profile?.real_name ||
          info.user?.name ||
          event.user;
      } catch {
        // Fall back to user ID
      }

      this.opts.onReaction?.(chatJid, messageId, emoji, userName);
    });

    // Start Socket Mode — resolves when connected
    await this.app.start();

    // Fetch bot user ID so we can ignore our own messages
    try {
      const authResult = await this.client.auth.test();
      this.botUserId = authResult.user_id as string;
      const botName = authResult.user || ASSISTANT_NAME;
      logger.info({ botUserId: this.botUserId, botName }, 'Slack bot connected');
      console.log(`\n  Slack bot: @${botName}`);
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch Slack bot user ID');
    }

    this.connected = true;
  }

  async sendMessage(jid: string, text: string, replyToMessageId?: string): Promise<string | void> {
    const channelId = jidToChannelId(jid);
    if (!channelId) {
      logger.warn({ jid }, 'Invalid Slack JID — cannot send message');
      return;
    }

    try {
      const chunks = splitMessage(text);
      let lastTs: string | undefined;

      for (let i = 0; i < chunks.length; i++) {
        const result = await this.client.chat.postMessage({
          channel: channelId,
          text: chunks[i],
          // Only thread the first chunk to the trigger message; rest follow in the thread
          ...(replyToMessageId ? { thread_ts: replyToMessageId } : {}),
        });
        lastTs = result.ts as string | undefined;
      }

      logger.info({ jid, length: text.length }, 'Slack message sent');
      return lastTs;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Slack message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
    logger.info('Slack bot disconnected');
  }

  async addReaction(jid: string, messageId: string, emoji: string): Promise<void> {
    const channelId = jidToChannelId(jid);
    if (!channelId) return;
    // Strip surrounding colons if passed as :emoji:
    const name = emoji.replace(/^:|:$/g, '');
    try {
      await this.client.reactions.add({ channel: channelId, timestamp: messageId, name });
    } catch (err) {
      logger.warn({ jid, messageId, emoji, err }, 'Failed to add Slack reaction');
    }
  }

  async removeReaction(jid: string, messageId: string, emoji: string): Promise<void> {
    const channelId = jidToChannelId(jid);
    if (!channelId) return;
    const name = emoji.replace(/^:|:$/g, '');
    try {
      await this.client.reactions.remove({ channel: channelId, timestamp: messageId, name });
    } catch (err) {
      logger.warn({ jid, messageId, emoji, err }, 'Failed to remove Slack reaction');
    }
  }

  /**
   * Thread support: Slack threads are implicit — creating one just means replying
   * to a message's ts. We return an object with {channelId, ts} so sendToThread can use it.
   */
  async createThread(
    jid: string,
    messageId: string,
    _name: string,
  ): Promise<{ channelId: string; ts: string } | null> {
    const channelId = jidToChannelId(jid);
    if (!channelId) return null;
    // In Slack, a thread is created implicitly on first reply — just return the anchor info
    return { channelId, ts: messageId };
  }

  async sendToThread(thread: { channelId: string; ts: string }, text: string): Promise<void> {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      try {
        await this.client.chat.postMessage({
          channel: thread.channelId,
          text: chunk,
          thread_ts: thread.ts,
        });
      } catch (err) {
        logger.warn({ thread, err }, 'Failed to send to Slack thread');
      }
    }
  }

  // Slack doesn't expose a public "user is typing" API, so we no-op setTyping
  // (the Bolt SDK does not support sending typing indicators to channels)

  // ──────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleMessage(event: any): Promise<void> {
    // Ignore bot messages (including our own)
    if (event.subtype === 'bot_message') return;
    if ('bot_id' in event && event.bot_id) return;
    if (this.botUserId && 'user' in event && event.user === this.botUserId) return;

    // Only process text messages
    if (!('text' in event) || !event.text) return;

    const channelId = event.channel;
    const chatJid = channelIdToJid(channelId);
    // Slack ts is the unique message timestamp, doubles as message ID
    const msgId = event.ts;
    const timestamp = new Date(parseFloat(event.ts) * 1000).toISOString();

    const senderUserId = 'user' in event ? event.user : 'unknown';
    let senderName = senderUserId;
    try {
      const info = await this.client.users.info({ user: senderUserId });
      senderName =
        info.user?.profile?.display_name ||
        info.user?.profile?.real_name ||
        info.user?.name ||
        senderUserId;
    } catch {
      // Fall back to user ID
    }

    // Resolve <@USERID> mentions to display names
    const { text: resolvedText, mentions } = await resolveMentions(event.text, this.client);
    let content = resolvedText;

    // Translate @BotName mention into our internal trigger format
    // Slack uses <@BOTID> which we already resolved above to @AssistantName
    if (
      content.toLowerCase().includes(`@${ASSISTANT_NAME.toLowerCase()}`) &&
      !TRIGGER_PATTERN.test(content)
    ) {
      content = content.replace(
        new RegExp(`@${ASSISTANT_NAME}`, 'i'),
        `@${ASSISTANT_NAME}`,
      );
      // Ensure it's at the start if it's the only trigger
      if (!TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // Prepend thread context if this is a threaded reply
    if ('thread_ts' in event && event.thread_ts && event.thread_ts !== event.ts) {
      // This message is a reply in a thread — note context for the agent
      content = `[Thread reply] ${content}`;
    }

    // Store channel metadata for group discovery
    let channelName = channelId;
    try {
      const info = await this.client.conversations.info({ channel: channelId });
      channelName = (info.channel as any)?.name || channelId;
    } catch {
      // Fall back to channel ID
    }
    this.opts.onChatMetadata(chatJid, timestamp, channelName);

    // Only process registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid, channelName }, 'Message from unregistered Slack channel — ignoring');
      return;
    }

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: senderUserId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      sender_user_id: senderUserId,
      mentions: mentions.map((m) => ({ ...m, platform: 'slack' as const })),
    });

    logger.info({ chatJid, channelName, sender: senderName }, 'Slack message stored');
  }
}
