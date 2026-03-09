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

  // ---- Context file operations ----
  /** Read a context file (CLAUDE.md) for a given layer path. Returns null if not found. */
  readContextFile(layerPath: string): string | null;
  /** Write a context file (CLAUDE.md) for a given layer path. Creates directories as needed. */
  writeContextFile(layerPath: string, content: string): void;

  // ---- Avatar operations ----
  /** Update an agent's avatar URL and source. */
  updateAgentAvatar(
    agentId: string,
    url: string | null,
    source: string | null,
  ): void;
  /** Resolve a platform-backed icon for a specific chat/channel JID. */
  resolveChatImage?(chatJid: string): Promise<string | null>;
  /** Resolve a Discord guild/server icon, optionally through a specific bot. */
  resolveDiscordGuildImage?(
    guildId: string,
    botId?: string,
  ): Promise<string | null>;
}

export interface QueueStats {
  activeContainers: number;
  idleContainers: number;
  maxActive: number;
  maxIdle: number;
}

export interface WebServerConfig {
  port: number;
  /** Basic auth credentials. If unset, HTTP auth is disabled. */
  auth?: { username: string; password: string };
  /** Bind hostname. Defaults to '127.0.0.1' (loopback only). */
  hostname?: string;
  /** Allowed CORS origin. If unset, no CORS headers are sent. */
  corsOrigin?: string;
}

export type WsEventType =
  | 'agent_status'
  | 'task_update'
  | 'log'
  | 'ipc_event'
  | 'peer_discovered'
  | 'peer_lost'
  | 'pair_request'
  | 'pair_approved';

export interface WsEvent {
  type: WsEventType;
  data: unknown;
  timestamp: string;
}
