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
