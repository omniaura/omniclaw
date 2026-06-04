import { beforeEach, describe, expect, it } from 'bun:test';

import {
  _initTestDatabase,
  getPendingSessionIntent,
  setChannelSubscription,
  setSession,
  storeChatMetadata,
} from './db.js';
import {
  _createIntermediateStatusStreamer,
  _handleSessionCommandForTest,
  _getSlashCommandGroupsFromSubscriptions,
  _getEnabledStartupConfirmationTargets,
  _isAgentEnabled,
  _markChannelSubscriptionsDirty,
  _selectEnabledSubscriptionsForMessage,
  _selectSubscriptionsForMessage,
  _setAgents,
  _setChannelSubscriptions,
  _setRegisteredGroups,
  _truncateIntermediateStatusBuffer,
  _setSessions,
  getAvailableGroups,
  hasWakingTrigger,
  shouldDropBotReaction,
} from './index.js';
import { buildTriggerPattern, DATA_DIR } from './config.js';
import fs from 'fs';
import path from 'path';
import type {
  Agent,
  ChannelSubscription,
  NewMessage,
  RegisteredGroup,
} from './types.js';

const BASE_GROUP: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Omni',
  added_at: '2024-01-01T00:00:00.000Z',
};

const BASE_SUBSCRIPTION: ChannelSubscription = {
  channelJid: 'team@g.us',
  agentId: 'team-agent',
  trigger: '@Omni',
  requiresTrigger: true,
  priority: 0,
  isPrimary: true,
  createdAt: '2024-01-01T00:00:00.000Z',
};

const BASE_AGENT: Agent = {
  id: 'team-agent',
  name: 'Team Agent',
  folder: 'team-folder',
  backend: 'apple-container',
  agentRuntime: 'claude-agent-sdk',
  isAdmin: false,
  createdAt: '2024-01-01T00:00:00.000Z',
};

const BASE_MESSAGE: NewMessage = {
  id: 'msg-1',
  chat_jid: 'team@g.us',
  sender: 'user-1',
  sender_name: 'User One',
  content: '@Omni hello',
  timestamp: '2024-01-01T00:01:00.000Z',
};

const makeMessage = (overrides: Partial<NewMessage> = {}): NewMessage => ({
  id: 'msg-1',
  chat_jid: 'tg:-100123',
  sender: 'telegram:42',
  sender_name: 'Peyton',
  content: 'follow up',
  timestamp: '2026-05-09T18:00:00.000Z',
  is_from_me: false,
  sender_platform: 'telegram',
  sender_user_id: '42',
  ...overrides,
});

