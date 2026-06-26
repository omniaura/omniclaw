import fs from 'fs';
import path from 'path';
import { App, Assistant } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import type { AnyChunk, KnownBlock } from '@slack/web-api';
import type { ReactionAddedEvent } from '@slack/types';

import { logger } from '../logger.js';
import {
  MAX_BINARY_DOWNLOAD_BYTES,
  MAX_TEXT_DOWNLOAD_BYTES,
  buildSafeMediaPath,
  ensureMediaDir,
  formatImageMarker,
  formatPlaceholder,
  formatTextFileMarker,
  isImageByTypeOrExtension,
  isTextByExtension,
  readStreamWithByteLimit,
} from '../media.js';
import { parseScopedSlackJid } from '../slack-jid.js';
import type {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  OutboundMessageStream,
  RegisteredGroup,
} from '../types.js';
import { splitMessage as splitMessageShared } from './utils.js';

export { parseScopedSlackJid };

// JID format: "slack:{channelId}" for channels/DMs
// e.g. "slack:C12345678" for a channel, "slack:D12345678" for a DM
// Multi-bot format: "slack:{botId}:{channelId}"

export function jidToChannelId(jid: string): string | null {
  const scoped = parseScopedSlackJid(jid);
  if (scoped) return scoped.channelId;
  if (!jid.startsWith('slack:')) return null;
  return jid.slice('slack:'.length);
}

export function channelIdToJid(channelId: string, botId?: string): string {
  if (botId) return `slack:${botId}:${channelId}`;
  return `slack:${channelId}`;
}

// Slack limits: plain `text` messages cap at 4,000 chars; `markdown` blocks
// (standard markdown rendering, added for AI apps) cap at 12,000.
const TEXT_LIMIT = 4000;
const MARKDOWN_BLOCK_LIMIT = 11500;
const THREAD_ROOT_CACHE_MAX = 1000;
const SEEN_MESSAGE_CACHE_MAX = 500;
const THREAD_EXCERPT_MAX_CHARS = 140;
const TASK_TITLE_MAX_CHARS = 80;
// Slack caps each task_update chunk at 256 chars; keep title + details under it
// so progress updates always render instead of being silently rejected.
const TASK_DETAILS_MAX_CHARS = 160;

const SLACK_FILE_HOSTS = new Set(['files.slack.com']);

// Rotating status shown under the assistant thread while the agent works.
const STATUS_LOADING_MESSAGES = [
  'Thinking it through…',
  'Working on it…',
  'Checking my notes…',
  'Almost there…',
];

/** Split text into chunks that fit a Slack markdown block. */
function splitMarkdown(text: string): string[] {
  return splitMessageShared(text, MARKDOWN_BLOCK_LIMIT, {
    preferBreaks: true,
    preserveLeadingWhitespace: true,
  });
}

/** Split text at Slack's plain-text message limit (hard split, no break preference). */
function splitMessage(text: string, maxLen = TEXT_LIMIT): string[] {
  return splitMessageShared(text, maxLen, false);
}

function assertSlackFileUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid Slack file URL');
  }

  if (parsed.protocol !== 'https:' || !SLACK_FILE_HOSTS.has(parsed.hostname)) {
    throw new Error(`Rejected non-Slack file URL: ${parsed.hostname || url}`);
  }
}

/** A `markdown` block renders standard markdown (GFM) instead of legacy mrkdwn. */
function markdownBlocks(text: string): KnownBlock[] {
  return [{ type: 'markdown', text }];
}

/** Resolve a Slack user ID to a display name, falling back to the provided default. */
async function resolveSlackUserName(
  client: WebClient,
  userId: string,
  fallback: string,
): Promise<string> {
  try {
    const info = await client.users.info({ user: userId });
    return (
      info.user?.profile?.display_name ||
      info.user?.profile?.real_name ||
      info.user?.name ||
      fallback
    );
  } catch {
    return fallback;
  }
}

/**
 * Resolve both a display name and `is_bot` flag for a Slack user. The reaction
 * handler uses `is_bot` to drop reactions from other Slack apps/bots (e.g.
 * CodeRabbit) so they don't wake the agent or pollute the warm-container
 * stream. Falls back to `{ name: fallback, isBot: false }` on lookup failure;
 * treating unknown reactors as humans is the conservative choice — the
 * downstream trigger-pattern check still gates whether a human reaction is
 * acted on.
 */
