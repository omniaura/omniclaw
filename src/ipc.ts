import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  DISPATCH_RUNTIME_SEP,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { calculateNextRun } from './schedule-utils.js';
import { AvailableGroup } from './ipc-snapshots.js';
import {
  createTask,
  deleteTask,
  getSubscriptionsForChannel,
  removeChannelSubscription,
  setChannelSubscription,
  getTaskById,
  setRegisteredGroup,
  updateTask,
} from './db.js';
import { findGroupByFolder } from './group-helpers.js';
import {
  listIpcJsonFiles,
  quarantineIpcFile,
  readIpcJsonFile,
} from './ipc-file-security.js';
import { logger } from './logger.js';
import { stripInternalTags } from './router.js';
import {
  Channel,
  IpcMessagePayload,
  IpcTaskPayload,
  NewMessage,
  RegisteredGroup,
  ThreadSummary,
} from './types.js';
import { normalizePreprocessScriptPath } from './task-preprocessor.js';
import { parseSlackJid } from './slack-jid.js';
import type { IpcEventKind } from './web/ipc-events.js';

export const MAX_IPC_FILES_PER_SOURCE_PER_POLL = 50;
export const MAX_IPC_FILES_PER_POLL = 200;

export interface IpcDeps {
  sendMessage: (
    jid: string,
    text: string,
    discordBotId?: string,
  ) => Promise<string | void>;
  /** Store a message in a group's DB and enqueue it for agent processing.
   * Pass sourceFolder to tag the message so the source agent doesn't echo it. */
  notifyGroup: (jid: string, text: string, sourceFolder?: string) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  updateGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  findChannel?: (jid: string) => Channel | undefined;
  /** Refresh the current_tasks.json snapshot so the agent sees updates immediately */
  writeTasksSnapshot?: (groupFolder: string, isMain: boolean) => void;
  /** Called when channel subscriptions are mutated via IPC */
  onSubscriptionChanged?: () => void;
  /** Runtime folders currently launched by the orchestrator (for auth). */
  activeRuntimeFolders?: () => ReadonlySet<string>;
  /** All known agent folders (including secondary agents not in registeredGroups). */
  agentFolders?: () => ReadonlySet<string>;
  /** Return all channel subscriptions for a JID (used to check if sourceGroup is a subscriber). */
  getSubscriptions?: (
    jid: string,
  ) => Array<{ agentId: string; agentFolder: string }>;
  /** Read locally stored chat/thread messages for tools like read_thread. */
  getMessages?: (jid: string, since: string, limit?: number) => NewMessage[];
  /** Read the durable rolling summary for a chat/thread. */
  getThreadSummary?: (jid: string) => ThreadSummary | undefined;
  /** Update the durable rolling summary for a chat/thread. */
  setThreadSummary?: (
    summary: Omit<ThreadSummary, 'updated_at'> & { updated_at?: string },
  ) => boolean;
  /** Called when an IPC event occurs (for the web UI inspector). */
  onIpcEvent?: (
    kind: IpcEventKind,
    sourceGroup: string,
    summary: string,
    details?: Record<string, unknown>,
  ) => void;
}

/**
 * Resolve a runtime group folder back to its canonical owner folder.
 *
 * Runtime folders have the format `{owner}{DISPATCH_RUNTIME_SEP}{16-char hex digest}`.
 * We validate both parts: the owner must be a known folder AND the suffix must
 * be exactly the 16-char hex digest format produced by getRuntimeGroupFolder().
 *
 * Returns null if the folder is unrecognized (unknown owner or malformed digest).
 * Liveness checking (whether the container is still running) is handled by the
 * caller — this function only validates structural ownership.
 */
const RUNTIME_DIGEST_RE = /^[0-9a-f]{16}$/;

function resolveOwnerGroupFolder(
  sourceGroup: string,
  registeredGroups: Record<string, RegisteredGroup>,
  agentFolders?: ReadonlySet<string>,
): string | null {
  const knownFolders = new Set([
    ...Object.values(registeredGroups).map((g) => g.folder),
    ...(agentFolders ?? []),
  ]);
  if (knownFolders.has(sourceGroup)) return sourceGroup;
  const idx = sourceGroup.indexOf(DISPATCH_RUNTIME_SEP);
  if (idx === -1) return null; // Unknown folder, not a runtime folder
  const owner = sourceGroup.slice(0, idx);
  const digest = sourceGroup.slice(idx + DISPATCH_RUNTIME_SEP.length);
  if (!knownFolders.has(owner) || !RUNTIME_DIGEST_RE.test(digest)) {
    return null; // Owner unknown or digest malformed
  }
  return owner;
}