function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('intermediate status streaming', () => {
  it('creates a status message for the first intermediate and edits it for subsequent updates', async () => {
    const sends: Array<{ jid: string; text: string }> = [];
    const edits: Array<{ jid: string; id: string; text: string }> = [];
    const streamer = _createIntermediateStatusStreamer({
      channel: {
        sendMessage: async (jid, text) => {
          sends.push({ jid, text });
          return 'status-1';
        },
        editMessage: async (jid, id, text) => {
          edits.push({ jid, id, text });
        },
      },
      chatJid: 'dc:chan',
      editDebounceMs: 1,
    });

    await streamer.append('first');
    await streamer.append('second');
    await tick();

    expect(sends).toEqual([{ jid: 'dc:chan', text: 'first' }]);
    expect(edits.at(-1)).toEqual({
      jid: 'dc:chan',
      id: 'status-1',
      text: 'first\nsecond',
    });
  });

  it('coalesces concurrent first intermediates into one status message', async () => {
    let resolveSend: (value: string) => void = () => undefined;
    const sends: string[] = [];
    const edits: string[] = [];
    const streamer = _createIntermediateStatusStreamer({
      channel: {
        sendMessage: async (_jid, text) => {
          sends.push(text);
          return new Promise<string>((resolve) => {
            resolveSend = resolve;
          });
        },
        editMessage: async (_jid, _id, text) => {
          edits.push(text);
        },
      },
      chatJid: 'dc:chan',
      editDebounceMs: 1,
    });

    const first = streamer.append('first');
    const second = streamer.append('second');
    resolveSend('status-1');
    await Promise.all([first, second]);
    await tick();

    expect(sends).toEqual(['first']);
    expect(edits.at(-1)).toBe('first\nsecond');
  });

  it('edits the final reply into the status message', async () => {
    const edits: string[] = [];
    const streamer = _createIntermediateStatusStreamer({
      channel: {
        sendMessage: async () => 'status-1',
        editMessage: async (_jid, _id, text) => {
          edits.push(text);
        },
      },
      chatJid: 'dc:chan',
      editDebounceMs: 1,
    });

    await streamer.append('working');
    const edited = await streamer.editFinal('final answer');

    expect(edited).toBe(true);
    expect(edits.at(-1)).toBe('final answer');
  });

  it('returns false when final edit fails so callers can fall back to sendMessage', async () => {
    const streamer = _createIntermediateStatusStreamer({
      channel: {
        sendMessage: async () => 'status-1',
        editMessage: async () => {
          throw new Error('rate limited');
        },
      },
      chatJid: 'dc:chan',
      editDebounceMs: 1,
    });

    await streamer.append('working');

    expect(await streamer.editFinal('final answer')).toBe(false);
  });

  it('does not silently truncate final replies over the edit limit', async () => {
    const edits: string[] = [];
    const streamer = _createIntermediateStatusStreamer({
      channel: {
        sendMessage: async () => 'status-1',
        editMessage: async (_jid, _id, text) => {
          edits.push(text);
        },
      },
      chatJid: 'dc:chan',
      editDebounceMs: 1,
    });

    await streamer.append('working');
    const edited = await streamer.editFinal('x'.repeat(2001));

    expect(edited).toBe(false);
    expect(edits.at(-1)).toBe('Final response follows below.');
  });

  it('truncates live buffers on line boundaries and strips broken fences', () => {
    const text = ['before', '```', 'secret output', '```', 'after'].join('\n');

    const truncated = _truncateIntermediateStatusBuffer(text, 22);

    expect(truncated).not.toContain('```');
    expect(truncated.startsWith('...')).toBe(true);
    expect(truncated.length).toBeLessThanOrEqual(22);
  });
});

describe('getAvailableGroups', () => {
  beforeEach(() => {
    _initTestDatabase();
    _setRegisteredGroups({});
    _setChannelSubscriptions({});
    _setAgents({});
  });

  it('returns supported group chats ordered by most recent activity', () => {
    storeChatMetadata('__group_sync__', '2026-03-25T12:04:00.000Z', 'Sync');
    storeChatMetadata('user@s.whatsapp.net', '2026-03-25T12:03:00.000Z', 'DM');
    storeChatMetadata('dc:dm:123', '2026-03-25T12:02:00.000Z', 'Discord DM');
    storeChatMetadata('team@g.us', '2026-03-25T12:00:00.000Z', 'WhatsApp');
    storeChatMetadata(
      'dc:server-1:channel-1',
      '2026-03-25T12:01:00.000Z',
      'Discord',
    );
    storeChatMetadata('tg:-100123', '2026-03-25T12:05:00.000Z', 'Telegram');

    expect(getAvailableGroups()).toEqual([
      {
        jid: 'tg:-100123',
        name: 'Telegram',
        lastActivity: '2026-03-25T12:05:00.000Z',
        isRegistered: false,
      },
      {
        jid: 'dc:server-1:channel-1',
        name: 'Discord',
        lastActivity: '2026-03-25T12:01:00.000Z',
        isRegistered: false,
      },
      {
        jid: 'team@g.us',
        name: 'WhatsApp',
        lastActivity: '2026-03-25T12:00:00.000Z',
        isRegistered: false,
      },
    ]);
  });

  it('marks exact registered chats as registered', () => {
    _setRegisteredGroups({
      'team@g.us': { ...BASE_GROUP, name: 'Team', folder: 'team' },
    });

    storeChatMetadata('team@g.us', '2026-03-25T12:00:00.000Z', 'Team');

    expect(getAvailableGroups()).toEqual([
      {
        jid: 'team@g.us',
        name: 'Team',
        lastActivity: '2026-03-25T12:00:00.000Z',
        isRegistered: true,
      },
    ]);
  });

  it('marks chats with channel subscriptions as registered', () => {
    _setChannelSubscriptions({
      'team@g.us': [{ ...BASE_SUBSCRIPTION }],
    });

    storeChatMetadata('team@g.us', '2026-03-25T12:00:00.000Z', 'Team');

    expect(getAvailableGroups()).toEqual([
      {
        jid: 'team@g.us',
        name: 'Team',
        lastActivity: '2026-03-25T12:00:00.000Z',
        isRegistered: true,
      },
    ]);
  });

  it('treats scoped Telegram chats as registered when a legacy JID exists', () => {
    _setRegisteredGroups({
      'tg:-100123': {
        ...BASE_GROUP,
        name: 'Telegram Group',
        folder: 'telegram',
      },
    });

    storeChatMetadata(
      'tg:bot-42:-100123',
      '2026-03-25T12:00:00.000Z',
      'Scoped Telegram',
    );

    expect(getAvailableGroups()).toEqual([
      {
        jid: 'tg:bot-42:-100123',
        name: 'Scoped Telegram',
        lastActivity: '2026-03-25T12:00:00.000Z',
        isRegistered: true,
      },
    ]);
  });

  it('keeps Slack channels out of the available groups list', () => {
    _setRegisteredGroups({
      'slack:C123': { ...BASE_GROUP, name: 'Slack Channel', folder: 'slack' },
    });

    storeChatMetadata(
      'slack:bot-99:C123',
      '2026-03-25T12:00:00.000Z',
      'Scoped Slack',
    );

    expect(getAvailableGroups()).toEqual([]);
  });
});