async function resolveSlackUserIdentity(
  client: WebClient,
  userId: string,
  fallback: string,
): Promise<{ name: string; isBot: boolean }> {
  try {
    const info = await client.users.info({ user: userId });
    const name =
      info.user?.profile?.display_name ||
      info.user?.profile?.real_name ||
      info.user?.name ||
      fallback;
    return { name, isBot: info.user?.is_bot === true };
  } catch {
    return { name: fallback, isBot: false };
  }
}

/** Resolve <@USERID> Slack mentions into display names. */
async function resolveMentions(
  text: string,
  client: WebClient,
): Promise<{ text: string; mentions: Array<{ id: string; name: string }> }> {
  const mentionRegex = /<@([A-Z0-9]+)>/g;
  const userIds = [
    ...new Set([...text.matchAll(mentionRegex)].map((m) => m[1])),
  ];
  const mentions: Array<{ id: string; name: string }> = [];

  for (const userId of userIds) {
    const displayName = await resolveSlackUserName(client, userId, userId);
    if (displayName !== userId) {
      mentions.push({ id: userId, name: displayName });
      text = text.replace(new RegExp(`<@${userId}>`, 'g'), `@${displayName}`);
    }
  }

  return { text, mentions };
}

interface SlackStreamTarget {
  channelId: string;
  threadTs: string;
  /** Required by chat.startStream outside DMs. */
  recipient?: { recipient_user_id: string; recipient_team_id: string };
}

export interface SlackChannelOpts {
  botId: string;
  token: string; // Bot token (xoxb-...)
  appToken: string; // App-level token for Socket Mode (xapp-...)
  multiBotMode?: boolean;
  allowLegacyJidRouting?: boolean;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onReaction?: (
    chatJid: string,
    messageId: string,
    emoji: string,
    userName: string,
    reactor: { id: string; isBot: boolean },
  ) => void;
  /** Called when a message arrives from an unregistered channel. Return true if registered. */
  autoRegister?: (chatJid: string, channelName: string) => Promise<boolean>;
}

export class SlackChannel implements Channel {
  name = 'slack';
  // Slack always shows the bot's display name on its messages — prefixing the
  // agent name again ("Clayton: …") is redundant noise.
  prefixAssistantName = false;
  readonly botId: string;

  private app: App;
  private client: WebClient;
  private botUserId: string | null = null;
  private teamId: string | null = null;
  private connected = false;
  private multiBotMode: boolean;
  private allowLegacyJidRouting: boolean;
  private opts: SlackChannelOpts;

  /** Active assistant (AI app) thread per DM channel: channelId → thread_ts. */
  private assistantThreads = new Map<string, string>();
  /** Assistant threads we've already titled (`channelId:thread_ts`). */
  private titledAssistantThreads = new Set<string>();
  /** Message ts → thread root ts, so replies always thread under the root. */
  private threadRootByTs = new Map<string, string>();
  /** Cached excerpts of thread root messages, keyed by `channelId:thread_ts`. */
  private threadRootExcerpts = new Map<string, string>();
  /** Dedup of processed messages (`channelId:ts`) across message/app_mention events. */
  private seenMessages = new Set<string>();
  /**
   * Last human sender per channel — chat.startStream needs a
   * recipient_user_id when streaming outside a DM.
   */
  private lastHumanSenderByChannel = new Map<string, string>();

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;
    this.botId = opts.botId;
    this.multiBotMode = opts.multiBotMode === true;
    this.allowLegacyJidRouting = opts.allowLegacyJidRouting !== false;

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