function safeEmitIpcEvent(
  deps: IpcDeps,
  ...args: Parameters<NonNullable<IpcDeps['onIpcEvent']>>
): void {
  if (!deps.onIpcEvent) return;
  queueMicrotask(() => {
    try {
      deps.onIpcEvent?.(...args);
    } catch (err) {
      logger.warn(
        { err, kind: args[0], sourceGroup: args[1] },
        'IPC event observer failed',
      );
    }
  });
}

function getRegisteredGroupForIpcJid(
  jid: string,
  registeredGroups: Record<string, RegisteredGroup>,
): RegisteredGroup | undefined {
  const exact = registeredGroups[jid];
  if (exact) return exact;
  const slack = parseSlackJid(jid);
  if (!slack) return undefined;
  return (
    registeredGroups[slack.parentJid] || registeredGroups[slack.legacyParentJid]
  );
}

function sourceCanAccessJid(
  jid: string,
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  deps: IpcDeps,
): {
  allowed: boolean;
  targetGroup: RegisteredGroup | undefined;
  isSelf: boolean;
} {
  const targetGroup = getRegisteredGroupForIpcJid(jid, registeredGroups);
  const channelSubs = deps.getSubscriptions?.(jid) ?? [];
  const isSelf = Boolean(
    (targetGroup && targetGroup.folder === sourceGroup) ||
    channelSubs.some((s) => s.agentFolder === sourceGroup),
  );
  return {
    allowed: isMain || isSelf || !!targetGroup,
    targetGroup,
    isSelf,
  };
}

function sourceCanReadJid(
  jid: string,
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  deps: IpcDeps,
): {
  allowed: boolean;
  targetGroup: RegisteredGroup | undefined;
  isSelf: boolean;
} {
  const access = sourceCanAccessJid(
    jid,
    sourceGroup,
    isMain,
    registeredGroups,
    deps,
  );
  return {
    ...access,
    allowed: isMain || access.isSelf,
  };
}

function clampReadThreadLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(100, Math.floor(limit)));
}

function normalizeConfirmationEmoji(
  value: unknown,
  fallback: string,
): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  const stripped = raw.replace(/^:+|:+$/g, '');
  if (!stripped || !/^[a-zA-Z0-9_+-]+$/.test(stripped)) return fallback;
  return stripped.slice(0, 64);
}

function renderConfirmationRequest(data: IpcMessagePayload): {
  text: string;
  approveEmoji: string;
  denyEmoji: string;
} {
  const action =
    typeof data.action === 'string' && data.action.trim()
      ? data.action.trim().slice(0, 240)
      : 'Approve this action?';
  const details =
    typeof data.details === 'string' ? data.details.trim().slice(0, 4000) : '';
  const approveName = normalizeConfirmationEmoji(
    data.approveEmoji,
    'white_check_mark',
  );
  const denyName = normalizeConfirmationEmoji(data.denyEmoji, 'x');
  const approveEmoji = `:${approveName}:`;
  const denyEmoji = `:${denyName}:`;
  const lines = [`*Confirmation needed:* ${action}`, ''];

  if (details) {
    lines.push(details, '');
  }

  lines.push(
    `React with ${approveEmoji} to approve or ${denyEmoji} to deny. You can also reply with changes or questions.`,
  );

  return {
    text: lines.join('\n'),
    approveEmoji,
    denyEmoji,
  };
}

type IpcSourceKind = 'messages' | 'tasks';

interface BudgetedIpcFiles {
  files: string[];
  deferredCount: number;
}

function selectIpcFilesForPoll(
  dirPath: string,
  sourceGroup: string,
  sourceKind: IpcSourceKind,
  deps: IpcDeps,
  remainingGlobalBudget: number,
): BudgetedIpcFiles {
  const allFiles = listIpcJsonFiles(dirPath)
    .map((file) => {
      const filePath = path.join(dirPath, file);
      try {
        return { file, mtimeMs: fs.statSync(filePath).mtimeMs };
      } catch {
        return { file, mtimeMs: 0 };
      }
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file))
    .map((entry) => entry.file);

  const sourceLimit = Math.min(
    MAX_IPC_FILES_PER_SOURCE_PER_POLL,
    Math.max(remainingGlobalBudget, 0),
  );
  const files = allFiles.slice(0, sourceLimit);
  const deferredCount = allFiles.length - files.length;

  if (deferredCount > 0) {
    logger.warn(
      {
        sourceGroup,
        sourceKind,
        fileCount: allFiles.length,
        processedCount: files.length,
        deferredCount,
        perSourceLimit: MAX_IPC_FILES_PER_SOURCE_PER_POLL,
        globalRemaining: remainingGlobalBudget,
      },
      'IPC source exceeded per-poll file budget; deferring overflow',
    );
    safeEmitIpcEvent(
      deps,
      'ipc_error',
      sourceGroup,
      `IPC ${sourceKind} backpressure: deferred ${deferredCount} file${deferredCount === 1 ? '' : 's'}`,
      {
        reason: 'ipc_backpressure',
        sourceKind,
        fileCount: allFiles.length,
        processedCount: files.length,
        deferredCount,
        perSourceLimit: MAX_IPC_FILES_PER_SOURCE_PER_POLL,
        globalRemaining: remainingGlobalBudget,
      },
    );
  }

  return { files, deferredCount };
}

