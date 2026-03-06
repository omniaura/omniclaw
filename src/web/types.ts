import type { Agent, ChannelSubscription, ScheduledTask } from '../types.js';

/**
 * State provider interface — the web server reads orchestrator state
 * through this interface instead of importing globals directly.
 */
export interface WebStateProvider {
  getAgents(): Record<string, Agent>;
  getChannelSubscriptions(): Record<string, ChannelSubscription[]>;
  getTasks(): ScheduledTask[];
  getTaskById(id: string): ScheduledTask | undefined;
  getMessages(
    chatJid: string,
    sinceTimestamp: string,
    limit?: number,
  ): Array<{
    id: string;
    chat_jid: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
  }>;
  getChats(): Array<{
    jid: string;
    name: string;
    last_message_time: string;
  }>;
  /** Live queue stats from GroupQueue. */
  getQueueStats(): QueueStats;

  // ---- Task mutations ----
  createTask(task: Omit<ScheduledTask, 'last_run' | 'last_result'>): void;
  updateTask(
    id: string,
    updates: Partial<
      Pick<
        ScheduledTask,
        'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
      >
    >,
  ): void;
  deleteTask(id: string): void;
  /** Calculate the next run time for a schedule. Returns null on invalid input. */
  calculateNextRun(
    scheduleType: 'cron' | 'interval' | 'once',
    scheduleValue: string,
  ): string | null;

  // ---- Context file operations ----
  /** Read a context file (CLAUDE.md) for a given layer path. Returns null if not found. */
  readContextFile(layerPath: string): string | null;
  /** Write a context file (CLAUDE.md) for a given layer path. Creates directories as needed. */
  writeContextFile(layerPath: string, content: string): void;
}

export interface QueueStats {
  activeContainers: number;
  idleContainers: number;
  maxActive: number;
  maxIdle: number;
}

export interface WebServerConfig {
  port: number;
  /** Basic auth credentials. If unset, auth is disabled (dev mode). */
  auth?: { username: string; password: string };
}

/** Shape of a WebSocket data attachment. */
export interface WsData {
  /** Channels the client is subscribed to for live events. */
  subscriptions: Set<string>;
}

export type WsEventType = 'agent_status' | 'task_update' | 'log';

export interface WsEvent {
  type: WsEventType;
  data: unknown;
  timestamp: string;
}
