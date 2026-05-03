import { beforeEach, describe, expect, it } from 'bun:test';

import {
  _initTestDatabase,
  setChannelSubscription,
  storeChatMetadata,
} from './db.js';
import {
  _getSlashCommandGroupsFromSubscriptions,
  _markChannelSubscriptionsDirty,
  _setChannelSubscriptions,
  _setRegisteredGroups,
  getAvailableGroups,
} from './index.js';
import type { ChannelSubscription, RegisteredGroup } from './types.js';

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

describe('getAvailableGroups', () => {
  beforeEach(() => {
    _initTestDatabase();
    _setRegisteredGroups({});
    _setChannelSubscriptions({});
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

describe('slash command subscription groups', () => {
  beforeEach(() => {
    _initTestDatabase();
    _setRegisteredGroups({});
    _setChannelSubscriptions({});
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
