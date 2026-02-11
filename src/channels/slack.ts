import { App, LogLevel } from '@slack/bolt';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import {
  getAllRegisteredGroups,
  storeChatMetadata,
  storeMessageDirect,
} from '../db.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';

export class SlackChannel implements Channel {
  name = 'slack';
  prefixAssistantName = false;

  private app: App;
  private connected = false;
  private botUserId = '';
  private userNameCache = new Map<string, string>();

  constructor(botToken: string, appToken: string) {
    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });
  }

  async connect(): Promise<void> {
    // Register message event handler
    this.app.event('message', async ({ event, client }) => {
      try {
        await this.handleMessage(event as any, client);
      } catch (err) {
        logger.error({ err }, 'Error handling Slack message');
      }
    });

    await this.app.start();

    // Resolve bot user ID
    try {
      const authResult = await this.app.client.auth.test();
      this.botUserId = (authResult.user_id as string) || '';
      this.connected = true;
      logger.info(
        { botUserId: this.botUserId },
        'Slack bot connected via Socket Mode',
      );
      console.log(`\n  Slack bot: ${authResult.user || this.botUserId}`);
    } catch (err) {
      logger.error({ err }, 'Failed to resolve Slack bot user ID');
      this.connected = true; // Still connected, just can't filter self
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jidToChannelId(jid);
    if (!channelId) {
      logger.warn({ jid }, 'Cannot resolve Slack channel ID from JID');
      return;
    }

    try {
      const chunks = splitMessage(text, 4000);
      for (const chunk of chunks) {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: chunk,
        });
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
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

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Slack doesn't support bot typing indicators — no-op
  }

  /**
   * Resolve the Slack workspace/team ID for a channel.
   */
  async resolveWorkspaceId(channelId: string): Promise<string | undefined> {
    try {
      const result = await this.app.client.conversations.info({ channel: channelId });
      const channel = result.channel as any;
      return channel?.context_team_id || channel?.shared_team_ids?.[0] || undefined;
    } catch (err) {
      logger.debug({ channelId, err }, 'Failed to resolve Slack workspace ID');
    }
    return undefined;
  }

  /**
   * Resolve the workspace name for a given workspace/team ID.
   */
  async resolveWorkspaceName(workspaceId: string): Promise<string | undefined> {
    try {
      const result = await this.app.client.team.info({ team: workspaceId });
      return (result.team as any)?.name;
    } catch (err) {
      logger.debug({ workspaceId, err }, 'Failed to resolve Slack workspace name');
    }
    return undefined;
  }

  private async resolveUserName(userId: string): Promise<string> {
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const user = result.user as any;
      const name = user?.profile?.display_name || user?.real_name || user?.name || userId;
      this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return userId;
    }
  }

  private async handleMessage(event: any, client: any): Promise<void> {
    // Ignore bot messages and subtypes (edits, joins, etc.)
    if (event.bot_id) return;
    if (event.subtype) return;
    if (event.user === this.botUserId) return;

    const isDM = event.channel_type === 'im';
    const chatJid = isDM
      ? `slack:dm:${event.channel}`
      : `slack:${event.channel}`;

    let content = event.text || '';
    const timestamp = new Date(parseFloat(event.ts) * 1000).toISOString();
    const sender = event.user || '';
    const senderName = await this.resolveUserName(sender);
    const msgId = event.ts;

    // Translate @bot mentions into trigger format
    if (this.botUserId && content.includes(`<@${this.botUserId}>`)) {
      content = content.replace(new RegExp(`<@${this.botUserId}>`, 'g'), '').trim();
      if (!TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // DMs always trigger — prepend trigger if not present
    if (isDM && !TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    // Determine chat name
    let chatName = chatJid;
    if (isDM) {
      chatName = senderName;
    } else {
      try {
        const channelInfo = await client.conversations.info({ channel: event.channel });
        chatName = (channelInfo.channel as any)?.name || chatJid;
      } catch {
        // Non-critical — use JID as fallback
      }
    }

    // Store chat metadata (include workspace ID for server-level context)
    storeChatMetadata(chatJid, timestamp, chatName, undefined, event.team || undefined);

    // Check if this chat is registered
    const registeredGroups = getAllRegisteredGroups();
    const group = registeredGroups[chatJid];

    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Slack chat',
      );
      return;
    }

    // Handle file attachments (images)
    if (event.files && event.files.length > 0) {
      const parts: string[] = [];
      for (const file of event.files) {
        if (file.mimetype?.startsWith('image/')) {
          try {
            const mediaDir = path.join(GROUPS_DIR, group.folder, 'media');
            fs.mkdirSync(mediaDir, { recursive: true });
            const filename = `${msgId}-${file.name || 'image.png'}`;
            const resp = await fetch(file.url_private, {
              headers: { Authorization: `Bearer ${this.app.client.token}` },
            });
            fs.writeFileSync(path.join(mediaDir, filename), Buffer.from(await resp.arrayBuffer()));
            parts.push(`[attachment:image file=${filename}]`);
          } catch (err) {
            logger.error({ err, url: file.url_private }, 'Failed to download Slack image');
            parts.push('[Image]');
          }
        } else if (file.mimetype?.startsWith('video/')) {
          parts.push('[Video]');
        } else if (file.mimetype?.startsWith('audio/')) {
          parts.push('[Audio]');
        } else {
          parts.push(`[File: ${file.name || 'attachment'}]`);
        }
      }
      const suffix = parts.join(' ');
      content = content ? `${content} ${suffix}` : suffix;
    }

    if (!content) return;

    // Clean up media files older than 24 hours
    this.cleanupOldMedia(group.folder);

    // Store message — startMessageLoop() will pick it up
    storeMessageDirect({
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Slack message stored',
    );
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

/** Convert a slack: JID to a Slack channel ID */
function jidToChannelId(jid: string): string | null {
  if (jid.startsWith('slack:dm:')) return jid.slice(9);
  if (jid.startsWith('slack:')) return jid.slice(6);
  return null;
}

/**
 * Split a message into chunks respecting Slack's 4000-char limit.
 * Prefers splitting at newlines, then spaces, then hard-splits.
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx <= 0) splitIdx = remaining.lastIndexOf(' ', maxLength);
    if (splitIdx <= 0) splitIdx = maxLength;

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
