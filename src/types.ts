export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/omniclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

/** Minimal process interface compatible with Bun.spawn's Subprocess */
export interface ContainerProcess {
  readonly killed: boolean;
  kill(signal?: number | string): void;
  readonly pid: number;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  memory?: number; // Container memory in MB. Default: 4096
  networkMode?: 'full' | 'none'; // Default: 'full'. Set to 'none' for outbound network isolation.
  /** Extra MCP servers to inject into the agent runtime (SSE/HTTP). Keyed by server name. */
  mcpServers?: Record<string, Record<string, unknown>>;
  /** Explicitly allow Firebase/GCP credentials to flow into the local backend env mount. */
  allowGcpCredentials?: boolean;
  /** Stream intermediate agent outputs (tool calls, thinking) via an edited status message. */
  streamIntermediates?: boolean;
}

export type BackendType = 'apple-container' | 'docker' | 'cursor-sdk';

import type {
  AgentRuntime as _AgentRuntime,
  TaskOutcomeState as _TaskOutcomeState,
  TaskOutcomeSignal as _TaskOutcomeSignal,
} from '@omniclaw/protocol';

export type AgentRuntime = _AgentRuntime;
export type TaskOutcomeState = _TaskOutcomeState;
export type TaskOutcomeSignal = _TaskOutcomeSignal;

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  autoRespondToQuestions?: boolean; // Respond to messages ending with '?' (default: false)
  autoRespondKeywords?: string[]; // Keywords that trigger response without mention (e.g., ["omni", "help"])
  discordBotId?: string; // Stable Discord bot identity key (e.g., "CLAUDE", "OPENCODE")
  discordGuildId?: string; // Discord guild/server ID (for server-level context)
  serverFolder?: string; // e.g., "servers/omniaura-discord" (shared across channels in same server)
  backend?: BackendType; // Which container backend runs this group's agent (default: apple-container)
  agentRuntime?: AgentRuntime; // Which agent runtime runs inside the container (default: claude-agent-sdk)
  description?: string; // What this agent does (for agent registry)
  /** Channel workspace folder. Mounted at /workspace/group/. Falls back to agent folder if unset. */
  channelFolder?: string; // e.g., 'servers/omni-aura/ditto-assistant/spec'
  /** Category team workspace. Mounted read-write at /workspace/category/. */
  categoryFolder?: string; // e.g., 'servers/omni-aura/ditto-assistant'
  /** Agent identity folder. Mounted read-write at /workspace/agent/. */
  agentContextFolder?: string; // e.g., 'agents/peytonomi'
  /** Discord slash command availability for this agent/channel registration. */
  discordCommands?: DiscordCommandConfig;
  /**
   * Per-agent model override propagated to the agent's container env. See the
   * Agent.model JSDoc for the runtime → env-var mapping. Persisted on the
   * `agents` row, not on `registered_groups`.
   */
  model?: string;
}

export interface DiscordCommandConfig {
  /** Optional allowlist. Omit to enable all built-in and workspace commands. */
  enabled?: string[];
  /** Optional denylist applied after enabled. */
  disabled?: string[];
}

/**
 * Inbound message envelope.
 *
 * Sender identity contract (see docs/sender-identity-phase0-audit.md):
 *
 *   sender           — Immutable platform ID (e.g. Discord snowflake, WhatsApp JID).
 *                       Used as the authoritative identity key for routing, filtering,
 *                       and dedup.  NEVER derived from a display name.
 *
 *   sender_name      — Human-readable display label (mutable, user-changeable).
 *                       Used ONLY for presentation (XML prompt, logs).
 *                       Must NEVER be used for authorization or dedup.
 *
 *   sender_platform  — Origin platform tag.  Together with `sender`, forms the
 *                       canonical sender key (`<platform>:<sender>`).  Populated by
 *                       adapters; synthetic messages use 'system' or 'ipc'.
 */
