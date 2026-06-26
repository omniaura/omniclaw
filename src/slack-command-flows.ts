/**
 * Slack slash command surface.
 *
 * Slack slash commands are declared in the Slack app manifest — there is no
 * runtime registration API like Discord. This module:
 *
 *   1. Generates the manifest command payload from the channel-agnostic flow
 *      definitions in `discord-command-flows.ts` (those types are shared
 *      across channels despite the historical filename).
 *   2. Parses the single `text` field Slack delivers into the typed option
 *      values each flow expects. Subcommands (used by `/session`) are read
 *      from the first whitespace-separated token.
 *
 * Slack delivers a payload where everything after the slash command name
 * lives in `text`. We accept two parsing modes for parity with Discord's
 * typed options:
 *
 *   • `key=value` segments override the named option (quoted values allowed).
 *   • Anything left over fills the first required string option, so users
 *     can type the natural form: `/research-driver investigate the foo bug`.
 */
import {
  SESSION_COMMAND_NAMES,
  type DiscordFlowDefinition,
  type DiscordFlowOptionDefinition,
  type DiscordFlowOptionType,
  type DiscordSessionCommand,
} from './discord-command-flows.js';

export type FlowDefinition = DiscordFlowDefinition;
export type FlowOptionDefinition = DiscordFlowOptionDefinition;
export type FlowOptionType = DiscordFlowOptionType;
export type SessionCommand = DiscordSessionCommand;

export interface SlackCommandManifestEntry {
  command: string;
  description: string;
  usage_hint?: string;
  should_escape: boolean;
}

/**
 * Build the `slash_commands` array Slack expects in its app manifest from a
 * set of resolved flow definitions. Subcommand-bearing flows (e.g. /session)
 * get a usage hint that names every subcommand so users see them in the
 * Slack command autocomplete preview.
 */
export function buildSlackSlashCommandManifest(
  flows: FlowDefinition[],
): SlackCommandManifestEntry[] {
  const seen = new Set<string>();
  const entries: SlackCommandManifestEntry[] = [];
  for (const flow of flows) {
    if (seen.has(flow.name)) continue;
    seen.add(flow.name);
    entries.push({
      command: `/${flow.name}`,
      description: flow.description,
      usage_hint: usageHintFor(flow),
      should_escape: false,
    });
  }
  return entries.sort((a, b) => a.command.localeCompare(b.command));
}

function usageHintFor(flow: FlowDefinition): string | undefined {
  if (flow.subcommands && flow.subcommands.length > 0) {
    const names = flow.subcommands.map((sc) => sc.name).join(' | ');
    return `${names} [options]`;
  }
  if (!flow.options || flow.options.length === 0) return undefined;
  return flow.options
    .map((opt) => {
      const placeholder = `<${opt.name}>`;
      return opt.required ? placeholder : `[${placeholder}]`;
    })
    .join(' ');
}

export interface ParsedSlackCommand {
  /** Resolved subcommand when the flow declares one. */
  subcommand?: string;
  /** Typed option values keyed by option name. */
  optionValues: Record<string, string | number | boolean | undefined>;
  /** Whatever the user typed after parsing key=value pairs. */
  remainder: string;
  /** Names of options that were filled from key=value pairs. */
  explicitOptions: Set<string>;
  /** Unrecognised key=value keys, surfaced for ephemeral warnings. */
  unknownOptions: string[];
}

/**
 * Parse a raw Slack `text` field against a flow definition. The first token
 * may be a subcommand; the remaining tokens are key=value pairs interleaved
 * with free-form text, which falls into the first required string option
 * that hasn't been set explicitly.
 */
