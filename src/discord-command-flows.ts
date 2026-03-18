import fs from 'fs';
import path from 'path';

import {
  ApplicationCommandOptionType,
  type ApplicationCommandOptionData,
  type ChatInputApplicationCommandData,
} from 'discord.js';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { assertPathWithin } from './path-security.js';
import type { RegisteredGroup } from './types.js';

export type DiscordFlowOptionType = 'string' | 'integer' | 'boolean';

export interface DiscordFlowOptionDefinition {
  name: string;
  description: string;
  type?: DiscordFlowOptionType;
  required?: boolean;
  defaultValue?: string | number | boolean;
}

export interface DiscordFlowDefinition {
  name: string;
  description: string;
  prompt: string;
  options?: DiscordFlowOptionDefinition[];
}

interface DiscordFlowFile {
  commands?: unknown;
}

const COMMANDS_FILENAME = 'discord-commands.json';
const COMMAND_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;

const BUILTIN_COMMANDS: DiscordFlowDefinition[] = [
  {
    name: 'mergemaster',
    description: 'Delegate and merge work for a limited window',
    prompt:
      'I need you to be in charge of {{repo}} for the next {{duration_minutes}} minutes. You will delegate tasks, keep the queue moving, and you will not code anything yourself. You are mergemaster for this window, and all agents should know that you are the active merger.\n\nYour goal is to accomplish meaningful work on {{goal}}.\n\nImportant constraints:\n- do not write implementation code yourself\n- keep agents aligned on the active repo, issue, and PR queue\n- do not merge until CI passes when the target stack cannot be tested directly from your container\n- before each merge, verify the PR is reviewed, green, and actually ready',
    options: [
      {
        name: 'repo',
        description: 'Repository or project to coordinate',
        type: 'string',
        defaultValue: 'the target repo',
      },
      {
        name: 'goal',
        description: 'What meaningful work to drive',
        type: 'string',
        defaultValue: 'meaningful progress on open issues',
      },
      {
        name: 'duration_minutes',
        description: 'How long the mergemaster window lasts',
        type: 'integer',
        defaultValue: 60,
      },
    ],
  },
  {
    name: 'taskbooker',
    description: 'Have the agent book and delegate a work plan',
    prompt:
      'You are taskbooker for the next {{duration_minutes}} minutes. Break down the goal, delegate concrete work, track who owns what, and keep the workstream organized without doing the implementation yourself.\n\nFocus area: {{goal}}\nTarget repo or project: {{repo}}\n\nImportant constraints:\n- do not code the solution yourself\n- produce a clear delegation plan with the highest-leverage next actions first\n- keep checking back on delegated work until there is meaningful forward progress',
    options: [
      {
        name: 'goal',
        description: 'Outcome to plan and delegate',
        type: 'string',
        required: true,
      },
      {
        name: 'repo',
        description: 'Repository or project to coordinate',
        type: 'string',
        defaultValue: 'the current repo',
      },
      {
        name: 'duration_minutes',
        description: 'How long to stay in taskbooker mode',
        type: 'integer',
        defaultValue: 45,
      },
    ],
  },
  {
    name: 'scheduler',
    description: 'Draft and queue scheduled follow-up work',
    prompt:
      'Act as scheduler. Turn this request into a clean execution plan and schedule-oriented follow-up work: {{goal}}.\n\nPlanning window: {{duration_minutes}} minutes\nProject scope: {{repo}}\n\nImportant constraints:\n- propose specific recurring or one-shot tasks when they would help\n- keep the plan actionable and lightweight\n- if scheduling is not the right tool, explain the better workflow and proceed with that instead',
    options: [
      {
        name: 'goal',
        description: 'Work to plan or schedule',
        type: 'string',
        required: true,
      },
      {
        name: 'repo',
        description: 'Repository or project in scope',
        type: 'string',
        defaultValue: 'the current repo',
      },
      {
        name: 'duration_minutes',
        description: 'Planning timebox in minutes',
        type: 'integer',
        defaultValue: 30,
      },
    ],
  },
];

function normalizeOptionType(value: unknown): DiscordFlowOptionType {
  return value === 'integer' || value === 'boolean' ? value : 'string';
}

function normalizeOption(
  input: unknown,
  source: string,
): DiscordFlowOptionDefinition | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const description =
    typeof record.description === 'string' ? record.description.trim() : '';
  if (!COMMAND_NAME_PATTERN.test(name)) {
    logger.warn(
      { source, name },
      'Ignoring Discord flow option with invalid name',
    );
    return null;
  }
  if (!description || description.length > 100) {
    logger.warn(
      { source, name },
      'Ignoring Discord flow option with invalid description',
    );
    return null;
  }

  return {
    name,
    description,
    type: normalizeOptionType(record.type),
    required: record.required === true,
    defaultValue:
      typeof record.defaultValue === 'string' ||
      typeof record.defaultValue === 'number' ||
      typeof record.defaultValue === 'boolean'
        ? record.defaultValue
        : undefined,
  };
}

