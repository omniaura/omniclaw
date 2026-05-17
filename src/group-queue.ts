import fs from 'fs';
import path from 'path';
import { Effect, Layer } from 'effect';

import type { AgentBackend } from './backends/types.js';
import {
  DATA_DIR,
  MAX_ACTIVE_CONTAINERS,
  MAX_IDLE_CONTAINERS,
  MAX_TASK_CONTAINERS,
} from './config.js';
import { OmniClawLoggerLayer } from './effect/logger-layer.js';
import { logger } from './logger.js';
import { ContainerProcess } from './types.js';
import {
  makeMessageQueue,
  type MessageQueueService,
} from './effect/message-queue.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
  promptPreview: string;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

export type Lane = 'message' | 'task';
type MessageLaneState = 'idle' | 'running' | 'cooldown';

/**
 * Structured reason code describing why a message lane is in its current state.
 *
 * - `running`: actively processing a message
 * - `cooling-down`: container kept warm, ready to reuse
 * - `back-pressure`: messages pending but waiting for container capacity
 * - `retrying`: backing off after a recent failure (retryCount > 0)
 * - `no-work`: no pending messages, no container
 */
export type MessageLaneReason =
  | 'running'
  | 'cooling-down'
  | 'back-pressure'
  | 'retrying'
  | 'no-work';

/**
 * Structured reason code describing why a task lane is in its current state.
 *
 * - `running`: actively executing a scheduled task
 * - `back-pressure`: pending tasks but waiting for task-container capacity
 * - `no-work`: no pending tasks, no task running
 */
export type TaskLaneReason = 'running' | 'back-pressure' | 'no-work';

export interface GroupQueueDetail {
  folderKey: string;
  messageLane: {
    active: boolean;
    idle: boolean;
    pendingCount: number;
    containerName: string | null;
    /**
     * Structured reason for the current lane state (operator diagnostics).
     * Optional for backward compatibility with older fixtures; the orchestrator
     * always populates this field. Consumers should fall back to
     * {@link deriveMessageLaneReasonFromDetail} when missing.
     */
    reason?: MessageLaneReason;
    /**
     * Epoch ms when the current message run started. Null when the lane is
     * idle (cooldown or no work). Operators use this with {@link runningMs}
     * to spot stuck or long-running message runs.
     */
    startedAt?: number | null;
    /**
     * Milliseconds elapsed since the current message run started. Null when
     * the lane is idle. Derived as `Date.now() - startedAt` in
     * {@link GroupQueue.getDetailedStats}.
     */
    runningMs?: number | null;
  };
  taskLane: {
    active: boolean;
    pendingCount: number;
    containerName: string | null;
    activeTask: {
      taskId: string;
      promptPreview: string;
      startedAt: number;
      runningMs: number;
    } | null;
    /**
     * Structured reason for the current lane state (operator diagnostics).
     * Optional for backward compatibility with older fixtures; the orchestrator
     * always populates this field. Consumers should fall back to
     * {@link deriveTaskLaneReasonFromDetail} when missing.
     */
    reason?: TaskLaneReason;
  };
  retryCount: number;
}

/** Resolve a message lane reason from a detail snapshot, deriving if absent. */
export function deriveMessageLaneReasonFromDetail(
  detail: GroupQueueDetail,
): MessageLaneReason {
  if (detail.messageLane.reason) return detail.messageLane.reason;
  // Map the legacy active/idle booleans back to the raw lane state.
  let laneState: 'idle' | 'running' | 'cooldown';
  if (detail.messageLane.idle) laneState = 'cooldown';
  else if (detail.messageLane.active) laneState = 'running';
  else laneState = 'idle';
  return deriveMessageLaneReason({
    laneState,
    pendingCount: detail.messageLane.pendingCount,
    retryCount: detail.retryCount,
  });
}

/** Resolve a task lane reason from a detail snapshot, deriving if absent. */
export function deriveTaskLaneReasonFromDetail(
  detail: GroupQueueDetail,
): TaskLaneReason {
  if (detail.taskLane.reason) return detail.taskLane.reason;
  return deriveTaskLaneReason({
    active: detail.taskLane.active,
    pendingCount: detail.taskLane.pendingCount,
  });
}

