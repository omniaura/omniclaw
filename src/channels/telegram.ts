import fs from 'fs';
import path from 'path';
import { Bot } from 'grammy';
import telegramifyMarkdown from 'telegramify-markdown';

import { logger } from '../logger.js';
import {
  buildSafeMediaPath,
  downloadBinaryAttachment,
  downloadTextAttachment,
  ensureMediaDir,
  formatBinaryFileMarker,
  formatImageMarker,
  formatPlaceholder,
  formatTextFileMarker,
  isImageByTypeOrExtension,
  isTextByExtension,
  MAX_BINARY_DOWNLOAD_BYTES,
  MAX_TEXT_DOWNLOAD_BYTES,
} from '../media.js';
import {
  buildTelegramApiFileUrl,
  buildTelegramFileDescriptor,
  parseTelegramApiFileUrl,
  parseTelegramFileDescriptor,
} from '../telegram-avatar.js';
import type {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { splitMessage } from './utils.js';

// Grammy HTTP errors can contain the full bot API URL (https://api.telegram.org/bot<TOKEN>/...)
// which leaks the bot token into structured logs. Extract only the safe message.
const TELEGRAM_BOT_URL_RE = /https?:\/\/api\.telegram\.org\/bot[^\s/]+/gi;

export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message.replace(
      TELEGRAM_BOT_URL_RE,
      'https://api.telegram.org/bot[REDACTED]',
    );
  }
  return String(err).replace(
    TELEGRAM_BOT_URL_RE,
    'https://api.telegram.org/bot[REDACTED]',
  );
}

type TelegramReactionEmoji =
  import('@grammyjs/types').ReactionTypeEmoji['emoji'];
export const VALID_TELEGRAM_REACTIONS: readonly TelegramReactionEmoji[] = [
  '👍',
  '👎',
  '❤',
  '🔥',
  '🥰',
  '👏',
  '😁',
  '🤔',
  '🤯',
  '😱',
  '🤬',
  '😢',
  '🎉',
  '🤩',
  '🤮',
  '💩',
  '🙏',
  '👌',
  '🕊',
  '🤡',
  '🥱',
  '🥴',
  '😍',
  '🐳',
  '❤‍🔥',
  '🌚',
  '🌭',
  '💯',
  '🤣',
  '⚡',
  '🍌',
  '🏆',
  '💔',
  '🤨',
  '😐',
  '🍓',
  '🍾',
  '💋',
  '🖕',
  '😈',
  '😴',
  '😭',
  '🤓',
  '👻',
  '👨‍💻',
  '👀',
  '🎃',
  '🙈',
  '😇',
  '😨',
  '🤝',
  '✍',
  '🤗',
  '🫡',
  '🎅',
  '🎄',
  '☃',
  '💅',
  '🤪',
  '🗿',
  '🆒',
  '💘',
  '🙉',
  '🦄',
  '😘',
  '💊',
  '🙊',
  '😎',
  '👾',
  '🤷‍♂',
  '🤷',
  '🤷‍♀',
  '😡',
];
export function isTelegramReactionEmoji(v: string): v is TelegramReactionEmoji {
  return (VALID_TELEGRAM_REACTIONS as readonly string[]).includes(v);
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  allowLegacyJidRouting?: boolean;
  /** Called when a message arrives from an unregistered chat. Return true if registered. */
  autoRegister?: (chatJid: string, chatName: string) => Promise<boolean>;
}