export function parseSlackCommandText(
  raw: string,
  flow: FlowDefinition,
): ParsedSlackCommand {
  const explicitOptions = new Set<string>();
  const unknownOptions: string[] = [];

  let remaining = (raw || '').trim();
  let subcommand: string | undefined;
  let activeFlow: FlowDefinition = flow;

  if (flow.subcommands && flow.subcommands.length > 0) {
    const { head, rest } = splitFirstToken(remaining);
    if (head) {
      const matched = flow.subcommands.find(
        (sc) => sc.name === head.toLowerCase(),
      );
      if (matched) {
        subcommand = matched.name;
        activeFlow = matched;
        remaining = rest;
      } else if (
        flow.name === 'session' &&
        SESSION_COMMAND_NAMES.has(head.toLowerCase() as SessionCommand)
      ) {
        // Tolerate aliases users learn from the Discord help text.
        subcommand = head.toLowerCase();
        remaining = rest;
      }
    }
  }

  const tokens = tokenize(remaining);
  const optionValues: Record<string, string | number | boolean | undefined> =
    {};
  const optionByName = new Map<string, FlowOptionDefinition>();
  for (const opt of activeFlow.options || []) {
    optionByName.set(opt.name, opt);
  }

  const freeTextTokens: string[] = [];
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq > 0) {
      const key = token.slice(0, eq).trim();
      const rawValue = token.slice(eq + 1);
      if (!key) continue;
      const opt = optionByName.get(key);
      if (!opt) {
        unknownOptions.push(key);
        continue;
      }
      const coerced = coerceValue(rawValue, opt.type);
      if (coerced === undefined) continue;
      optionValues[opt.name] = coerced;
      explicitOptions.add(opt.name);
      continue;
    }
    freeTextTokens.push(token);
  }

  const freeText = freeTextTokens.join(' ').trim();
  if (freeText) {
    const target = pickFreeTextTarget(activeFlow, explicitOptions);
    if (target) {
      const coerced = coerceValue(freeText, target.type);
      if (coerced !== undefined) {
        optionValues[target.name] = coerced;
        explicitOptions.add(target.name);
      }
    }
  }

  return {
    subcommand,
    optionValues,
    remainder: freeText,
    explicitOptions,
    unknownOptions,
  };
}

function splitFirstToken(text: string): { head: string; rest: string } {
  const match = text.match(/^(\S+)(\s+([\s\S]*))?$/);
  if (!match) return { head: '', rest: '' };
  return { head: match[1], rest: (match[3] || '').trim() };
}

/**
 * Slack delivers `text` as a single string. We accept POSIX-ish quoting so
 * `goal="ship the thing"` is handled like a shell argv element while
 * unquoted whitespace splits tokens.
 */
function tokenize(input: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      i++;
      continue;
    }
    let token = '';
    while (i < input.length) {
      const c = input[i];
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (c === '"' || c === "'") {
        const quote = c;
        i++;
        while (i < input.length && input[i] !== quote) {
          token += input[i];
          i++;
        }
        if (i < input.length) i++; // consume closing quote
        continue;
      }
      token += c;
      i++;
    }
    if (token.length > 0) out.push(token);
  }
  return out;
}

function pickFreeTextTarget(
  flow: FlowDefinition,
  explicit: Set<string>,
): FlowOptionDefinition | undefined {
  const options = flow.options || [];
  const required = options.find(
    (opt) =>
      opt.required &&
      (opt.type === undefined || opt.type === 'string') &&
      !explicit.has(opt.name),
  );
  if (required) return required;
  return options.find(
    (opt) =>
      (opt.type === undefined || opt.type === 'string') &&
      !explicit.has(opt.name),
  );
}

function coerceValue(
  raw: string,
  type: FlowOptionType | undefined,
): string | number | boolean | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  switch (type) {
    case 'integer': {
      const n = Number.parseInt(value, 10);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean': {
      const lower = value.toLowerCase();
      if (['true', 'yes', '1', 'on'].includes(lower)) return true;
      if (['false', 'no', '0', 'off'].includes(lower)) return false;
      return undefined;
    }
    default:
      return value;
  }
}