export interface NewMessage {
  id: string;
  chat_jid: string;
  /** Immutable platform-specific sender ID (authoritative key). */
  sender: string;
  /** Human-readable display name (presentation only — do not use for auth or dedup). */
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  /**
   * Origin platform.  Set by the adapter that ingested the message.
   * Synthetic messages use 'system'; IPC-relayed messages use 'ipc'.
   */
  sender_platform?:
    | 'discord'
    | 'whatsapp'
    | 'telegram'
    | 'slack'
    | 'ipc'
    | 'system'
    | 'web';
  /** Platform-specific sender ID (e.g., Discord user ID, WhatsApp JID) */
  sender_user_id?: string;
  /** Array of mentioned users with their IDs and display names */
  mentions?: Array<{
    id: string;
    name: string;
    platform: 'discord' | 'whatsapp' | 'telegram' | 'slack';
  }>;
  /**
   * True when the message is a reply to one of the bot's own messages.
   * Treated as an explicit trigger by the subscription filter, since the
   * user is clearly addressing the bot even without an @mention.
   */
  is_reply_to_bot?: boolean;
  /**
   * Optional subscription identity for reply routing. When present, only this
   * agent should be triggered by the reply.
   */
  reply_to_agent_id?: string;
  /**
   * Optional channel bot identity for reply routing. Telegram stores the
   * replied-to bot's numeric ID here.
   */
  reply_to_bot_id?: string;
}

/** Attachment type tag for the unified media pipeline. */
export type MediaAttachmentType = 'image' | 'file' | 'video' | 'audio';

/**
 * Channel-agnostic media attachment descriptor.
 * Produced by channel adapters, consumed by the container agent runtime.
 */
export interface MediaAttachment {
  /** Semantic type of the attachment. */
  type: MediaAttachmentType;
  /** MIME type when known (e.g. "image/png"). */
  mimeType: string | null;
  /** Absolute path to the downloaded file on the host. */
  localPath: string;
  /** Original remote URL the file was fetched from. */
  originalUrl: string;
  /** Human-readable filename (sanitised — no directory components). */
  filename: string;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  /**
   * Optional TypeScript workflow path, relative to TASK_WORKFLOWS_DIR, that runs
   * before the agent prompt. The workflow can skip a no-op task or modify the
   * prompt with deterministic triage output.
   */
  preprocess_script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
  /** ISO timestamp set when a task starts executing; cleared on completion. */
  executing_since: string | null;
  /** Outcome state from the most recent run (done/blocked/abandoned). */
  last_outcome_state?: TaskOutcomeState | null;
  /** Reason string from the most recent outcome signal. */
  last_outcome_reason?: string | null;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
  outcome_state?: TaskOutcomeState;
  outcome_reason?: string;
  outcome_question?: string;
}

export type TaskRunPhaseName =
  | 'lease_acquired'
  | 'group_resolved'
  | 'dispatch_started'
  | 'stream_result_received'
  | 'outbound_send_attempted'
  | 'run_finalized';

export interface TaskRunPhaseEvent {
  task_id: string;
  run_at: string;
  sequence: number;
  phase: TaskRunPhaseName;
  event_at: string;
  status: 'ok' | 'error';
  retryable: boolean;
  error: string | null;
}

export type FactoryWorkflowPhase =
  | 'discovery'
  | 'spec'
  | 'impl'
  | 'review'
  | 'qa'
  | 'done';

export interface FactoryWorkflowArtifact {
  type: 'issue' | 'pr' | 'branch' | 'commit' | 'file' | 'url' | 'note';
  label: string;
  url?: string;
  path?: string;
}

