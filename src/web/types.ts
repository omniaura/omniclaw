import type {
  Agent,
  ChannelSubscription,
  ScheduledTask,
  TaskRunLog,
  TaskRunPhaseEvent,
} from '../types.js';
import type { GroupQueueDetail } from '../group-queue.js';
import type { IpcEvent } from './ipc-events.js';
import type { RemoteImageFetch } from './image-cache.js';

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
  /**
   * Per-chat message count over the trailing 24h window, keyed by chat_jid.
   * Chats with zero recent messages may be omitted. Optional so lightweight
   * test stubs can keep compiling — callers fall back to "no data" when the
   * method is absent.
   */
  getChat24hMessageCounts?(): Map<string, number>;
  /** Live queue stats from GroupQueue. */
  getQueueStats(): QueueStats;
  /** Per-group queue details for the IPC inspector. */
  getQueueDetails(): GroupQueueDetail[];
  /** Recent IPC events from the event buffer. */
  getIpcEvents(count?: number): IpcEvent[];
  /** Execution history for a specific task. */
  getTaskRunLogs(taskId: string, limit?: number): TaskRunLog[];
  /** Phase events for a specific task run (identified by taskId + run_at timestamp). */
  getTaskRunPhaseEvents(taskId: string, runAt: string): TaskRunPhaseEvent[];
  /**
   * Aggregate task run outcomes since the given ISO timestamp. Used by the
   * /system page to roll up recent task outcomes (success/error counts and
   * outcome-state breakdown) without drilling into individual tasks. Optional
   * so the existing FakeState and test stubs continue to compile; when absent,
   * the /system page renders zeroes for the rollup.
   */
  getRecentTaskOutcomes?(sinceIso: string): RecentTaskOutcomes;
  /** Search messages by content with optional filters. */
  searchMessages(
    query: string,
    chatJid?: string,
    limit?: number,
    filters?: { fromDate?: string; toDate?: string; sender?: string },
  ): Array<{
    id: string;
    chat_jid: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
  }>;

  // ---- Task mutations ----
  createTask(
    task: Omit<ScheduledTask, 'last_run' | 'last_result' | 'executing_since'>,
  ): void;
  updateTask(
    id: string,
    updates: Partial<
      Pick<
        ScheduledTask,
        | 'prompt'
        | 'preprocess_script'
        | 'schedule_type'
        | 'schedule_value'
        | 'next_run'
        | 'status'
        | 'context_mode'
      >
    >,
  ): void;
  deleteTask(id: string): void;
  /**
   * Trigger a scheduled task to run immediately, bypassing its schedule.
   * Returns ok=false with a reason when the task is missing or in a
   * non-runnable state (e.g. completed/cancelled).
   */
  runTaskNow?(id: string): {
    ok: boolean;
    reason?: 'not_found' | 'invalid_state';
  };
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

  // ---- Message injection ----
  /**
   * Inject a message into a channel and trigger agent processing.
   * Returns the stored message ID.
   */
  sendMessage?(
    agentId: string,
    chatJid: string,
    content: string,
    senderName?: string,
  ): string;

  // ---- Avatar operations ----
  /** Update an agent's avatar URL and source. */
  updateAgentAvatar(
    agentId: string,
    url: string | null,
    source: string | null,
  ): void;

  /**
   * Snapshot of LAN discovery / peer trust state for the /system rollup.
   * Optional so test stubs and lightweight providers can omit it; when
   * unimplemented the /system page renders zeros for the peers tile.
   */
  getPeerHealth?(): PeerHealthSnapshot;

  // ---- Agent on/off switch ----
  /**
   * Toggle whether the agent is enabled. When disabled, the orchestrator
   * skips message dispatch and scheduled task execution for this agent.
   * Returns true if the agent was found and updated.
   */
  setAgentEnabled(agentId: string, enabled: boolean): boolean;
  /**
   * Update the per-agent model override. Pass null/empty to clear and fall
   * back to the host .env value or runtime default. Returns true if the
   * agent was found and updated.
   */
  setAgentModel(agentId: string, model: string | null): boolean;
  /** Resolve a platform-backed icon for a specific chat/channel JID. */
  resolveChatImage?(chatJid: string): Promise<string | null>;
  /** Resolve a stored agent avatar reference to a fetchable URL. */
  resolveAgentAvatarUrl?(
    agentId: string,
    avatarUrl: string,
    avatarSource?: Agent['avatarSource'],
  ): Promise<string | null>;
  /** Resolve a Discord guild/server icon, optionally through a specific bot. */
  resolveDiscordGuildImage?(
    guildId: string,
    botId?: string,
  ): Promise<string | null>;
  /** Optional per-request remote image fetch override, primarily for tests. */
  fetchRemoteImage?: RemoteImageFetch;
  /** Optional per-request cache directory override for remote images. */
  remoteImageCacheDir?: string;
}

export interface QueueStats {
  activeContainers: number;
  idleContainers: number;
  maxActive: number;
  maxIdle: number;
}

/**
 * Aggregate of recent task run outcomes. Buckets cover the success/error split
 * from `task_run_logs.status` and the agent-reported outcome state
 * (done/blocked/abandoned) from `task_run_logs.outcome_state`. Runs with no
 * outcome state recorded fall into `unknown`.
 */
export interface RecentTaskOutcomes {
  total: number;
  success: number;
  error: number;
  by_outcome_state: {
    done: number;
    blocked: number;
    abandoned: number;
    unknown: number;
  };
}

/**
 * Aggregate LAN peer health used by the /system peers tile. Mirrors the
 * status taxonomy on the /network page so the two surfaces agree.
 *
 * `trusted_offline` is broken out because a trusted peer that is offline
 * is the most operationally interesting case — sync, browse, and remote
 * logs all silently fail against it.
 */
export interface PeerHealthSnapshot {
  /** True when discovery is configured in this build (env / capability). */
  discovery_available: boolean;
  /** True when the discovery runtime is actually broadcasting/listening. */
  discovery_active: boolean;
  /** Total peers known across discovered + stored (excludes revoked). */
  total: number;
  /** Peers currently visible on the network (discovered this session). */
  online: number;
  /** Peers whose trust status is `trusted`. */
  trusted: number;
  /** Trusted peers that are not currently online. */
  trusted_offline: number;
  /** Inbound pair requests awaiting admin approval. */
  pending_requests: number;
  /** Count of peers by `PeerStatus`. Always carries all keys (zero default). */
  by_status: {
    discovered: number;
    pending: number;
    trusted: number;
    revoked: number;
  };
}

export interface WebServerConfig {
  port: number;
  /** Basic auth credentials. If unset, HTTP auth is disabled. */
  auth?: { username: string; password: string };
  /** Session-based password. When set, serves a login page and uses cookie sessions. Takes precedence over Basic Auth. */
  sessionPassword?: string;
  /** Bind hostname. Defaults to '127.0.0.1' (loopback only). */
  hostname?: string;
  /** Allowed CORS origin. If unset, no CORS headers are sent. */
  corsOrigin?: string;
  /** Opt-in: allow discovery admin routes from loopback/private LAN without Basic Auth. */
  trustLanDiscoveryAdmin?: boolean;
}

export type WsEventType =
  | 'agent_status'
  | 'task_update'
  | 'log'
  | 'ipc_event'
  | 'new_message'
  | 'peer_discovered'
  | 'peer_lost'
  | 'pair_request'
  | 'pair_approved';

export interface WsEvent {
  type: WsEventType;
  data: unknown;
  timestamp: string;
}