/** Derive a structured reason code for a message lane from raw state. */
export function deriveMessageLaneReason(input: {
  laneState: 'idle' | 'running' | 'cooldown';
  pendingCount: number;
  retryCount: number;
}): MessageLaneReason {
  if (input.laneState === 'running') return 'running';
  if (input.laneState === 'cooldown') return 'cooling-down';
  // laneState === 'idle' from here on
  if (input.retryCount > 0) return 'retrying';
  if (input.pendingCount > 0) return 'back-pressure';
  return 'no-work';
}

/** Derive a structured reason code for a task lane from raw state. */
export function deriveTaskLaneReason(input: {
  active: boolean;
  pendingCount: number;
}): TaskLaneReason {
  if (input.active) return 'running';
  if (input.pendingCount > 0) return 'back-pressure';
  return 'no-work';
}

interface ActiveTaskInfo {
  taskId: string;
  promptPreview: string;
  startedAt: number;
}

interface GroupState {
  // Message lane
  messageLaneState: MessageLaneState;
  /** JIDs with pending messages. Multiple JIDs can share one GroupState (folder). */
  pendingMessageJids: string[];
  messageProcess: ContainerProcess | null;
  messageContainerName: string | null;
  messageGroupFolder: string | null;
  messageBackend: AgentBackend | null;
  /** Epoch ms when the current message run started; null when idle. */
  messageRunStartedAt: number | null;
  retryCount: number;

  // Task lane
  taskActive: boolean;
  pendingTasks: QueuedTask[];
  taskProcess: ContainerProcess | null;
  taskContainerName: string | null;
  taskGroupFolder: string | null;
  taskBackend: AgentBackend | null;

  // Tracking for context injection
  activeTaskInfo: ActiveTaskInfo | null;
}

interface StartMessageRunResult {
  started: boolean;
  processingCount: number;
}

