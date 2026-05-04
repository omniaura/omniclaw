/**
 * @omniclaw/protocol — Shared type definitions for the OmniClaw container protocol.
 *
 * These types define the contract between the orchestrator (host) and the
 * agent-runner (container). Both sides import from this package to stay in sync.
 *
 * IMPORTANT: This package must remain dependency-free (pure TypeScript types only)
 * so it can be used in both the host process and the isolated container image
 * without pulling in extra runtime dependencies.
 */

// ---------------------------------------------------------------------------
// Agent Runtime
// ---------------------------------------------------------------------------

/** Which agent runtime runs inside the container. */
export type AgentRuntime =
  | 'claude-agent-sdk'
  | 'opencode'
  | 'codex'
  | 'cursor-sdk';

// ---------------------------------------------------------------------------
// Channel Info
// ---------------------------------------------------------------------------

/** Describes a channel that an agent can send/receive messages on. */
export interface ChannelInfo {
  id: string;
  jid: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Container Input (orchestrator → agent-runner via stdin JSON)
// ---------------------------------------------------------------------------

/** JSON payload sent from the orchestrator to the agent-runner via stdin. */
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  resumeAt?: string;
  groupFolder: string;
  /** Host-side runtime key for IPC/session isolation (defaults to groupFolder). */
  runtimeFolder?: string;
  chatJid: string;
  isMain: boolean;
  /** Effective container network policy after backend defaults/overrides are applied. */
  networkMode?: 'full' | 'none';
  isScheduledTask?: boolean;
  discordGuildId?: string;
  serverFolder?: string;
  /** Secrets injected by the orchestrator (e.g. API keys). */
  secrets?: Record<string, string>;
  /** Which agent runtime to use inside the container. Default: claude-agent-sdk */
  agentRuntime?: AgentRuntime;
  /** Multi-channel routing: all channels that map to this agent. Only set when agent has >1 route. */
  channels?: ChannelInfo[];
  /** Agent's display name (e.g. "OCPeyton"). Injected into system prompt for self-awareness. */
  agentName?: string;
  /** Agent's Discord bot ID. Injected into system prompt so agent knows its own bot identity. */
  discordBotId?: string;
  /** Agent's trigger word/phrase (e.g. "@OCPeyton"). */
  agentTrigger?: string;
  /** Agent's identity + global notes folder, mounted read-write at /workspace/agent/ */
  agentContextFolder?: string;
  /** Human-readable name of the channel that triggered this invocation. */
  currentChannelName?: string;
  /** Channel workspace folder. If set, overrides groupFolder as /workspace/group/ mount. */
  channelFolder?: string;
  /** Category team workspace, mounted read-write at /workspace/category/ (shared across channels in same category) */
  categoryFolder?: string;
  /** Pre-fetched GitHub context markdown (open PRs, issues, review comments) for injection into system prompt. */
  githubContext?: string;
  /** GitHub activity delta digest (events since last user message in this channel). */
  githubActivityDelta?: string;
  /** Auto-fetched context for GitHub PR/issue URLs detected in user messages. */
  githubLinkedContext?: string;
  /** Extra MCP servers to inject into the agent runtime alongside the built-in omniclaw server. */
  mcpServers?: Record<string, Record<string, unknown>>;
  /** Relative task workflow directory name shown to agents for deterministic scheduled task preprocessors. */
  taskWorkflowsDir?: string;
}

// ---------------------------------------------------------------------------
// Task Outcome Signal (agent → orchestrator, optional in ContainerOutput)
// ---------------------------------------------------------------------------

/** Explicit agent outcome state for scheduled task runs. */
export type TaskOutcomeState = 'done' | 'blocked' | 'abandoned' | 'skipped';

/** Signal from the agent indicating how a task run concluded. */
export interface TaskOutcomeSignal {
  state: TaskOutcomeState;
  /** Why the task ended in this state (e.g. "Rate limited", "Missing credentials"). */
  reason?: string;
  /** For blocked: what input is needed from the user? */
  question?: string;
}

// ---------------------------------------------------------------------------
// Container Output (agent-runner → orchestrator via stdout JSON)
// ---------------------------------------------------------------------------

/** JSON payload sent from the agent-runner back to the orchestrator via stdout. */
export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  resumeAt?: string;
  error?: string;
  intermediate?: boolean;
  /** The chat JID this output should be routed to (multi-channel agents). */
  chatJid?: string;
  /** Explicit agent outcome signal (done/blocked/abandoned/skipped). */
  outcome?: TaskOutcomeSignal;
}

// ---------------------------------------------------------------------------
// IPC Message (follow-up messages via file-based IPC)
// ---------------------------------------------------------------------------

/** A follow-up message delivered to the agent via IPC file polling. */
export interface IpcMessage {
  text: string;
  chatJid?: string;
}

/** Result of draining the IPC input directory. */
export interface IpcDrainResult {
  messages: IpcMessage[];
  shutdown: boolean;
}