export class TelegramChannel implements Channel {
  name = 'telegram';
  prefixAssistantName = false; // Telegram bots already display their name
  readonly botId: string;

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private allowLegacyJidRouting: boolean;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
    const tokenPrefix = botToken.split(':', 1)[0] || '';
    this.botId = /^\d+$/.test(tokenPrefix) ? tokenPrefix : 'telegram-bot';
    this.allowLegacyJidRouting = opts.allowLegacyJidRouting !== false;
  }

  private buildSenderIdentity(
    from: { id?: string | number | bigint } | null | undefined,
  ): {
    sender: string;
    senderUserId?: string;
  } {
    const senderUserId = from?.id != null ? String(from.id) : undefined;
    return {
      sender: senderUserId ? `telegram:${senderUserId}` : '',
      senderUserId,
    };
  }

  /**
   * True when `replyTo.from.id` matches this bot's own ID — i.e. the user is
   * replying to one of the bot's messages. Used as an implicit trigger so
   * the agent activates without an explicit @mention.
   */
  private isReplyToThisBot(
    replyTo: { from?: { id?: string | number | bigint } | null } | undefined,
  ): boolean {
    const fromId = replyTo?.from?.id;
    if (fromId == null) return false;
    return String(fromId) === this.botId;
  }

  /**
   * Look up the registered group for a chat, auto-registering if configured.
   */
  private async resolveGroup(
    chatJid: string,
    legacyChatJid: string,
    chatName: string,
  ): Promise<RegisteredGroup | undefined> {
    const groups = this.opts.registeredGroups();
    let group = groups[chatJid] || groups[legacyChatJid];
    if (!group && this.opts.autoRegister) {
      const registered = await this.opts.autoRegister(chatJid, chatName);
      if (registered) {
        group = groups[chatJid] || groups[legacyChatJid];
      }
    }
    return group;
  }

  /**
   * Resolve a Telegram file_id to a download URL via the Bot API.
   * Returns `null` if the file cannot be resolved (bot not connected, no path).
   */
  private async getTelegramFileUrl(fileId: string): Promise<string | null> {
    if (!this.bot) return null;
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) return null;
    return buildTelegramApiFileUrl(this.botToken, file.file_path);
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const scopedChatId = `tg:${this.botId}:${chatId}`;
      const legacyChatId = `tg:${chatId}`;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : 'title' in ctx.chat
            ? ctx.chat.title
            : 'Unknown';

      ctx.reply(
        `Chat ID: \`${scopedChatId}\`\nLegacy ID: \`${legacyChatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ctx.me.first_name || ctx.me.username} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatId = ctx.chat.id;
      const chatJid = `tg:${this.botId}:${chatId}`;
      const legacyChatJid = `tg:${chatId}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const { sender, senderUserId } = this.buildSenderIdentity(ctx.from);
      const senderName =
        ctx.from?.first_name || ctx.from?.username || 'Unknown';
      const msgId = ctx.message.message_id.toString();

      if (!senderName || senderName === 'Unknown') {
        logger.warn(
          {
            op: 'senderIdentity',
            counter: 'sender_name_empty',
            platform: 'telegram',
            sender,
          },
          'Telegram message has empty/unknown sender_name',
        );
      }

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : 'title' in ctx.chat
            ? ctx.chat.title
            : chatJid;

      // Prepend reply context so the agent knows what's being replied to
      const replyTo = ctx.message.reply_to_message;
      const isReplyToBot = this.isReplyToThisBot(replyTo);
      const replyToBotId = isReplyToBot ? String(replyTo?.from?.id) : undefined;
      if (replyTo && 'text' in replyTo && replyTo.text) {
        const truncated =
          replyTo.text.length > 200
            ? replyTo.text.slice(0, 200) + '…'
            : replyTo.text;
        const replyAuthor =
          replyTo.from?.first_name || replyTo.from?.username || 'someone';
        content = `[Replying to ${replyAuthor}: "${truncated}"]\n${content}`;
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);
      this.opts.onChatMetadata(legacyChatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = await this.resolveGroup(chatJid, legacyChatJid, chatName);
      if (!group) {
        logger.debug(
          { chatJid, legacyChatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        sender_platform: 'telegram',
        sender_user_id: senderUserId,
        is_reply_to_bot: isReplyToBot,
        reply_to_bot_id: replyToBotId,
      });

      logger.info(
        { chatJid, chatName, sender: senderName, isReplyToBot },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = async (ctx: any, placeholder: string) => {
      const chatId = ctx.chat.id;
      const chatJid = `tg:${this.botId}:${chatId}`;
      const legacyChatJid = `tg:${chatId}`;
      const chatName =
        ctx.chat.type === 'private'
          ? ctx.from?.first_name || ctx.from?.username || 'Unknown'
          : 'title' in ctx.chat
            ? ctx.chat.title
            : chatJid;
      const group = await this.resolveGroup(chatJid, legacyChatJid, chatName);
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const { sender, senderUserId } = this.buildSenderIdentity(ctx.from);
      const senderName =
        ctx.from?.first_name || ctx.from?.username || 'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const isReplyToBot = this.isReplyToThisBot(ctx.message.reply_to_message);
      const replyToBotId = isReplyToBot
        ? String(ctx.message.reply_to_message?.from?.id)
        : undefined;

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onChatMetadata(legacyChatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
        sender_platform: 'telegram',
        sender_user_id: senderUserId,
        is_reply_to_bot: isReplyToBot,
        reply_to_bot_id: replyToBotId,
      });
    };

    // Photos: download the largest resolution and store as image attachment
    this.bot.on('message:photo', async (ctx) => {
      const chatId = ctx.chat.id;
      const chatJid = `tg:${this.botId}:${chatId}`;
      const legacyChatJid = `tg:${chatId}`;
      const chatName =
        ctx.chat.type === 'private'
          ? ctx.from?.first_name || ctx.from?.username || 'Unknown'
          : 'title' in ctx.chat
            ? ctx.chat.title
            : chatJid;
      const group = await this.resolveGroup(chatJid, legacyChatJid, chatName);
      if (!group) return;

      const msgId = ctx.message.message_id.toString();
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const { sender, senderUserId } = this.buildSenderIdentity(ctx.from);
      const senderName =
        ctx.from?.first_name || ctx.from?.username || 'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const isReplyToBot = this.isReplyToThisBot(ctx.message.reply_to_message);
      const replyToBotId = isReplyToBot
        ? String(ctx.message.reply_to_message?.from?.id)
        : undefined;

      // Telegram sends multiple sizes; pick the largest (last in array)
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      let marker = '[Photo]';

      try {
        const url = await this.getTelegramFileUrl(largest.file_id);
        if (url) {
          const mediaDir = ensureMediaDir(group);
          const filePath = buildSafeMediaPath(mediaDir, msgId, 'photo.jpg');
          const bytes = await downloadBinaryAttachment(url);
          fs.writeFileSync(filePath, bytes);
          marker = formatImageMarker(path.basename(filePath));
        }
      } catch (err) {
        logger.warn(
          { err: safeErrorMessage(err), msgId },
          'Failed to download Telegram photo — falling back to placeholder',
        );
      }

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onChatMetadata(legacyChatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: `${marker}${caption}`,
        timestamp,
        is_from_me: false,
        sender_platform: 'telegram',
        sender_user_id: senderUserId,
        is_reply_to_bot: isReplyToBot,
        reply_to_bot_id: replyToBotId,
      });
    });

    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));

    // Documents: download images, inline small text files, save other binaries
    // (PDFs, archives, etc.) to the group's media dir so the agent can Read them.
    this.bot.on('message:document', async (ctx) => {
      const chatId = ctx.chat.id;
      const chatJid = `tg:${this.botId}:${chatId}`;
      const legacyChatJid = `tg:${chatId}`;
      const chatName =
        ctx.chat.type === 'private'
          ? ctx.from?.first_name || ctx.from?.username || 'Unknown'
          : 'title' in ctx.chat
            ? ctx.chat.title
            : chatJid;
      const group = await this.resolveGroup(chatJid, legacyChatJid, chatName);
      if (!group) return;

      const doc = ctx.message.document;
      const fileName = doc?.file_name || 'file';
      const mimeType = doc?.mime_type || null;
      const fileSize = doc?.file_size ?? Infinity;
      const msgId = ctx.message.message_id.toString();
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const { sender, senderUserId } = this.buildSenderIdentity(ctx.from);
      const senderName =
        ctx.from?.first_name || ctx.from?.username || 'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const isReplyToBot = this.isReplyToThisBot(ctx.message.reply_to_message);
      const replyToBotId = isReplyToBot
        ? String(ctx.message.reply_to_message?.from?.id)
        : undefined;

      let marker = `[Document: ${fileName}]`;

      try {
        if (isImageByTypeOrExtension(mimeType, fileName)) {
          // Image sent as document (uncompressed)
          const url = await this.getTelegramFileUrl(doc!.file_id);
          if (url) {
            const mediaDir = ensureMediaDir(group);
            const filePath = buildSafeMediaPath(mediaDir, msgId, fileName);
            const bytes = await downloadBinaryAttachment(url);
            fs.writeFileSync(filePath, bytes);
            marker = formatImageMarker(path.basename(filePath));
          }
        } else if (
          isTextByExtension(fileName) &&
          fileSize <= MAX_TEXT_DOWNLOAD_BYTES
        ) {
          // Small text file — inline its content
          const url = await this.getTelegramFileUrl(doc!.file_id);
          if (url) {
            const safeName = path.basename(fileName);
            const text = await downloadTextAttachment(url);
            marker = formatTextFileMarker(safeName, text);
          }
        } else if (fileSize <= MAX_BINARY_DOWNLOAD_BYTES) {
          // Other binary (PDF, archive, etc.) — save to media dir and emit a
          // path marker so the agent can open it with the Read tool.
          const url = await this.getTelegramFileUrl(doc!.file_id);
          if (url) {
            const mediaDir = ensureMediaDir(group);
            const filePath = buildSafeMediaPath(mediaDir, msgId, fileName);
            const bytes = await downloadBinaryAttachment(url);
            fs.writeFileSync(filePath, bytes);
            marker = formatBinaryFileMarker(path.basename(filePath), fileName);
          }
        } else {
          // Too large to download — fall back to a placeholder.
          marker = formatPlaceholder('file', fileName);
        }
      } catch (err) {
        logger.warn(
          { err: safeErrorMessage(err), msgId, fileName },
          'Failed to download Telegram document — falling back to placeholder',
        );
        marker = formatPlaceholder('file', fileName);
      }

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onChatMetadata(legacyChatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: `${marker}${caption}`,
        timestamp,
        is_from_me: false,
        sender_platform: 'telegram',
        sender_user_id: senderUserId,
        is_reply_to_bot: isReplyToBot,
        reply_to_bot_id: replyToBotId,
      });

      logger.info(
        { chatJid, msgId, fileName, fileSize, isReplyToBot },
        'Telegram document stored',
      );
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          logger.info(
            { username: botInfo.username },
            'Telegram bot ready — send /chatid to get a chat registration ID',
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = this.extractNumericChatId(jid);
      if (!numericId) {
        logger.warn(
          { jid, botId: this.botId },
          'Unsupported Telegram JID format',
        );
        return;
      }
      const parsedReplyId = replyToMessageId
        ? parseInt(replyToMessageId, 10)
        : NaN;
      const replyParams = !isNaN(parsedReplyId)
        ? { reply_parameters: { message_id: parsedReplyId } }
        : {};

      // Convert Markdown to Telegram's MarkdownV2 format for proper rendering
      // (bold, italic, code blocks, links). Must convert before splitting to
      // avoid breaking escaped sequences at chunk boundaries.
      const formatted = telegramifyMarkdown(text, 'escape');

      // Telegram has a 4096 character limit per message — split if needed.
      // Preserve leading whitespace so code blocks / indented content aren't mangled.
      const chunks = splitMessage(formatted, 4096, {
        preserveLeadingWhitespace: true,
      });
      for (let i = 0; i < chunks.length; i++) {
        const opts = {
          parse_mode: 'MarkdownV2' as const,
          ...(i === 0 ? replyParams : {}),
        };
        await this.bot.api.sendMessage(numericId, chunks[i], opts);
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error(
        { jid, err: safeErrorMessage(err) },
        'Failed to send Telegram message',
      );
    }
  }

  async addReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    if (!this.bot) return;
    const numericChatId = this.extractNumericChatId(jid);
    if (!numericChatId) return;
    const numericMsgId = parseInt(messageId, 10);
    if (isNaN(numericMsgId)) return;
    if (!isTelegramReactionEmoji(emoji)) {
      logger.warn(
        { jid, messageId, emoji },
        'Unsupported Telegram reaction emoji — skipping',
      );
      return;
    }
    try {
      await this.bot.api.setMessageReaction(numericChatId, numericMsgId, [
        { type: 'emoji', emoji },
      ]);
    } catch (err) {
      logger.warn(
        { jid, messageId, emoji, err: safeErrorMessage(err) },
        'Failed to add Telegram reaction',
      );
    }
  }

  // NOTE: Telegram's Bot API has no single-reaction removal endpoint. This clears
  // all reactions on the message. The emoji param is accepted for interface
  // compatibility but is not used in the API call.
  async removeReaction(
    jid: string,
    messageId: string,
    _emoji: string,
  ): Promise<void> {
    if (!this.bot) return;
    const numericChatId = this.extractNumericChatId(jid);
    if (!numericChatId) return;
    const numericMsgId = parseInt(messageId, 10);
    if (isNaN(numericMsgId)) return;
    try {
      await this.bot.api.setMessageReaction(numericChatId, numericMsgId, []);
    } catch (err) {
      logger.warn(
        { jid, messageId, err: safeErrorMessage(err) },
        'Failed to remove Telegram reaction',
      );
    }
  }

  async getAvatarUrl(): Promise<string | null> {
    if (!this.bot) return null;
    try {
      const me = await this.bot.api.getMe();
      const photos = await this.bot.api.getUserProfilePhotos(me.id, {
        limit: 1,
      });
      if (!photos.photos.length || !photos.photos[0].length) return null;
      const photo = photos.photos[0][photos.photos[0].length - 1];
      const file = await this.bot.api.getFile(photo.file_id);
      if (!file.file_path) return null;
      return buildTelegramFileDescriptor(this.botId, file.file_path);
    } catch (err) {
      logger.warn({ err }, 'Failed to get Telegram avatar');
      return null;
    }
  }

  async resolveStoredAvatarUrl(
    storedAvatarUrl: string,
  ): Promise<string | null> {
    const descriptor = parseTelegramFileDescriptor(storedAvatarUrl);
    if (descriptor) {
      if (descriptor.botId !== this.botId) return null;
      return buildTelegramApiFileUrl(this.botToken, descriptor.filePath);
    }

    const parsed = parseTelegramApiFileUrl(storedAvatarUrl);
    if (!parsed || parsed.botId !== this.botId) return null;
    return buildTelegramApiFileUrl(this.botToken, parsed.filePath);
  }

  async getChatAvatarUrl(jid: string): Promise<string | null> {
    if (!this.bot) return null;
    const numericChatId = this.extractNumericChatId(jid);
    if (!numericChatId) return null;

    try {
      let fileId: string | undefined;

      if (!numericChatId.startsWith('-')) {
        const photos = await this.bot.api.getUserProfilePhotos(
          Number(numericChatId),
          {
            limit: 1,
          },
        );
        if (photos.photos.length && photos.photos[0].length) {
          fileId = photos.photos[0][photos.photos[0].length - 1]?.file_id;
        }
      }

      if (!fileId) {
        const chat = await this.bot.api.getChat(Number(numericChatId));
        fileId = chat.photo?.big_file_id || chat.photo?.small_file_id;
      }

      if (!fileId) return null;
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) return null;
      return buildTelegramApiFileUrl(this.botToken, file.file_path);
    } catch (err) {
      logger.warn({ err, jid }, 'Failed to get Telegram chat avatar');
      return null;
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    const scoped = this.parseScopedJid(jid);
    if (scoped) return scoped.botId === this.botId;
    return this.allowLegacyJidRouting && /^tg:-?\d+$/.test(jid);
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = this.extractNumericChatId(jid);
      if (!numericId) return;
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug(
        { jid, err: safeErrorMessage(err) },
        'Failed to send Telegram typing indicator',
      );
    }
  }

  private parseScopedJid(
    jid: string,
  ): { botId: string; chatId: string } | null {
    const m = /^tg:([^:]+):(-?\d+)$/.exec(jid);
    if (!m) return null;
    return { botId: m[1], chatId: m[2] };
  }

  private extractNumericChatId(jid: string): string | null {
    const scoped = this.parseScopedJid(jid);
    if (scoped) {
      if (scoped.botId !== this.botId) return null;
      return scoped.chatId;
    }
    if (this.allowLegacyJidRouting && /^tg:-?\d+$/.test(jid)) {
      return jid.replace(/^tg:/, '');
    }
    return null;
  }
}