function toChannelJid(jid: string): string {
  const marker = '::agent::';
  const idx = jid.indexOf(marker);
  return idx >= 0 ? jid.slice(0, idx) : jid;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0; // total live containers (processing + idle)
  private idleCount = 0; // subset of activeCount that are idle-waiting
  private idleGroups: string[] = []; // folderKeys of idle containers, oldest first
  private activeTaskCount = 0;
  private waitingMessageGroups: string[] = [];
  private waitingTaskGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;
  private effectQueue: MessageQueueService | null = null;
  private readonly dataDir: string;
  private readonly maxActiveContainers: number;
  private readonly maxIdleContainers: number;
  private readonly maxTaskContainers: number;
  private readonly fsImpl: Pick<
    typeof fs,
    'mkdirSync' | 'writeFileSync' | 'renameSync'
  >;

  // JID→folder mapping: multiple JIDs can share one folder (agent)
  private jidToFolder = new Map<string, string>();

  constructor(
    options: {
      dataDir?: string;
      maxActiveContainers?: number;
      maxIdleContainers?: number;
      maxTaskContainers?: number;
      fsImpl?: Pick<typeof fs, 'mkdirSync' | 'writeFileSync' | 'renameSync'>;
    } = {},
  ) {
    this.dataDir = options.dataDir ?? DATA_DIR;
    this.maxActiveContainers =
      options.maxActiveContainers ?? MAX_ACTIVE_CONTAINERS;
    this.maxIdleContainers = options.maxIdleContainers ?? MAX_IDLE_CONTAINERS;
    this.maxTaskContainers = options.maxTaskContainers ?? MAX_TASK_CONTAINERS;
    this.fsImpl = options.fsImpl ?? fs;

    // Initialize Effect-based message queue
    Effect.runPromise(
      makeMessageQueue().pipe(Effect.provide(OmniClawLoggerLayer)),
    )
      .then((queue) => {
        this.effectQueue = queue;
        logger.info('Effect-based message queue initialized');
      })
      .catch((err) => {
        logger.error({ err }, 'Failed to initialize Effect message queue');
      });
  }

  /**
   * Register a JID→folder mapping so multiple JIDs share one GroupState.
   */
  registerJidMapping(jid: string, folder: string): void {
    this.jidToFolder.set(jid, folder);
  }

  /**
   * Resolve a JID to its folder key for GroupState lookup.
   * Falls back to the JID itself for backwards compatibility.
   */
  private resolveFolder(jid: string): string {
    return this.jidToFolder.get(jid) || jid;
  }

  private getGroup(groupJid: string): GroupState {
    const key = this.resolveFolder(groupJid);
    let state = this.groups.get(key);
    if (!state) {
      state = {
        messageLaneState: 'idle',
        pendingMessageJids: [],
        messageProcess: null,
        messageContainerName: null,
        messageGroupFolder: null,
        messageBackend: null,
        messageRunStartedAt: null,
        retryCount: 0,

        taskActive: false,
        pendingTasks: [],
        taskProcess: null,
        taskContainerName: null,
        taskGroupFolder: null,
        taskBackend: null,

        activeTaskInfo: null,
      };
      this.groups.set(key, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  private queuePendingMessage(
    groupJid: string,
    addToWaitingList = false,
  ): void {
    const state = this.getGroup(groupJid);
    if (!state.pendingMessageJids.includes(groupJid)) {
      state.pendingMessageJids.push(groupJid);
    }
    if (addToWaitingList && !this.waitingMessageGroups.includes(groupJid)) {
      this.waitingMessageGroups.push(groupJid);
    }
  }

  private dequeuePendingMessage(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.pendingMessageJids = state.pendingMessageJids.filter(
      (jid) => jid !== groupJid,
    );
    this.waitingMessageGroups = this.waitingMessageGroups.filter(
      (jid) => jid !== groupJid,
    );
  }

  private startMessageRun(groupJid: string): StartMessageRunResult {
    const state = this.getGroup(groupJid);
    const processingCount = this.activeCount - this.idleCount;
    if (state.messageLaneState !== 'idle') {
      return { started: false, processingCount };
    }

    this.transitionMessageLaneState(groupJid, 'running');
    state.messageRunStartedAt = Date.now();
    this.dequeuePendingMessage(groupJid);
    this.activeCount++;
    return { started: true, processingCount };
  }

  private finishMessageRun(groupJid: string): void {
    const state = this.getGroup(groupJid);
    this.transitionMessageLaneState(groupJid, 'idle');
    state.messageProcess = null;
    state.messageContainerName = null;
    state.messageGroupFolder = null;
    state.messageBackend = null;
    state.messageRunStartedAt = null;
    this.activeCount--;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) {
      logger.info({ groupJid }, 'enqueueMessageCheck: shutting down, skipping');
      return;
    }

    const folderKey = this.resolveFolder(groupJid);
    const state = this.getGroup(groupJid);

    // Only check the message lane — task lane is independent
    if (state.messageLaneState !== 'idle') {
      this.queuePendingMessage(groupJid);
      logger.info(
        { groupJid, folderKey },
        'Message container active, message queued',
      );
      return;
    }

    const processingCount = this.activeCount - this.idleCount;
    if (processingCount >= this.maxActiveContainers) {
      // Proactively preempt the oldest idle container to free a slot sooner.
      if (this.idleGroups.length > 0) {
        const oldest = this.idleGroups[0];
        logger.info(
          { groupJid, folderKey, preempting: oldest },
          'Preempting oldest idle container to free processing slot',
        );
        this._closeIdleContainer(oldest);
      }
      this.queuePendingMessage(groupJid, true);
      logger.info(
        { groupJid, folderKey, processingCount, activeCount: this.activeCount },
        'At active container limit, message queued',
      );
      return;
    }

    logger.info(
      {
        groupJid,
        folderKey,
        processingCount: this.activeCount - this.idleCount,
        activeCount: this.activeCount,
      },
      'Launching container for group',
    );
    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(
    groupJid: string,
    taskId: string,
    fn: () => Promise<void>,
    promptPreview: string = '',
  ): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing of the same task (check both running and pending)
    if (state.activeTaskInfo?.taskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    // If task lane is already active for this group, queue the task
    if (state.taskActive) {
      state.pendingTasks.push({ id: taskId, groupJid, fn, promptPreview });
      logger.debug({ groupJid, taskId }, 'Task container active, task queued');
      return;
    }

    // Check both global limit and task-specific limit
    if (
      this.activeCount - this.idleCount >= this.maxActiveContainers ||
      this.activeTaskCount >= this.maxTaskContainers
    ) {
      state.pendingTasks.push({ id: taskId, groupJid, fn, promptPreview });
      // If the message container is idle, preempt it to free a slot
      if (state.messageLaneState === 'cooldown') {
        logger.info(
          { groupJid, taskId },
          'Preempting idle message container for task',
        );
        this.closeStdin(groupJid, 'message');
      }
      if (!this.waitingTaskGroups.includes(groupJid)) {
        this.waitingTaskGroups.push(groupJid);
      }
      logger.debug(
        {
          groupJid,
          taskId,
          activeCount: this.activeCount,
          activeTaskCount: this.activeTaskCount,
        },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately — but if message container is idle, preempt it too
    // (frees a global slot for the task to use)
    if (state.messageLaneState === 'cooldown') {
      logger.info(
        { groupJid, taskId },
        'Preempting idle message container for task',
      );
      this.closeStdin(groupJid, 'message');
    }
    this.runTask(groupJid, { id: taskId, groupJid, fn, promptPreview }).catch(
      (err) =>
        logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ContainerProcess,
    containerName: string,
    groupFolder?: string,
    backend?: AgentBackend,
    lane: Lane = 'message',
  ): void {
    const state = this.getGroup(groupJid);
    if (lane === 'message') {
      state.messageProcess = proc;
      state.messageContainerName = containerName;
      if (groupFolder) state.messageGroupFolder = groupFolder;
      if (backend) {
        state.messageBackend = backend;
        // Register backend with Effect queue
        if (this.effectQueue && groupFolder) {
          Effect.runPromise(
            this.effectQueue.registerBackend(groupJid, backend, groupFolder),
          ).catch((err) => {
            logger.error(
              { groupJid, err },
              'Failed to register backend with Effect queue',
            );
          });
        }
      }
    } else {
      state.taskProcess = proc;
      state.taskContainerName = containerName;
      if (groupFolder) state.taskGroupFolder = groupFolder;
      if (backend) state.taskBackend = backend;
    }
  }

  /**
   * Mark the message container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   * [Upstream PR #354] - Prevents scheduled task deadlocks.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    const folderKey = this.resolveFolder(groupJid);

    // Guard against duplicate idle notifications from the same container.
    // The IPC stream can emit multiple 'success' statuses during a container's
    // lifetime (idle → woken → idle again), each calling notifyIdle. Without
    // this guard, idleCount drifts up because the cooldown->running/idle transition
    // only decrements once, causing negative "active containers"
    // in the dashboard.
    if (state.messageLaneState === 'cooldown') {
      logger.debug(
        { groupJid, folderKey },
        'notifyIdle: already idle, skipping duplicate',
      );
      return;
    }

    this.transitionMessageLaneState(groupJid, 'cooldown');
    // Clear the run timer when entering cooldown so /ipc doesn't show a
    // growing "running age" while the lane is actually idle-waiting.
    state.messageRunStartedAt = null;

    // A processing slot just freed up — let waiting messages start.
    this.drainWaitingMessages();

    // Pending tasks for this group? Preempt immediately.
    if (state.pendingTasks.length > 0) {
      logger.info(
        { groupJid },
        'Idle container preempted: pending tasks found',
      );
      this._closeIdleContainer(groupJid);
      return;
    }

    // Over idle limit? Preempt the oldest idle container.
    if (this.idleCount > this.maxIdleContainers) {
      const oldest = this.idleGroups.shift()!;
      logger.info(
        { oldest, idleCount: this.idleCount, maxIdle: this.maxIdleContainers },
        'Idle limit exceeded, preempting oldest idle container',
      );
      this._closeIdleContainer(oldest);
    }
  }

  /**
   * Atomically clear the idle-waiting state for a group.
   * No-op if the group is not currently idle.
   * All idle-count bookkeeping goes through this single method to prevent
   * drift from multiple callers decrementing independently.
   */
  private transitionMessageLaneState(
    groupJidOrFolder: string,
    nextState: MessageLaneState,
  ): boolean {
    const folderKey = this.resolveFolder(groupJidOrFolder);
    const state = this.groups.get(folderKey);
    if (!state || state.messageLaneState === nextState) return false;

    const wasCooldown = state.messageLaneState === 'cooldown';
    const willCooldown = nextState === 'cooldown';

    if (wasCooldown && !willCooldown) {
      this.idleCount = Math.max(0, this.idleCount - 1);
      this.idleGroups = this.idleGroups.filter((k) => k !== folderKey);
    }

    state.messageLaneState = nextState;

    if (!wasCooldown && willCooldown) {
      this.idleCount++;
      if (!this.idleGroups.includes(folderKey)) {
        this.idleGroups.push(folderKey);
      }
    }

    return true;
  }

  /** Close an idle container and update idle tracking. */
  private _closeIdleContainer(groupJidOrFolder: string): void {
    this.transitionMessageLaneState(groupJidOrFolder, 'running');
    this.closeStdin(groupJidOrFolder, 'message');
  }

  /**
   * Send a follow-up message to the active message container via IPC.
   * Delegates to the backend if one is registered (supports local + cloud).
   * Returns true if the message was written, false if no active container.
   *
   * chatJid is included in the piped message so the container can route
   * responses to the correct channel when the agent has multiple routes.
   *
   * Now uses Effect-based queue for automatic retries and timeout protection.
   */
  async sendMessage(chatJid: string, text: string): Promise<boolean> {
    const state = this.getGroup(chatJid);
    if (state.messageLaneState === 'idle' || !state.messageGroupFolder) {
      return false;
    }
    // Container was idle — mark it active again (single-method bookkeeping).
    // Only restamp the run timer on a real cooldown → running transition;
    // follow-up sendMessage() calls while already running must NOT reset
    // messageRunStartedAt, otherwise long-running/stuck runs get underreported
    // on /ipc every time a new message arrives.
    const resumed = this.transitionMessageLaneState(chatJid, 'running');
    if (resumed) {
      state.messageRunStartedAt = Date.now();
    }
    const channelJid = toChannelJid(chatJid);

    // Use Effect-based queue if available
    if (this.effectQueue && state.messageBackend) {
      try {
        await Effect.runPromise(
          this.effectQueue.sendMessage(
            chatJid,
            text,
            state.messageBackend,
            state.messageGroupFolder,
            channelJid,
          ),
        );
        return true;
      } catch (err) {
        logger.error(
          { chatJid, error: err },
          'Effect message send failed after retries, falling back to direct send',
        );
        // Fall through to backup methods
      }
    }

    // Fallback: delegate to backend directly
    if (state.messageBackend) {
      return state.messageBackend.sendMessage(state.messageGroupFolder, text, {
        chatJid: channelJid,
      });
    }

    // Fallback: direct local filesystem write
    const inputDir = path.join(
      this.dataDir,
      'ipc',
      state.messageGroupFolder,
      'input',
    );
    try {
      this.fsImpl.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      this.fsImpl.writeFileSync(
        tempPath,
        JSON.stringify({ type: 'message', text, chatJid: channelJid }),
      );
      this.fsImpl.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container on a specific lane to wind down.
   * Delegates to the backend if one is registered.
   */
  closeStdin(groupJid: string, lane: Lane = 'message'): void {
    const state = this.getGroup(groupJid);

    const active =
      lane === 'message' ? state.messageLaneState !== 'idle' : state.taskActive;
    const groupFolder =
      lane === 'message' ? state.messageGroupFolder : state.taskGroupFolder;
    const backend =
      lane === 'message' ? state.messageBackend : state.taskBackend;

    if (!active || !groupFolder) return;

    // Delegate to backend if available
    if (backend) {
      const inputSubdir = lane === 'task' ? 'input-task' : 'input';
      backend.closeStdin(groupFolder, inputSubdir);
      return;
    }

    // Fallback: direct local filesystem write — atomic shutdown IPC message
    const inputSubdir = lane === 'task' ? 'input-task' : 'input';
    const inputDir = path.join(this.dataDir, 'ipc', groupFolder, inputSubdir);
    try {
      this.fsImpl.mkdirSync(inputDir, { recursive: true });
      const filename = `_shutdown-${Date.now()}.json`;
      const filePath = path.join(inputDir, filename);
      const tempPath = `${filePath}.tmp`;
      this.fsImpl.writeFileSync(tempPath, JSON.stringify({ type: 'shutdown' }));
      this.fsImpl.renameSync(tempPath, filePath);
    } catch {
      // ignore
    }
  }

  /**
   * Get info about the currently running task for a group.
   * Used for context injection into message prompts.
   */
  getActiveTaskInfo(groupJid: string): ActiveTaskInfo | null {
    const folderKey = this.resolveFolder(groupJid);
    const state = this.groups.get(folderKey);
    return state?.activeTaskInfo ?? null;
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const start = this.startMessageRun(groupJid);
    if (!start.started) {
      const state = this.getGroup(groupJid);
      logger.debug(
        { groupJid, reason, laneState: state.messageLaneState },
        'Skipping duplicate message dispatch start',
      );
      return;
    }
    await this.runStartedMessageGroup(groupJid, reason);
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.taskActive = true;
    state.activeTaskInfo = {
      taskId: task.id,
      promptPreview: task.promptPreview,
      startedAt: Date.now(),
    };
    this.activeCount++;
    this.activeTaskCount++;

    logger.debug(
      {
        groupJid,
        taskId: task.id,
        activeCount: this.activeCount,
        activeTaskCount: this.activeTaskCount,
      },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.taskActive = false;
      state.activeTaskInfo = null;
      state.taskProcess = null;
      state.taskContainerName = null;
      state.taskGroupFolder = null;
      state.taskBackend = null;
      this.activeCount--;
      this.activeTaskCount--;
      this.drainTaskLane(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  /** Drain pending messages for a group's message lane, then try other waiting groups. */
  private drainMessageLane(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);
    if (state.pendingMessageJids.length > 0) {
      // Process the first pending JID (may differ from the JID that launched the container)
      const nextJid = state.pendingMessageJids[0];
      this.runForGroup(nextJid, 'drain').catch((err) =>
        logger.error(
          { groupJid: nextJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      // A global slot was freed and immediately re-used; also try draining waiting tasks
      this.drainWaitingTasks();
      return;
    }

    // Nothing pending for this group; a global slot freed up — drain both waiting lists
    this.drainWaitingMessages();
    this.drainWaitingTasks();
  }

  /** Drain pending tasks for a group's task lane, then try other waiting groups. */
  private drainTaskLane(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);
    if (state.pendingTasks.length > 0) {
      // Check task concurrency limits before starting next task
      if (
        this.activeCount - this.idleCount < this.maxActiveContainers &&
        this.activeTaskCount < this.maxTaskContainers
      ) {
        const task = state.pendingTasks.shift()!;
        this.runTask(groupJid, task).catch((err) =>
          logger.error(
            { groupJid, taskId: task.id, err },
            'Unhandled error in runTask (drain)',
          ),
        );
        // A global slot was freed and immediately re-used; also try draining waiting messages
        this.drainWaitingMessages();
        return;
      }
      // Can't run now — put back in waiting list
      if (!this.waitingTaskGroups.includes(groupJid)) {
        this.waitingTaskGroups.push(groupJid);
      }
      return;
    }

    // Nothing pending for this group; a global slot freed up — drain both waiting lists
    this.drainWaitingMessages();
    this.drainWaitingTasks();
  }

  private drainWaitingMessages(): void {
    while (
      this.waitingMessageGroups.length > 0 &&
      this.activeCount - this.idleCount < this.maxActiveContainers
    ) {
      const nextJid = this.waitingMessageGroups.shift()!;
      const state = this.getGroup(nextJid);

      if (state.pendingMessageJids.length > 0) {
        const jidToProcess = state.pendingMessageJids[0];
        this.runForGroup(jidToProcess, 'drain').catch((err) =>
          logger.error(
            { groupJid: jidToProcess, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
    }
  }

  private async runStartedMessageGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting message container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      this.finishMessageRun(groupJid);
      this.drainMessageLane(groupJid);
    }
  }

  private drainWaitingTasks(): void {
    while (
      this.waitingTaskGroups.length > 0 &&
      this.activeCount - this.idleCount < this.maxActiveContainers &&
      this.activeTaskCount < this.maxTaskContainers
    ) {
      const nextJid = this.waitingTaskGroups.shift()!;
      const state = this.getGroup(nextJid);

      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      }
    }
  }

  /** Check if a specific lane is active for a group. */
  isActive(key: string, lane?: Lane): boolean {
    const folderKey = this.resolveFolder(key);
    const state = this.groups.get(folderKey);
    if (!state) return false;
    if (lane === 'message') return state.messageLaneState !== 'idle';
    if (lane === 'task') return state.taskActive;
    // No lane specified: return true if either lane is active
    return state.messageLaneState !== 'idle' || state.taskActive;
  }

  /** Return a snapshot of queue concurrency stats (for the web UI). */
  getStats(): {
    activeContainers: number;
    idleContainers: number;
    maxActive: number;
    maxIdle: number;
  } {
    return {
      activeContainers: this.activeCount,
      idleContainers: this.idleCount,
      maxActive: this.maxActiveContainers,
      maxIdle: this.maxIdleContainers,
    };
  }

  /** Return per-group queue state for the IPC inspector. */
  getDetailedStats(): GroupQueueDetail[] {
    const details: GroupQueueDetail[] = [];
    for (const [folderKey, state] of this.groups) {
      const messageReason = deriveMessageLaneReason({
        laneState: state.messageLaneState,
        pendingCount: state.pendingMessageJids.length,
        retryCount: state.retryCount,
      });
      const taskReason = deriveTaskLaneReason({
        active: state.taskActive,
        pendingCount: state.pendingTasks.length,
      });
      details.push({
        folderKey,
        messageLane: {
          active: state.messageLaneState !== 'idle',
          idle: state.messageLaneState === 'cooldown',
          pendingCount: state.pendingMessageJids.length,
          containerName: state.messageContainerName,
          reason: messageReason,
          startedAt: state.messageRunStartedAt,
          runningMs:
            state.messageRunStartedAt !== null
              ? Date.now() - state.messageRunStartedAt
              : null,
        },
        taskLane: {
          active: state.taskActive,
          pendingCount: state.pendingTasks.length,
          containerName: state.taskContainerName,
          activeTask: state.activeTaskInfo
            ? {
                taskId: state.activeTaskInfo.taskId,
                promptPreview: state.activeTaskInfo.promptPreview,
                startedAt: state.activeTaskInfo.startedAt,
                runningMs: Date.now() - state.activeTaskInfo.startedAt,
              }
            : null,
          reason: taskReason,
        },
        retryCount: state.retryCount,
      });
    }
    return details;
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    const activeContainers: string[] = [];
    for (const [jid, state] of this.groups) {
      if (
        state.messageProcess &&
        !state.messageProcess.killed &&
        state.messageContainerName
      ) {
        activeContainers.push(state.messageContainerName);
      }
      if (
        state.taskProcess &&
        !state.taskProcess.killed &&
        state.taskContainerName
      ) {
        activeContainers.push(state.taskContainerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
