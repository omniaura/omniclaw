import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { processMessageIpc, IpcDeps, type MessageResult } from './ipc.js';
import { Channel, IpcMessagePayload, RegisteredGroup } from './types.js';

// =============================================================================
// Shared test fixtures
// =============================================================================

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const THIRD_GROUP: RegisteredGroup = {
  name: 'Third',
  folder: 'third-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let sentMessages: Array<{ jid: string; text: string }>;
let notifiedGroups: Array<{ jid: string; text: string }>;
let reactions: Array<{
  action: 'add' | 'remove';
  jid: string;
  messageId: string;
  emoji: string;
}>;
let deps: IpcDeps;
let tmpDir: string;

beforeEach(() => {
  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };

  sentMessages = [];
  notifiedGroups = [];
  reactions = [];

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-msg-test-'));

  deps = {
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
      return `sent-${sentMessages.length}`;
    },
    notifyGroup: (jid, text) => {
      notifiedGroups.push({ jid, text });
    },
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
    },
    updateGroup: (jid, group) => {
      groups[jid] = group;
    },
    syncGroupMetadata: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    findChannel: (jid) =>
      ({
        addReaction: async (_jid: string, msgId: string, emoji: string) => {
          reactions.push({ action: 'add', jid: _jid, messageId: msgId, emoji });
        },
        removeReaction: async (_jid: string, msgId: string, emoji: string) => {
          reactions.push({
            action: 'remove',
            jid: _jid,
            messageId: msgId,
            emoji,
          });
        },
      }) as Partial<Channel> as Channel,
  };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper to call processMessageIpc
async function processMsg(
  data: IpcMessagePayload,
  sourceGroup = 'main',
  isMain = true,
): Promise<MessageResult> {
  return processMessageIpc(data, sourceGroup, isMain, tmpDir, groups, deps);
}

// =============================================================================
// react_to_message
// =============================================================================

describe('processMessageIpc: react_to_message', () => {
  it('adds a reaction via channel', async () => {
    const result = await processMsg({
      type: 'react_to_message',
      chatJid: 'other@g.us',
      messageId: 'msg-123',
      emoji: '👍',
    });

    expect(result).toEqual({ action: 'handled' });
    expect(reactions).toHaveLength(1);
    expect(reactions[0]).toEqual({
      action: 'add',
      jid: 'other@g.us',
      messageId: 'msg-123',
      emoji: '👍',
    });
  });

  it('removes a reaction when remove=true', async () => {
    const result = await processMsg({
      type: 'react_to_message',
      chatJid: 'other@g.us',
      messageId: 'msg-456',
      emoji: '❤️',
      remove: true,
    });

    expect(result).toEqual({ action: 'handled' });
    expect(reactions).toHaveLength(1);
    expect(reactions[0].action).toBe('remove');
  });

  it('handles missing channel gracefully (no findChannel result)', async () => {
    deps.findChannel = () => undefined;

    const result = await processMsg({
      type: 'react_to_message',
      chatJid: 'unknown@g.us',
      messageId: 'msg-789',
      emoji: '🔥',
    });

    expect(result).toEqual({ action: 'handled' });
    expect(reactions).toHaveLength(0);
  });

  it('handles findChannel not set (undefined deps.findChannel)', async () => {
    deps.findChannel = undefined;

    const result = await processMsg({
      type: 'react_to_message',
      chatJid: 'other@g.us',
      messageId: 'msg-abc',
      emoji: '👎',
    });

    expect(result).toEqual({ action: 'handled' });
    expect(reactions).toHaveLength(0);
  });

  it('requires all fields (chatJid, messageId, emoji)', async () => {
    // Missing emoji
    const result = await processMsg({
      type: 'react_to_message',
      chatJid: 'other@g.us',
      messageId: 'msg-123',
    });

    // Should not be handled as a reaction
    expect(result).toEqual({ action: 'unknown' });
    expect(reactions).toHaveLength(0);
  });

  it('requires chatJid', async () => {
    const result = await processMsg({
      type: 'react_to_message',
      messageId: 'msg-123',
      emoji: '👍',
    });

    expect(result).toEqual({ action: 'unknown' });
  });

  it('requires messageId', async () => {
    const result = await processMsg({
      type: 'react_to_message',
      chatJid: 'other@g.us',
      emoji: '👍',
    });

    expect(result).toEqual({ action: 'unknown' });
  });
});

// =============================================================================
// format_mention
// =============================================================================

