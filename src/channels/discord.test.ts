import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MessageFlags } from 'discord.js';
import fs from 'fs';
import path from 'path';

import {
  jidToChannelId,
  DiscordChannel,
  getAttachmentWorkspaceFolder,
  isImageAttachment,
} from './discord.js';
import { _initTestDatabase, setAgent, setChannelSubscription } from '../db.js';
import { GROUPS_DIR } from '../config.js';
import {
  downloadBinaryAttachment,
  downloadTextAttachment,
  readStreamWithByteLimit,
} from '../media.js';
import type { RegisteredGroup } from '../types.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  _initTestDatabase();
});

function createStream(
  chunks: Array<string | Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk,
        );
      }
      controller.close();
    },
  });
}

// --- jidToChannelId ---

describe('Discord jidToChannelId', () => {
  it('extracts channel ID from guild channel JID', () => {
    expect(jidToChannelId('dc:1234567890')).toBe('1234567890');
  });

  it('returns null for DM JIDs (dc:dm: prefix)', () => {
    expect(jidToChannelId('dc:dm:9876543210')).toBeNull();
  });

  it('returns null for non-Discord JIDs', () => {
    expect(jidToChannelId('slack:C12345')).toBeNull();
    expect(jidToChannelId('tg:12345')).toBeNull();
    expect(jidToChannelId('main@g.us')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(jidToChannelId('')).toBeNull();
  });

  it('handles JID with just the dc: prefix', () => {
    expect(jidToChannelId('dc:')).toBe('');
  });

  it('handles JID with extra colons', () => {
    // dc:some:thing — starts with dc: but not dc:dm:, so slices after "dc:"
    expect(jidToChannelId('dc:some:thing')).toBe('some:thing');
  });
});

// --- DiscordChannel.ownsJid ---

describe('DiscordChannel.ownsJid', () => {
  const channel = new DiscordChannel({
    token: 'test-token-not-used',
    botId: 'test-bot-id',
  });

  it('matches dc: prefixed JIDs', () => {
    expect(channel.ownsJid('dc:123456')).toBe(true);
  });

  it('matches dc:dm: prefixed JIDs', () => {
    expect(channel.ownsJid('dc:dm:user123')).toBe(true);
  });

  it('does not match non-Discord JIDs', () => {
    expect(channel.ownsJid('slack:C123')).toBe(false);
    expect(channel.ownsJid('tg:123')).toBe(false);
    expect(channel.ownsJid('main@g.us')).toBe(false);
  });
});

describe('getAttachmentWorkspaceFolder', () => {
  it('uses channelFolder when available', () => {
    expect(
      getAttachmentWorkspaceFolder({
        folder: 'rind',
        channelFolder: 'servers/123/channels/456',
      }),
    ).toBe('servers/123/channels/456');
  });

  it('falls back to agent folder when channelFolder is missing', () => {
    expect(getAttachmentWorkspaceFolder({ folder: 'rind' })).toBe('rind');
  });
});

// --- isImageAttachment ---

describe('isImageAttachment', () => {
  it('matches when contentType starts with image/', () => {
    expect(
      isImageAttachment({ contentType: 'image/png', name: 'photo.png' }),
    ).toBe(true);
    expect(
      isImageAttachment({ contentType: 'image/jpeg', name: 'photo.jpg' }),
    ).toBe(true);
    expect(
      isImageAttachment({ contentType: 'image/gif', name: 'anim.gif' }),
    ).toBe(true);
    expect(
      isImageAttachment({ contentType: 'image/webp', name: 'img.webp' }),
    ).toBe(true);
  });

  it('rejects when contentType is a known non-image type', () => {
    expect(
      isImageAttachment({ contentType: 'application/pdf', name: 'doc.pdf' }),
    ).toBe(false);
    expect(
      isImageAttachment({ contentType: 'text/plain', name: 'notes.txt' }),
    ).toBe(false);
    expect(
      isImageAttachment({ contentType: 'video/mp4', name: 'clip.mp4' }),
    ).toBe(false);
  });

  it('falls back to extension when contentType is null', () => {
    expect(
      isImageAttachment({ contentType: null, name: 'screenshot.png' }),
    ).toBe(true);
    expect(isImageAttachment({ contentType: null, name: 'photo.jpg' })).toBe(
      true,
    );
    expect(isImageAttachment({ contentType: null, name: 'image.jpeg' })).toBe(
      true,
    );
    expect(isImageAttachment({ contentType: null, name: 'anim.gif' })).toBe(
      true,
    );
    expect(isImageAttachment({ contentType: null, name: 'pic.webp' })).toBe(
      true,
    );
  });

  it('falls back to extension when contentType is undefined', () => {
    expect(isImageAttachment({ name: 'screenshot.png' })).toBe(true);
    expect(isImageAttachment({ name: 'doc.pdf' })).toBe(false);
  });

  it('rejects non-image extensions when contentType is null', () => {
    expect(isImageAttachment({ contentType: null, name: 'file.txt' })).toBe(
      false,
    );
    expect(isImageAttachment({ contentType: null, name: 'app.exe' })).toBe(
      false,
    );
    expect(isImageAttachment({ contentType: null, name: 'data.json' })).toBe(
      false,
    );
  });

  it('handles missing name when contentType is null', () => {
    expect(isImageAttachment({ contentType: null })).toBe(false);
    expect(isImageAttachment({ contentType: null, name: null })).toBe(false);
  });
});

describe('Discord download guards', () => {
  it('reads streamed responses within the byte limit', async () => {
    const bytes = await readStreamWithByteLimit(
      createStream(['hello', ' ', 'world']),
      32,
    );

    expect(bytes.toString()).toBe('hello world');
  });

  it('rejects streamed responses that exceed the byte limit', async () => {
    await expect(
      readStreamWithByteLimit(createStream(['12345', '67890']), 8),
    ).rejects.toThrow('Download exceeded 8 bytes');
  });

  it('applies capped streamed downloads for binary attachments', async () => {
    let capturedSignal: AbortSignal | null = null;

    globalThis.fetch = mock(
      (_url: string | URL | Request, init?: RequestInit) => {
        capturedSignal = init?.signal as AbortSignal | null;
        return Promise.resolve(
          new Response(createStream([new Uint8Array([1, 2, 3, 4])])),
        );
      },
    ) as unknown as typeof globalThis.fetch;

    const bytes = await downloadBinaryAttachment(
      'https://cdn.discordapp.test/file.png',
    );

    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    expect(capturedSignal).toBeTruthy();
  });

  it('rejects text attachments when the actual response body exceeds the cap', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(createStream(['a'.repeat(70_000), 'b'.repeat(40_000)])),
      ),
    ) as unknown as typeof globalThis.fetch;

    await expect(
      downloadTextAttachment('https://cdn.discordapp.test/file.txt'),
    ).rejects.toThrow('Download exceeded 102400 bytes');
  });
});