    // Mention fallback: covers channels where the bot can't read message
    // history. message.* events carry richer payloads (files), so give them a
    // moment to win the dedup race before processing the mention payload.
    this.app.event('app_mention', async ({ event }) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await this.handleMessage(event).catch((err: unknown) =>
        logger.error({ err }, 'Error handling Slack app_mention'),
      );
    });

    // Register reaction handler (for share-request approvals etc.)
    this.app.event('reaction_added', async ({ event }) => {
      await this.handleReactionAdded(event).catch((err: unknown) =>
        logger.error({ err }, 'Error handling Slack reaction_added'),
      );
    });

    // Slack AI-app assistant threads (the "agent" split-pane experience).
    // Harmless when the app doesn't have the Agents feature enabled — the
    // events simply never arrive.
    try {
      this.registerAssistant();
    } catch (err) {
      logger.warn({ err }, 'Failed to register Slack assistant middleware');
    }

    // Start Socket Mode — resolves when connected
    await this.app.start();

    // Fetch bot user ID so we can ignore our own messages
    try {
      const authResult = await this.client.auth.test();
      this.botUserId = authResult.user_id as string;
      this.teamId = (authResult.team_id as string) || null;
      const botName = authResult.user || 'unknown';
      logger.info(
        { botUserId: this.botUserId, botName },
        'Slack bot connected',
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch Slack bot user ID');
    }

    this.connected = true;
  }

  async sendMessage(
    jid: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<string | void> {
    const channelId = this.extractChannelId(jid);
    if (!channelId) {
      logger.warn({ jid }, 'Invalid Slack JID — cannot send message');
      return;
    }

    // Slack requires threading on the root ts — map reply targets through the
    // thread-root cache. Bare sends to a DM with an active assistant thread go
    // into that thread so they show up in the agent pane.
    const threadTs = replyToMessageId
      ? (this.threadRootByTs.get(replyToMessageId) ?? replyToMessageId)
      : this.assistantThreads.get(channelId);

    try {
      // Threaded sends get the native AI streaming treatment when possible
      // (assistant threads, and channel threads where the recipient is known).
      if (threadTs) {
        const target = this.resolveStreamTarget(channelId, threadTs);
        if (target) {
          const ts = await this.trySendStreamed(target, text);
          if (ts) {
            logger.info({ jid, length: text.length }, 'Slack message streamed');
            return ts;
          }
        }
      }

      const chunks = splitMarkdown(text);
      let firstTs: string | undefined;
      let lastTs: string | undefined;

      for (let i = 0; i < chunks.length; i++) {
        // First chunk threads under the resolved root; subsequent chunks
        // thread under the first chunk so they form a single thread.
        const chunkThread = i === 0 ? threadTs : (firstTs ?? threadTs);
        const ts = await this.postChunk(channelId, chunks[i], chunkThread);
        if (i === 0) firstTs = ts;
        lastTs = ts;
      }

      logger.info({ jid, length: text.length }, 'Slack message sent');
      return lastTs;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Slack message');
    }
  }

  async editMessage(
    jid: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    const channelId = this.extractChannelId(jid);
    if (!channelId) return;
    const chunk = text.slice(0, MARKDOWN_BLOCK_LIMIT);
    try {
      await this.client.chat.update({
        channel: channelId,
        ts: messageId,
        text: chunk.slice(0, TEXT_LIMIT),
        blocks: markdownBlocks(chunk),
      });
    } catch (err) {
      // markdown block can be rejected for odd content — retry as plain text
      try {
        await this.client.chat.update({
          channel: channelId,
          ts: messageId,
          text: text.slice(0, TEXT_LIMIT),
          blocks: [],
        });
      } catch (err2) {
        logger.warn(
          { jid, messageId, err: err2 },
          'Failed to edit Slack message',
        );
      }
    }
  }

  /**
   * Typing indicator: in assistant threads we surface Slack's native AI
   * status ("is thinking…" with rotating loading messages). Regular channels
   * have no public typing API, so this is a no-op there. Slack clears the
   * status automatically when the reply lands in the thread.
   */
  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const channelId = this.extractChannelId(jid);
    if (!channelId) return;
    const threadTs = this.assistantThreads.get(channelId);
    if (!threadTs) return;
    try {
      await this.client.assistant.threads.setStatus({
        channel_id: channelId,
        thread_ts: threadTs,
        status: isTyping ? 'is thinking…' : '',
        ...(isTyping ? { loading_messages: STATUS_LOADING_MESSAGES } : {}),
      });
    } catch (err) {
      logger.debug({ jid, err }, 'Slack assistant setStatus failed');
    }
  }

  async getAvatarUrl(): Promise<string | null> {
    if (!this.connected || !this.botUserId) return null;
    try {
      const info = await this.client.users.info({ user: this.botUserId });
      return (
        info.user?.profile?.image_512 || info.user?.profile?.image_192 || null
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to get Slack avatar');
      return null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    const scoped = parseScopedSlackJid(jid);
    if (scoped) return scoped.botId === this.botId;
    return this.allowLegacyJidRouting && /^slack:[^:]+$/.test(jid);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
    logger.info('Slack bot disconnected');
  }

  async addReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const channelId = this.extractChannelId(jid);
    if (!channelId) return;
    // Strip surrounding colons if passed as :emoji:
    const name = emoji.replace(/^:|:$/g, '');
    try {
      await this.client.reactions.add({
        channel: channelId,
        timestamp: messageId,
        name,
      });
    } catch (err) {
      logger.warn(
        { jid, messageId, emoji, err },
        'Failed to add Slack reaction',
      );
    }
  }

  async removeReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const channelId = this.extractChannelId(jid);
    if (!channelId) return;
    const name = emoji.replace(/^:|:$/g, '');
    try {
      await this.client.reactions.remove({
        channel: channelId,
        timestamp: messageId,
        name,
      });
    } catch (err) {
      logger.warn(
        { jid, messageId, emoji, err },
        'Failed to remove Slack reaction',
      );
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
    const channelId = this.extractChannelId(jid);
    if (!channelId) return null;
    // In Slack, a thread is created implicitly on first reply — just return the anchor info
    return { channelId, ts: this.threadRootByTs.get(messageId) ?? messageId };
  }

  async sendToThread(
    thread: { channelId: string; ts: string },
    text: string,
  ): Promise<void> {
    for (const chunk of splitMarkdown(text)) {
      try {
        await this.postChunk(thread.channelId, chunk, thread.ts);
      } catch (err) {
        logger.warn({ thread, err }, 'Failed to send to Slack thread');
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Register Bolt's Assistant middleware for Slack's AI-app experience:
   * suggested prompts on thread open, auto thread titles, and context saving.
   * Requires the app manifest to enable the Agents feature (`assistant:write`
   * scope + `assistant_thread_started`/`assistant_thread_context_changed`
   * event subscriptions).
   */
  private registerAssistant(): void {
    const assistant = new Assistant({
      threadStarted: async ({ event, setSuggestedPrompts }) => {
        const thread = event.assistant_thread;
        this.assistantThreads.set(thread.channel_id, thread.thread_ts);
        try {
          await setSuggestedPrompts({
            title: 'How can I help?',
            prompts: [
              {
                title: 'What can you do?',
                message:
                  'What can you do? Give me a quick tour of your capabilities.',
              },
              {
                title: 'Schedule a recurring task',
                message:
                  'I want to schedule a recurring task — ask me what it should do and how often.',
              },
              {
                title: 'Summarize something',
                message:
                  'I am going to paste some text. Summarize it and pull out any action items.',
              },
            ],
          });
        } catch (err) {
          logger.debug({ err }, 'Slack assistant suggested prompts failed');
        }
      },
      threadContextChanged: async ({ saveThreadContext }) => {
        try {
          await saveThreadContext();
        } catch (err) {
          logger.debug({ err }, 'Slack assistant saveThreadContext failed');
        }
      },
      userMessage: async ({ message, setTitle }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const event = message as any;
        const channelId: string | undefined = event.channel;
        const threadTs: string | undefined = event.thread_ts;
        if (channelId && threadTs) {
          this.assistantThreads.set(channelId, threadTs);
          // Title the thread after the first user message so the agent pane
          // sidebar stays navigable.
          if (event.text) {
            const key = `${channelId}:${threadTs}`;
            if (!this.titledAssistantThreads.has(key)) {
              this.titledAssistantThreads.add(key);
              try {
                await setTitle(String(event.text).slice(0, 60));
              } catch (err) {
                logger.debug({ err }, 'Slack assistant setTitle failed');
              }
            }
          }
        }
        await this.handleMessage(event, { assistantThread: true }).catch(
          (err: unknown) =>
            logger.error({ err }, 'Error handling Slack assistant message'),
        );
      },
    });
    this.app.assistant(assistant);
  }

  /**
   * Start a natively streamed message. Returns null when streaming isn't
   * possible for this target: chat.startStream requires a thread anchor, and
   * outside DMs also a recipient user + team.
   */
  async startMessageStream(
    jid: string,
    replyToMessageId?: string,
  ): Promise<OutboundMessageStream | null> {
    const channelId = this.extractChannelId(jid);
    if (!channelId) return null;
    const threadTs = replyToMessageId
      ? (this.threadRootByTs.get(replyToMessageId) ?? replyToMessageId)
      : this.assistantThreads.get(channelId);
    if (!threadTs) return null;
    const target = this.resolveStreamTarget(channelId, threadTs);
    if (!target) return null;
    return this.createOutboundStream(target);
  }

  private resolveStreamTarget(
    channelId: string,
    threadTs: string,
  ): SlackStreamTarget | null {
    // DM channels (assistant threads included) stream without recipient info.
    if (channelId.startsWith('D')) return { channelId, threadTs };
    const userId = this.lastHumanSenderByChannel.get(channelId);
    if (!userId || !this.teamId) return null;
    return {
      channelId,
      threadTs,
      recipient: {
        recipient_user_id: userId,
        recipient_team_id: this.teamId,
      },
    };
  }

  /**
   * Streamed message session backed by chat.startStream/appendStream/
   * stopStream — ONE Slack message per agent run.
   *
   * Intermediate activity updates a SINGLE live "progress" task card in place
   * (re-sending the same `task_update` id, which Slack updates rather than
   * appending) so a tool-heavy run shows one evolving status line instead of a
   * card per action (#850). The final reply streams as markdown into the same
   * message; `stop()` finalizes it in place so it persists (unlike CodeRabbit,
   * which deletes its streamed message). Operations are serialized through an
   * internal chain so concurrent appends can't race the startStream call.
   */
  private createOutboundStream(
    target: SlackStreamTarget,
  ): OutboundMessageStream {
    const { channelId, threadTs } = target;
    // Stable id for the single progress card. Reusing it makes every status
    // append update that one card in place instead of stacking a new one.
    const PROGRESS_TASK_ID = 'agent-progress';
    let ts: string | undefined;
    let openTask: { id: string; title: string } | null = null;
    let chain: Promise<unknown> = Promise.resolve();

    const run = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = chain.then(fn);
      chain = next.catch(() => undefined);
      return next;
    };

    const send = async (chunks: AnyChunk[]): Promise<void> => {
      if (!ts) {
        const started = await this.client.chat.startStream({
          channel: channelId,
          thread_ts: threadTs,
          ...(target.recipient ?? {}),
          task_display_mode: 'timeline',
          chunks,
        });
        ts = started.ts as string | undefined;
        if (!ts) throw new Error('chat.startStream returned no ts');
        this.rememberThreadRoot(ts, threadTs);
      } else {
        await this.client.chat.appendStream({ channel: channelId, ts, chunks });
      }
    };

    const closeOpenTask = (): AnyChunk[] => {
      if (!openTask) return [];
      const closer: AnyChunk = {
        type: 'task_update',
        id: openTask.id,
        title: openTask.title,
        status: 'complete',
      };
      openTask = null;
      return [closer];
    };

    return {
      appendStatus: (text: string) =>
        run(async () => {
          const trimmed = text.trim();
          // First meaningful line becomes the card title — skip code-fence
          // markers so tool-result updates (```…```) don't surface a bare ```.
          const firstLine =
            trimmed
              .split('\n')
              .map((l) => l.trim())
              .find((l) => l && !/^`{3,}/.test(l)) || '';
          const title = firstLine.slice(0, TASK_TITLE_MAX_CHARS) || 'Working…';
          // Always reuse the same task id so each update mutates the single
          // live card in place rather than appending a new one per action.
          const task: AnyChunk = {
            type: 'task_update',
            id: PROGRESS_TASK_ID,
            title,
            status: 'in_progress',
            ...(trimmed.length > title.length
              ? { details: trimmed.slice(0, TASK_DETAILS_MAX_CHARS) }
              : {}),
          };
          openTask = { id: PROGRESS_TASK_ID, title };
          try {
            await send([task]);
          } catch (err) {
            // A dropped status update isn't worth abandoning the stream for
            // (e.g. transient rate limit) — but a failed startStream means
            // streaming is unavailable, so propagate for the caller to fall
            // back to the edit-loop.
            if (!ts) throw err;
            logger.debug(
              { channelId, err },
              'Slack task update append failed (non-fatal)',
            );
          }
        }),
      appendText: (text: string) =>
        run(async () => {
          for (const chunk of splitMarkdown(text)) {
            await send([
              ...closeOpenTask(),
              { type: 'markdown_text', text: chunk },
            ]);
          }
        }),
      stop: () =>
        run(async () => {
          if (!ts) return undefined;
          const closers = closeOpenTask();
          await this.client.chat.stopStream({
            channel: channelId,
            ts,
            ...(closers.length > 0 ? { chunks: closers } : {}),
          });
          return ts;
        }),
    };
  }

  /**
   * Send a complete response through the streaming APIs in one shot.
   * Returns the message ts, or undefined when streaming is unavailable so
   * the caller can fall back to chat.postMessage.
   */
  private async trySendStreamed(
    target: SlackStreamTarget,
    text: string,
  ): Promise<string | undefined> {
    const stream = this.createOutboundStream(target);
    try {
      await stream.appendText(text);
      return await stream.stop();
    } catch (err) {
      logger.debug(
        { channelId: target.channelId, err },
        'Slack streaming send unavailable — falling back to chat.postMessage',
      );
      // If content already landed via startStream, finalize instead of
      // duplicating; stop() returns undefined when nothing was sent.
      try {
        return await stream.stop();
      } catch {
        return undefined;
      }
    }
  }

  /**
   * Post a single chunk as a markdown block (standard markdown rendering),
   * falling back to plain text if Slack rejects the block.
   */
  private async postChunk(
    channelId: string,
    chunk: string,
    threadTs?: string,
  ): Promise<string | undefined> {
    try {
      const result = await this.client.chat.postMessage({
        channel: channelId,
        text: chunk.slice(0, TEXT_LIMIT), // notification fallback
        blocks: markdownBlocks(chunk),
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      const ts = result.ts as string | undefined;
      if (ts) this.rememberThreadRoot(ts, threadTs ?? ts);
      return ts;
    } catch (err) {
      logger.debug(
        { channelId, err },
        'Slack markdown block send failed — falling back to plain text',
      );
      let lastTs: string | undefined;
      for (const piece of splitMessage(chunk)) {
        const result = await this.client.chat.postMessage({
          channel: channelId,
          text: piece,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
        lastTs = result.ts as string | undefined;
        if (lastTs) this.rememberThreadRoot(lastTs, threadTs ?? lastTs);
      }
      return lastTs;
    }
  }

  private rememberThreadRoot(ts: string, root: string): void {
    this.threadRootByTs.set(ts, root);
    if (this.threadRootByTs.size > THREAD_ROOT_CACHE_MAX) {
      const oldest = this.threadRootByTs.keys().next().value;
      if (oldest !== undefined) this.threadRootByTs.delete(oldest);
    }
  }

  /** Dedup across message + app_mention deliveries of the same message. */
  private markSeen(key: string): boolean {
    if (this.seenMessages.has(key)) return false;
    this.seenMessages.add(key);
    if (this.seenMessages.size > SEEN_MESSAGE_CACHE_MAX) {
      const oldest = this.seenMessages.values().next().value;
      if (oldest !== undefined) this.seenMessages.delete(oldest);
    }
    return true;
  }

  /** Fetch (and cache) a short excerpt of a thread's root message. */
  private async getThreadRootExcerpt(
    channelId: string,
    threadTs: string,
  ): Promise<string | null> {
    const key = `${channelId}:${threadTs}`;
    const cached = this.threadRootExcerpts.get(key);
    if (cached !== undefined) return cached || null;
    try {
      const result = await this.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 1,
      });
      const rootText = result.messages?.[0]?.text || '';
      const excerpt = rootText
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, THREAD_EXCERPT_MAX_CHARS);
      this.threadRootExcerpts.set(key, excerpt);
      return excerpt || null;
    } catch {
      this.threadRootExcerpts.set(key, '');
      return null;
    }
  }

  /**
   * Process a `reaction_added` event. Exposed (via the public-shaped method)
   * for tests; the bolt event handler in `connect()` delegates straight here.
   *
   * Filters that must precede dispatch:
   *   1. drop reactions added by this bot itself (otherwise our own
   *      `reactions.add` calls from approval flows would loop back in),
   *   2. drop reactions on messages NOT authored by this bot — reactions on
   *      human/teammate messages would wake the warm container with a
   *      synthetic trigger that costs an inference round-trip just to no-op.
   *      Mirrors the Discord adapter's `reaction.message.author?.id` check.
   */
  async handleReactionAdded(event: ReactionAddedEvent): Promise<void> {
    const channelId =
      event.item.type === 'message' ? event.item.channel : null;
    if (!channelId) return;

    if (this.botUserId && event.user === this.botUserId) return;
    if (this.botUserId && event.item_user !== this.botUserId) return;

    const chatJid = channelIdToJid(
      channelId,
      this.multiBotMode ? this.botId : undefined,
    );
    const messageId = event.item.type === 'message' ? event.item.ts : null;
    if (!messageId) return;

    const emoji = `:${event.reaction}:`;

    const { name: userName, isBot } = await resolveSlackUserIdentity(
      this.client,
      event.user,
      event.user,
    );

    this.opts.onReaction?.(chatJid, messageId, emoji, userName, {
      id: event.user,
      isBot,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleMessage(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event: any,
    opts: { assistantThread?: boolean } = {},
  ): Promise<void> {
    // Ignore bot messages (including our own)
    if (event.subtype === 'bot_message') return;
    if ('bot_id' in event && event.bot_id) return;
    if (this.botUserId && 'user' in event && event.user === this.botUserId)
      return;

    // Require text or file attachments (skip protocol-only events)
    const hasText = 'text' in event && !!event.text;
    const hasFiles =
      'files' in event && Array.isArray(event.files) && event.files.length > 0;
    if (!hasText && !hasFiles) return;

    const channelId = event.channel;
    // The same message can arrive via message + app_mention (and assistant
    // routing) — process it once.
    if (!this.markSeen(`${channelId}:${event.ts}`)) return;

    const chatJid = channelIdToJid(
      channelId,
      this.multiBotMode ? this.botId : undefined,
    );
    const legacyChatJid = channelIdToJid(channelId);
    // Slack ts is the unique message timestamp, doubles as message ID
    const msgId = event.ts;
    const timestamp = new Date(parseFloat(event.ts) * 1000).toISOString();

    // Replies to this message must thread under the root ts.
    this.rememberThreadRoot(event.ts, event.thread_ts || event.ts);

    const senderUserId = 'user' in event ? event.user : 'unknown';
    if (senderUserId && senderUserId !== 'unknown') {
      this.lastHumanSenderByChannel.set(channelId, senderUserId);
    }
    const sender = `slack:${senderUserId}`;
    const senderName = await resolveSlackUserName(
      this.client,
      senderUserId,
      'Unknown user',
    );

    if (!senderName) {
      logger.warn(
        {
          op: 'senderIdentity',
          counter: 'sender_name_empty',
          platform: 'slack',
          sender: senderUserId,
        },
        'Slack message has empty sender_name',
      );
    }

    // Resolve <@USERID> mentions to display names
    const { text: resolvedText, mentions } = await resolveMentions(
      event.text || '',
      this.client,
    );
    let content = resolvedText;

    if (
      this.multiBotMode &&
      mentions.length > 0 &&
      this.botUserId &&
      !mentions.some((m) => m.id === this.botUserId) &&
      !/@allagents/i.test(content)
    ) {
      logger.debug(
        {
          channelId,
          botId: this.botId,
          mentionedUserIds: mentions.map((m) => m.id),
        },
        'Slack message mentions another bot — ignoring for this bot',
      );
      return;
    }

    // Annotate threaded replies with the root message so the agent has
    // context. Assistant threads skip this — the whole conversation IS the
    // thread, and history comes from the message store.
    if (
      !opts.assistantThread &&
      'thread_ts' in event &&
      event.thread_ts &&
      event.thread_ts !== event.ts
    ) {
      const excerpt = await this.getThreadRootExcerpt(
        channelId,
        event.thread_ts,
      );
      content = excerpt
        ? `[Thread reply to: "${excerpt}"] ${content}`
        : `[Thread reply] ${content}`;
    }

    // Store channel metadata for group discovery
    let channelName = channelId;
    try {
      const info = await this.client.conversations.info({
        channel: channelId,
      });
      channelName =
        info.channel?.name ||
        (info.channel?.is_im ? `DM: ${senderName}` : channelId);
    } catch {
      // Fall back to channel ID
    }
    this.opts.onChatMetadata(chatJid, timestamp, channelName);
    if (this.allowLegacyJidRouting) {
      this.opts.onChatMetadata(legacyChatJid, timestamp, channelName);
    }

    // Only process registered groups (auto-register if callback provided)
    const groups = this.opts.registeredGroups();
    let group =
      groups[chatJid] ||
      (this.allowLegacyJidRouting ? groups[legacyChatJid] : undefined);
    if (!group && this.opts.autoRegister) {
      const registered = await this.opts.autoRegister(chatJid, channelName);
      if (registered) {
        group =
          groups[chatJid] ||
          (this.allowLegacyJidRouting ? groups[legacyChatJid] : undefined);
      }
    }
    if (!group) {
      logger.debug(
        { chatJid, legacyChatJid, channelName },
        'Message from unregistered Slack channel — ignoring',
      );
      return;
    }

    // Process file attachments (images, documents, etc.)
    if (hasFiles) {
      const fileMarkers = await this.processFileAttachments(
        event.files,
        group,
        msgId,
      );
      if (fileMarkers.length > 0) {
        const suffix = fileMarkers.join(' ');
        content = content ? `${content} ${suffix}` : suffix;
      }
    }

    // Skip if still no content after file processing
    if (!content) return;

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      sender_platform: 'slack',
      sender_user_id: senderUserId,
      mentions: mentions.map((m) => ({ ...m, platform: 'slack' as const })),
    });

    logger.info(
      { chatJid, channelName, sender: senderName },
      'Slack message stored',
    );
  }

  /**
   * Download a Slack file using the bot token for authentication.
   * Slack private file URLs require `Authorization: Bearer <token>`.
   */
  private async downloadSlackFile(
    url: string,
    maxBytes: number,
  ): Promise<Buffer> {
    assertSlackFileUrl(url);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.opts.token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Slack file download failed: ${response.status}`);
    }
    return readStreamWithByteLimit(response.body, maxBytes);
  }

  /**
   * Process Slack file attachments from a message event, returning
   * attachment markers to prepend/append to the message content.
   */
  private async processFileAttachments(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    files: any[],
    group: RegisteredGroup,
    msgId: string,
  ): Promise<string[]> {
    const markers: string[] = [];

    for (const file of files) {
      const fileName = file.name || 'file';
      const mimeType = file.mimetype || null;
      const fileSize = file.size ?? Infinity;
      const downloadUrl = file.url_private_download || file.url_private;

      if (!downloadUrl) {
        markers.push(formatPlaceholder('file', fileName));
        continue;
      }

      try {
        if (isImageByTypeOrExtension(mimeType, fileName)) {
          const bytes = await this.downloadSlackFile(
            downloadUrl,
            MAX_BINARY_DOWNLOAD_BYTES,
          );
          const mediaDir = ensureMediaDir(group);
          const filePath = buildSafeMediaPath(mediaDir, msgId, fileName);
          fs.writeFileSync(filePath, bytes);
          markers.push(formatImageMarker(path.basename(filePath)));
        } else if (
          isTextByExtension(fileName) &&
          fileSize <= MAX_TEXT_DOWNLOAD_BYTES
        ) {
          const bytes = await this.downloadSlackFile(
            downloadUrl,
            MAX_TEXT_DOWNLOAD_BYTES,
          );
          const safeName = path.basename(fileName);
          const text = new TextDecoder().decode(bytes);
          markers.push(formatTextFileMarker(safeName, text));
        } else if (mimeType?.startsWith('video/')) {
          markers.push(formatPlaceholder('video'));
        } else if (mimeType?.startsWith('audio/')) {
          markers.push(formatPlaceholder('audio'));
        } else {
          markers.push(formatPlaceholder('file', fileName));
        }
      } catch (err) {
        logger.warn(
          { err, msgId, fileName },
          'Failed to download Slack file — falling back to placeholder',
        );
        markers.push(formatPlaceholder('file', fileName));
      }
    }

    return markers;
  }

  private extractChannelId(jid: string): string | null {
    const scoped = parseScopedSlackJid(jid);
    if (scoped) {
      if (scoped.botId !== this.botId) return null;
      return scoped.channelId;
    }
    if (this.allowLegacyJidRouting && /^slack:[^:]+$/.test(jid)) {
      return jidToChannelId(jid);
    }
    return null;
  }
}