/** Result of processing an IPC message. */
export type MessageResult =
  | { action: 'handled' }
  | { action: 'suppressed'; reason: string }
  | { action: 'blocked'; reason: string }
  | { action: 'unknown' };

function sanitizeIpcRequestId(requestId: string): string {
  return String(requestId).replace(/[^a-zA-Z0-9_-]/g, '');
}

function writeIpcMessageResponse(
  ipcBaseDir: string,
  sourceGroup: string,
  requestId: string | undefined,
  body: Record<string, unknown>,
): { ok: true } | { ok: false; result: MessageResult } {
  if (!requestId) return { ok: true };

  const safeRequestId = sanitizeIpcRequestId(requestId);
  if (!safeRequestId) {
    logger.warn(
      { requestId },
      'IPC message response requestId sanitized to empty string — skipping response',
    );
    return {
      ok: false,
      result: { action: 'blocked', reason: 'requestId sanitized to empty' },
    };
  }

  const responseDir = path.join(ipcBaseDir, sourceGroup, 'responses');
  fs.mkdirSync(responseDir, { recursive: true });
  const responseFile = path.join(responseDir, `${safeRequestId}.json`);
  const tempPath = `${responseFile}.tmp`;
  fs.writeFileSync(
    tempPath,
    JSON.stringify(
      {
        requestId: safeRequestId,
        ...body,
      },
      null,
      2,
    ),
  );
  fs.renameSync(tempPath, responseFile);
  return { ok: true };
}

/**
 * Process a single IPC message payload. Extracted from startIpcWatcher to
 * enable direct unit testing of message dispatch logic.
 */