describe('Discord slash flows', () => {
  it('routes /session subcommands to the host session handler', async () => {
    let received:
      | {
          command: string;
          sessionId?: string;
          name?: string;
        }
      | undefined;
    const channel = new DiscordChannel({
      token: 'test-token-not-used',
      botId: 'PRIMARY',
      onSessionCommand: (command, _chatJid, _group, options) => {
        received = {
          command,
          sessionId: options?.sessionId,
          name: options?.name,
        };
        return { message: 'renamed' };
      },
    });

    setAgent({
      id: 'clayton-discord',
      name: 'Clayton',
      folder: 'clayton-discord',
      backend: 'apple-container',
      agentRuntime: 'claude-agent-sdk',
      isAdmin: false,
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    setChannelSubscription({
      channelJid: 'dc:1474995286903361772',
      agentId: 'clayton-discord',
      trigger: '@Clayton',
      requiresTrigger: true,
      priority: 0,
      isPrimary: true,
      discordBotId: 'PRIMARY',
      discordGuildId: '753336633083953213',
      createdAt: '2026-05-01T00:00:00.000Z',
    });

    const interaction = {
      id: '1499999999999999999',
      commandName: 'session',
      channelId: '1474995286903361772',
      guildId: '753336633083953213',
      inGuild: () => true,
      memberPermissions: { has: () => true },
      options: {
        getSubcommand: () => 'rename',
        getString: (name: string) =>
          name === 'session_id'
            ? '123e4567-e89b-12d3-a456-426614174000'
            : name === 'name'
              ? 'launch triage'
              : null,
        getInteger: () => null,
        getBoolean: () => null,
      },
      deferReply: mock(async () => {}),
      editReply: mock(async () => {}),
      followUp: mock(async () => {}),
    };

    await (
      channel as unknown as {
        handleSlashCommand: (input: typeof interaction) => Promise<void>;
      }
    ).handleSlashCommand(interaction);

    expect(received).toEqual({
      command: 'rename',
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
      name: 'launch triage',
    });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'renamed',
    });
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('forwards /session new resume_from to the host session handler', async () => {
    let received:
      | {
          command: string;
          resumeFrom?: string;
          name?: string;
        }
      | undefined;
    const channel = new DiscordChannel({
      token: 'test-token-not-used',
      botId: 'PRIMARY',
      onSessionCommand: (command, _chatJid, _group, options) => {
        received = {
          command,
          resumeFrom: options?.resumeFrom,
          name: options?.name,
        };
        return { message: 'queued' };
      },
    });

    setAgent({
      id: 'clayton-discord',
      name: 'Clayton',
      folder: 'clayton-discord',
      backend: 'apple-container',
      agentRuntime: 'claude-agent-sdk',
      isAdmin: false,
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    setChannelSubscription({
      channelJid: 'dc:1474995286903361772',
      agentId: 'clayton-discord',
      trigger: '@Clayton',
      requiresTrigger: true,
      priority: 0,
      isPrimary: true,
      discordBotId: 'PRIMARY',
      discordGuildId: '753336633083953213',
      createdAt: '2026-05-01T00:00:00.000Z',
    });

    const interaction = {
      id: '1499999999999999999',
      commandName: 'session',
      channelId: '1474995286903361772',
      guildId: '753336633083953213',
      inGuild: () => true,
      memberPermissions: { has: () => true },
      options: {
        getSubcommand: () => 'new',
        getString: (name: string) =>
          name === 'resume_from'
            ? '123e4567-e89b-12d3-a456-426614174000'
            : name === 'name'
              ? 'launch triage'
              : null,
        getInteger: () => null,
        getBoolean: () => null,
      },
      deferReply: mock(async () => {}),
      editReply: mock(async () => {}),
      followUp: mock(async () => {}),
    };

    await (
      channel as unknown as {
        handleSlashCommand: (input: typeof interaction) => Promise<void>;
      }
    ).handleSlashCommand(interaction);

    expect(received).toEqual({
      command: 'new',
      resumeFrom: '123e4567-e89b-12d3-a456-426614174000',
      name: 'launch triage',
    });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'queued',
    });
  });

  it('routes legacy /sessions to /session list with deprecation metadata', async () => {
    let received:
      | {
          command: string;
          deprecatedAlias?: string;
        }
      | undefined;
    const channel = new DiscordChannel({
      token: 'test-token-not-used',
      botId: 'PRIMARY',
      onSessionCommand: (command, _chatJid, _group, options) => {
        received = {
          command,
          deprecatedAlias: options?.deprecatedAlias,
        };
        return { message: 'listed' };
      },
    });

    setAgent({
      id: 'clayton-discord',
      name: 'Clayton',
      folder: 'clayton-discord',
      backend: 'apple-container',
      agentRuntime: 'claude-agent-sdk',
      isAdmin: false,
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    setChannelSubscription({
      channelJid: 'dc:1474995286903361772',
      agentId: 'clayton-discord',
      trigger: '@Clayton',
      requiresTrigger: true,
      priority: 0,
      isPrimary: true,
      discordBotId: 'PRIMARY',
      discordGuildId: '753336633083953213',
      createdAt: '2026-05-01T00:00:00.000Z',
    });

    const interaction = {
      id: '1499999999999999999',
      commandName: 'sessions',
      channelId: '1474995286903361772',
      guildId: '753336633083953213',
      inGuild: () => true,
      memberPermissions: { has: () => true },
      options: {
        getSubcommand: () => null,
        getString: () => null,
        getInteger: () => null,
        getBoolean: () => null,
      },
      deferReply: mock(async () => {}),
      editReply: mock(async () => {}),
      followUp: mock(async () => {}),
    };

    await (
      channel as unknown as {
        handleSlashCommand: (input: typeof interaction) => Promise<void>;
      }
    ).handleSlashCommand(interaction);

    expect(received).toEqual({
      command: 'list',
      deprecatedAlias: 'sessions',
    });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'listed',
    });
  });

  it('acknowledges the interaction before queueing the synthetic message', async () => {
    let deferred = false;
    let queued = false;
    const channel = new DiscordChannel({
      token: 'test-token-not-used',
      botId: 'PRIMARY',
      onSyntheticMessage: () => {
        expect(deferred).toBe(true);
        queued = true;
      },
    });

    setAgent({
      id: 'clayton-discord',
      name: 'Clayton',
      folder: 'clayton-discord',
      backend: 'apple-container',
      agentRuntime: 'claude-agent-sdk',
      isAdmin: false,
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    setChannelSubscription({
      channelJid: 'dc:1474995286903361772',
      agentId: 'clayton-discord',
      trigger: '@Clayton',
      requiresTrigger: true,
      priority: 0,
      isPrimary: true,
      discordBotId: 'PRIMARY',
      discordGuildId: '753336633083953213',
      createdAt: '2026-05-01T00:00:00.000Z',
    });

    const interaction = {
      id: '1499999999999999999',
      commandName: 'mergemaster',
      channelId: '1474995286903361772',
      guildId: '753336633083953213',
      inGuild: () => true,
      member: { displayName: 'Future Trees' },
      user: {
        id: '217828620029132802',
        globalName: 'Future Trees',
        username: 'futuretrees',
      },
      channel: { name: 'agentflow' },
      options: {
        getString: (name: string) =>
          name === 'repo'
            ? 'omniclaw'
            : name === 'goal'
              ? 'clear the queue'
              : null,
        getInteger: (name: string) => (name === 'duration_minutes' ? 60 : null),
        getBoolean: () => null,
      },
      deferReply: mock(async () => {
        deferred = true;
      }),
      editReply: mock(async () => {}),
      followUp: mock(async () => {}),
    };

    await (
      channel as unknown as {
        handleSlashCommand: (input: typeof interaction) => Promise<void>;
      }
    ).handleSlashCommand(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Queued "/mergemaster" for Clayton.',
    });
    expect(queued).toBe(true);
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('sends follow-up when queueing fails after acknowledgement', async () => {
    const channel = new DiscordChannel({
      token: 'test-token-not-used',
      botId: 'PRIMARY',
      onSyntheticMessage: () => {
        throw new Error('queue failed');
      },
    });

    setAgent({
      id: 'clayton-discord',
      name: 'Clayton',
      folder: 'clayton-discord',
      backend: 'apple-container',
      agentRuntime: 'claude-agent-sdk',
      isAdmin: false,
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    setChannelSubscription({
      channelJid: 'dc:1474995286903361772',
      agentId: 'clayton-discord',
      trigger: '@Clayton',
      requiresTrigger: true,
      priority: 0,
      isPrimary: true,
      discordBotId: 'PRIMARY',
      discordGuildId: '753336633083953213',
      createdAt: '2026-05-01T00:00:00.000Z',
    });

    const interaction = {
      id: '1499999999999999999',
      commandName: 'mergemaster',
      channelId: '1474995286903361772',
      guildId: '753336633083953213',
      inGuild: () => true,
      member: { displayName: 'Future Trees' },
      user: {
        id: '217828620029132802',
        globalName: 'Future Trees',
        username: 'futuretrees',
      },
      channel: { name: 'agentflow' },
      options: {
        getString: (name: string) =>
          name === 'repo'
            ? 'omniclaw'
            : name === 'goal'
              ? 'clear the queue'
              : null,
        getInteger: (name: string) => (name === 'duration_minutes' ? 60 : null),
        getBoolean: () => null,
      },
      deferReply: mock(async () => {}),
      editReply: mock(async () => {}),
      followUp: mock(async () => {}),
    };

    await (
      channel as unknown as {
        handleSlashCommand: (input: typeof interaction) => Promise<void>;
      }
    ).handleSlashCommand(interaction);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Queued "/mergemaster" for Clayton.',
    });
    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    expect(interaction.followUp).toHaveBeenCalledWith({
      content:
        'I acknowledged the command, but failed to queue it. Check OmniClaw logs for details.',
      ephemeral: true,
    });
  });

  // ---------------------------------------------------------------------------
  // Codex / OpenCode / per-channel slash sync coverage (#639).
  //
  // The post-#635 architecture derives slash command groups from canonical
  // `channelSubscriptions` via the `slashCommandGroups` callback. The cases
  // below pin behavior for non-Claude runtimes (Codex, OpenCode), for the
  // subscription-derived channel-folder lookup, and for the full
  // registration → invoke → routing path that PR #635's review (Cody)
  // explicitly asked for. Tests share a folder cleanup set so concurrent
  // workers don't leak fixtures under the canonical `groups/` directory.
  // ---------------------------------------------------------------------------
  describe('non-Claude runtime + channel-folder sync', () => {
    const createdFolders = new Set<string>();

    afterEach(() => {
      for (const folder of createdFolders) {
        const absolute = path.join(GROUPS_DIR, folder);
        if (fs.existsSync(absolute)) {
          fs.rmSync(absolute, { recursive: true, force: true });
        }
      }
      createdFolders.clear();
    });

    function writeDiscordCommandFile(
      relativeFolder: string,
      commandName: string,
      prompt = 'Run the {{topic}} flow for {{repo}}',
    ): void {
      createdFolders.add(relativeFolder);
      const folder = path.join(GROUPS_DIR, relativeFolder);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(
        path.join(folder, 'discord-commands.json'),
        JSON.stringify(
          {
            commands: [
              {
                name: commandName,
                description: 'Per-channel test flow',
                prompt,
                options: [
                  {
                    name: 'repo',
                    description: 'Repository to target',
                    type: 'string',
                    defaultValue: 'omniclaw',
                  },
                  {
                    name: 'topic',
                    description: 'What to drive',
                    type: 'string',
                    defaultValue: 'triage',
                  },
                ],
              },
            ],
          },
          null,
          2,
        ),
      );
    }

    function mockGuildCommandsApi(
      channel: DiscordChannel,
      setCommands: (commands: unknown[]) => Promise<void>,
    ): void {
      const fetchGuild = mock(async () => ({
        commands: { set: setCommands },
      }));
      (
        channel as unknown as {
          connected: boolean;
          client: {
            guilds: { fetch: (guildId: string) => Promise<unknown> };
          };
        }
      ).connected = true;
      (
        channel as unknown as {
          client: {
            guilds: { fetch: (guildId: string) => Promise<unknown> };
          };
        }
      ).client = { guilds: { fetch: fetchGuild } };
    }

    it('syncs builtin slash commands for a Codex-runtime bot', async () => {
      const setCommands = mock(async (_commands: unknown[]) => {});
      const channel = new DiscordChannel({
        token: 'test-token-not-used',
        botId: 'CODEX',
        slashCommandGroups: () => [
          {
            name: 'Dex',
            folder: 'dex-discord',
            trigger: '@Dex',
            added_at: '2026-05-01T00:00:00.000Z',
            discordBotId: 'CODEX',
            discordGuildId: '753336633083953213',
            backend: 'apple-container',
            agentRuntime: 'codex',
          },
        ],
      });
      mockGuildCommandsApi(channel, setCommands);

      await channel.refreshSlashCommands();

      expect(setCommands).toHaveBeenCalledTimes(1);
      const commands = setCommands.mock.calls[0]?.[0] as Array<{
        name: string;
      }>;
      // mergemaster is a builtin so it should appear for any runtime.
      expect(commands.map((c) => c.name)).toContain('mergemaster');
    });

    it('syncs builtin slash commands for an OpenCode-runtime bot', async () => {
      const setCommands = mock(async (_commands: unknown[]) => {});
      const channel = new DiscordChannel({
        token: 'test-token-not-used',
        botId: 'OPENCODE',
        slashCommandGroups: () => [
          {
            name: 'Otto',
            folder: 'otto-discord',
            trigger: '@Otto',
            added_at: '2026-05-01T00:00:00.000Z',
            discordBotId: 'OPENCODE',
            discordGuildId: '753336633083953213',
            backend: 'apple-container',
            agentRuntime: 'opencode',
          },
        ],
      });
      mockGuildCommandsApi(channel, setCommands);

      await channel.refreshSlashCommands();

      expect(setCommands).toHaveBeenCalledTimes(1);
      const commands = setCommands.mock.calls[0]?.[0] as Array<{
        name: string;
      }>;
      expect(commands.map((c) => c.name)).toContain('mergemaster');
    });

    it('picks up custom commands from a subscription-derived channel folder', async () => {
      const setCommands = mock(async (_commands: unknown[]) => {});
      const guildId = '753336633083953214';
      const channelId = '1474995286903361773';
      const channelFolder = path.join(
        'servers',
        guildId,
        'channels',
        channelId,
      );
      writeDiscordCommandFile(channelFolder, 'channeltest');

      const channel = new DiscordChannel({
        token: 'test-token-not-used',
        botId: 'CODEX',
        slashCommandGroups: () => [
          {
            name: 'Dex',
            folder: 'dex-discord',
            trigger: '@Dex',
            added_at: '2026-05-01T00:00:00.000Z',
            discordBotId: 'CODEX',
            discordGuildId: guildId,
            channelFolder,
            backend: 'apple-container',
            agentRuntime: 'codex',
          },
        ],
      });
      mockGuildCommandsApi(channel, setCommands);

      await channel.refreshSlashCommands();

      expect(setCommands).toHaveBeenCalledTimes(1);
      const commands = setCommands.mock.calls[0]?.[0] as Array<{
        name: string;
      }>;
      expect(commands.map((c) => c.name)).toContain('channeltest');
    });

    it('falls back to legacy single-bot registeredGroups when slashCommandGroups is absent', async () => {
      const setCommands = mock(async (_commands: unknown[]) => {});
      const channel = new DiscordChannel({
        token: 'test-token-not-used',
        botId: 'PRIMARY',
        registeredGroups: () => ({
          'dc:1474995286903361776': {
            name: 'Clayton',
            folder: 'clayton-discord',
            trigger: '@Clayton',
            added_at: '2026-05-01T00:00:00.000Z',
            discordBotId: 'PRIMARY',
            discordGuildId: '753336633083953215',
            backend: 'apple-container',
            agentRuntime: 'claude-agent-sdk',
          },
        }),
      });
      mockGuildCommandsApi(channel, setCommands);

      await channel.refreshSlashCommands();

      expect(setCommands).toHaveBeenCalledTimes(1);
      const commands = setCommands.mock.calls[0]?.[0] as Array<{
        name: string;
      }>;
      expect(commands.map((c) => c.name)).toContain('mergemaster');
    });

    it('routes a derived channel-folder slash command end-to-end (register → invoke → synthetic message)', async () => {
      // Cody's follow-up on #635: prove the derived channel-folder slash
      // command path works for *execution*, not only registration. Wires a
      // Codex subscription with a custom `channeltest` command in its
      // derived channel folder, then asserts both that the slash sync
      // includes it and that invoking it dispatches a synthetic message
      // with the rendered prompt to onSyntheticMessage.
      const guildId = '753336633083953216';
      const channelId = '1474995286903361777';
      const channelFolder = path.join(
        'servers',
        guildId,
        'channels',
        channelId,
      );
      writeDiscordCommandFile(
        channelFolder,
        'channeltest',
        'Drive {{topic}} on {{repo}}.',
      );

      let synthetic: { trigger?: string; content?: string } | undefined;
      const setCommands = mock(async (_commands: unknown[]) => {});
      const codexGroup: RegisteredGroup = {
        name: 'Dex',
        folder: 'dex-discord',
        trigger: '@Dex',
        added_at: '2026-05-01T00:00:00.000Z',
        discordBotId: 'CODEX',
        discordGuildId: guildId,
        channelFolder,
        backend: 'apple-container',
        agentRuntime: 'codex',
      };
      const channel = new DiscordChannel({
        token: 'test-token-not-used',
        botId: 'CODEX',
        slashCommandGroups: () => [codexGroup],
        onSyntheticMessage: (message) => {
          synthetic = {
            trigger: codexGroup.trigger,
            content: message.content,
          };
        },
      });
      mockGuildCommandsApi(channel, setCommands);

      // Registration path: confirm the derived channel-folder command is
      // sent to Discord.
      setAgent({
        id: 'dex-discord',
        name: 'Dex',
        folder: 'dex-discord',
        backend: 'apple-container',
        agentRuntime: 'codex',
        isAdmin: false,
        createdAt: '2026-05-01T00:00:00.000Z',
      });
      setChannelSubscription({
        channelJid: `dc:${channelId}`,
        agentId: 'dex-discord',
        trigger: '@Dex',
        requiresTrigger: true,
        priority: 0,
        isPrimary: true,
        discordBotId: 'CODEX',
        discordGuildId: guildId,
        channelFolder,
        createdAt: '2026-05-01T00:00:00.000Z',
      });
      await channel.refreshSlashCommands();
      const registered = setCommands.mock.calls[0]?.[0] as Array<{
        name: string;
      }>;
      expect(registered.map((c) => c.name)).toContain('channeltest');

      // Execution path: invoking the command must reach onSyntheticMessage
      // with the rendered prompt prefixed by the group trigger.
      const interaction = {
        id: '1499999999999999999',
        commandName: 'channeltest',
        channelId,
        guildId,
        inGuild: () => true,
        member: { displayName: 'Future Trees' },
        user: {
          id: '217828620029132802',
          globalName: 'Future Trees',
          username: 'futuretrees',
        },
        channel: { name: 'channel-test' },
        options: {
          getString: (name: string) =>
            name === 'repo' ? 'omniclaw' : name === 'topic' ? 'triage' : null,
          getInteger: () => null,
          getBoolean: () => null,
        },
        deferReply: mock(async () => {}),
        editReply: mock(async () => {}),
        followUp: mock(async () => {}),
      };

      await (
        channel as unknown as {
          handleSlashCommand: (input: typeof interaction) => Promise<void>;
        }
      ).handleSlashCommand(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith({
        content: 'Queued "/channeltest" for Dex.',
      });
      expect(synthetic).toBeDefined();
      expect(synthetic?.content).toBe('@Dex Drive triage on omniclaw.');
      expect(interaction.followUp).not.toHaveBeenCalled();
    });
  });
});

// --- shouldAutoRespond ---

describe('Discord shouldAutoRespond', () => {
  // shouldAutoRespond is an instance method, but we need a DiscordChannel instance.
  // Since the constructor requires a token, we create a minimal instance with a dummy token.
  // The method only uses `content` and `group` parameters — no actual Discord connection needed.
  const channel = new DiscordChannel({
    token: 'test-token-not-used',
    botId: 'test-bot-id',
  });

  function makeGroup(
    overrides: Partial<RegisteredGroup> = {},
  ): RegisteredGroup {
    return {
      name: 'Test',
      folder: 'test',
      trigger: '@Bot',
      added_at: '2025-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  describe('question detection (autoRespondToQuestions)', () => {
    it('responds to messages ending with ?', () => {
      const group = makeGroup({ autoRespondToQuestions: true });
      expect(channel.shouldAutoRespond('What time is it?', group)).toBe(true);
    });

    it('trims content before checking for trailing ?', () => {
      const group = makeGroup({ autoRespondToQuestions: true });
      // content.trim().endsWith('?') — trailing whitespace is trimmed first
      expect(channel.shouldAutoRespond('What time is it?  ', group)).toBe(true);
      expect(channel.shouldAutoRespond('  What time is it?  ', group)).toBe(
        true,
      );
    });

    it('does not respond to questions when autoRespondToQuestions is false', () => {
      const group = makeGroup({ autoRespondToQuestions: false });
      expect(channel.shouldAutoRespond('What time is it?', group)).toBe(false);
    });

    it('does not respond to questions when autoRespondToQuestions is undefined', () => {
      const group = makeGroup();
      expect(channel.shouldAutoRespond('What time is it?', group)).toBe(false);
    });

    it('does not respond to non-question messages', () => {
      const group = makeGroup({ autoRespondToQuestions: true });
      expect(channel.shouldAutoRespond('Hello world', group)).toBe(false);
    });

    it('does not respond to empty content', () => {
      const group = makeGroup({ autoRespondToQuestions: true });
      expect(channel.shouldAutoRespond('', group)).toBe(false);
    });

    it('responds to multi-line messages ending with ?', () => {
      const group = makeGroup({ autoRespondToQuestions: true });
      expect(
        channel.shouldAutoRespond('Line one\nLine two\nQuestion?', group),
      ).toBe(true);
    });
  });

  describe('keyword matching (autoRespondKeywords)', () => {
    it('matches keyword with word boundary (case-insensitive)', () => {
      const group = makeGroup({ autoRespondKeywords: ['help'] });
      expect(channel.shouldAutoRespond('I need help with this', group)).toBe(
        true,
      );
    });

    it('is case-insensitive', () => {
      const group = makeGroup({ autoRespondKeywords: ['help'] });
      expect(channel.shouldAutoRespond('HELP me please', group)).toBe(true);
      expect(channel.shouldAutoRespond('Help Me', group)).toBe(true);
    });

    it('does not match partial words (word boundary)', () => {
      const group = makeGroup({ autoRespondKeywords: ['help'] });
      expect(channel.shouldAutoRespond('That was helpful', group)).toBe(false);
      expect(channel.shouldAutoRespond('The helper arrived', group)).toBe(
        false,
      );
    });

    it('matches when keyword is the entire message', () => {
      const group = makeGroup({ autoRespondKeywords: ['status'] });
      expect(channel.shouldAutoRespond('status', group)).toBe(true);
    });

    it('matches multiple keywords (any match)', () => {
      const group = makeGroup({
        autoRespondKeywords: ['hello', 'help', 'status'],
      });
      expect(channel.shouldAutoRespond('Can you help', group)).toBe(true);
      expect(channel.shouldAutoRespond('Check the status', group)).toBe(true);
      expect(channel.shouldAutoRespond('Say hello', group)).toBe(true);
    });

    it('does not match when no keywords match', () => {
      const group = makeGroup({ autoRespondKeywords: ['help', 'status'] });
      expect(channel.shouldAutoRespond('Just chatting here', group)).toBe(
        false,
      );
    });

    it('escapes special regex characters in keywords', () => {
      // The regex escapes special chars, but \b after non-word chars like '+'
      // has a known edge case: \b between non-word chars doesn't always trigger.
      // Test with a keyword containing a dot (also special but works with \b).
      const group = makeGroup({ autoRespondKeywords: ['file.txt'] });
      expect(channel.shouldAutoRespond('Open file.txt now', group)).toBe(true);
      // Dot is escaped — should not match "fileXtxt"
      expect(channel.shouldAutoRespond('Open fileXtxt now', group)).toBe(false);
    });

    it('handles keyword with dots', () => {
      const group = makeGroup({ autoRespondKeywords: ['v2.0'] });
      expect(channel.shouldAutoRespond('Released v2.0 today', group)).toBe(
        true,
      );
      // Dot is escaped — should not match "v2X0"
      expect(channel.shouldAutoRespond('Released v2X0 today', group)).toBe(
        false,
      );
    });

    it('returns false when autoRespondKeywords is undefined', () => {
      const group = makeGroup();
      expect(channel.shouldAutoRespond('help me', group)).toBe(false);
    });

    it('returns false when autoRespondKeywords is empty', () => {
      const group = makeGroup({ autoRespondKeywords: [] });
      expect(channel.shouldAutoRespond('help me', group)).toBe(false);
    });
  });

  describe('combined behavior', () => {
    it('question detection takes priority over keywords', () => {
      const group = makeGroup({
        autoRespondToQuestions: true,
        autoRespondKeywords: ['help'],
      });
      // Question without keyword — still matches via question detection
      expect(channel.shouldAutoRespond('How are you?', group)).toBe(true);
    });

    it('falls back to keyword matching when not a question', () => {
      const group = makeGroup({
        autoRespondToQuestions: true,
        autoRespondKeywords: ['help'],
      });
      expect(channel.shouldAutoRespond('I need help', group)).toBe(true);
    });

    it('returns false when neither condition matches', () => {
      const group = makeGroup({
        autoRespondToQuestions: true,
        autoRespondKeywords: ['help'],
      });
      expect(channel.shouldAutoRespond('Just chatting', group)).toBe(false);
    });
  });
});
