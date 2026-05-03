import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

import fs from 'fs';
import os from 'os';
import path from 'path';

import { ApplicationCommandOptionType } from 'discord.js';

import {
  buildDiscordSlashCommandPayloads,
  getDiscordFlowDefinitionsForGroup,
  renderDiscordFlowPrompt,
} from './discord-command-flows.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'Test Agent',
    folder: 'test-agent',
    trigger: '@TestAgent',
    added_at: '2026-03-18T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  mock.restore();
});

describe('discord command flows', () => {
  it('includes built-in flows for every group', () => {
    const names = getDiscordFlowDefinitionsForGroup(makeGroup()).map(
      (command) => command.name,
    );

    expect(names).toContain('implement-driver');
    expect(names).toContain('issue-driver');
    expect(names).toContain('mergemaster');
    expect(names).toContain('product-driver');
    expect(names).toContain('qa-driver');
    expect(names).toContain('research-driver');
    expect(names).toContain('taskbooker');
    expect(names).toContain('scheduler');
  });

  it('renders flow prompts with provided values and defaults', () => {
    const mergemaster = getDiscordFlowDefinitionsForGroup(makeGroup()).find(
      (command) => command.name === 'mergemaster',
    );

    expect(mergemaster).toBeDefined();
    expect(
      renderDiscordFlowPrompt(mergemaster!, {
        repo: 'mac-runner',
        goal: 'open issues',
      }),
    ).toContain('mac-runner');
    expect(
      renderDiscordFlowPrompt(mergemaster!, {
        repo: 'mac-runner',
        goal: 'open issues',
      }),
    ).toContain('60 minutes');
  });

  it('loads custom commands from the most specific workspace file', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclaw-flows-'));
    const groupsDir = path.join(tempRoot, 'groups');

    try {
      fs.mkdirSync(path.join(groupsDir, 'server'), { recursive: true });
      fs.mkdirSync(path.join(groupsDir, 'test-agent'), { recursive: true });
      fs.mkdirSync(path.join(groupsDir, 'server', 'channel'), {
        recursive: true,
      });

      fs.writeFileSync(
        path.join(groupsDir, 'test-agent', 'discord-commands.json'),
        JSON.stringify({
          commands: [
            {
              name: 'triage',
              description: 'Agent-level triage',
              prompt: 'Agent triage {{goal}}',
              options: [
                {
                  name: 'goal',
                  description: 'Goal',
                  required: true,
                },
              ],
            },
          ],
        }),
      );

      fs.writeFileSync(
        path.join(groupsDir, 'server', 'channel', 'discord-commands.json'),
        JSON.stringify([
          {
            name: 'triage',
            description: 'Channel-level triage',
            prompt: 'Channel triage {{goal}}',
            options: [
              {
                name: 'goal',
                description: 'Goal',
                required: true,
              },
            ],
          },
        ]),
      );

      const triage = getDiscordFlowDefinitionsForGroup(
        makeGroup({
          serverFolder: 'server',
          channelFolder: 'server/channel',
        }),
        groupsDir,
      ).find((command) => command.name === 'triage');

      expect(triage?.description).toBe('Channel-level triage');
      expect(triage?.prompt).toBe('Channel triage {{goal}}');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('filters built-in and custom commands by agent command config', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclaw-flows-'));
    const groupsDir = path.join(tempRoot, 'groups');

    try {
      fs.mkdirSync(path.join(groupsDir, 'test-agent'), { recursive: true });
      fs.writeFileSync(
        path.join(groupsDir, 'test-agent', 'discord-commands.json'),
        JSON.stringify({
          commands: [
            {
              name: 'custom-spike',
              description: 'Run a custom spike',
              prompt: 'Spike {{goal}}',
            },
          ],
        }),
      );

      const names = getDiscordFlowDefinitionsForGroup(
        makeGroup({
          discordCommands: {
            enabled: ['product-driver', 'issue-driver', 'custom-spike'],
            disabled: ['issue-driver'],
          },
        }),
        groupsDir,
      ).map((command) => command.name);

      expect(names).toEqual(['custom-spike', 'product-driver']);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('treats an empty enabled list as deny-all', () => {
    const names = getDiscordFlowDefinitionsForGroup(
      makeGroup({
        discordCommands: { enabled: [] },
      }),
    ).map((command) => command.name);

    expect(names).toEqual([]);
  });

  it('does not let custom command files override system commands', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclaw-flows-'));
    const groupsDir = path.join(tempRoot, 'groups');
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      fs.mkdirSync(path.join(groupsDir, 'test-agent'), { recursive: true });
      fs.writeFileSync(
        path.join(groupsDir, 'test-agent', 'discord-commands.json'),
        JSON.stringify({
          commands: [
            {
              name: 'resume',
              description: 'Malicious resume override',
              prompt: 'This should never replace the host system command.',
            },
          ],
        }),
      );

      const resume = getDiscordFlowDefinitionsForGroup(
        makeGroup(),
        groupsDir,
      ).find((command) => command.name === 'resume');

      expect(resume?.system).toBe(true);
      expect(resume?.prompt).toBe('');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'resume' }),
        'Ignoring custom Discord command that conflicts with a system command',
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('ignores custom commands with oversized prompts', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclaw-flows-'));
    const groupsDir = path.join(tempRoot, 'groups');

    try {
      fs.mkdirSync(path.join(groupsDir, 'test-agent'), { recursive: true });
      fs.writeFileSync(
        path.join(groupsDir, 'test-agent', 'discord-commands.json'),
        JSON.stringify({
          commands: [
            {
              name: 'too-big',
              description: 'Oversized prompt',
              prompt: 'x'.repeat(4001),
            },
          ],
        }),
      );

      const commands = getDiscordFlowDefinitionsForGroup(
        makeGroup(),
        groupsDir,
      );
      expect(
        commands.find((command) => command.name === 'too-big'),
      ).toBeUndefined();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('builds slash payloads with Discord option types', () => {
    const payloads = buildDiscordSlashCommandPayloads([makeGroup()]);
    const mergemaster = payloads.find(
      (command) => command.name === 'mergemaster',
    );

    expect(
      mergemaster?.options?.find((option) => option.name === 'repo')?.type,
    ).toBe(ApplicationCommandOptionType.String);
    expect(
      mergemaster?.options?.find((option) => option.name === 'duration_minutes')
        ?.type,
    ).toBe(ApplicationCommandOptionType.Integer);
  });

  it('ignores invalid commands and invalid options from custom files', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclaw-flows-'));
    const groupsDir = path.join(tempRoot, 'groups');

    try {
      fs.mkdirSync(path.join(groupsDir, 'test-agent'), { recursive: true });
      fs.writeFileSync(
        path.join(groupsDir, 'test-agent', 'discord-commands.json'),
        JSON.stringify({
          commands: [
            {
              name: 'valid-flow',
              description: 'Valid command',
              prompt: 'Run {{count}} times with {{enabled}}',
              options: [
                {
                  name: 'count',
                  description: 'Number of retries',
                  type: 'integer',
                  defaultValue: 3,
                },
                {
                  name: 'enabled',
                  description: 'Whether the task is enabled',
                  type: 'boolean',
                  defaultValue: true,
                },
                {
                  name: 'bad option!',
                  description: 'bad',
                },
              ],
            },
            {
              name: 'bad command!',
              description: 'Ignored',
              prompt: 'nope',
            },
          ],
        }),
      );

      const commands = getDiscordFlowDefinitionsForGroup(
        makeGroup(),
        groupsDir,
      );
      const validFlow = commands.find(
        (command) => command.name === 'valid-flow',
      );

      expect(validFlow).toBeDefined();
      expect(validFlow?.options).toHaveLength(2);
      expect(
        commands.find((command) => command.name === 'bad command!'),
      ).toBeUndefined();
      expect(
        renderDiscordFlowPrompt(validFlow!, { count: 5, enabled: false }),
      ).toBe('Run 5 times with false');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('deduplicates identical folder paths before reading command files', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclaw-flows-'));
    const groupsDir = path.join(tempRoot, 'groups');
    const readSpy = spyOn(fs, 'readFileSync');

    try {
      fs.mkdirSync(path.join(groupsDir, 'shared'), { recursive: true });
      fs.writeFileSync(
        path.join(groupsDir, 'shared', 'discord-commands.json'),
        JSON.stringify({
          commands: [
            {
              name: 'shared-flow',
              description: 'Shared command',
              prompt: 'Shared prompt',
            },
          ],
        }),
      );

      const commands = getDiscordFlowDefinitionsForGroup(
        makeGroup({
          serverFolder: 'shared',
          categoryFolder: 'shared',
          folder: 'shared',
          channelFolder: 'shared',
        }),
        groupsDir,
      );

      expect(
        commands.find((command) => command.name === 'shared-flow'),
      ).toBeDefined();
      expect(
        readSpy.mock.calls.filter((call) =>
          String(call[0]).endsWith(
            path.join('shared', 'discord-commands.json'),
          ),
        ),
      ).toHaveLength(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps the first slash command definition when groups conflict', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclaw-flows-'));
    const groupsDir = path.join(tempRoot, 'groups');
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      fs.mkdirSync(path.join(groupsDir, 'group-a'), { recursive: true });
      fs.mkdirSync(path.join(groupsDir, 'group-b'), { recursive: true });
      fs.writeFileSync(
        path.join(groupsDir, 'group-a', 'discord-commands.json'),
        JSON.stringify({
          commands: [
            {
              name: 'triage',
              description: 'First definition',
              prompt: 'first',
            },
          ],
        }),
      );
      fs.writeFileSync(
        path.join(groupsDir, 'group-b', 'discord-commands.json'),
        JSON.stringify({
          commands: [
            {
              name: 'triage',
              description: 'Second definition',
              prompt: 'second',
            },
          ],
        }),
      );

      const payloads = buildDiscordSlashCommandPayloads(
        [makeGroup({ folder: 'group-a' }), makeGroup({ folder: 'group-b' })],
        groupsDir,
      );
      const triage = payloads.find((command) => command.name === 'triage');

      expect(triage?.description).toBe('First definition');
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('logs and ignores malformed command files', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclaw-flows-'));
    const groupsDir = path.join(tempRoot, 'groups');
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      fs.mkdirSync(path.join(groupsDir, 'test-agent'), { recursive: true });
      fs.writeFileSync(
        path.join(groupsDir, 'test-agent', 'discord-commands.json'),
        '{ not valid json',
      );

      const names = getDiscordFlowDefinitionsForGroup(
        makeGroup(),
        groupsDir,
      ).map((command) => command.name);

      expect(names).toContain('mergemaster');
      expect(names).not.toContain('test-agent');
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
