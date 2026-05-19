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
  subcommands?: DiscordFlowDefinition[];
  /** System commands are handled by the host, not sent to the agent. */
  system?: boolean;
}

interface DiscordFlowFile {
  commands?: unknown;
}

const COMMANDS_FILENAME = 'discord-commands.json';
const COMMAND_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;
const MAX_PROMPT_LENGTH = 4000;

const BUILTIN_COMMANDS: DiscordFlowDefinition[] = [
  {
    name: 'mergemaster',
    description: 'Delegate and merge work for a limited window',
    prompt:
      "I need you to be in charge of {{repo}} for the next {{duration_minutes}} minutes. You will delegate tasks, keep the queue moving, and you will not code anything yourself. You are mergemaster for this window, and all agents should know that you are the active merger.\n\nYour goal is to accomplish meaningful work on {{goal}}.\n\nImportant constraints:\n- stay in this channel unless explicitly delegating cross-channel work\n- do not write implementation code yourself\n- keep agents aligned on the active repo, issue, and PR queue\n- do not merge until CI passes when the target stack cannot be tested directly from your container\n- before each merge, verify the PR is reviewed, green, and actually ready\n\nFYI on GitHub identity (NORMAL BEHAVIOR): all of a user's agents may be operating under the same GitHub account (the user's own account, via a shared PAT). This is expected. As a result, agents cannot leave a formal `APPROVED` review on PRs they (or any other agent under the same identity) authored — GitHub will reject the request with `Can not approve your own pull request`. Treat agent technical sign-off comments (CI status + diff verification + risk notes posted via `gh pr review --comment`) as the in-band readiness signal, and rely on the human user for any formal `APPROVED` review when one is genuinely required. Do not treat the missing formal approval as a structural blocker if the underlying technical readiness checks are satisfied.",
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
    name: 'product-driver',
    description: 'Drive product discovery and issue creation',
    prompt:
      'You are product driver for {{repo}} for the next {{duration_minutes}} minutes.\n\nGoal: {{goal}}\n\nYour job is to turn ambiguous product direction into concrete product progress. Start by reading the repo context, open issues, recent PRs, product docs, and relevant user conversations. De-duplicate before filing anything.\n\nExpected output:\n- identify the highest-leverage product gaps or opportunities\n- file clear issues with user problem, scope, acceptance criteria, and test notes when the repo needs tracking issues\n- direct small exploratory PRs only when code discovery is needed to clarify the product path\n- keep implementation delegated or narrowly exploratory; do not drift into broad feature work\n- leave a short queue update naming filed issues, delegated owners, blockers, and next decisions needed',
    options: [
      {
        name: 'repo',
        description: 'Repository or product area to drive',
        type: 'string',
        defaultValue: 'the target repo',
      },
      {
        name: 'goal',
        description: 'Product outcome or customer problem',
        type: 'string',
        defaultValue: 'meaningful product progress',
      },
      {
        name: 'duration_minutes',
        description: 'How long to stay in product-driver mode',
        type: 'integer',
        defaultValue: 60,
      },
    ],
  },
  {
    name: 'issue-driver',
    description: 'Triage, dedupe, and file actionable issues',
    prompt:
      'You are issue driver for {{repo}} for the next {{duration_minutes}} minutes.\n\nGoal: {{goal}}\n\nWork the issue queue like a product-minded engineer. Inspect existing issues and recent PRs first, then decide whether to update, close, split, prioritize, or file new issues. Prefer fewer high-quality issues over many vague ones.\n\nIssue quality bar:\n- concrete problem statement and why it matters\n- reproduction or evidence when applicable\n- proposed scope, non-goals, acceptance criteria, and verification plan\n- priority recommendation and dependencies\n- links to relevant files, PRs, conversations, or docs\n\nDo not implement fixes unless explicitly asked. End with a concise issue ledger and recommended next owners.',
    options: [
      {
        name: 'repo',
        description: 'Repository or project issue queue',
        type: 'string',
        defaultValue: 'the target repo',
      },
      {
        name: 'goal',
        description: 'Triage theme or product area',
        type: 'string',
        defaultValue: 'open issue quality and prioritization',
      },
      {
        name: 'duration_minutes',
        description: 'How long to stay in issue-driver mode',
        type: 'integer',
        defaultValue: 45,
      },
    ],
  },
  {
    name: 'research-driver',
    description: 'Run technical/product research and propose paths',
    prompt:
      'You are research driver for {{repo}} for the next {{duration_minutes}} minutes.\n\nQuestion or area: {{goal}}\n\nBuild evidence before recommending direction. Read primary sources, current repo code, open issues, and comparable implementations. When web research is needed, prefer official docs, source repos, specs, and recent primary references over summaries.\n\nDeliverables:\n- concise findings with source links or file references\n- option set with tradeoffs, risks, and confidence level\n- recommended next step and smallest validation PR or spike\n- issues to file only when they are actionable and de-duplicated\n\nDo not present speculation as fact; call out unknowns and verification gaps.',
    options: [
      {
        name: 'repo',
        description: 'Repository or product area to research',
        type: 'string',
        defaultValue: 'the target repo',
      },
      {
        name: 'goal',
        description: 'Research question or decision',
        type: 'string',
        required: true,
      },
      {
        name: 'duration_minutes',
        description: 'Research timebox in minutes',
        type: 'integer',
        defaultValue: 45,
      },
    ],
  },
  {
    name: 'implement-driver',
    description: 'Take a scoped issue through a PR-ready patch',
    prompt:
      'You are implementation driver for {{repo}}.\n\nTarget: {{goal}}\n\nTake one well-scoped change from intent to PR-ready state. Inspect the existing code and tests first, confirm the smallest coherent implementation path, then write the patch, add or update focused tests, run the relevant validation, and push or open/update the PR if repo policy expects it.\n\nConstraints:\n- keep scope tight and avoid unrelated refactors\n- preserve user or teammate work in the worktree\n- document any product or technical ambiguity instead of guessing silently\n- request review when the PR is ready, with a short verification summary\n\nIf the target is not implementation-ready, file or update an issue with the missing requirements and hand it back to product/issue driver.',
    options: [
      {
        name: 'repo',
        description: 'Repository to modify',
        type: 'string',
        defaultValue: 'the target repo',
      },
      {
        name: 'goal',
        description: 'Issue, PR, or scoped implementation target',
        type: 'string',
        required: true,
      },
    ],
  },
  {
    name: 'qa-driver',
    description: 'Verify behavior, PRs, and release readiness',
    prompt:
      'You are QA driver for {{repo}} for the next {{duration_minutes}} minutes.\n\nTarget: {{goal}}\n\nValidate behavior from the user and release perspective. Inspect the diff or feature path, identify risk areas, run the most relevant automated and manual checks available in this environment, and file focused follow-up issues for defects or missing coverage.\n\nQA checklist:\n- confirm expected behavior and edge cases from product context\n- run targeted tests before broad tests when possible\n- reproduce reported bugs with clear steps and evidence\n- verify UI/API behavior where applicable\n- separate blockers from follow-up polish\n\nDo not merge. End with pass/fail status, evidence, blockers, and recommended next action.',
    options: [
      {
        name: 'repo',
        description: 'Repository, PR, or feature to verify',
        type: 'string',
        defaultValue: 'the target repo',
      },
      {
        name: 'goal',
        description: 'Behavior, issue, or PR to validate',
        type: 'string',
        required: true,
      },
      {
        name: 'duration_minutes',
        description: 'QA timebox in minutes',
        type: 'integer',
        defaultValue: 45,
      },
    ],
  },
  {
    name: 'taskbooker',
    description: 'Have the agent book and delegate a work plan',
    prompt:
      'You are taskbooker for the next {{duration_minutes}} minutes. Break down the goal, delegate concrete work, track who owns what, and keep the workstream organized without doing the implementation yourself.\n\nFocus area: {{goal}}\nTarget repo or project: {{repo}}\n\nImportant constraints:\n- stay in this channel unless explicitly delegating cross-channel work\n- do not code the solution yourself\n- produce a clear delegation plan with the highest-leverage next actions first\n- keep checking back on delegated work until there is meaningful forward progress',
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
  {
    name: 'session',
    description: 'Manage the active agent session for this channel',
    prompt: '',
    system: true,
    subcommands: [
      {
        name: 'new',
        description: 'Start a fresh agent session in this channel',
        prompt: '',
        system: true,
        options: [
          {
            name: 'name',
            description: 'Optional friendly name for the next session',
            type: 'string',
          },
          {
            name: 'resume_from',
            description: 'Optional existing session ID to fork from',
            type: 'string',
          },
        ],
      },
      {
        name: 'resume',
        description: 'Resume a previous session in this channel',
        prompt: '',
        system: true,
        options: [
          {
            name: 'session_id',
            description: 'Session ID to resume (omit to see recent sessions)',
            type: 'string',
          },
        ],
      },
      {
        name: 'list',
        description: 'List recent sessions for this channel',
        prompt: '',
        system: true,
        options: [
          {
            name: 'limit',
            description:
              'Maximum number of sessions to show (default 10, max 25)',
            type: 'integer',
          },
        ],
      },
      {
        name: 'current',
        description: 'Show the active session for this channel',
        prompt: '',
        system: true,
      },
      {
        name: 'end',
        description: 'End the active session, optionally confirming its ID',
        prompt: '',
        system: true,
        options: [
          {
            name: 'session_id',
            description: 'Active session ID to confirm before ending',
            type: 'string',
          },
        ],
      },
      {
        name: 'rename',
        description: 'Give a session a friendly name',
        prompt: '',
        system: true,
        options: [
          {
            name: 'session_id',
            description: 'Session ID to rename',
            type: 'string',
            required: true,
          },
          {
            name: 'name',
            description: 'Friendly session name',
            type: 'string',
            required: true,
          },
        ],
      },
    ],
  },
  {
    name: 'resume',
    description: 'Resume a previous agent session in this channel',
    prompt: '',
    system: true,
    options: [
      {
        name: 'session_id',
        description: 'Session ID to resume (omit to see recent sessions)',
        type: 'string',
      },
    ],
  },
  {
    name: 'sessions',
    description: 'List recent agent sessions for this channel',
    prompt: '',
    system: true,
  },
];

const BUILTIN_SYSTEM_COMMAND_NAMES = new Set(
  BUILTIN_COMMANDS.filter((command) => command.system).map(
    (command) => command.name,
  ),
);

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
  if (prompt.length > MAX_PROMPT_LENGTH) {
    logger.warn(
      {
        source,
        name,
        promptLength: prompt.length,
        maxPromptLength: MAX_PROMPT_LENGTH,
      },
      'Ignoring Discord flow with oversized prompt',
    );
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

function isCommandEnabledForGroup(
  command: DiscordFlowDefinition,
  group: RegisteredGroup,
): boolean {
  const config = group.discordCommands;
  if (!config) return true;

  const enabled = new Set(config.enabled || []);
  const disabled = new Set(config.disabled || []);
  if (config.enabled !== undefined && !enabled.has(command.name)) return false;
  return !disabled.has(command.name);
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
      if (BUILTIN_SYSTEM_COMMAND_NAMES.has(command.name)) {
        logger.warn(
          { command: command.name, filePath },
          'Ignoring custom Discord command that conflicts with a system command',
        );
        continue;
      }
      commands.set(command.name, command);
    }
  }

  return [...commands.values()]
    .filter((command) => isCommandEnabledForGroup(command, group))
    .sort((a, b) => a.name.localeCompare(b.name));
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
      options: command.subcommands
        ? command.subcommands.map((subcommand) =>
            toDiscordSubcommandData(subcommand),
          )
        : toSortedDiscordOptionData(command.options),
    }));
}

function toDiscordSubcommandData(
  command: DiscordFlowDefinition,
): ApplicationCommandOptionData {
  return {
    type: ApplicationCommandOptionType.Subcommand,
    name: command.name,
    description: command.description,
    options: toSortedDiscordOptionData(command.options),
  } as ApplicationCommandOptionData;
}

function toSortedDiscordOptionData(
  options: DiscordFlowOptionDefinition[] | undefined,
): ApplicationCommandOptionData[] | undefined {
  return options
    ?.slice()
    .sort((a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required)))
    .map((option) => toDiscordOptionData(option));
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

/** Names of built-in system commands (handled by host, not agent). */
export const SYSTEM_COMMAND_NAMES = new Set(BUILTIN_SYSTEM_COMMAND_NAMES);

export type DiscordSessionCommand =
  | 'new'
  | 'resume'
  | 'list'
  | 'current'
  | 'end'
  | 'rename';

export const SESSION_COMMAND_NAMES = new Set<DiscordSessionCommand>([
  'new',
  'resume',
  'list',
  'current',
  'end',
  'rename',
]);

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
