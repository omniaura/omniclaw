import fs from 'fs';
import { parseDocument } from 'yaml';
import { z } from 'zod';

import { logger } from './logger.js';
import type { BackendType, ContainerConfig, RegisteredGroup } from './types.js';

const folderSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'must be a safe folder name');

const backendSchema = z.enum(['apple-container', 'docker']);
const agentRuntimeSchema = z.enum(['claude-agent-sdk', 'opencode', 'codex']);
const containerConfigSchema = z
  .object({})
  .passthrough()
  .transform((value) => value as ContainerConfig);

const channelSchema = z
  .object({
    jid: z.string().min(1),
    name: z.string().min(1).optional(),
    trigger: z.string().min(1),
    requiresTrigger: z.boolean().optional(),
    discordBotId: z.string().min(1).optional(),
    discord_bot_id: z.string().min(1).optional(),
    discordGuildId: z.string().min(1).optional(),
    discord_guild_id: z.string().min(1).optional(),
    serverFolder: z.string().min(1).optional(),
    server_folder: z.string().min(1).optional(),
    channelFolder: z.string().min(1).optional(),
    channel_folder: z.string().min(1).optional(),
    categoryFolder: z.string().min(1).optional(),
    category_folder: z.string().min(1).optional(),
    autoRespondToQuestions: z.boolean().optional(),
    auto_respond_to_questions: z.boolean().optional(),
    autoRespondKeywords: z.array(z.string().min(1)).optional(),
    auto_respond_keywords: z.array(z.string().min(1)).optional(),
  })
  .strict();

const agentSchema = z
  .object({
    name: z.string().min(1).optional(),
    folder: folderSchema.optional(),
    backend: backendSchema.optional(),
    agentRuntime: agentRuntimeSchema.optional(),
    agent_runtime: agentRuntimeSchema.optional(),
    description: z.string().min(1).optional(),
    containerConfig: containerConfigSchema.optional(),
    container_config: containerConfigSchema.optional(),
    serverFolder: z.string().min(1).optional(),
    server_folder: z.string().min(1).optional(),
    agentContextFolder: z.string().min(1).optional(),
    agent_context_folder: z.string().min(1).optional(),
    heartbeat: z.object({}).passthrough().optional(),
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
        containerConfig: agent.containerConfig || agent.container_config,
        requiresTrigger: channel.requiresTrigger,
        discordBotId: channel.discordBotId || channel.discord_bot_id,
        discordGuildId: channel.discordGuildId || channel.discord_guild_id,
        serverFolder:
          channel.serverFolder ||
          channel.server_folder ||
          agent.serverFolder ||
          agent.server_folder,
        backend: agent.backend as BackendType | undefined,
        agentRuntime: agent.agentRuntime || agent.agent_runtime,
        description: agent.description,
        autoRespondToQuestions:
          channel.autoRespondToQuestions ?? channel.auto_respond_to_questions,
        autoRespondKeywords:
          channel.autoRespondKeywords || channel.auto_respond_keywords,
        channelFolder: channel.channelFolder || channel.channel_folder,
        categoryFolder: channel.categoryFolder || channel.category_folder,
        agentContextFolder:
          agent.agentContextFolder || agent.agent_context_folder,
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