export async function processMessageIpc(
  data: IpcMessagePayload,
  sourceGroup: string,
  isMain: boolean,
  ipcBaseDir: string,
  registeredGroups: Record<string, RegisteredGroup>,
  deps: IpcDeps,
): Promise<MessageResult> {
  // --- react_to_message ---
  if (
    data.type === 'react_to_message' &&
    data.chatJid &&
    data.messageId &&
    data.emoji
  ) {
    const chatJid = data.chatJid;
    const messageId = data.messageId;
    const emoji = data.emoji;
    const ch = deps.findChannel?.(chatJid);
    let reactionError: string | null = null;

    if (!ch) {
      reactionError = `No channel found for ${chatJid}.`;
    } else if (data.remove) {
      if (!ch.removeReaction) {
        reactionError = 'Channel does not support removing reactions.';
      } else {
        try {
          await ch.removeReaction(chatJid, messageId, emoji);
        } catch (err) {
          reactionError = err instanceof Error ? err.message : String(err);
        }
      }
    } else if (!ch.addReaction) {
      reactionError = 'Channel does not support adding reactions.';
    } else {
      try {
        await ch.addReaction(chatJid, messageId, emoji);
      } catch (err) {
        reactionError = err instanceof Error ? err.message : String(err);
      }
    }

    const responseWrite = writeIpcMessageResponse(
      ipcBaseDir,
      sourceGroup,
      data.requestId,
      reactionError
        ? {
            type: 'react_to_message_response',
            ok: false,
            error: reactionError,
          }
        : {
            type: 'react_to_message_response',
            ok: true,
            result: data.remove ? 'Reaction removed.' : 'Reaction added.',
          },
    );
    if (!responseWrite.ok) {
      return responseWrite.result;
    }

    if (reactionError) {
      logger.warn(
        {
          chatJid,
          messageId,
          emoji,
          remove: !!data.remove,
          sourceGroup,
          err: reactionError,
        },
        'IPC reaction failed',
      );
    } else {
      logger.info(
        {
          chatJid,
          messageId,
          emoji,
          remove: !!data.remove,
          sourceGroup,
        },
        'IPC reaction processed',
      );
    }
    return { action: 'handled' };
  }

  // --- format_mention ---
  if (data.type === 'format_mention' && data.userName && data.platform) {
    const userRegistryPath = path.join(ipcBaseDir, 'user_registry.json');
    let formattedMention = `@${data.userName}`;
    try {
      if (fs.existsSync(userRegistryPath)) {
        const registryData = JSON.parse(
          fs.readFileSync(userRegistryPath, 'utf-8'),
        );
        const key = data.userName!.toLowerCase().trim();
        const user = registryData[key];
        if (user) {
          switch (user.platform) {
            case 'discord':
            case 'slack':
              formattedMention = `<@${user.id}>`;
              break;
            case 'whatsapp':
              formattedMention = `@${user.id}`;
              break;
            default:
              formattedMention = `@${user.name}`;
          }
        }
      }
    } catch (err) {
      logger.warn(
        { err, userName: data.userName },
        'format_mention: failed to read user registry',
      );
    }
    // Write response back so the agent can read the result
    const responseWrite = writeIpcMessageResponse(
      ipcBaseDir,
      sourceGroup,
      data.requestId,
      {
        type: 'format_mention_response',
        result: formattedMention,
      },
    );
    if (!responseWrite.ok) {
      return responseWrite.result;
    }
    logger.info(
      {
        userName: data.userName,
        platform: data.platform,
        formattedMention,
        sourceGroup,
      },
      'IPC format_mention processed',
    );
    return { action: 'handled' };
  }

  // --- request_confirmation ---
  if (data.type === 'request_confirmation' && data.chatJid) {
    const chatJid = data.chatJid;
    const access = sourceCanAccessJid(
      chatJid,
      sourceGroup,
      isMain,
      registeredGroups,
      deps,
    );
    if (!access.allowed) {
      const responseWrite = writeIpcMessageResponse(
        ipcBaseDir,
        sourceGroup,
        data.requestId,
        {
          type: 'request_confirmation_response',
          ok: false,
          error: `Not authorized to request confirmation in ${chatJid}.`,
        },
      );
      if (!responseWrite.ok) return responseWrite.result;
      logger.warn(
        { chatJid, sourceGroup },
        'Unauthorized IPC request_confirmation attempt blocked',
      );
      return { action: 'blocked', reason: 'not authorized' };
    }

    const { text, approveEmoji, denyEmoji } = renderConfirmationRequest(data);
    const msgText = stripInternalTags(text);
    if (!msgText) {
      const responseWrite = writeIpcMessageResponse(
        ipcBaseDir,
        sourceGroup,
        data.requestId,
        {
          type: 'request_confirmation_response',
          ok: false,
          error: 'Confirmation request was empty after sanitization.',
        },
      );
      if (!responseWrite.ok) return responseWrite.result;
      return { action: 'blocked', reason: 'empty confirmation request' };
    }

    const sentMessageId = await deps.sendMessage(chatJid, msgText);
    const messageId =
      typeof sentMessageId === 'string' && sentMessageId.trim()
        ? sentMessageId.trim()
        : undefined;
    const ch = deps.findChannel?.(chatJid);
    const reactionsAdded: string[] = [];
    const reactionErrors: string[] = [];

    if (messageId && ch?.addReaction) {
      for (const emoji of [approveEmoji, denyEmoji]) {
        try {
          await ch.addReaction(chatJid, messageId, emoji);
          reactionsAdded.push(emoji);
        } catch (err) {
          reactionErrors.push(err instanceof Error ? err.message : String(err));
        }
      }
    }

    const responseWrite = writeIpcMessageResponse(
      ipcBaseDir,
      sourceGroup,
      data.requestId,
      {
        type: 'request_confirmation_response',
        ok: true,
        result: {
          chatJid,
          messageId: messageId ?? null,
          approveEmoji,
          denyEmoji,
          reactionsAdded,
          reactionErrors,
        },
      },
    );
    if (!responseWrite.ok) return responseWrite.result;

    logger.info(
      {
        chatJid,
        sourceGroup,
        messageId,
        approveEmoji,
        denyEmoji,
        reactionErrorCount: reactionErrors.length,
      },
      'IPC request_confirmation processed',
    );
    return { action: 'handled' };
  }

  // --- read_thread ---
  if (data.type === 'read_thread' && data.chatJid) {
    const chatJid = data.chatJid;
    const access = sourceCanReadJid(
      chatJid,
      sourceGroup,
      isMain,
      registeredGroups,
      deps,
    );
    if (!access.allowed) {
      const responseWrite = writeIpcMessageResponse(
        ipcBaseDir,
        sourceGroup,
        data.requestId,
        {
          type: 'read_thread_response',
          ok: false,
          error: `Not authorized to read ${chatJid}.`,
        },
      );
      if (!responseWrite.ok) return responseWrite.result;
      logger.warn(
        { chatJid, sourceGroup },
        'Unauthorized IPC read_thread attempt blocked',
      );
      return { action: 'blocked', reason: 'not authorized' };
    }

    if (!deps.getMessages) {
      const responseWrite = writeIpcMessageResponse(
        ipcBaseDir,
        sourceGroup,
        data.requestId,
        {
          type: 'read_thread_response',
          ok: false,
          error: 'Host message reader is unavailable.',
        },
      );
      if (!responseWrite.ok) return responseWrite.result;
      return { action: 'blocked', reason: 'message reader unavailable' };
    }

    const limit = clampReadThreadLimit(data.limit);
    const messages = deps.getMessages(chatJid, '', limit).map((m) => ({
      id: m.id,
      sender: m.sender_name || m.sender,
      sender_id: m.sender,
      timestamp: m.timestamp,
      content: m.content,
    }));
    const threadSummary = deps.getThreadSummary?.(chatJid);
    const responseWrite = writeIpcMessageResponse(
      ipcBaseDir,
      sourceGroup,
      data.requestId,
      {
        type: 'read_thread_response',
        ok: true,
        result: {
          chatJid,
          count: messages.length,
          summary: threadSummary ?? null,
          messages,
        },
      },
    );
    if (!responseWrite.ok) return responseWrite.result;
    logger.info(
      { chatJid, sourceGroup, count: messages.length },
      'IPC read_thread processed',
    );
    return { action: 'handled' };
  }

  // --- update_thread_summary ---
  if (data.type === 'update_thread_summary' && data.chatJid) {
    const chatJid = data.chatJid;
    const access = sourceCanReadJid(
      chatJid,
      sourceGroup,
      isMain,
      registeredGroups,
      deps,
    );
    if (!access.allowed) {
      const responseWrite = writeIpcMessageResponse(
        ipcBaseDir,
        sourceGroup,
        data.requestId,
        {
          type: 'update_thread_summary_response',
          ok: false,
          error: `Not authorized to update summary for ${chatJid}.`,
        },
      );
      if (!responseWrite.ok) return responseWrite.result;
      logger.warn(
        { chatJid, sourceGroup },
        'Unauthorized IPC update_thread_summary attempt blocked',
      );
      return { action: 'blocked', reason: 'not authorized' };
    }

    if (!deps.setThreadSummary) {
      const responseWrite = writeIpcMessageResponse(
        ipcBaseDir,
        sourceGroup,
        data.requestId,
        {
          type: 'update_thread_summary_response',
          ok: false,
          error: 'Host thread summary writer is unavailable.',
        },
      );
      if (!responseWrite.ok) return responseWrite.result;
      return { action: 'blocked', reason: 'thread summary writer unavailable' };
    }

    const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
    if (!summary) {
      const responseWrite = writeIpcMessageResponse(
        ipcBaseDir,
        sourceGroup,
        data.requestId,
        {
          type: 'update_thread_summary_response',
          ok: false,
          error: 'Summary must be non-empty.',
        },
      );
      if (!responseWrite.ok) return responseWrite.result;
      return { action: 'blocked', reason: 'empty summary' };
    }

    const status =
      data.status === 'active' ||
      data.status === 'resolved' ||
      data.status === 'blocked'
        ? data.status
        : undefined;
    const updated = deps.setThreadSummary({
      chat_jid: chatJid,
      summary,
      status,
      updated_by: sourceGroup,
      through_message_id: data.throughMessageId,
      through_timestamp: data.throughTimestamp,
    });

    const responseWrite = writeIpcMessageResponse(
      ipcBaseDir,
      sourceGroup,
      data.requestId,
      {
        type: 'update_thread_summary_response',
        ok: updated,
        ...(updated
          ? {
              result: {
                chatJid,
                updated: true,
              },
            }
          : {
              error:
                'Thread summary was not updated because it appears older than the saved summary.',
            }),
      },
    );
    if (!responseWrite.ok) return responseWrite.result;
    logger.info(
      { chatJid, sourceGroup, updated },
      'IPC update_thread_summary processed',
    );
    return updated
      ? { action: 'handled' }
      : { action: 'blocked', reason: 'stale summary' };
  }

  // --- ssh_pubkey ---
  if (data.type === 'ssh_pubkey' && data.pubkey) {
    logger.info(
      { folder: sourceGroup, pubkey: data.pubkey },
      'Agent generated new SSH key',
    );
    return { action: 'handled' };
  }

  // --- message ---
  if (data.type === 'message' && data.chatJid && data.text) {
    const msgChatJid = data.chatJid;
    const msgText = stripInternalTags(data.text);
    if (!msgText) {
      logger.debug(
        { chatJid: data.chatJid, sourceGroup },
        'IPC message suppressed (internal-only)',
      );
      safeEmitIpcEvent(
        deps,
        'message_suppressed',
        sourceGroup,
        'Message suppressed (internal-only)',
        { chatJid: data.chatJid },
      );
      return { action: 'suppressed', reason: 'internal-only' };
    }
    const { allowed, targetGroup, isSelf } = sourceCanAccessJid(
      msgChatJid,
      sourceGroup,
      isMain,
      registeredGroups,
      deps,
    );
    if (allowed) {
      await deps.sendMessage(msgChatJid, msgText, data.discord_bot_id);
      // Cross-group message: also wake up the target agent.
      // Pass sourceGroup so the notify message is tagged — the source
      // agent won't see its own IPC message echoed back at it.
      if (targetGroup && !isSelf) {
        deps.notifyGroup(msgChatJid, msgText, sourceGroup);
      }
      logger.info(
        {
          chatJid: data.chatJid,
          originChatJid: data.originChatJid,
          currentChatJid: data.currentChatJid,
          targetWasExplicit: data.targetWasExplicit,
          sourceGroup,
        },
        'IPC message sent',
      );
      safeEmitIpcEvent(
        deps,
        'message_sent',
        sourceGroup,
        `Message sent to ${msgChatJid}`,
        {
          chatJid: msgChatJid,
          originChatJid: data.originChatJid,
          currentChatJid: data.currentChatJid,
          targetWasExplicit: data.targetWasExplicit,
        },
      );
      return { action: 'handled' };
    } else {
      logger.warn(
        { chatJid: data.chatJid, sourceGroup },
        'Unauthorized IPC message attempt blocked (target not registered)',
      );
      safeEmitIpcEvent(
        deps,
        'message_blocked',
        sourceGroup,
        `Blocked: target ${msgChatJid} not registered`,
        { chatJid: msgChatJid },
      );
      return { action: 'blocked', reason: 'target not registered' };
    }
  }

  return { action: 'unknown' };
}

