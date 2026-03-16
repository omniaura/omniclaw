import { describe, expect, it } from 'bun:test';

import {
  hasAttentiveEligibleMessage,
  isAttentiveEligibleMessage,
} from './attentive-routing.js';

describe('isAttentiveEligibleMessage', () => {
  it('accepts user-authored chat messages', () => {
    expect(
      isAttentiveEligibleMessage({
        sender: 'discord:123',
        sender_name: 'Alice',
        sender_platform: 'discord',
      }),
    ).toBe(true);
  });

  it('rejects agent-authored IPC echoes', () => {
    expect(
      isAttentiveEligibleMessage({
        sender: 'agent:groups/test-agent',
        sender_name: 'Test Agent',
        sender_platform: 'ipc',
      }),
    ).toBe(false);
  });

  it('rejects synthetic system messages', () => {
    expect(
      isAttentiveEligibleMessage({
        sender: 'system',
        sender_name: 'System',
        sender_platform: 'system',
      }),
    ).toBe(false);
  });
});

describe('hasAttentiveEligibleMessage', () => {
  it('keeps attentive mode alive through internal-only traffic', () => {
    expect(
      hasAttentiveEligibleMessage([
        {
          sender: 'agent:groups/test-agent',
          sender_name: 'Test Agent',
          sender_platform: 'ipc',
        },
        {
          sender: 'system',
          sender_name: 'GitHub Webhook',
          sender_platform: 'system',
        },
      ]),
    ).toBe(false);
  });

  it('considers the batch eligible when a human follow-up is present', () => {
    expect(
      hasAttentiveEligibleMessage([
        {
          sender: 'agent:groups/test-agent',
          sender_name: 'Test Agent',
          sender_platform: 'ipc',
        },
        {
          sender: 'discord:456',
          sender_name: 'Bob',
          sender_platform: 'discord',
        },
      ]),
    ).toBe(true);
  });
});