describe('Discord session command state', () => {
  const sessionId = '123e4567-e89b-12d3-a456-426614174000';
  const group: RegisteredGroup = {
    name: 'Session Agent',
    folder: 'session-agent',
    trigger: '@Session',
    added_at: '2024-01-01T00:00:00.000Z',
  };
  const sessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
    'projects',
    '-workspace-group',
  );

  beforeEach(() => {
    _initTestDatabase();
    _setRegisteredGroups({});
    _setChannelSubscriptions({});
    _setAgents({});
    _setSessions({});
    fs.rmSync(path.join(DATA_DIR, 'sessions', group.folder), {
      recursive: true,
      force: true,
    });
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, `${sessionId}.jsonl`), '{}\n');
  });

  it('persists pending fork and name intents for /session new resume_from', () => {
    const result = _handleSessionCommandForTest('new', 'dc:channel-1', group, {
      resumeFrom: sessionId,
      name: 'launch **triage** `branch`',
    });

    expect(result.message).toContain(`forked from \`${sessionId}\``);
    expect(getPendingSessionIntent(group.folder)).toEqual({
      forkFrom: sessionId,
      name: 'launch triage branch',
    });
  });

  it('renders sanitized session names in host responses', () => {
    const result = _handleSessionCommandForTest(
      'rename',
      'dc:channel-1',
      group,
      {
        sessionId,
        name: 'release `_cut_` **now**',
      },
    );

    expect(result.message).toBe(
      `Session \`${sessionId}\` renamed to "release cut now".`,
    );
  });

  it('keeps /session end as an active-session confirmation', () => {
    setSession(group.folder, sessionId);
    _setSessions({ [group.folder]: sessionId });

    const result = _handleSessionCommandForTest('end', 'dc:channel-1', group, {
      sessionId: 'abcdefab-cdef-abcd-efab-cdefabcdefab',
    });

    expect(result.message).toContain('is not the active session');
  });
});

describe('slash command subscription groups', () => {
  beforeEach(() => {
    _initTestDatabase();
    _setRegisteredGroups({});
    _setChannelSubscriptions({});
    _setAgents({});
  });

  it('refreshes dirty channel subscriptions before building slash command groups', () => {
    _setRegisteredGroups({
      'dc:guild-1:channel-1': {
        ...BASE_GROUP,
        name: 'Discord Fallback',
        folder: 'agent-one',
        discordBotId: 'bot-a',
        discordGuildId: 'guild-1',
      },
    });
    setChannelSubscription({
      ...BASE_SUBSCRIPTION,
      channelJid: 'dc:guild-1:channel-1',
      agentId: 'agent-one',
      trigger: '@Cody',
      discordBotId: 'bot-a',
      discordGuildId: 'guild-1',
    });
    _markChannelSubscriptionsDirty();

    expect(_getSlashCommandGroupsFromSubscriptions()).toEqual([
      expect.objectContaining({
        folder: 'agent-one',
        trigger: '@Cody',
        discordBotId: 'bot-a',
        discordGuildId: 'guild-1',
      }),
    ]);
  });
});

