import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { calculateNextRun } from './schedule-utils.js';
import { AvailableGroup } from './ipc-snapshots.js';
import {
  createTask,
  deleteTask,
  getTaskById,
  setRegisteredGroup,
  updateTask,
} from './db.js';
import { transferFiles } from './file-transfer.js';
import { rejectTraversalSegments } from './path-security.js';
import {
  findGroupByFolder,
  findJidByFolder,
  findMainGroupJid,
  isMainGroup,
} from './group-helpers.js';
import {
  listIpcJsonFiles,
  quarantineIpcFile,
  readIpcJsonFile,
} from './ipc-file-security.js';
import { logger } from './logger.js';
import { stripInternalTags } from './router.js';
import { reconcileHeartbeats } from './task-scheduler.js';
import {
  Channel,
  HeartbeatConfig,
  IpcMessagePayload,
  IpcTaskPayload,
  RegisteredGroup,
} from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<string | void>;
  /** Store a message in a group's DB and enqueue it for agent processing */
  notifyGroup: (jid: string, text: string) => void;
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
}

// --- Pending share request tracking ---

export interface PendingShareRequest {
  sourceJid: string;
  sourceName: string;
  sourceGroup: string;
  description: string;
  serverFolder?: string;
  timestamp: number;
}

const pendingShareRequests = new Map<string, PendingShareRequest>();
const STALE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function trackShareRequest(
  messageId: string,
  meta: PendingShareRequest,
): void {
  // Clean stale entries
  const now = Date.now();
  for (const [id, entry] of pendingShareRequests) {
    if (now - entry.timestamp > STALE_TTL_MS) pendingShareRequests.delete(id);
  }
  pendingShareRequests.set(messageId, meta);
  logger.info(
    { messageId, sourceGroup: meta.sourceGroup },
    'Share request tracked for reaction approval',
  );
}

export function consumeShareRequest(
  messageId: string,
): PendingShareRequest | undefined {
  const entry = pendingShareRequests.get(messageId);
  if (entry) pendingShareRequests.delete(messageId);
  return entry;
}

