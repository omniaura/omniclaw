import { describe, expect, it } from 'bun:test';

import {
  buildStartupConfirmationTargets,
  hasPriorRuntimeState,
} from './startup-notifications.js';
import type { ChannelSubscription, RegisteredGroup } from './types.js';

describe('hasPriorRuntimeState', () => {
  it('returns false for a fresh startup with no persisted state', () => {
    expect(
      hasPriorRuntimeState({
        lastTimestamp: '',
        lastAgentTimestamp: {},
        sessions: {},
      }),
    ).toBe(false);
  });

  it('returns true when any prior router or session state exists', () => {
    expect(
      hasPriorRuntimeState({
        lastTimestamp: '2026-03-25T20:00:00.000Z',
        lastAgentTimestamp: {},
        sessions: {},
      }),
    ).toBe(true);

    expect(
      hasPriorRuntimeState({
        lastTimestamp: '',
        lastAgentTimestamp: { main: '2026-03-25T20:00:00.000Z' },
        sessions: {},
      }),
    ).toBe(true);

    expect(
      hasPriorRuntimeState({
        lastTimestamp: '',
        lastAgentTimestamp: {},
        sessions: { main: 'session-123' },
      }),
    ).toBe(true);
  });
});

describe('buildStartupConfirmationTargets', () => {
  it('targets primary subscriptions and standalone groups', () => {
    const registeredGroups: Record<string, RegisteredGroup> = {
      'dc:1': {
        name: 'Agent One',
        folder: 'agent-one',
        trigger: '@AgentOne',
        added_at: '2026-03-25T20:00:00.000Z',
      },
      'wa:solo': {
        name: 'Solo',
        folder: 'solo',
        trigger: '@Solo',
        added_at: '2026-03-25T20:00:00.000Z',
      },
    };
    const channelSubscriptions: Record<string, ChannelSubscription[]> = {
      'dc:1': [
        {
          channelJid: 'dc:1',
          agentId: 'agent-one',
          trigger: '@AgentOne',
          requiresTrigger: true,
          priority: 100,
          isPrimary: true,
          createdAt: '2026-03-25T20:00:00.000Z',
        },
      ],
    };

    expect(
      buildStartupConfirmationTargets(registeredGroups, channelSubscriptions),
    ).toEqual([
      { chatJid: 'dc:1', agentId: 'agent-one', trigger: '@AgentOne' },
      { chatJid: 'wa:solo', trigger: '@Solo' },
    ]);
  });

  it('falls back to the first subscription when none are primary', () => {
    const registeredGroups: Record<string, RegisteredGroup> = {
      'dc:2': {
        name: 'Fallback',
        folder: 'fallback',
        trigger: '@Fallback',
        added_at: '2026-03-25T20:00:00.000Z',
      },
    };
    const channelSubscriptions: Record<string, ChannelSubscription[]> = {
      'dc:2': [
        {
          channelJid: 'dc:2',
          agentId: 'fallback-agent',
          trigger: '@Fallback',
          requiresTrigger: true,
          priority: 100,
          isPrimary: false,
          createdAt: '2026-03-25T20:00:00.000Z',
        },
        {
          channelJid: 'dc:2',
          agentId: 'other-agent',
          trigger: '@Other',
          requiresTrigger: true,
          priority: 50,
          isPrimary: false,
          createdAt: '2026-03-25T20:00:00.000Z',
        },
      ],
    };

    expect(
      buildStartupConfirmationTargets(registeredGroups, channelSubscriptions),
    ).toEqual([
      { chatJid: 'dc:2', agentId: 'fallback-agent', trigger: '@Fallback' },
    ]);
  });

  it('dedupes multi-channel agents to one startup target', () => {
    const registeredGroups: Record<string, RegisteredGroup> = {
      'dc:3': {
        name: 'Shared Agent',
        folder: 'shared-agent',
        trigger: '@Shared',
        added_at: '2026-03-25T20:00:00.000Z',
      },
      'dc:4': {
        name: 'Shared Agent Alt',
        folder: 'shared-agent',
        trigger: '@Shared',
        added_at: '2026-03-25T20:00:00.000Z',
      },
    };
    const channelSubscriptions: Record<string, ChannelSubscription[]> = {
      'dc:3': [
        {
          channelJid: 'dc:3',
          agentId: 'shared-agent',
          trigger: '@Shared',
          requiresTrigger: true,
          priority: 100,
          isPrimary: true,
          createdAt: '2026-03-25T20:00:00.000Z',
        },
      ],
      'dc:4': [
        {
          channelJid: 'dc:4',
          agentId: 'shared-agent',
          trigger: '@Shared',
          requiresTrigger: true,
          priority: 100,
          isPrimary: true,
          createdAt: '2026-03-25T20:00:00.000Z',
        },
      ],
    };

    expect(
      buildStartupConfirmationTargets(registeredGroups, channelSubscriptions),
    ).toEqual([
      { chatJid: 'dc:3', agentId: 'shared-agent', trigger: '@Shared' },
    ]);
  });
});
