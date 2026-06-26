import { describe, expect, it } from 'bun:test';

import {
  buildSlackSlashCommandManifest,
  parseSlackCommandText,
} from './slack-command-flows.js';
import type { DiscordFlowDefinition } from './discord-command-flows.js';

const RESEARCH_FLOW: DiscordFlowDefinition = {
  name: 'research-driver',
  description: 'Run technical/product research and propose paths',
  prompt: 'Research {{goal}} in {{repo}} for {{duration_minutes}} minutes',
  options: [
    {
      name: 'goal',
      description: 'Research question',
      type: 'string',
      required: true,
    },
    {
      name: 'repo',
      description: 'Repository',
      type: 'string',
      defaultValue: 'the target repo',
    },
    {
      name: 'duration_minutes',
      description: 'Timebox',
      type: 'integer',
      defaultValue: 45,
    },
  ],
};

const SESSION_FLOW: DiscordFlowDefinition = {
  name: 'session',
  description: 'Manage the active agent session',
  prompt: '',
  system: true,
  subcommands: [
    {
      name: 'new',
      description: 'Start a new session',
      prompt: '',
      system: true,
      options: [
        { name: 'name', description: '', type: 'string' },
        { name: 'resume_from', description: '', type: 'string' },
      ],
    },
    {
      name: 'list',
      description: 'List recent sessions',
      prompt: '',
      system: true,
      options: [{ name: 'limit', description: '', type: 'integer' }],
    },
    {
      name: 'current',
      description: 'Show the active session',
      prompt: '',
      system: true,
    },
  ],
};

describe('parseSlackCommandText — flows', () => {
  it('routes free text into the first required string option', () => {
    const parsed = parseSlackCommandText(
      'investigate the foo bug',
      RESEARCH_FLOW,
    );
    expect(parsed.optionValues.goal).toBe('investigate the foo bug');
    expect(parsed.subcommand).toBeUndefined();
    expect(parsed.unknownOptions).toEqual([]);
  });

  it('overrides options with key=value pairs and coerces typed values', () => {
    const parsed = parseSlackCommandText(
      'repo=omniclaw duration_minutes=15 investigate the bug',
      RESEARCH_FLOW,
    );
    expect(parsed.optionValues.repo).toBe('omniclaw');
    expect(parsed.optionValues.duration_minutes).toBe(15);
    expect(parsed.optionValues.goal).toBe('investigate the bug');
  });

  it('supports quoted values for multi-word options', () => {
    const parsed = parseSlackCommandText(
      'goal="ship the thing" repo=omniclaw',
      RESEARCH_FLOW,
    );
    expect(parsed.optionValues.goal).toBe('ship the thing');
    expect(parsed.optionValues.repo).toBe('omniclaw');
  });

  it('records unknown options for surfacing to the user', () => {
    const parsed = parseSlackCommandText(
      'foo=bar goal=research',
      RESEARCH_FLOW,
    );
    expect(parsed.unknownOptions).toEqual(['foo']);
    expect(parsed.optionValues.goal).toBe('research');
  });
});

describe('parseSlackCommandText — session subcommands', () => {
  it('parses /session new with name', () => {
    const parsed = parseSlackCommandText('new name=greenfield', SESSION_FLOW);
    expect(parsed.subcommand).toBe('new');
    expect(parsed.optionValues.name).toBe('greenfield');
  });

  it('parses /session list with integer limit', () => {
    const parsed = parseSlackCommandText('list limit=5', SESSION_FLOW);
    expect(parsed.subcommand).toBe('list');
    expect(parsed.optionValues.limit).toBe(5);
  });

  it('parses /session current with no options', () => {
    const parsed = parseSlackCommandText('current', SESSION_FLOW);
    expect(parsed.subcommand).toBe('current');
    expect(parsed.optionValues).toEqual({});
  });

  it('rejects unknown subcommands while preserving the parsed remainder', () => {
    const parsed = parseSlackCommandText('bogus arg', SESSION_FLOW);
    expect(parsed.subcommand).toBeUndefined();
  });
});

describe('buildSlackSlashCommandManifest', () => {
  it('emits one manifest entry per flow with usage hints', () => {
    const entries = buildSlackSlashCommandManifest([
      RESEARCH_FLOW,
      SESSION_FLOW,
    ]);
    expect(entries).toEqual([
      {
        command: '/research-driver',
        description: 'Run technical/product research and propose paths',
        usage_hint: '<goal> [<repo>] [<duration_minutes>]',
        should_escape: false,
      },
      {
        command: '/session',
        description: 'Manage the active agent session',
        usage_hint: 'new | list | current [options]',
        should_escape: false,
      },
    ]);
  });

  it('deduplicates flows that appear twice', () => {
    const entries = buildSlackSlashCommandManifest([
      RESEARCH_FLOW,
      RESEARCH_FLOW,
    ]);
    expect(entries).toHaveLength(1);
  });
});
