/**
 * Backend type definitions for OmniClaw
 * Defines the AgentBackend interface that all backends implement.
 */

import {
  Agent,
  type AgentRuntime,
  type BackendType,
  ContainerProcess,
  RegisteredGroup,
} from '../types.js';

export type { AgentRuntime, BackendType };

/**
 * Unified group-or-agent type for backwards compatibility.
 * Backends accept either an Agent or a RegisteredGroup.
 */
export type AgentOrGroup = Agent | RegisteredGroup;

/** Extract the folder from either an Agent or RegisteredGroup. */
export function getFolder(entity: AgentOrGroup): string {
  return entity.folder;
}

/** Extract the name from either an Agent or RegisteredGroup. */
export function getName(entity: AgentOrGroup): string {
  return entity.name;
}

/** Check if the entity is an Agent (has 'id' field). */
export function isAgent(entity: AgentOrGroup): entity is Agent {
  return 'id' in entity && 'isAdmin' in entity;
}

/** Get containerConfig from either type. */
export function getContainerConfig(
  entity: AgentOrGroup,
): RegisteredGroup['containerConfig'] {
  return entity.containerConfig;
}

/** Get serverFolder from either type. */
export function getServerFolder(entity: AgentOrGroup): string | undefined {
  return entity.serverFolder;
}

/** Get backend type from either type. */
export function getBackendType(entity: AgentOrGroup): BackendType {
  if (isAgent(entity)) return entity.backend;
  return (entity as RegisteredGroup).backend || 'apple-container';
}

/** Get agent runtime from either type. */
export function getAgentRuntime(entity: AgentOrGroup): AgentRuntime {
  if (isAgent(entity)) return entity.agentRuntime;
  return (entity as RegisteredGroup).agentRuntime || 'claude-agent-sdk';
}

export interface ChannelInfo {
  id: string;
  jid: string;
  name: string;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  resumeAt?: string;
  groupFolder: string;
  /** Host-side runtime key for IPC/session isolation (defaults to groupFolder). */
  runtimeFolder?: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  discordGuildId?: string;
  serverFolder?: string;
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
  agentContextFolder?: string; // e.g., 'agents/peytonomi'
  /** Channel workspace folder. If set, overrides groupFolder as /workspace/group/ mount. */
  channelFolder?: string; // e.g., 'servers/omni-aura/ditto-assistant/spec'
  /** Category team workspace, mounted read-write at /workspace/category/ (shared across channels in same category) */
  categoryFolder?: string; // e.g., 'servers/omni-aura/ditto-assistant'
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  resumeAt?: string;
  error?: string;
  intermediate?: boolean;
  /** The chat JID this output should be routed to (multi-channel agents). */
  chatJid?: string;
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Interface that all agent backends must implement.
 * Backends handle running agents, IPC, and file operations.
 *
 * runAgent accepts AgentOrGroup for backwards compatibility —
 * new code should pass Agent, old code can still pass RegisteredGroup.
 */
export interface AgentBackend {
  readonly name: string;

  /** Run an agent for a group. Returns when agent completes. */
  runAgent(
    group: AgentOrGroup,
    input: ContainerInput,
    onProcess: (proc: ContainerProcess, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<ContainerOutput>;

  /** Send a follow-up message to an active agent via IPC. Returns true if sent.
   *  opts.chatJid is included so the container can route responses to the correct channel. */
  sendMessage(
    groupFolder: string,
    text: string,
    opts?: { chatJid?: string },
  ): boolean;

  /** Signal an active agent to wind down. Optional inputSubdir for task lane isolation. */
  closeStdin(groupFolder: string, inputSubdir?: string): void;

  /** Write IPC data files (tasks snapshot, groups snapshot, agent registry). */
  writeIpcData(groupFolder: string, filename: string, data: string): void;

  /** Read a file from a group's workspace. Path is relative to /workspace/group/. */
  readFile(groupFolder: string, relativePath: string): Promise<Buffer | null>;

  /** Write a file to a group's workspace. Path is relative to /workspace/group/. */
  writeFile(
    groupFolder: string,
    relativePath: string,
    content: Buffer | string,
  ): Promise<void>;

  /** Initialize the backend (called once at startup). */
  initialize(): Promise<void>;

  /** Shut down the backend gracefully. */
  shutdown(): Promise<void>;
}