export interface FactoryHandoffRecord {
  id: string;
  workflowId: string;
  repo: string;
  sourceIssue?: string;
  sourcePr?: string;
  phase: FactoryWorkflowPhase;
  ownerAgentId: string;
  driver: string;
  intent: string;
  summary: string;
  body: string;
  decisions: string[];
  artifacts: FactoryWorkflowArtifact[];
  blockers: string[];
  nextDriver?: string;
  nextScope?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface FactoryWorkflowClaim {
  workflowId: string;
  repo: string;
  ownerAgentId: string;
  ownerRunId: string;
  phase: FactoryWorkflowPhase;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

// --- Channel abstraction ---

/**
 * Handle for a natively streamed outbound message (e.g. Slack's
 * chat.startStream/appendStream/stopStream). Created via
 * Channel.startMessageStream; all methods may throw — callers fall back to
 * sendMessage/editMessage on failure.
 */
export interface OutboundMessageStream {
  /**
   * Append an intermediate status update (tool call, progress note).
   * Rendered as a task timeline on platforms that support it.
   */
  appendStatus(text: string): Promise<void>;
  /** Append final response text (markdown). */
  appendText(text: string): Promise<void>;
  /** Finalize the stream. Returns the message id, or undefined if nothing was sent. */
  stop(): Promise<string | undefined>;
}

export interface Channel {
  name: string;
  /** Optional channel/bot identity key for multi-bot routing (Discord/Telegram). */
  botId?: string;
  connect(): Promise<void>;
  sendMessage(
    jid: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<string | void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: thread support for streaming intermediate output.
  // Thread handles are opaque — callers store the value from createThread and pass it to sendToThread.
  createThread?(jid: string, messageId: string, name: string): Promise<unknown>;
  sendToThread?(thread: unknown, text: string): Promise<void>;
  // Optional: edit an existing message in-place.
  editMessage?(jid: string, messageId: string, text: string): Promise<void>;
  /**
   * Optional: start a natively streamed message (e.g. Slack chat.startStream).
   * Returns null when streaming isn't possible for this target (no thread
   * anchor, missing recipient info) so callers can fall back to sendMessage.
   */
  startMessageStream?(
    jid: string,
    replyToMessageId?: string,
  ): Promise<OutboundMessageStream | null>;
  // Optional: add/remove emoji reactions on messages.
  addReaction?(jid: string, messageId: string, emoji: string): Promise<void>;
  removeReaction?(jid: string, messageId: string, emoji: string): Promise<void>;
  // Whether to prefix outbound messages with the assistant name.
  // Telegram bots already display their name, so they return false.
  // WhatsApp returns true. Default true if not implemented.
  prefixAssistantName?: boolean;
  /** Fetch the bot's own profile image URL from this channel's platform. */
  getAvatarUrl?(): Promise<string | null>;
  /** Resolve a stored avatar reference into a fetchable remote URL. */
  resolveStoredAvatarUrl?(storedAvatarUrl: string): Promise<string | null>;
  /** Fetch a chat/user image URL for a specific JID. */
  getChatAvatarUrl?(jid: string): Promise<string | null>;
  /** Fetch a server/community image URL for a specific server ID. */
  getServerIconUrl?(serverId: string): Promise<string | null>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (WhatsApp syncGroupMetadata) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
) => void;

// --- Agent-Channel Decoupling ---

/**
 * An Agent is an autonomous entity that handles messages for one or more channels.
 * Replaces RegisteredGroup as the primary routing unit.
 */
export interface Agent {
  id: string; // "main", "omniaura-discord"
  name: string;
  description?: string;
  folder: string; // Workspace folder (= id for backwards compat)
  backend: BackendType;
  agentRuntime: AgentRuntime; // Which agent runtime runs inside the container
  containerConfig?: ContainerConfig;
  isAdmin: boolean; // Local agent = true (can approve tasks, access local FS)
  serverFolder?: string; // Shared server context (e.g., "servers/omniaura-discord")
  createdAt: string;
  /** Agent identity + global notes folder, mounted read-write at /workspace/agent/. */
  agentContextFolder?: string; // e.g., 'agents/peytonomi'
  /** Roles required to appear in this agent's channel roster context. Empty = no filter. */
  rosterRoleFilters?: string[];
  /** Profile image reference (safe URL, token-free descriptor, or local path). */
  avatarUrl?: string;
  /** Which platform the avatar was sourced from. */
  avatarSource?: 'discord' | 'telegram' | 'slack' | 'custom';
  /**
   * Whether this agent is enabled. When false, the orchestrator skips message
   * dispatch and scheduled task execution for this agent. Inbound messages are
   * still persisted; toggling back to true resumes processing from the next
   * message. Defaults to true on existing rows via DB migration.
   */
  enabled?: boolean;
  /**
   * Per-agent model override, interpreted by the agent runtime:
   *   claude-agent-sdk → CLAUDE_MODEL (e.g. "claude-opus-4-7")
   *   opencode         → OPENCODE_MODEL (e.g. "anthropic/claude-sonnet-4-5")
   *   codex            → CODEX_MODEL
   *   cursor-sdk       → CURSOR_AGENT_MODEL
   * When set, the orchestrator writes this value into the container's env
   * file, overriding any host-level .env value. Empty / unset falls back to
   * the host .env or runtime default.
   */
  model?: string;
}

/** Volatile, sanitized runtime state for discovery/roster views. */
export interface AgentHealth {
  agentId: string;
  isOnline: boolean;
  lastHeartbeatAt: string;
  updatedAt: string;
  capabilities: string[];
}

/**
 * Maps a channel JID to an agent.
 * Multiple channels can route to the same agent.
 */
export interface ChannelRoute {
  channelJid: string; // "dc:123", "tg:<botId>:-100...", "123@g.us"
  agentId: string; // FK to Agent.id
  trigger: string;
  requiresTrigger: boolean;
  discordBotId?: string;
  discordGuildId?: string;
  createdAt: string;
}

/**
 * Multi-agent channel subscription.
 * Multiple agents can subscribe to the same channel.
 */
export interface ChannelSubscription {
  channelJid: string;
  agentId: string;
  trigger: string;
  requiresTrigger: boolean;
  priority: number;
  isPrimary: boolean;
  discordBotId?: string;
  discordGuildId?: string;
  createdAt: string;
  /** Channel workspace folder. Overrides agent folder as /workspace/group/ mount when set. */
  channelFolder?: string; // e.g., 'servers/omni-aura/ditto-assistant/spec'
  /** Category team workspace folder, mounted at /workspace/category/. */
  categoryFolder?: string; // e.g., 'servers/omni-aura/ditto-assistant'
}

/**
 * Convert a RegisteredGroup + JID into an Agent (for migration).
 */
export function registeredGroupToAgent(
  jid: string,
  group: RegisteredGroup,
): Agent {
  const isMainGroup = group.folder === 'main';
  const backendType = group.backend || 'apple-container';
  return {
    id: group.folder,
    name: group.name,
    description: group.description,
    folder: group.folder,
    backend: backendType,
    agentRuntime:
      group.agentRuntime ||
      (backendType === 'cursor-sdk' ? 'cursor-sdk' : 'claude-agent-sdk'),
    containerConfig: group.containerConfig,
    isAdmin: isMainGroup,
    serverFolder: group.serverFolder,
    createdAt: group.added_at,
    model: group.model,
  };
}

/**
 * Convert a RegisteredGroup + JID into a ChannelRoute (for migration).
 */
export function registeredGroupToRoute(
  jid: string,
  group: RegisteredGroup,
): ChannelRoute {
  return {
    channelJid: jid,
    agentId: group.folder,
    trigger: group.trigger,
    requiresTrigger: group.requiresTrigger !== false,
    discordBotId: group.discordBotId,
    discordGuildId: group.discordGuildId,
    createdAt: group.added_at,
  };
}

// --- GitHub Watch Config ---

export interface GitHubRepoWatch {
  owner: string;
  repo: string;
  openPrs?: { limit?: number; includeReviewComments?: boolean };
  recentIssues?: { limit?: number };
}

export interface GitHubAgentWatch {
  agentId: string;
  repos: GitHubRepoWatch[];
}

export interface GitHubWatchesConfig {
  watches: GitHubAgentWatch[];
  /** Cache TTL in milliseconds. Default: 300000 (5 minutes) */
  cacheTtlMs?: number;
  /** Per-channel watched repos for delta context injection. */
  channelWatches?: GitHubChannelWatch[];
  /** Feature flag: enable delta context injection. Default: false */
  githubDeltaContextEnabled?: boolean;
}

export interface GitHubChannelWatch {
  channelJid: string;
  repos: GitHubRepoWatch[];
}

// --- IPC Data Types ---

/** IPC message payloads sent by agents to the orchestrator. */
export interface IpcMessagePayload {
  type: string;
  chatJid?: string;
  originChatJid?: string;
  currentChatJid?: string;
  targetWasExplicit?: boolean;
  text?: string;
  messageId?: string;
  emoji?: string;
  remove?: boolean;
  userName?: string;
  platform?: string;
  requestId?: string;
  pubkey?: string;
  discord_bot_id?: string;
}

/** IPC task payloads sent by agents to the orchestrator. */
export interface IpcTaskPayload {
  type: string;
  taskId?: string;
  requestId?: string;
  prompt?: string;
  preprocess_script?: string | null;
  schedule_type?: string;
  schedule_value?: string;
  context_mode?: string;
  groupFolder?: string;
  chatJid?: string;
  targetJid?: string;
  channel_jid?: string;
  // For register_group
  jid?: string;
  name?: string;
  folder?: string;
  trigger?: string;
  requiresTrigger?: boolean;
  containerConfig?: ContainerConfig;
  discord_bot_id?: string;
  discord_guild_id?: string;
  description?: string;
  target_agent?: string;
  // For register_group: backend config
  backend?: BackendType;
  agent_runtime?: AgentRuntime;
  group_description?: string;
  // For edit_task
  status?: string;
}
