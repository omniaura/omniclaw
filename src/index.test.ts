import { beforeEach, describe, expect, it } from 'bun:test';

import {
  _initTestDatabase,
  getSession,
  getPendingSessionIntent,
  setChannelSubscription,
  setSession,
  storeChatMetadata,
} from './db.js';
import {
  _createIntermediateStatusStreamer,
  _getRuntimeGroupFolderForTest,
  _handleSessionCommandForTest,
  _getSlashCommandGroupsFromSubscriptions,
  _getEnabledStartupConfirmationTargets,
  _isAgentEnabled,
  _prepareSlackThreadSessionForkForTest,
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

  it('streams intermediates and the final reply through a native message stream', async () => {
    const statuses: string[] = [];
    const texts: string[] = [];
    let stopped = 0;
    const sends: string[] = [];
    const streamer = _createIntermediateStatusStreamer({
      channel: {
        sendMessage: async (_jid, text) => {
          sends.push(text);
          return 'status-1';
        },
        editMessage: async () => undefined,
        startMessageStream: async (_jid, replyTo) => {
          expect(replyTo).toBe('trigger-1');
          return {
            appendStatus: async (text: string) => {
              statuses.push(text);
            },
            appendText: async (text: string) => {
              texts.push(text);
            },
            stop: async () => {
              stopped++;
              return 'stream-1';
            },
          };
        },
      },
      chatJid: 'slack:C123',
      replyAnchor: () => 'trigger-1',
      editDebounceMs: 1,
    });

    await streamer.append('tool call 1');
    await streamer.append('tool call 2');
    expect(streamer.isActive).toBe(true);
    const edited = await streamer.editFinal('final answer');

    expect(edited).toBe(true);
    expect(statuses).toEqual(['tool call 1', 'tool call 2']);
    expect(texts).toEqual(['final answer']);
    expect(stopped).toBe(1);
    // No status message was ever posted/edited — fully native
    expect(sends).toEqual([]);
  });

  it('falls back to the edit loop when the native stream is unavailable', async () => {
    const sends: Array<{ text: string; replyTo?: string }> = [];
    const streamer = _createIntermediateStatusStreamer({
      channel: {
        sendMessage: async (_jid, text, replyTo) => {
          sends.push({ text, replyTo });
          return 'status-1';
        },
        editMessage: async () => undefined,
        startMessageStream: async () => null,
      },
      chatJid: 'slack:C123',
      replyAnchor: () => 'trigger-1',
      editDebounceMs: 1,
    });

    await streamer.append('working');

    // The fallback status message threads under the trigger too
    expect(sends).toEqual([{ text: 'working', replyTo: 'trigger-1' }]);
    expect(streamer.messageId).toBe('status-1');
  });

  it('falls back mid-run when a native stream append fails, keeping the buffer', async () => {
    const sends: string[] = [];
    let appendCalls = 0;
    const streamer = _createIntermediateStatusStreamer({
      channel: {
        sendMessage: async (_jid, text) => {
          sends.push(text);
          return 'status-1';
        },
        editMessage: async () => undefined,
        startMessageStream: async () => ({
          appendStatus: async () => {
            appendCalls++;
            if (appendCalls > 1) throw new Error('stream broke');
          },
          appendText: async () => undefined,
          stop: async () => undefined,
        }),
      },
      chatJid: 'slack:C123',
      editDebounceMs: 1,
    });

    await streamer.append('first');
    await streamer.append('second');

    // Fallback status message carries the full buffered context
    expect(sends).toEqual(['first\nsecond']);
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

describe('runtime group folder selection', () => {
  beforeEach(() => {
    _initTestDatabase();
    _setSessions({});
  });

  it('keeps legacy channel runs on the base group folder', () => {
    expect(_getRuntimeGroupFolderForTest('support', 'slack:C123')).toBe(
      'support',
    );
  });

  it('isolates legacy Slack thread runs from the parent group session', () => {
    const parent = _getRuntimeGroupFolderForTest('support', 'slack:TEST:C123');
    const thread = _getRuntimeGroupFolderForTest(
      'support',
      'slack:TEST:C123:thread:1700000000.000100',
    );
    const siblingThread = _getRuntimeGroupFolderForTest(
      'support',
      'slack:TEST:C123:thread:1700000000.000200',
    );

    expect(parent).toBe('support');
    expect(thread).toMatch(/^support__dispatch__[a-f0-9]{16}$/);
    expect(siblingThread).toMatch(/^support__dispatch__[a-f0-9]{16}$/);
    expect(thread).not.toBe(parent);
    expect(siblingThread).not.toBe(thread);
  });

  it('prepares a new Slack thread session as a fork of the parent channel session', () => {
    const parentSession = '11111111-1111-4111-8111-111111111111';
    const threadJid = 'slack:TEST:C123:thread:1700000000.000100';
    const threadRuntime = _getRuntimeGroupFolderForTest('support', threadJid);

    setSession('support', parentSession);
    _setSessions({ support: parentSession });

    expect(
      _prepareSlackThreadSessionForkForTest('support', threadJid, threadJid),
    ).toBe(parentSession);
    expect(getSession(threadRuntime)).toBe(parentSession);
    expect(getPendingSessionIntent(threadRuntime)).toEqual({
      forkFrom: parentSession,
      name: undefined,
    });
  });

  it('uses the matching subscribed-agent parent session for Slack thread forks', () => {
    const parentSession = '22222222-2222-4222-8222-222222222222';
    const parentKey = 'slack:TEST:C123::agent::team-agent';
    const threadKey =
      'slack:TEST:C123:thread:1700000000.000100::agent::team-agent';
    const parentRuntime = _getRuntimeGroupFolderForTest('support', parentKey);
    const threadRuntime = _getRuntimeGroupFolderForTest('support', threadKey);

    setSession(parentRuntime, parentSession);
    _setSessions({ [parentRuntime]: parentSession });

    expect(
      _prepareSlackThreadSessionForkForTest(
        'support',
        'slack:TEST:C123:thread:1700000000.000100',
        threadKey,
      ),
    ).toBe(parentSession);
    expect(getSession(threadRuntime)).toBe(parentSession);
    expect(getPendingSessionIntent(threadRuntime)?.forkFrom).toBe(
      parentSession,
    );
  });

  it('does not overwrite an existing Slack thread session fork state', () => {
    const parentSession = '33333333-3333-4333-8333-333333333333';
    const threadSession = '44444444-4444-4444-8444-444444444444';
    const threadJid = 'slack:TEST:C123:thread:1700000000.000100';
    const threadRuntime = _getRuntimeGroupFolderForTest('support', threadJid);

    setSession('support', parentSession);
    setSession(threadRuntime, threadSession);
    _setSessions({ support: parentSession, [threadRuntime]: threadSession });

    expect(
      _prepareSlackThreadSessionForkForTest('support', threadJid, threadJid),
    ).toBeUndefined();
    expect(getSession(threadRuntime)).toBe(threadSession);
    expect(getPendingSessionIntent(threadRuntime)).toBeUndefined();
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

  it('inherits parent Slack subscriptions for thread-scoped conversations', () => {
    _setChannelSubscriptions({
      'slack:TEST:C123': [
        {
          ...BASE_SUBSCRIPTION,
          channelJid: 'slack:TEST:C123',
          agentId: 'agent-a',
          trigger: '@Clayton',
          priority: 0,
        },
      ],
    });

    const result = _selectSubscriptionsForMessage(
      'slack:TEST:C123:thread:1700000000.000100',
      [
        makeMessage({
          chat_jid: 'slack:TEST:C123:thread:1700000000.000100',
          sender_platform: 'slack',
          sender: 'slack:UPEYTON',
          sender_user_id: 'UPEYTON',
          content: '@Clayton please handle this thread',
        }),
      ],
    );

    expect(result.selectedByTrigger).toBe(true);
    expect(result.selected.map((s) => s.agentId)).toEqual(['agent-a']);
  });

  it('falls back to legacy Slack parent subscriptions for thread conversations', () => {
    _setChannelSubscriptions({
      'slack:C123': [
        {
          ...BASE_SUBSCRIPTION,
          channelJid: 'slack:C123',
          agentId: 'agent-a',
          trigger: '@Clayton',
          priority: 0,
        },
      ],
    });

    const result = _selectSubscriptionsForMessage(
      'slack:TEST:C123:thread:1700000000.000100',
      [
        makeMessage({
          chat_jid: 'slack:TEST:C123:thread:1700000000.000100',
          sender_platform: 'slack',
          sender: 'slack:UPEYTON',
          sender_user_id: 'UPEYTON',
          content: '@Clayton please handle this thread',
        }),
      ],
    );

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