describe('agent off-switch routing guards', () => {
  beforeEach(() => {
    _initTestDatabase();
    _setRegisteredGroups({});
    _setChannelSubscriptions({});
    _setAgents({});
  });

  it('resolves enabled state by agent id or workspace folder', () => {
    _setAgents({
      'agent-id': {
        ...BASE_AGENT,
        id: 'agent-id',
        folder: 'workspace-folder',
        enabled: false,
      },
    });

    expect(_isAgentEnabled('agent-id')).toBe(false);
    expect(_isAgentEnabled('workspace-folder')).toBe(false);
    expect(_isAgentEnabled('unknown-legacy-folder')).toBe(true);
  });

  it('marks trigger-matched disabled subscriptions so legacy fallback stays blocked', () => {
    _setAgents({
      'team-agent': {
        ...BASE_AGENT,
        id: 'team-agent',
        enabled: false,
      },
    });
    _setRegisteredGroups({
      'team@g.us': { ...BASE_GROUP, folder: 'team-folder' },
    });
    _setChannelSubscriptions({
      'team@g.us': [{ ...BASE_SUBSCRIPTION, agentId: 'team-agent' }],
    });

    const selection = _selectEnabledSubscriptionsForMessage('team@g.us', [
      BASE_MESSAGE,
    ]);

    expect(selection.selected).toEqual([]);
    expect(selection.selectedByTrigger).toBe(true);
    expect(selection.allTriggerMatchesDisabled).toBe(true);
  });

  it('filters disabled agents out of startup confirmation targets', () => {
    _setAgents({
      'disabled-by-id': {
        ...BASE_AGENT,
        id: 'disabled-by-id',
        folder: 'disabled-sub-folder',
        enabled: false,
      },
      'legacy-id': {
        ...BASE_AGENT,
        id: 'legacy-id',
        folder: 'disabled-legacy-folder',
        enabled: false,
      },
      'enabled-agent': {
        ...BASE_AGENT,
        id: 'enabled-agent',
        folder: 'enabled-folder',
        enabled: true,
      },
    });
    _setRegisteredGroups({
      'dc:subscribed': {
        ...BASE_GROUP,
        name: 'Subscribed',
        folder: 'disabled-sub-folder',
        trigger: '@DisabledSub',
      },
      'dc:legacy-disabled': {
        ...BASE_GROUP,
        name: 'Legacy Disabled',
        folder: 'disabled-legacy-folder',
        trigger: '@LegacyDisabled',
      },
      'dc:enabled': {
        ...BASE_GROUP,
        name: 'Enabled',
        folder: 'enabled-folder',
        trigger: '@Enabled',
      },
    });
    _setChannelSubscriptions({
      'dc:subscribed': [
        {
          ...BASE_SUBSCRIPTION,
          channelJid: 'dc:subscribed',
          agentId: 'disabled-by-id',
          trigger: '@DisabledSub',
          isPrimary: true,
        },
      ],
    });

    expect(_getEnabledStartupConfirmationTargets()).toEqual([
      { chatJid: 'dc:enabled', trigger: '@Enabled' },
    ]);
  });
});

