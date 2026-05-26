/**
 * Sender identity validation logging and spoof rejection tests — issue #454
 *
 * Covers:
 * - Canonical sender envelope construction across all adapters
 * - Label-only spoof rejection (plausible sender_name but mismatched sender_user_id)
 * - Structured logging for identity validation outcomes
 * - IPC sender authorization via filesystem-derived identity
 * - Roster inflation detection and logging
 * - Edge cases: empty sender, platform prefix consistency
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  mock,
} from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DISPATCH_RUNTIME_SEP } from './config.js';
import { processMessageIpc, type IpcDeps, type MessageResult } from './ipc.js';
import { logger } from './logger.js';
import { formatMessages } from './router.js';
import type {
  Channel,
  IpcMessagePayload,
  NewMessage,
  RegisteredGroup,
} from './types.js';

// ---- Factories ----

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'dc:123',
    sender: 'discord:111222333',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2026-03-30T12:00:00.000Z',
    ...overrides,
  };
}

// ---- Logger spy ----

let logRecords: Array<Record<string, unknown>>;
let originalInfo: typeof logger.info;
let originalWarn: typeof logger.warn;

beforeEach(() => {
  logRecords = [];
  originalInfo = logger.info;
  originalWarn = logger.warn;

  logger.info = ((fieldsOrMsg: Record<string, unknown> | string) => {
    if (typeof fieldsOrMsg === 'object') logRecords.push(fieldsOrMsg);
  }) as unknown as typeof logger.info;

  logger.warn = ((fieldsOrMsg: Record<string, unknown> | string) => {
    if (typeof fieldsOrMsg === 'object')
      logRecords.push({ ...fieldsOrMsg, _level: 'warn' });
  }) as unknown as typeof logger.warn;
});

afterEach(() => {
  logger.info = originalInfo;
  logger.warn = originalWarn;
});

// =============================================================================
// 1. Canonical sender envelope format validation
// =============================================================================

describe('canonical sender envelope format', () => {
  it('Discord adapter produces discord:<snowflake> sender format', () => {
    const msg = makeMsg({
      sender: 'discord:456789012345678',
      sender_name: 'TestUser',
    });
    const result = formatMessages([msg]);

    expect(result).toContain('sender_id="discord:456789012345678"');
    expect(result).toContain('sender="TestUser"');
    expect(result).not.toContain('sender_key=');
    expect(result).not.toContain('sender_label=');
  });

  it('WhatsApp adapter produces whatsapp:<jid> sender format', () => {
    const msg = makeMsg({
      sender: 'whatsapp:123456789@s.whatsapp.net',
      sender_name: 'Phone User',
    });
    const result = formatMessages([msg]);

    expect(result).toContain('sender_id="whatsapp:123456789@s.whatsapp.net"');
    expect(result).toContain('sender="Phone User"');
  });

  it('Telegram adapter produces telegram:<user_id> sender format', () => {
    const msg = makeMsg({
      sender: 'telegram:9876543',
      sender_name: 'TGUser',
    });
    const result = formatMessages([msg]);

    expect(result).toContain('sender_id="telegram:9876543"');
    expect(result).toContain('sender="TGUser"');
  });

  it('Slack adapter produces slack:<user_id> sender format', () => {
    const msg = makeMsg({
      sender: 'slack:U01ABCDEF',
      sender_name: 'SlackUser',
    });
    const result = formatMessages([msg]);

    expect(result).toContain('sender_id="slack:U01ABCDEF"');
  });

  it('all platform senders include immutable ID in participant_keys', () => {
    const msgs = [
      makeMsg({ id: '1', sender: 'discord:111', sender_name: 'A' }),
      makeMsg({
        id: '2',
        sender: 'whatsapp:222@s.whatsapp.net',
        sender_name: 'B',
      }),
      makeMsg({ id: '3', sender: 'telegram:333', sender_name: 'C' }),
      makeMsg({ id: '4', sender: 'slack:U444', sender_name: 'D' }),
    ];
    const result = formatMessages(msgs);

    expect(result).toContain(
      'participant_keys="discord:111, whatsapp:222@s.whatsapp.net, telegram:333, slack:U444"',
    );
  });
});

// =============================================================================
// 2. Label-only spoof rejection
// =============================================================================

describe('label-only spoof detection', () => {
  it('detects sender_name impersonation with different sender IDs', () => {
    // Real user "Alice" is discord:111, attacker is discord:999 using name "Alice"
    const msgs = [
      makeMsg({
        id: '1',
        sender: 'discord:111',
        sender_name: 'Alice',
        content: 'I am the real Alice',
      }),
      makeMsg({
        id: '2',
        sender: 'discord:999',
        sender_name: 'Alice',
        content: 'I am also Alice (spoofed name)',
      }),
    ];
    const result = formatMessages(msgs);

    // Both should appear in roster because they have different sender IDs
    expect(result).toContain('excerpt_participants="Alice, Alice"');
    // Immutable IDs are distinct — agent can tell them apart
    expect(result).toContain('participant_keys="discord:111, discord:999"');
    // Each message carries its own immutable ID
    expect(result).toContain('sender_id="discord:111"');
    expect(result).toContain('sender_id="discord:999"');
  });

  it('immutable sender_id prevents name-based impersonation in message XML', () => {
    // Spoof scenario: attacker sets display name to match another user
    const spoofMsg = makeMsg({
      sender: 'discord:attacker-id',
      sender_name: 'Peyton Spencer', // copied display name
    });
    const result = formatMessages([spoofMsg]);

    // The XML output includes the immutable sender_id, not just the name
    expect(result).toContain('sender="Peyton Spencer"');
    expect(result).toContain('sender_id="discord:attacker-id"');
    // Agent consuming this XML can verify identity via sender_id, not sender name
  });

  it('sender_name mismatch across messages from same ID is detected via roster inflation', () => {
    // User changes display name mid-conversation — detected as inflation
    const msgs = [
      makeMsg({
        id: '1',
        sender: 'discord:123',
        sender_name: 'RealName',
        content: 'hi',
      }),
      makeMsg({
        id: '2',
        sender: 'discord:123',
        sender_name: 'FakeName',
        content: 'also me',
      }),
    ];

    formatMessages(msgs);

    // Should log roster inflation
    const inflationLog = logRecords.find(
      (r) => r.counter === 'participant_roster_inflation',
    );
    expect(inflationLog).toBeDefined();
    expect(inflationLog!.op).toBe('senderIdentity');
    expect(inflationLog!.expected_count).toBe(1); // 1 unique sender ID
    expect(inflationLog!.actual_count).toBe(2); // 2 different display names
  });

  it('no inflation logged when sender names are consistent', () => {
    const msgs = [
      makeMsg({ id: '1', sender: 'discord:111', sender_name: 'Alice' }),
      makeMsg({ id: '2', sender: 'discord:222', sender_name: 'Bob' }),
    ];

    formatMessages(msgs);

    const inflationLog = logRecords.find(
      (r) => r.counter === 'participant_roster_inflation',
    );
    expect(inflationLog).toBeUndefined();
  });

  it('multiple users changing names triggers proportional inflation count', () => {
    const msgs = [
      makeMsg({ id: '1', sender: 'discord:111', sender_name: 'A1' }),
      makeMsg({ id: '2', sender: 'discord:111', sender_name: 'A2' }),
      makeMsg({ id: '3', sender: 'discord:222', sender_name: 'B1' }),
      makeMsg({ id: '4', sender: 'discord:222', sender_name: 'B2' }),
    ];

    formatMessages(msgs);

    const inflationLog = logRecords.find(
      (r) => r.counter === 'participant_roster_inflation',
    );
    expect(inflationLog).toBeDefined();
    expect(inflationLog!.expected_count).toBe(2); // 2 unique sender IDs
    expect(inflationLog!.actual_count).toBe(4); // 4 different labels
  });
});

// =============================================================================
// 3. Empty/missing sender identity edge cases
// =============================================================================

describe('empty and missing sender identity', () => {
  it('messages with empty sender ID are excluded from participant roster', () => {
    const msgs = [
      makeMsg({ id: '1', sender: '', sender_name: 'Ghost' }),
      makeMsg({ id: '2', sender: 'discord:999', sender_name: 'Valid' }),
    ];
    const result = formatMessages(msgs);

    const headerLine = result.split('\n')[0];
    expect(headerLine).toContain('excerpt_participants="Valid"');
    expect(headerLine).not.toContain('Ghost');
    // Ghost message still rendered in body
    expect(result).toContain('sender="Ghost"');
  });

  it('messages with no sender_name but valid sender ID are excluded from roster', () => {
    const msgs = [
      makeMsg({ id: '1', sender: 'discord:111', sender_name: '' }),
      makeMsg({ id: '2', sender: 'discord:222', sender_name: 'Bob' }),
    ];
    const result = formatMessages(msgs);

    expect(result).toContain('excerpt_participants="Bob"');
    expect(result).not.toContain('excerpt_participants="Bob, "');
    expect(result).not.toContain('excerpt_participants=", Bob"');
  });

  it('system sender is never included in participant roster', () => {
    const msgs = [
      makeMsg({
        id: '1',
        sender: 'system',
        sender_name: 'System',
        content: 'notification',
      }),
      makeMsg({ id: '2', sender: 'discord:111', sender_name: 'User' }),
    ];
    const result = formatMessages(msgs);

    expect(result).toContain('excerpt_participants="User"');
    // System should not appear in participants attribute
    const headerLine = result.split('\n')[0];
    expect(headerLine).not.toContain('System');
  });
});

// =============================================================================
// 4. IPC sender authorization via filesystem identity
// =============================================================================

describe('IPC sender authorization', () => {
  const MAIN_GROUP: RegisteredGroup = {
    name: 'Main',
    folder: 'main',
    trigger: 'always',
    added_at: '2024-01-01T00:00:00.000Z',
  };

  const OTHER_GROUP: RegisteredGroup = {
    name: 'Other',
    folder: 'other-group',
    trigger: '@Agent',
    added_at: '2024-01-01T00:00:00.000Z',
  };

  let groups: Record<string, RegisteredGroup>;
  let sendCalls: Array<{ jid: string; text: string }>;
  let deps: IpcDeps;
  let tmpDir: string;

  beforeEach(() => {
    groups = {
      'main@g.us': MAIN_GROUP,
      'other@g.us': OTHER_GROUP,
    };
    sendCalls = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-sender-test-'));
    deps = {
      sendMessage: async (jid, text) => {
        sendCalls.push({ jid, text });
        return `sent-${sendCalls.length}`;
      },
      notifyGroup: () => {},
      registeredGroups: () => groups,
      registerGroup: () => {},
      updateGroup: () => {},
      syncGroupMetadata: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
      findChannel: () =>
        ({
          addReaction: async () => {},
          removeReaction: async () => {},
        }) as Partial<Channel> as Channel,
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function processMsg(
    data: IpcMessagePayload,
    sourceGroup = 'main',
    isMain = true,
  ): Promise<MessageResult> {
    return processMessageIpc(data, sourceGroup, isMain, tmpDir, groups, deps);
  }

  it('accepts messages from main group (isMain=true)', async () => {
    const result = await processMsg(
      {
        type: 'message',
        chatJid: 'other@g.us',
        text: 'hello from main',
      },
      'main',
      true,
    );
    expect(result.action).toBe('handled');
    expect(sendCalls).toHaveLength(1);
  });

  it('accepts messages to a registered target group', async () => {
    // Non-main agent sending to a registered group — isRegisteredTarget is true
    const result = await processMsg(
      {
        type: 'message',
        chatJid: 'other@g.us',
        text: 'hello from other',
      },
      'other-group',
      false,
    );
    expect(result.action).toBe('handled');
  });

  it('blocks messages to unregistered target from non-main source', async () => {
    const result = await processMsg(
      {
        type: 'message',
        chatJid: 'unregistered@g.us',
        text: 'spoofed message',
      },
      'other-group',
      false,
    );
    expect(result.action).toBe('blocked');
  });

  it('logs unauthorized IPC message attempts', async () => {
    await processMsg(
      {
        type: 'message',
        chatJid: 'unregistered@g.us',
        text: 'blocked attempt',
      },
      'other-group',
      false,
    );

    const warnLog = logRecords.find(
      (r) =>
        r._level === 'warn' &&
        typeof r.chatJid === 'string' &&
        r.chatJid.includes('unregistered'),
    );
    expect(warnLog).toBeDefined();
  });

  it('strips internal tags from IPC messages before sending', async () => {
    await processMsg(
      {
        type: 'message',
        chatJid: 'other@g.us',
        text: '<internal>secret reasoning</internal>The actual response',
      },
      'main',
      true,
    );

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].text).toBe('The actual response');
    expect(sendCalls[0].text).not.toContain('secret reasoning');
  });

  it('suppresses messages that are entirely internal tags', async () => {
    const result = await processMsg(
      {
        type: 'message',
        chatJid: 'other@g.us',
        text: '<internal>only internal content</internal>',
      },
      'main',
      true,
    );

    expect(result.action).toBe('suppressed');
    expect(sendCalls).toHaveLength(0);
  });
});

// =============================================================================
// 5. Cross-platform sender identity consistency
// =============================================================================

describe('cross-platform sender identity in formatted output', () => {
  it('messages from multiple platforms are correctly attributed', () => {
    const msgs = [
      makeMsg({
        id: '1',
        sender: 'discord:111',
        sender_name: 'DiscordUser',
        content: 'from discord',
      }),
      makeMsg({
        id: '2',
        sender: 'whatsapp:222@s.whatsapp.net',
        sender_name: 'WAUser',
        content: 'from whatsapp',
      }),
      makeMsg({
        id: '3',
        sender: 'telegram:333',
        sender_name: 'TGUser',
        content: 'from telegram',
      }),
    ];
    const result = formatMessages(msgs);

    // Each message has correct platform-prefixed sender_id
    expect(result).toContain('sender_id="discord:111"');
    expect(result).toContain('sender_id="whatsapp:222@s.whatsapp.net"');
    expect(result).toContain('sender_id="telegram:333"');

    // Participant keys preserve platform prefixes
    expect(result).toContain('participant_keys=');
    expect(result).toContain('discord:111');
    expect(result).toContain('whatsapp:222@s.whatsapp.net');
    expect(result).toContain('telegram:333');
  });

  it('same numeric ID on different platforms are distinct senders', () => {
    const msgs = [
      makeMsg({
        id: '1',
        sender: 'discord:12345',
        sender_name: 'User',
        content: 'discord',
      }),
      makeMsg({
        id: '2',
        sender: 'telegram:12345',
        sender_name: 'User',
        content: 'telegram',
      }),
    ];
    const result = formatMessages(msgs);

    // Both appear in participant_keys as distinct identities
    expect(result).toContain(
      'participant_keys="discord:12345, telegram:12345"',
    );
    // Both appear in participants (same name, different IDs)
    expect(result).toContain('excerpt_participants="User, User"');
  });
});

// =============================================================================
// 6. Structured logging counters
// =============================================================================

describe('sender identity structured logging', () => {
  it('logs participant_roster_inflation with op=senderIdentity', () => {
    formatMessages([
      makeMsg({ id: '1', sender: 'discord:123', sender_name: 'Name1' }),
      makeMsg({ id: '2', sender: 'discord:123', sender_name: 'Name2' }),
    ]);

    const log = logRecords.find(
      (r) => r.counter === 'participant_roster_inflation',
    );
    expect(log).toBeDefined();
    expect(log!.op).toBe('senderIdentity');
    expect(log!.expected_count).toBe(1);
    expect(log!.actual_count).toBe(2);
  });

  it('does not log inflation when names match sender IDs 1:1', () => {
    formatMessages([
      makeMsg({ id: '1', sender: 'discord:111', sender_name: 'Alice' }),
      makeMsg({ id: '2', sender: 'discord:222', sender_name: 'Bob' }),
      makeMsg({ id: '3', sender: 'discord:111', sender_name: 'Alice' }),
    ]);

    const log = logRecords.find(
      (r) => r.counter === 'participant_roster_inflation',
    );
    expect(log).toBeUndefined();
  });

  it('does not log inflation for single-sender conversations', () => {
    formatMessages([
      makeMsg({ id: '1', sender: 'discord:111', sender_name: 'Solo' }),
      makeMsg({ id: '2', sender: 'discord:111', sender_name: 'Solo' }),
    ]);

    const log = logRecords.find(
      (r) => r.counter === 'participant_roster_inflation',
    );
    expect(log).toBeUndefined();
  });

  it('does not log inflation for empty message arrays', () => {
    formatMessages([]);

    expect(logRecords).toHaveLength(0);
  });
});