let ipcWatcherRunning = false;

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
        .map((e) => e.name);
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = listIpcJsonFiles(messagesDir);
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
                if (data.remove) {
                  await (ch?.removeReaction?.(chatJid, messageId, emoji) ??
                    Promise.resolve());
                } else {
                  await (ch?.addReaction?.(chatJid, messageId, emoji) ??
                    Promise.resolve());
                }
                logger.info(
                  {
                    chatJid: data.chatJid,
                    messageId: data.messageId,
                    emoji: data.emoji,
                    remove: !!data.remove,
                    sourceGroup,
                  },
                  'IPC reaction processed',
                );
                fs.unlinkSync(filePath);
                continue;
              }
              if (
                data.type === 'format_mention' &&
                data.userName &&
                data.platform
              ) {
                // Look up user in registry and write response back to agent
                const userRegistryPath = path.join(
                  ipcBaseDir,
                  'user_registry.json',
                );
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
                if (data.requestId) {
                  const safeRequestId = String(data.requestId).replace(
                    /[^a-zA-Z0-9_-]/g,
                    '',
                  );
                  if (!safeRequestId) {
                    logger.warn(
                      { requestId: data.requestId },
                      'format_mention: requestId sanitized to empty string — skipping response',
                    );
                    break;
                  }
                  const responseDir = path.join(
                    ipcBaseDir,
                    sourceGroup,
                    'responses',
                  );
                  fs.mkdirSync(responseDir, { recursive: true });
                  const responseFile = path.join(
                    responseDir,
                    `${safeRequestId}.json`,
                  );
                  const tempPath = `${responseFile}.tmp`;
                  fs.writeFileSync(
                    tempPath,
                    JSON.stringify(
                      {
                        type: 'format_mention_response',
                        requestId: safeRequestId,
                        result: formattedMention,
                      },
                      null,
                      2,
                    ),
                  );
                  fs.renameSync(tempPath, responseFile);
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
                fs.unlinkSync(filePath);
                continue;
              }
              if (data.type === 'ssh_pubkey' && data.pubkey) {
                logger.info(
                  { folder: sourceGroup, pubkey: data.pubkey },
                  'Agent generated new SSH key',
                );
                fs.unlinkSync(filePath);
                continue;
              }
              if (data.type === 'message' && data.chatJid && data.text) {
                // Strip <internal>...</internal> blocks before sending
                const msgChatJid = data.chatJid;
                const msgText = stripInternalTags(data.text);
                if (!msgText) {
                  logger.debug(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message suppressed (internal-only)',
                  );
                  fs.unlinkSync(filePath);
                  continue;
                }
                // Authorization: any registered agent can message any other registered agent
                const targetGroup = registeredGroups[msgChatJid];
                const isSelf =
                  targetGroup && targetGroup.folder === sourceGroup;
                const isRegisteredTarget = !!targetGroup;
                if (isMain || isSelf || isRegisteredTarget) {
                  await deps.sendMessage(msgChatJid, msgText);
                  // Cross-group message: also wake up the target agent
                  if (targetGroup && targetGroup.folder !== sourceGroup) {
                    deps.notifyGroup(msgChatJid, msgText);
                  }
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked (target not registered)',
                  );
                }
              }
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
          const taskFiles = listIpcJsonFiles(tasksDir);
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
              await processTaskIpc(data, sourceGroup, isMain, deps);
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

  /** Shared handler for pause/resume/cancel — identical auth + dispatch pattern */
  const TASK_ACTION_LABELS: Record<string, string> = {
    pause_task: 'paused',
    resume_task: 'resumed',
    cancel_task: 'cancelled',
  };
  const TASK_ACTION_VERBS: Record<string, string> = {
    pause_task: 'pause',
    resume_task: 'resume',
    cancel_task: 'cancel',
  };
  const handleTaskLifecycle = (
    action: string,
    taskId: string | undefined,
    srcGroup: string,
    isMainGroup: boolean,
  ) => {
    const verb = TASK_ACTION_VERBS[action] ?? action;
    if (!taskId) {
      logger.warn(
        { action, sourceGroup: srcGroup },
        `Task ${verb} attempt with missing taskId`,
      );
      return;
    }
    const task = getTaskById(taskId);
    const label = TASK_ACTION_LABELS[action] ?? action;
    if (!task) {
      logger.warn(
        { taskId, sourceGroup: srcGroup },
        `Task ${verb} attempt but task not found`,
      );
      return;
    }
    if (isMainGroup || task.group_folder === srcGroup) {
      if (action === 'cancel_task') {
        deleteTask(taskId);
      } else {
        updateTask(taskId, {
          status: action === 'pause_task' ? 'paused' : 'active',
        });
      }
      logger.info({ taskId, sourceGroup: srcGroup }, `Task ${label} via IPC`);
      refreshTasksSnapshot();
    } else {
      logger.warn(
        { taskId, sourceGroup: srcGroup },
        `Unauthorized task ${verb} attempt`,
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
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
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
        refreshTasksSnapshot();
      }
      break;

    case 'pause_task':
    case 'resume_task':
    case 'cancel_task':
      handleTaskLifecycle(data.type, data.taskId, sourceGroup, isMain);
      break;

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
          description: data.group_description,
          requiresTrigger: data.requiresTrigger,
        };

        // If a Discord guild ID is provided, set it and compute serverFolder
        if (data.discord_guild_id) {
          groupToRegister.discordGuildId = data.discord_guild_id;
          groupToRegister.serverFolder = `servers/${data.discord_guild_id}`;
        }

        deps.registerGroup(data.jid, groupToRegister);
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'configure_heartbeat': {
      if (data.enabled === undefined) {
        logger.warn({ data }, 'configure_heartbeat missing enabled field');
        break;
      }

      // Resolve target group
      const targetJid =
        isMain && data.target_group_jid
          ? data.target_group_jid
          : findJidByFolder(registeredGroups, sourceGroup);

      if (!targetJid) {
        logger.warn(
          { sourceGroup },
          'configure_heartbeat: could not resolve target group',
        );
        break;
      }

      const targetGroup = registeredGroups[targetJid];
      if (!targetGroup) {
        logger.warn(
          { targetJid },
          'configure_heartbeat: target group not registered',
        );
        break;
      }

      // Authorization: non-main groups can only configure their own heartbeat
      if (!isMain && targetGroup.folder !== sourceGroup) {
        logger.warn(
          { sourceGroup, targetFolder: targetGroup.folder },
          'Unauthorized configure_heartbeat attempt',
        );
        break;
      }

      const heartbeat: HeartbeatConfig | undefined = data.enabled
        ? {
            enabled: true,
            interval: data.interval || '1800000',
            scheduleType: (data.heartbeat_schedule_type === 'cron'
              ? 'cron'
              : 'interval') as 'cron' | 'interval',
          }
        : undefined;

      const updatedGroup: RegisteredGroup = { ...targetGroup, heartbeat };
      deps.updateGroup(targetJid, updatedGroup);
      reconcileHeartbeats(deps.registeredGroups());

      logger.info(
        { targetJid, folder: targetGroup.folder, enabled: data.enabled },
        'Heartbeat configured via IPC',
      );
      break;
    }

    case 'share_request': {
      if (!data.description) {
        logger.warn({ data }, 'share_request missing description');
        break;
      }

      // Find the source group's display name and JID
      const sourceGroupEntry = findGroupByFolder(registeredGroups, sourceGroup);
      const sourceName = sourceGroupEntry?.[1].name || sourceGroup;
      const sourceJid = sourceGroupEntry?.[0] || sourceGroup;

      // Track validated files at case scope for notification message
      let sharedFiles: string[] = [];
      let requestedFiles: string[] = [];

      // If files are specified with a target_agent, do the file transfer
      if (data.target_agent && data.files && data.files.length > 0) {
        // Validate all file paths before transfer (defense-in-depth)
        const validFiles: string[] = [];
        for (const file of data.files) {
          try {
            rejectTraversalSegments(file, 'share_request.files');
            validFiles.push(file);
          } catch (err) {
            logger.warn(
              { file, sourceGroup, error: err },
              'Rejected share_request file path',
            );
          }
        }

        const targetGroupEntry = findGroupByFolder(
          registeredGroups,
          data.target_agent!,
        );
        if (targetGroupEntry && sourceGroupEntry && validFiles.length > 0) {
          const result = await transferFiles({
            sourceGroup: sourceGroupEntry[1],
            targetGroup: targetGroupEntry[1],
            files: validFiles,
            direction: 'push',
          });
          logger.info(
            {
              sourceGroup,
              targetAgent: data.target_agent,
              transferred: result.transferred,
              errors: result.errors,
            },
            'Share request file transfer completed',
          );
        }
        sharedFiles = validFiles;
      }

      // If request_files are specified, pull files from target to source
      if (
        data.target_agent &&
        data.request_files &&
        data.request_files.length > 0
      ) {
        // Validate all requested file paths (defense-in-depth)
        const validRequestFiles: string[] = [];
        for (const file of data.request_files) {
          try {
            rejectTraversalSegments(file, 'share_request.request_files');
            validRequestFiles.push(file);
          } catch (err) {
            logger.warn(
              { file, sourceGroup, error: err },
              'Rejected share_request request_files path',
            );
          }
        }

        const targetGroupEntry = findGroupByFolder(
          registeredGroups,
          data.target_agent!,
        );
        if (
          targetGroupEntry &&
          sourceGroupEntry &&
          validRequestFiles.length > 0
        ) {
          const result = await transferFiles({
            sourceGroup: targetGroupEntry[1],
            targetGroup: sourceGroupEntry[1],
            files: validRequestFiles,
            direction: 'push',
          });
          logger.info(
            {
              sourceGroup,
              targetAgent: data.target_agent,
              transferred: result.transferred,
            },
            'Share request file pull completed',
          );
        }
        requestedFiles = validRequestFiles;
      }

      // Determine target JID: specific agent or main
      let targetJid: string | undefined;
      if (data.target_agent) {
        targetJid = findJidByFolder(registeredGroups, data.target_agent);
      }
      if (!targetJid) {
        // Fall back to main group
        targetJid = findMainGroupJid(registeredGroups);
      }

      if (!targetJid) {
        logger.warn('share_request: could not find target group JID');
        break;
      }

      // Build path guidance
      const serverFolder = data.serverFolder;
      const scope = data.scope || 'auto';
      let pathGuidance: string;
      if (serverFolder) {
        pathGuidance = `\n\n*Where to write context:*\n• _Channel-specific:_ \`groups/${sourceGroup}/CLAUDE.md\`\n• _Server-wide (all Discord channels):_ \`groups/${serverFolder}/CLAUDE.md\``;
        if (scope === 'server') {
          pathGuidance += ' ← requested';
        } else if (scope === 'channel') {
          pathGuidance = `\n\n*Write context to:* \`groups/${sourceGroup}/CLAUDE.md\``;
        }
      } else {
        pathGuidance = `\n\n*Write context to:* \`groups/${sourceGroup}/CLAUDE.md\``;
      }

      const filesInfo = sharedFiles.length
        ? `\n\n*Files shared:* ${sharedFiles.join(', ')}`
        : '';
      const requestFilesInfo = requestedFiles.length
        ? `\n\n*Files requested:* ${requestedFiles.join(', ')}`
        : '';
      const targetInfo = data.target_agent
        ? ` (targeted to ${data.target_agent})`
        : '';

      const message = `*Context Request* from _${sourceName}_ (${sourceJid})${targetInfo}:\n\n${data.description}${pathGuidance}${filesInfo}${requestFilesInfo}\n\n_React 👍 to approve, or reply manually._`;
      const sentId = await deps.sendMessage(targetJid, message);

      // Track for reaction-based approval
      if (sentId) {
        trackShareRequest(sentId, {
          sourceJid,
          sourceName,
          sourceGroup,
          description: data.description,
          serverFolder,
          timestamp: Date.now(),
        });
      }

      logger.info(
        {
          sourceGroup,
          sourceJid,
          targetJid,
          scope,
          serverFolder,
          targetAgent: data.target_agent,
          trackedMessageId: sentId,
        },
        'Share request forwarded',
      );
      break;
    }

    case 'delegate_task':
    case 'context_request': {
      if (!data.description) {
        logger.warn({ data }, `${data.type} missing description`);
        break;
      }

      const sourceGroupEntry = findGroupByFolder(registeredGroups, sourceGroup);
      const sourceName = sourceGroupEntry?.[1].name || sourceGroup;
      const sourceJid = sourceGroupEntry?.[0] || sourceGroup;

      const mainJid = findMainGroupJid(registeredGroups);
      if (!mainJid) {
        logger.warn(`${data.type}: could not find main group JID`);
        break;
      }

      let label: string;
      let extraInfo: string;
      let trackedDescription: string;
      if (data.type === 'delegate_task') {
        const callbackAgent = data.callbackAgentId || sourceGroup;
        label = 'Task Request';
        extraInfo = data.files?.length
          ? `\n\n*Files included:* ${data.files.join(', ')}`
          : '';
        trackedDescription = `[DELEGATE TASK] ${data.description}\n\nCallback agent: ${callbackAgent}`;
      } else {
        label = 'Context Request';
        extraInfo = data.requestedTopics?.length
          ? `\n\n*Requested topics:* ${data.requestedTopics.join(', ')}`
          : '';
        trackedDescription = `[CONTEXT REQUEST] ${data.description}${data.requestedTopics?.length ? `\nTopics: ${data.requestedTopics.join(', ')}` : ''}`;
      }

      const requestMsg = `*${label}* from _${sourceName}_ (${sourceJid}):\n\n${data.description}${extraInfo}\n\n_React 👍 to approve, or reply manually._`;
      const sentId = await deps.sendMessage(mainJid, requestMsg);

      if (sentId) {
        trackShareRequest(sentId, {
          sourceJid,
          sourceName,
          sourceGroup,
          description: trackedDescription,
          serverFolder: undefined,
          timestamp: Date.now(),
        });
      }

      logger.info(
        { sourceGroup, description: data.description.slice(0, 100) },
        `${label} forwarded for approval`,
      );
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