describe('subscription selection', () => {
  beforeEach(() => {
    _initTestDatabase();
    _setRegisteredGroups({});
    _setChannelSubscriptions({});
    _setAgents({});
  });

  it('routes reply-to-agent messages only to the replied-to agent in a shared channel', () => {
    _setChannelSubscriptions({
      'tg:-100123': [
        {
          ...BASE_SUBSCRIPTION,
          channelJid: 'tg:-100123',
          agentId: 'agent-a',
          trigger: '@AgentA',
          priority: 0,
        },
        {
          ...BASE_SUBSCRIPTION,
          channelJid: 'tg:-100123',
          agentId: 'agent-b',
          trigger: '@AgentB',
          priority: 1,
        },
      ],
    });

    const result = _selectSubscriptionsForMessage('tg:-100123', [
      makeMessage({
        is_reply_to_bot: true,
        reply_to_agent_id: 'agent-a',
      }),
    ]);

    expect(result.selectedByTrigger).toBe(true);
    expect(result.selected.map((s) => s.agentId)).toEqual(['agent-a']);
  });

  it('does not fan out bot replies to legacy shared Telegram subscriptions when only a bot target is known', () => {
    _setChannelSubscriptions({
      'tg:-100123': [
        {
          ...BASE_SUBSCRIPTION,
          channelJid: 'tg:-100123',
          agentId: 'agent-a',
          trigger: '@AgentA',
          priority: 0,
        },
        {
          ...BASE_SUBSCRIPTION,
          channelJid: 'tg:-100123',
          agentId: 'agent-b',
          trigger: '@AgentB',
          priority: 1,
        },
      ],
    });

    const result = _selectSubscriptionsForMessage('tg:-100123', [
      makeMessage({
        is_reply_to_bot: true,
        reply_to_bot_id: 'bot-a',
      }),
    ]);

    expect(result.selectedByTrigger).toBe(false);
    expect(result.selected).toEqual([]);
  });

  it('matches Telegram replies to the subscription with the scoped replied-to bot id', () => {
    _setChannelSubscriptions({
      'tg:bot-a:-100123': [
        {
          ...BASE_SUBSCRIPTION,
          channelJid: 'tg:bot-a:-100123',
          agentId: 'agent-a',
          trigger: '@AgentA',
          priority: 0,
        },
      ],
      'tg:bot-b:-100123': [
        {
          ...BASE_SUBSCRIPTION,
          channelJid: 'tg:bot-b:-100123',
          agentId: 'agent-b',
          trigger: '@AgentB',
          priority: 1,
        },
      ],
    });

    const result = _selectSubscriptionsForMessage('tg:bot-a:-100123', [
      makeMessage({
        chat_jid: 'tg:bot-a:-100123',
        is_reply_to_bot: true,
        reply_to_bot_id: 'bot-a',
      }),
    ]);

    expect(result.selectedByTrigger).toBe(true);
    expect(result.selected.map((s) => s.agentId)).toEqual(['agent-a']);
  });
});

describe('hasWakingTrigger', () => {
  const pattern = buildTriggerPattern('@Clayton');

  it('wakes on an explicit @mention', () => {
    expect(
      hasWakingTrigger(
        [{ id: 'slack-1', content: '@Clayton can you review this?' }],
        pattern,
      ),
    ).toBe(true);
  });

  it('does NOT wake on a reaction notification that matches the trigger', () => {
    // handleReactionNotification synthesizes this content + a `react-` id.
    expect(
      hasWakingTrigger(
        [
          {
            id: 'react-1779680048436-l7zwa9',
            content: '@Clayton [CodeRabbit reacted with :eyes:]',
          },
        ],
        pattern,
      ),
    ).toBe(false);
  });

  it('still wakes when a real mention is batched alongside a reaction', () => {
    expect(
      hasWakingTrigger(
        [
          { id: 'react-1', content: '@Clayton [Someone reacted with :eyes:]' },
          { id: 'slack-2', content: '@Clayton ship it' },
        ],
        pattern,
      ),
    ).toBe(true);
  });

  it('does not wake on unaddressed chatter', () => {
    expect(
      hasWakingTrigger(
        [{ id: 'slack-3', content: 'https://example.com neat link' }],
        pattern,
      ),
    ).toBe(false);
  });
});

describe('shouldDropBotReaction', () => {
  it('drops reactions from bot/app reactors', () => {
    expect(shouldDropBotReaction({ id: 'U_CODERABBIT', isBot: true })).toBe(
      true,
    );
  });

  it('keeps reactions from human reactors', () => {
    expect(shouldDropBotReaction({ id: 'U_HUMAN', isBot: false })).toBe(false);
  });

  it('keeps reactions when isBot is missing or unknown (default-false)', () => {
    // Mirrors the resolver fallback when users.info lookup fails — we choose
    // to treat unresolved reactors as humans so a transient API blip can't
    // silently swallow a real user's reaction.
    expect(shouldDropBotReaction({ id: 'U_UNKNOWN', isBot: false })).toBe(
      false,
    );
  });
});
