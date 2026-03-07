import type { Agent, ChannelSubscription, ScheduledTask } from '../types.js';
import type { GroupQueueDetail } from '../group-queue.js';
import type { IpcEvent } from './ipc-events.js';

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
  /** Per-group queue details for the IPC inspector. */
  getQueueDetails(): GroupQueueDetail[];
  /** Recent IPC events from the event buffer. */
  getIpcEvents(count?: number): IpcEvent[];

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

export type WsEventType = 'agent_status' | 'task_update' | 'log' | 'ipc_event';

export interface WsEvent {
  type: WsEventType;
  data: unknown;
  timestamp: string;
}
