import { describe, expect, it } from 'bun:test';

import fs from 'fs';
import os from 'os';
import path from 'path';

import { ApplicationCommandOptionType } from 'discord.js';

import {
  buildDiscordSlashCommandPayloads,
  getDiscordFlowDefinitionsForGroup,
  renderDiscordFlowPrompt,
} from './discord-command-flows.js';
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

describe('discord command flows', () => {
  it('includes built-in flows for every group', () => {
    const names = getDiscordFlowDefinitionsForGroup(makeGroup()).map(
      (command) => command.name,
    );

    expect(names).toContain('mergemaster');
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
});
