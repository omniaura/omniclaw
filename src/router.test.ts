/**
 * Tests for router.ts functions not covered by formatting.test.ts.
 *
 * Covers: getAgentName, findChannel.
 * (escapeXml, formatMessages, stripInternalTags, formatOutbound
 *  are already tested in formatting.test.ts)
 */
import { describe, it, expect } from 'bun:test';

import { ASSISTANT_NAME } from './config.js';
import { Channel, RegisteredGroup } from './types.js';
import { getAgentName, findChannel } from './router.js';

// --- Mock Channel factory ---

function makeChannel(opts: {
  jids: string[];
  connected?: boolean;
  sentMessages?: Array<{ jid: string; text: string }>;
}): Channel {
  const sent = opts.sentMessages ?? [];
  return {
    ownsJid: (jid: string) => opts.jids.includes(jid),
    isConnected: () => opts.connected ?? true,
    sendMessage: async (jid: string, text: string) => {
      sent.push({ jid, text });
    },
    prefixAssistantName: true,
  } as unknown as Channel;
}

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@TestBot',
    added_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// --- getAgentName ---

describe('getAgentName', () => {
  it('extracts name from trigger by stripping @ prefix', () => {
    expect(getAgentName(makeGroup({ trigger: '@OmarOmni' }))).toBe('OmarOmni');
  });

  it('returns trigger as-is if no @ prefix', () => {
    expect(getAgentName(makeGroup({ trigger: 'Omni' }))).toBe('Omni');
  });

  it('falls back to ASSISTANT_NAME when trigger is undefined', () => {
    expect(getAgentName(makeGroup({ trigger: undefined }))).toBe(
      ASSISTANT_NAME,
    );
  });

  it('falls back to ASSISTANT_NAME when trigger is empty', () => {
    expect(getAgentName(makeGroup({ trigger: '' }))).toBe(ASSISTANT_NAME);
  });

  it('handles multi-word triggers', () => {
    expect(getAgentName(makeGroup({ trigger: '@My Bot' }))).toBe('My Bot');
  });
});

// --- findChannel ---

describe('findChannel', () => {
  it('finds channel that owns the JID', () => {
    const ch1 = makeChannel({ jids: ['abc@g.us'] });
    const ch2 = makeChannel({ jids: ['def@g.us'] });

    const result = findChannel([ch1, ch2], 'def@g.us');
    expect(result).toBe(ch2);
  });

  it('returns undefined when no channel owns the JID', () => {
    const ch = makeChannel({ jids: ['abc@g.us'] });

    const result = findChannel([ch], 'unknown@g.us');
    expect(result).toBeUndefined();
  });

  it('returns first matching channel when multiple own same JID', () => {
    const ch1 = makeChannel({ jids: ['abc@g.us'] });
    const ch2 = makeChannel({ jids: ['abc@g.us'] });

    const result = findChannel([ch1, ch2], 'abc@g.us');
    expect(result).toBe(ch1);
  });

  it('handles empty channels array', () => {
    expect(findChannel([], 'abc@g.us')).toBeUndefined();
  });
});
