import fs from 'fs';
import { parseDocument } from 'yaml';
import { z } from 'zod';

import { logger } from './logger.js';
import type { BackendType, ContainerConfig, RegisteredGroup } from './types.js';

const folderSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'must be a lowercase safe folder name');

const backendSchema = z.enum(['apple-container', 'docker', 'cursor-sdk']);
const agentRuntimeSchema = z.enum([
  'claude-agent-sdk',
  'opencode',
  'codex',
  'cursor-sdk',
]);
const discordCommandNameSchema = z
  .string()
  .regex(/^[a-z0-9_-]{1,32}$/, 'must be a Discord slash command name');
export const discordCommandsSchema = z
  .object({
    enabled: z.array(discordCommandNameSchema).optional(),
    disabled: z.array(discordCommandNameSchema).optional(),
  })
  .strict();
const additionalMountSchema = z
  .object({
    hostPath: z.string().min(1),
    containerPath: z.string().min(1).optional(),
    readonly: z.boolean().optional(),
  })
  .strict();
const containerConfigSchema = z
  .object({
    additionalMounts: z.array(additionalMountSchema).optional(),
    timeout: z.number().int().positive().optional(),
    memory: z.number().int().positive().optional(),
    networkMode: z.enum(['full', 'none']).optional(),
    mcpServers: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .optional(),
    allowGcpCredentials: z.boolean().optional(),
    streamIntermediates: z.boolean().optional(),
  })
  .strict()
  .transform((value) => value as ContainerConfig);

const channelSchema = z
  .object({
    jid: z.string().min(1),
    name: z.string().min(1).optional(),
    trigger: z.string().min(1),
    requiresTrigger: z.boolean().optional(),
    discordBotId: z.string().min(1).optional(),
    discordGuildId: z.string().min(1).optional(),
    serverFolder: z.string().min(1).optional(),
    channelFolder: z.string().min(1).optional(),
    categoryFolder: z.string().min(1).optional(),
    autoRespondToQuestions: z.boolean().optional(),
    autoRespondKeywords: z.array(z.string().min(1)).optional(),
  })
  .strict();

const agentSchema = z
  .object({
    name: z.string().min(1).optional(),
    folder: folderSchema.optional(),
    backend: backendSchema.optional(),
    agentRuntime: agentRuntimeSchema.optional(),
    description: z.string().min(1).optional(),
    containerConfig: containerConfigSchema.optional(),
    serverFolder: z.string().min(1).optional(),
    agentContextFolder: z.string().min(1).optional(),
    discordCommands: discordCommandsSchema.optional(),
    /** Per-agent model override (CLAUDE_MODEL/OPENCODE_MODEL/CODEX_MODEL/CURSOR_AGENT_MODEL). */
    model: z.string().min(1).max(200).optional(),
    channels: z.array(channelSchema).min(1),
  })
  .strict();

const topologySchema = z
  .object({
    agents: z.record(folderSchema, agentSchema).default({}),
  })
  .strict();

export interface TopologyRegistration {
  jid: string;
  group: RegisteredGroup;
}

function formatTopologyError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'agents.yaml';
      return `${path}: ${issue.message}`;
    })
    .join('\n');
}

function readYamlFile(filePath: string): unknown {
  const source = fs.readFileSync(filePath, 'utf8');
  const document = parseDocument(source, { prettyErrors: true });
  if (document.errors.length > 0) {
    const details = document.errors.map((error) => error.message).join('\n');
    throw new Error(`Invalid agent topology YAML:\n${details}`);
  }
  return document.toJSON();
}

export function loadDeclarativeAgentTopology(
  filePath: string,
  existingGroups: Record<string, RegisteredGroup> = {},
): TopologyRegistration[] {
  if (!fs.existsSync(filePath)) return [];

  const parsed = topologySchema.safeParse(readYamlFile(filePath));
  if (!parsed.success) {
    throw new Error(
      `Invalid agent topology config ${filePath}:\n${formatTopologyError(parsed.error)}`,
    );
  }

  const registrations: TopologyRegistration[] = [];
  const seenJids = new Set<string>();

  for (const [agentId, agent] of Object.entries(parsed.data.agents)) {
    const folder = agent.folder || agentId;
    const agentName = agent.name || agentId;

    for (const channel of agent.channels) {
      if (seenJids.has(channel.jid)) {
        throw new Error(
          `Invalid agent topology config ${filePath}: duplicate channel jid ${channel.jid}`,
        );
      }
      seenJids.add(channel.jid);

      const existing = existingGroups[channel.jid];
      const group: RegisteredGroup = {
        name: channel.name || agentName,
        folder,
        trigger: channel.trigger,
        added_at: existing?.added_at || new Date().toISOString(),
        containerConfig: agent.containerConfig,
        requiresTrigger: channel.requiresTrigger,
        discordBotId: channel.discordBotId,
        discordGuildId: channel.discordGuildId,
        serverFolder: channel.serverFolder || agent.serverFolder,
        backend: agent.backend as BackendType | undefined,
        agentRuntime: agent.agentRuntime,
        description: agent.description,
        model: agent.model,
        autoRespondToQuestions: channel.autoRespondToQuestions,
        autoRespondKeywords: channel.autoRespondKeywords,
        channelFolder: channel.channelFolder,
        categoryFolder: channel.categoryFolder,
        agentContextFolder: agent.agentContextFolder,
        discordCommands: agent.discordCommands,
      };
      registrations.push({ jid: channel.jid, group });
    }
  }

  return registrations;
}

export function applyDeclarativeAgentTopology(options: {
  filePath: string;
  existingGroups: Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}): number {
  const registrations = loadDeclarativeAgentTopology(
    options.filePath,
    options.existingGroups,
  );
  const configuredJids = new Set(registrations.map((entry) => entry.jid));
  const staleJids = Object.keys(options.existingGroups).filter(
    (jid) => !configuredJids.has(jid),
  );
  if (registrations.length > 0 && staleJids.length > 0) {
    logger.warn(
      { filePath: options.filePath, staleJids },
      'Existing registered groups are absent from declarative topology',
    );
  }
  for (const registration of registrations) {
    options.registerGroup(registration.jid, registration.group);
  }
  if (registrations.length > 0) {
    logger.info(
      { filePath: options.filePath, registrationCount: registrations.length },
      'Declarative agent topology applied',
    );
  }
  return registrations.length;
}
