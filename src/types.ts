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
  networkMode?: 'full' | 'none'; // Default: 'none' for non-main, 'full' for main
}


export type BackendType = 'apple-container' | 'docker';

/** Which agent runtime runs inside the container. */
export type AgentRuntime = 'claude-agent-sdk' | 'opencode';

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
  streamIntermediates?: boolean; // Stream intermediate output (thinking, tool calls) to channel threads. Default: false
  /** Channel workspace folder. Mounted at /workspace/group/. Falls back to agent folder if unset. */
  channelFolder?: string; // e.g., 'servers/omni-aura/ditto-assistant/spec'
  /** Category team workspace. Mounted read-write at /workspace/category/. */
  categoryFolder?: string; // e.g., 'servers/omni-aura/ditto-assistant'
  /** Agent identity folder. Mounted read-write at /workspace/agent/. */
  agentContextFolder?: string; // e.g., 'agents/peytonomi'
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  /** Platform-specific sender ID (e.g., Discord user ID, WhatsApp JID) */
  sender_user_id?: string;
  /** Array of mentioned users with their IDs and display names */
  mentions?: Array<{
    id: string;
    name: string;
    platform: 'discord' | 'whatsapp' | 'telegram' | 'slack';
  }>;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
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
  // Optional: add/remove emoji reactions on messages.
  addReaction?(jid: string, messageId: string, emoji: string): Promise<void>;
  removeReaction?(jid: string, messageId: string, emoji: string): Promise<void>;
  // Whether to prefix outbound messages with the assistant name.
  // Telegram bots already display their name, so they return false.
  // WhatsApp returns true. Default true if not implemented.
  prefixAssistantName?: boolean;
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
}

/**
 * Maps a channel JID to an agent.
 * Multiple channels can route to the same agent.
 */
export interface ChannelRoute {
  channelJid: string; // "dc:123", "tg:-100...", "123@g.us"
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
    agentRuntime: group.agentRuntime || 'claude-agent-sdk',
    containerConfig: group.containerConfig,
    isAdmin: isMainGroup,
    serverFolder: group.serverFolder,
    createdAt: group.added_at,
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

// --- IPC Data Types ---

/** IPC message payloads sent by agents to the orchestrator. */
export interface IpcMessagePayload {
  type: string;
  chatJid?: string;
  text?: string;
  messageId?: string;
  emoji?: string;
  remove?: boolean;
  userName?: string;
  platform?: string;
  requestId?: string;
  pubkey?: string;
}

/** IPC task payloads sent by agents to the orchestrator. */
export interface IpcTaskPayload {
  type: string;
  taskId?: string;
  prompt?: string;
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
  // For share_request
  description?: string;
  sourceGroup?: string;
  scope?: string;
  serverFolder?: string;
  discordGuildId?: string;
  target_agent?: string;
  files?: string[];
  request_files?: string[];
  // For register_group: backend config
  backend?: BackendType;
  agent_runtime?: AgentRuntime;
  group_description?: string;
  // For delegate_task
  callbackAgentId?: string;
  // For context_request
  requestedTopics?: string[];
}