function normalizeFlow(
  input: unknown,
  source: string,
): DiscordFlowDefinition | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const description =
    typeof record.description === 'string' ? record.description.trim() : '';
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';

  if (!COMMAND_NAME_PATTERN.test(name)) {
    logger.warn({ source, name }, 'Ignoring Discord flow with invalid name');
    return null;
  }
  if (!description || description.length > 100) {
    logger.warn(
      { source, name },
      'Ignoring Discord flow with invalid description',
    );
    return null;
  }
  if (!prompt) {
    logger.warn({ source, name }, 'Ignoring Discord flow with empty prompt');
    return null;
  }

  const options = Array.isArray(record.options)
    ? record.options
        .map((option) => normalizeOption(option, source))
        .filter(
          (option): option is DiscordFlowOptionDefinition => option !== null,
        )
    : undefined;

  return {
    name,
    description,
    prompt,
    options,
  };
}

function loadFlowFile(filePath: string): DiscordFlowDefinition[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as DiscordFlowFile | unknown[];
    const commands: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as DiscordFlowFile).commands)
        ? ((parsed as DiscordFlowFile).commands as unknown[])
        : [];

    return commands
      .map((command) => normalizeFlow(command, filePath))
      .filter((command): command is DiscordFlowDefinition => command !== null);
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to load Discord command file');
    return [];
  }
}

function getGroupCommandPaths(
  group: RegisteredGroup,
  groupsDir = GROUPS_DIR,
): string[] {
  const relativeFolders = [
    group.serverFolder,
    group.categoryFolder,
    group.folder,
    group.channelFolder,
  ].filter((folder, index, all): folder is string => {
    if (!folder || !folder.trim()) return false;
    return all.indexOf(folder) === index;
  });

  return relativeFolders.map((relativeFolder) => {
    const absoluteFolder = path.join(groupsDir, relativeFolder);
    assertPathWithin(absoluteFolder, groupsDir, 'Discord command folder');
    return path.join(absoluteFolder, COMMANDS_FILENAME);
  });
}

export function getDiscordFlowDefinitionsForGroup(
  group: RegisteredGroup,
  groupsDir = GROUPS_DIR,
): DiscordFlowDefinition[] {
  const commands = new Map<string, DiscordFlowDefinition>();
  for (const builtin of BUILTIN_COMMANDS) {
    commands.set(builtin.name, builtin);
  }

  for (const filePath of getGroupCommandPaths(group, groupsDir)) {
    if (!fs.existsSync(filePath)) continue;
    for (const command of loadFlowFile(filePath)) {
      commands.set(command.name, command);
    }
  }

  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function optionTypeToDiscord(
  type: DiscordFlowOptionType | undefined,
):
  | ApplicationCommandOptionType.String
  | ApplicationCommandOptionType.Integer
  | ApplicationCommandOptionType.Boolean {
  switch (type) {
    case 'integer':
      return ApplicationCommandOptionType.Integer;
    case 'boolean':
      return ApplicationCommandOptionType.Boolean;
    default:
      return ApplicationCommandOptionType.String;
  }
}

export function buildDiscordSlashCommandPayloads(
  groups: RegisteredGroup[],
  groupsDir = GROUPS_DIR,
): ChatInputApplicationCommandData[] {
  const commands = new Map<string, DiscordFlowDefinition>();

  for (const group of groups) {
    for (const command of getDiscordFlowDefinitionsForGroup(group, groupsDir)) {
      const existing = commands.get(command.name);
      if (existing && JSON.stringify(existing) !== JSON.stringify(command)) {
        logger.warn(
          { command: command.name, group: group.folder },
          'Discord slash command conflict detected; keeping first definition',
        );
        continue;
      }
      commands.set(command.name, command);
    }
  }

  return [...commands.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((command) => ({
      name: command.name,
      description: command.description,
      options: command.options?.map((option) => toDiscordOptionData(option)),
    }));
}

function toDiscordOptionData(
  option: DiscordFlowOptionDefinition,
): ApplicationCommandOptionData {
  const common = {
    name: option.name,
    description: option.description,
    required: option.required,
  };

  switch (option.type) {
    case 'integer':
      return {
        ...common,
        type: ApplicationCommandOptionType.Integer,
      };
    case 'boolean':
      return {
        ...common,
        type: ApplicationCommandOptionType.Boolean,
      };
    default:
      return {
        ...common,
        type: ApplicationCommandOptionType.String,
      };
  }
}

function stringifyOptionValue(value: string | number | boolean): string {
  return typeof value === 'boolean'
    ? value
      ? 'true'
      : 'false'
    : String(value);
}

export function renderDiscordFlowPrompt(
  command: DiscordFlowDefinition,
  optionValues: Record<string, string | number | boolean | undefined>,
): string {
  const defaults = new Map<string, string>();
  for (const option of command.options || []) {
    if (option.defaultValue !== undefined) {
      defaults.set(option.name, stringifyOptionValue(option.defaultValue));
    }
  }

  return command.prompt.replace(
    /{{\s*([a-z0-9_-]+)\s*}}/gi,
    (_, key: string) => {
      const value = optionValues[key];
      if (value !== undefined) return stringifyOptionValue(value);
      return defaults.get(key) || '';
    },
  );
}
