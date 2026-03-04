import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import type { Channel } from './types.js';

export interface ThreadStreamContext {
  channel: Channel | undefined;
  chatJid: string;
  streamIntermediates: boolean;
  groupName: string;
  groupFolder: string;
  label: string; // for thought log filename slug
}

export interface ThreadStreamer {
  handleIntermediate(raw: string): Promise<void>;
  writeThoughtLog(): void;
}

/** Maximum number of intermediate messages sent to a thread per query (#131) */
const MAX_THREAD_MESSAGES = 20;

/** Minimum delay (ms) between intermediate thread sends to avoid rate limits (#131) */
const MIN_THREAD_SEND_INTERVAL_MS = 1000;

/**
 * Create a ThreadStreamer that buffers intermediate output to a thought log
 * and optionally streams it to a channel thread (e.g. Discord).
 *
 * Safety guards (Issue #131):
 * - Caps thread messages at MAX_THREAD_MESSAGES per query to prevent flooding
 * - Enforces MIN_THREAD_SEND_INTERVAL_MS between sends to avoid 429 rate limits
 *
 * Graceful degradation: if thread creation fails, intermediates are still
 * captured in the thought log. No errors are thrown to the caller.
 */
export function createThreadStreamer(
  ctx: ThreadStreamContext,
  parentMessageId: string | null,
  threadName: string,
): ThreadStreamer {
  const thoughtLogBuffer: string[] = [];
  let thread: unknown = null;
  let threadCreationAttempted = false;
  let threadMessageCount = 0;
  let threadCapLogged = false;
  let lastSendTime = 0;

  const canStream =
    ctx.streamIntermediates &&
    !!ctx.channel?.createThread &&
    !!ctx.channel?.sendToThread &&
    !!parentMessageId;

  return {
    async handleIntermediate(raw: string): Promise<void> {
      thoughtLogBuffer.push(raw);

      if (!canStream) return;

      // Cap thread messages to prevent flooding (#131)
      if (threadMessageCount >= MAX_THREAD_MESSAGES) {
        if (!threadCapLogged) {
          threadCapLogged = true;
          logger.info(
            { group: ctx.groupName, count: threadMessageCount },
            'Thread message cap reached — further intermediates logged only',
          );
        }
        return;
      }

      if (!threadCreationAttempted) {
        threadCreationAttempted = true;
        try {
          thread = await ctx.channel!.createThread!(
            ctx.chatJid,
            parentMessageId!,
            threadName,
          );
        } catch {
          // Thread creation failed — silently degrade to thought-log only
        }
      }

      if (thread) {
        try {
          // Enforce minimum interval between sends (#131)
          const now = Date.now();
          const elapsed = now - lastSendTime;
          if (lastSendTime > 0 && elapsed < MIN_THREAD_SEND_INTERVAL_MS) {
            await new Promise((resolve) =>
              setTimeout(resolve, MIN_THREAD_SEND_INTERVAL_MS - elapsed),
            );
          }
          await ctx.channel!.sendToThread!(thread, raw);
          lastSendTime = Date.now();
          threadMessageCount++;
        } catch {
          // Send failed — continue without thread output
        }
      }
    },

    writeThoughtLog(): void {
      if (thoughtLogBuffer.length === 0) return;

      try {
        const now = new Date();
        const date = now.toISOString().split('T')[0];
        const time = now
          .toISOString()
          .split('T')[1]
          .slice(0, 5)
          .replace(':', '');
        const slug =
          ctx.label
            .trim()
            .slice(0, 50)
            .replace(/[^a-z0-9]+/gi, '-')
            .toLowerCase() || 'query';
        const filename = `${date}-${time}-${slug}.md`;
        const dir = path.join(
          GROUPS_DIR,
          'global',
          'thoughts',
          ctx.groupFolder,
        );
        fs.mkdirSync(dir, { recursive: true });
        const header = `# ${ctx.groupName} — ${now.toLocaleString()}\n\n`;
        fs.writeFileSync(
          path.join(dir, filename),
          header + thoughtLogBuffer.join('\n\n---\n\n'),
        );
        logger.debug({ group: ctx.groupName, filename }, 'Thought log written');
      } catch (err) {
        logger.warn(
          { group: ctx.groupName, err },
          'Failed to write thought log',
        );
      }
    },
  };
}