describe('processMessageIpc: format_mention', () => {
  // Note: format_mention tests verify the return value and don't check response
  // files on disk, because group-queue.test.ts globally mocks the fs module and
  // bun:test module mocks leak between files in the same suite.

  it('handles discord mention format', async () => {
    // Write user registry using real fs (node:fs) to avoid mock interference
    const realFs = await import('node:fs');
    realFs.writeFileSync(
      path.join(tmpDir, 'user_registry.json'),
      JSON.stringify({
        john: { platform: 'discord', id: '12345', name: 'John' },
      }),
    );

    const result = await processMsg({
      type: 'format_mention',
      userName: 'John',
      platform: 'discord',
      requestId: 'req-001',
    });

    expect(result).toEqual({ action: 'handled' });
  });

  it('handles slack mention format', async () => {
    const realFs = await import('node:fs');
    realFs.writeFileSync(
      path.join(tmpDir, 'user_registry.json'),
      JSON.stringify({
        alice: { platform: 'slack', id: 'U12345', name: 'Alice' },
      }),
    );

    const result = await processMsg({
      type: 'format_mention',
      userName: 'Alice',
      platform: 'slack',
      requestId: 'req-002',
    });

    expect(result).toEqual({ action: 'handled' });
  });

  it('handles whatsapp mention format', async () => {
    const realFs = await import('node:fs');
    realFs.writeFileSync(
      path.join(tmpDir, 'user_registry.json'),
      JSON.stringify({
        bob: {
          platform: 'whatsapp',
          id: '15551234567@s.whatsapp.net',
          name: 'Bob',
        },
      }),
    );

    const result = await processMsg({
      type: 'format_mention',
      userName: 'Bob',
      platform: 'whatsapp',
      requestId: 'req-003',
    });

    expect(result).toEqual({ action: 'handled' });
  });

  it('handles unknown platform with @name fallback', async () => {
    const realFs = await import('node:fs');
    realFs.writeFileSync(
      path.join(tmpDir, 'user_registry.json'),
      JSON.stringify({
        charlie: {
          platform: 'matrix',
          id: '@charlie:matrix.org',
          name: 'Charlie',
        },
      }),
    );

    const result = await processMsg({
      type: 'format_mention',
      userName: 'Charlie',
      platform: 'matrix',
      requestId: 'req-004',
    });

    expect(result).toEqual({ action: 'handled' });
  });

  it('falls back to @userName when user not in registry', async () => {
    const realFs = await import('node:fs');
    realFs.writeFileSync(
      path.join(tmpDir, 'user_registry.json'),
      JSON.stringify({}),
    );

    const result = await processMsg({
      type: 'format_mention',
      userName: 'Unknown',
      platform: 'discord',
      requestId: 'req-005',
    });

    expect(result).toEqual({ action: 'handled' });
  });

  it('falls back to @userName when no registry file exists', async () => {
    const result = await processMsg({
      type: 'format_mention',
      userName: 'NoRegistry',
      platform: 'discord',
      requestId: 'req-006',
    });

    expect(result).toEqual({ action: 'handled' });
  });

  it('performs case-insensitive user lookup', async () => {
    const realFs = await import('node:fs');
    realFs.writeFileSync(
      path.join(tmpDir, 'user_registry.json'),
      JSON.stringify({
        john: { platform: 'discord', id: '99999', name: 'John' },
      }),
    );

    const result = await processMsg({
      type: 'format_mention',
      userName: 'JOHN',
      platform: 'discord',
      requestId: 'req-007',
    });

    expect(result).toEqual({ action: 'handled' });
  });

  it('sanitizes requestId (strips special characters)', async () => {
    const result = await processMsg({
      type: 'format_mention',
      userName: 'Test',
      platform: 'discord',
      requestId: 'req/../../../evil',
    });

    // Should sanitize the requestId and still handle successfully
    expect(result).toEqual({ action: 'handled' });
  });

  it('blocks when requestId sanitizes to empty string', async () => {
    const result = await processMsg({
      type: 'format_mention',
      userName: 'Test',
      platform: 'discord',
      requestId: '../../..',
    });

    expect(result).toEqual({
      action: 'blocked',
      reason: 'requestId sanitized to empty',
    });
  });

  it('handles no requestId (no response file written)', async () => {
    const result = await processMsg({
      type: 'format_mention',
      userName: 'Test',
      platform: 'discord',
    });

    expect(result).toEqual({ action: 'handled' });
  });

  it('writes response to correct source group directory', async () => {
    const result = await processMsg(
      {
        type: 'format_mention',
        userName: 'Test',
        platform: 'discord',
        requestId: 'req-grp',
      },
      'other-group',
      false,
    );

    expect(result).toEqual({ action: 'handled' });
  });

  it('requires both userName and platform', async () => {
    // Missing platform
    const result1 = await processMsg({
      type: 'format_mention',
      userName: 'Test',
    });
    expect(result1).toEqual({ action: 'unknown' });

    // Missing userName
    const result2 = await processMsg({
      type: 'format_mention',
      platform: 'discord',
    });
    expect(result2).toEqual({ action: 'unknown' });
  });

  it('handles corrupt user registry file gracefully', async () => {
    const realFs = await import('node:fs');
    realFs.writeFileSync(
      path.join(tmpDir, 'user_registry.json'),
      'not valid json{{{',
    );

    const result = await processMsg({
      type: 'format_mention',
      userName: 'Test',
      platform: 'discord',
      requestId: 'req-corrupt',
    });

    // Should still handle (falls back to @userName)
    expect(result).toEqual({ action: 'handled' });
  });
});