let ipcWatcherRunning = false;

export function resetIpcWatcherForTests(): void {
  ipcWatcherRunning = false;
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs
        .readdirSync(ipcBaseDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== 'errors')
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    const runtimeFolders = deps.activeRuntimeFolders?.();
    const agentFolders = deps.agentFolders?.();
    let remainingPollBudget = MAX_IPC_FILES_PER_POLL;
    for (const sourceGroup of groupFolders) {
      const ownerGroup = resolveOwnerGroupFolder(
        sourceGroup,
        registeredGroups,
        agentFolders,
      );
      if (ownerGroup === null) {
        // Unknown sender — not a registered group or runtime folder.
        // Log and quarantine to prevent unbounded disk growth from rogue dirs.
        const rogueDir = path.join(ipcBaseDir, sourceGroup);
        logger.warn(
          { sourceGroup },
          'Skipping IPC from unrecognized source folder — quarantining',
        );
        try {
          const errDir = path.join(ipcBaseDir, 'errors');
          fs.mkdirSync(errDir, { recursive: true });
          fs.renameSync(rogueDir, path.join(errDir, sourceGroup));
        } catch {
          // If rename fails (e.g. cross-device), just delete
          try {
            fs.rmSync(rogueDir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
        continue;
      }
      // Detect stale dispatch folders: container has finished (removed from
      // activeRuntimeFolders) but the IPC directory was not yet cleaned up.
      // Process any remaining files first, then delete the directory.
      const isStaleDispatch =
        sourceGroup.includes(DISPATCH_RUNTIME_SEP) &&
        runtimeFolders !== undefined &&
        !runtimeFolders.has(sourceGroup);
      const isMain = ownerGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');
      let sourceHadDeferredFiles = false;

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageSelection = selectIpcFilesForPoll(
            messagesDir,
            ownerGroup,
            'messages',
            deps,
            remainingPollBudget,
          );
          const messageFiles = messageSelection.files;
          sourceHadDeferredFiles ||= messageSelection.deferredCount > 0;
          remainingPollBudget -= messageFiles.length;
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const result = readIpcJsonFile(filePath);
              if (!result.ok) {
                logger.warn(
                  { file, sourceGroup, reason: result.reason },
                  'Rejected IPC message file',
                );
                quarantineIpcFile(
                  filePath,
                  ipcBaseDir,
                  result.reason,
                  sourceGroup,
                );
                continue;
              }
              const data = result.data as IpcMessagePayload;
              await processMessageIpc(
                data,
                ownerGroup,
                isMain,
                ipcBaseDir,
                registeredGroups,
                deps,
              );
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              quarantineIpcFile(filePath, ipcBaseDir, String(err), sourceGroup);
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskSelection = selectIpcFilesForPoll(
            tasksDir,
            ownerGroup,
            'tasks',
            deps,
            remainingPollBudget,
          );
          const taskFiles = taskSelection.files;
          sourceHadDeferredFiles ||= taskSelection.deferredCount > 0;
          remainingPollBudget -= taskFiles.length;
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            const taskResult = readIpcJsonFile(filePath);
            if (!taskResult.ok) {
              logger.warn(
                { file, sourceGroup, reason: taskResult.reason },
                'Rejected IPC task file',
              );
              quarantineIpcFile(
                filePath,
                ipcBaseDir,
                taskResult.reason,
                sourceGroup,
              );
              continue;
            }
            try {
              const data = taskResult.data as IpcTaskPayload;
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, ownerGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              quarantineIpcFile(filePath, ipcBaseDir, String(err), sourceGroup);
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }

      // Clean up stale dispatch IPC folder after processing any remaining files.
      // This avoids a race where the container exits, activeRuntimeFolders is
      // updated, and the watcher finds the orphaned directory on the next poll.
      if (isStaleDispatch && !sourceHadDeferredFiles) {
        const staleDir = path.join(ipcBaseDir, sourceGroup);
        try {
          fs.rmSync(staleDir, { recursive: true, force: true });
          logger.debug({ sourceGroup }, 'Cleaned up stale dispatch IPC folder');
        } catch (err) {
          logger.debug(
            { sourceGroup, err },
            'Failed to clean up stale dispatch IPC folder — will retry next poll',
          );
        }
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: IpcTaskPayload,
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  /** Refresh current_tasks.json so the agent sees the mutation immediately */
  const refreshTasksSnapshot = () => {
    deps.writeTasksSnapshot?.(sourceGroup, isMain);
  };

  /** Shared handler for cancel — auth + dispatch pattern */
  const handleTaskCancel = (
    taskId: string | undefined,
    srcGroup: string,
    isMainGroup: boolean,
  ) => {
    if (!taskId) {
      logger.warn(
        { sourceGroup: srcGroup },
        'Task cancel attempt with missing taskId',
      );
      return;
    }
    const task = getTaskById(taskId);
    if (!task) {
      logger.warn(
        { taskId, sourceGroup: srcGroup },
        'Task cancel attempt but task not found',
      );
      return;
    }
    if (isMainGroup || task.group_folder === srcGroup) {
      deleteTask(taskId);
      logger.info({ taskId, sourceGroup: srcGroup }, 'Task cancelled via IPC');
      safeEmitIpcEvent(
        deps,
        'task_cancelled',
        srcGroup,
        `Task ${taskId} cancelled`,
        { taskId },
      );
      refreshTasksSnapshot();
    } else {
      logger.warn(
        { taskId, sourceGroup: srcGroup },
        'Unauthorized task cancel attempt',
      );
    }
  };

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid!;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        const nextRun = calculateNextRun(scheduleType, data.schedule_value);
        if (nextRun === null) {
          logger.warn(
            { scheduleType, scheduleValue: data.schedule_value },
            'Invalid schedule configuration',
          );
          break;
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        const preprocessScript = normalizePreprocessScriptPath(
          data.preprocess_script,
        );
        if (!preprocessScript.ok) {
          logger.warn(
            { sourceGroup, targetFolder, error: preprocessScript.error },
            'Invalid task preprocess_script rejected',
          );
          break;
        }
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          preprocess_script: preprocessScript.path,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        safeEmitIpcEvent(
          deps,
          'task_created',
          sourceGroup,
          `Task ${taskId} created for ${targetFolder}`,
          { taskId, targetFolder },
        );
        refreshTasksSnapshot();
      }
      break;

    case 'cancel_task':
      handleTaskCancel(data.taskId, sourceGroup, isMain);
      break;

    case 'edit_task': {
      if (!data.taskId) {
        logger.warn({ sourceGroup }, 'edit_task attempt with missing taskId');
        break;
      }
      const task = getTaskById(data.taskId);
      if (!task) {
        logger.warn(
          { taskId: data.taskId, sourceGroup },
          'edit_task attempt but task not found',
        );
        break;
      }
      if (!isMain && task.group_folder !== sourceGroup) {
        logger.warn(
          { taskId: data.taskId, sourceGroup },
          'Unauthorized edit_task attempt',
        );
        break;
      }

      const updates: Partial<
        Pick<
          typeof task,
          | 'prompt'
          | 'preprocess_script'
          | 'schedule_type'
          | 'schedule_value'
          | 'next_run'
          | 'status'
          | 'context_mode'
        >
      > = {};
      if (data.prompt) updates.prompt = data.prompt;
      if (data.preprocess_script !== undefined) {
        const preprocessScript = normalizePreprocessScriptPath(
          data.preprocess_script,
        );
        if (!preprocessScript.ok) {
          logger.warn(
            {
              taskId: data.taskId,
              sourceGroup,
              error: preprocessScript.error,
            },
            'Invalid task preprocess_script rejected',
          );
          break;
        }
        updates.preprocess_script = preprocessScript.path;
      }
      if (data.schedule_type)
        updates.schedule_type = data.schedule_type as
          | 'cron'
          | 'interval'
          | 'once';
      if (data.schedule_value) updates.schedule_value = data.schedule_value;
      if (data.status) updates.status = data.status as 'active' | 'paused';
      if (data.context_mode)
        updates.context_mode = data.context_mode as 'group' | 'isolated';

      const effectiveStatus = updates.status ?? task.status;
      const scheduleChanged = !!(
        updates.schedule_type || updates.schedule_value
      );
      const beingResumed =
        updates.status === 'active' && task.status !== 'active';

      if (effectiveStatus === 'active' && (scheduleChanged || beingResumed)) {
        const newType = (updates.schedule_type ?? task.schedule_type) as
          | 'cron'
          | 'interval'
          | 'once';
        const newValue = updates.schedule_value ?? task.schedule_value;
        // Always recalculate when schedule explicitly changed (including 'once').
        // On resume without a schedule change, only recalculate cron/interval so
        // the task fires at the next appropriate time rather than a stale next_run.
        if (scheduleChanged || newType !== 'once') {
          const nextRun = calculateNextRun(newType, newValue);
          if (nextRun !== null) updates.next_run = nextRun;
        }
      }

      updateTask(data.taskId, updates);
      logger.info(
        { taskId: data.taskId, sourceGroup, updates: Object.keys(updates) },
        'Task edited via IPC',
      );
      safeEmitIpcEvent(
        deps,
        'task_edited',
        sourceGroup,
        `Task ${data.taskId} updated: ${Object.keys(updates).join(', ')}`,
        { taskId: data.taskId, fields: Object.keys(updates) },
      );
      refreshTasksSnapshot();
      break;
    }

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!/^[a-z0-9][a-z0-9_-]*$/i.test(data.folder)) {
          logger.warn(
            { folder: data.folder, sourceGroup },
            'Invalid group folder name rejected (must be alphanumeric with hyphens/underscores)',
          );
          break;
        }
        const groupToRegister: RegisteredGroup = {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          backend: data.backend,
          agentRuntime: data.agent_runtime,
          description: data.group_description,
          requiresTrigger: data.requiresTrigger,
          discordBotId: data.discord_bot_id,
        };

        // If a Discord guild ID is provided, validate it and compute serverFolder
        if (data.discord_guild_id) {
          if (!/^\d+$/.test(data.discord_guild_id)) {
            logger.warn(
              { discordGuildId: data.discord_guild_id, sourceGroup },
              'Invalid discord_guild_id rejected (must be numeric snowflake)',
            );
            break;
          }
          groupToRegister.discordGuildId = data.discord_guild_id;
          groupToRegister.serverFolder = `servers/${data.discord_guild_id}`;
        }

        deps.registerGroup(data.jid, groupToRegister);
        safeEmitIpcEvent(
          deps,
          'group_registered',
          sourceGroup,
          `Group registered: ${data.name} (${data.folder})`,
          { jid: data.jid, name: data.name, folder: data.folder },
        );
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'subscribe_channel': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized subscribe_channel attempt blocked',
        );
        break;
      }
      if (!data.channel_jid || !data.target_agent) {
        logger.warn({ data }, 'subscribe_channel missing required fields');
        break;
      }
      const targetEntry = findGroupByFolder(
        registeredGroups,
        data.target_agent,
      );
      if (!targetEntry) {
        logger.warn(
          { targetAgent: data.target_agent },
          'subscribe_channel target agent not found',
        );
        break;
      }
      const targetGroup = targetEntry[1];
      const subs = getSubscriptionsForChannel(data.channel_jid);
      const existing = subs.find((s) => s.agentId === targetGroup.folder);
      const now = new Date().toISOString();
      setChannelSubscription({
        channelJid: data.channel_jid,
        agentId: targetGroup.folder,
        trigger: data.trigger || targetGroup.trigger || `@${targetGroup.name}`,
        requiresTrigger: data.requiresTrigger !== false,
        priority: 100,
        isPrimary: existing?.isPrimary ?? false,
        discordBotId: data.discord_bot_id || targetGroup.discordBotId,
        discordGuildId: data.discord_guild_id || targetGroup.discordGuildId,
        createdAt: existing?.createdAt || now,
      });
      logger.info(
        { channelJid: data.channel_jid, agentId: targetGroup.folder },
        'Channel subscription upserted via IPC',
      );
      deps.onSubscriptionChanged?.();
      break;
    }

    case 'unsubscribe_channel': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized unsubscribe_channel attempt blocked',
        );
        break;
      }
      if (!data.channel_jid || !data.target_agent) {
        logger.warn({ data }, 'unsubscribe_channel missing required fields');
        break;
      }
      removeChannelSubscription(data.channel_jid, data.target_agent);
      logger.info(
        { channelJid: data.channel_jid, agentId: data.target_agent },
        'Channel subscription removed via IPC',
      );
      deps.onSubscriptionChanged?.();
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