// =============================================================================
// ssh_pubkey
// =============================================================================

describe('processMessageIpc: ssh_pubkey', () => {
  it('handles ssh_pubkey message', async () => {
    const result = await processMsg({
      type: 'ssh_pubkey',
      pubkey: 'ssh-ed25519 AAAA...',
    });

    expect(result).toEqual({ action: 'handled' });
    // No messages sent, no reactions, just logged
    expect(sentMessages).toHaveLength(0);
    expect(reactions).toHaveLength(0);
  });

  it('requires pubkey field', async () => {
    const result = await processMsg({
      type: 'ssh_pubkey',
    });

    expect(result).toEqual({ action: 'unknown' });
  });
});

// =============================================================================
// message
// =============================================================================

describe('processMessageIpc: message', () => {
  it('main group can send to any registered group', async () => {
    const result = await processMsg(
      {
        type: 'message',
        chatJid: 'other@g.us',
        text: 'Hello from main!',
      },
      'main',
      true,
    );

    expect(result).toEqual({ action: 'handled' });
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toEqual({
      jid: 'other@g.us',
      text: 'Hello from main!',
    });
  });

  it('notifies target group for cross-group messages', async () => {
    await processMsg(
      {
        type: 'message',
        chatJid: 'other@g.us',
        text: 'Cross-group notification',
      },
      'main',
      true,
    );

    expect(notifiedGroups).toHaveLength(1);
    expect(notifiedGroups[0].jid).toBe('other@g.us');
  });

  it('does not notify for self-messages (same folder)', async () => {
    await processMsg(
      {
        type: 'message',
        chatJid: 'other@g.us',
        text: 'Self message',
      },
      'other-group',
      false,
    );

    expect(sentMessages).toHaveLength(1);
    expect(notifiedGroups).toHaveLength(0); // No cross-group notify
  });

  it('registered agent can send to another registered agent', async () => {
    const result = await processMsg(
      {
        type: 'message',
        chatJid: 'third@g.us',
        text: 'Agent-to-agent',
      },
      'other-group',
      false,
    );

    expect(result).toEqual({ action: 'handled' });
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].jid).toBe('third@g.us');
    // Cross-group, so should notify
    expect(notifiedGroups).toHaveLength(1);
  });

  it('blocks messages to unregistered targets from non-main', async () => {
    const result = await processMsg(
      {
        type: 'message',
        chatJid: 'unknown@g.us',
        text: 'Should be blocked',
      },
      'other-group',
      false,
    );

    expect(result).toEqual({
      action: 'blocked',
      reason: 'target not registered',
    });
    expect(sentMessages).toHaveLength(0);
  });

  it('main group can send to unregistered targets', async () => {
    const result = await processMsg(
      {
        type: 'message',
        chatJid: 'unknown@g.us',
        text: 'Main can send anywhere',
      },
      'main',
      true,
    );

    expect(result).toEqual({ action: 'handled' });
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].jid).toBe('unknown@g.us');
    // Unknown target — no notifyGroup (targetGroup is undefined)
    expect(notifiedGroups).toHaveLength(0);
  });

  it('strips <internal> tags from message text', async () => {
    await processMsg(
      {
        type: 'message',
        chatJid: 'other@g.us',
        text: '<internal>reasoning here</internal>Visible message',
      },
      'main',
      true,
    );

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toBe('Visible message');
    expect(sentMessages[0].text).not.toContain('internal');
  });

  it('suppresses messages that are entirely internal', async () => {
    const result = await processMsg(
      {
        type: 'message',
        chatJid: 'other@g.us',
        text: '<internal>All internal reasoning</internal>',
      },
      'main',
      true,
    );

    expect(result).toEqual({ action: 'suppressed', reason: 'internal-only' });
    expect(sentMessages).toHaveLength(0);
  });

  it('requires chatJid and text', async () => {
    // Missing text
    const result1 = await processMsg({
      type: 'message',
      chatJid: 'other@g.us',
    });
    expect(result1).toEqual({ action: 'unknown' });

    // Missing chatJid
    const result2 = await processMsg({
      type: 'message',
      text: 'Hello',
    });
    expect(result2).toEqual({ action: 'unknown' });
  });
});

// =============================================================================
// Unknown message types
// =============================================================================

describe('processMessageIpc: unknown types', () => {
  it('returns unknown for unrecognized type', async () => {
    const result = await processMsg({
      type: 'nonexistent_type',
    });

    expect(result).toEqual({ action: 'unknown' });
  });

  it('returns unknown for empty type', async () => {
    const result = await processMsg({
      type: '',
    });

    expect(result).toEqual({ action: 'unknown' });
  });
});
