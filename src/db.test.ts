import { describe, it, expect, beforeEach } from 'bun:test';

import {
  _initTestDatabase,
  createTask,
  deleteTask,
  getAllAgents,
  getAllChats,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  setAgent,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    // Raw WhatsApp JID is canonicalized at read time via mapMessageRow
    expect(messages[0].sender).toBe('whatsapp:123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('stores empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('');
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    // Store a message from the user (is_from_me: false)
    store({
      id: 'msg-user',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'user message',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_from_me: false,
    });

    // Store a message from the bot (is_from_me: true)
    store({
      id: 'msg-bot',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'bot message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // getMessagesSince filters out is_from_me: true messages
    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-user');
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

describe('agent runtime persistence', () => {
  it('preserves codex for agents loaded back from sqlite', () => {
    setAgent({
      id: 'codex-agent',
      name: 'Codex Agent',
      description: 'codex runtime',
      folder: 'codex-agent',
      backend: 'docker',
      agentRuntime: 'codex',
      isAdmin: false,
      createdAt: '2026-03-10T00:00:00.000Z',
    });

    const agents = getAllAgents();
    expect(agents['codex-agent']?.agentRuntime).toBe('codex');
  });
});

// --- storeMessage (sender_missing counter) ---

describe('storeMessage sender_missing counter', () => {
  it('stores message with empty sender without crashing (counter logs but does not reject)', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    // Should not throw — counter logs an error but still stores
    storeMessage({
      id: 'missing-sender-1',
      chat_jid: 'group@g.us',
      sender: '',
      sender_name: 'Ghost',
      content: 'no sender',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toBe('');
    expect(messages[0].content).toBe('no sender');
  });
});

// --- storeMessage (sender_platform) ---

describe('storeMessage with sender_platform', () => {
  it('persists and retrieves sender_platform', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'dc-plat-1',
      chat_jid: 'group@g.us',
      sender: '123456789012345678',
      sender_name: 'Alice',
      content: 'hello from discord',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_platform: 'discord',
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(1);
    expect(messages[0].sender_platform).toBe('discord');
  });

  it('returns undefined sender_platform for legacy messages without it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'legacy-1',
      chat_jid: 'group@g.us',
      sender: '15551234567@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'old message',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(1);
    expect(messages[0].sender_platform).toBeUndefined();
  });

  it('persists all platform types correctly', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    const platforms = [
      'discord',
      'whatsapp',
      'telegram',
      'slack',
      'ipc',
      'system',
    ] as const;
    for (const [i, platform] of platforms.entries()) {
      storeMessage({
        id: `plat-${platform}`,
        chat_jid: 'group@g.us',
        sender: `sender-${i}`,
        sender_name: `User ${i}`,
        content: `from ${platform}`,
        timestamp: `2024-01-01T00:00:0${i + 1}.000Z`,
        is_from_me: false,
        sender_platform: platform,
      });
    }

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(platforms.length);
    for (const [i, platform] of platforms.entries()) {
      expect(messages[i].sender_platform).toBe(platform);
    }
  });

  it('includes sender_platform in getNewMessages results', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'gnm-1',
      chat_jid: 'group@g.us',
      sender: '999',
      sender_name: 'TgUser',
      content: 'telegram msg',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_platform: 'telegram',
    });

    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].sender_platform).toBe('telegram');
  });
});

// --- storeMessage (sender_user_id + mentions) ---

describe('storeMessage with sender_user_id and mentions', () => {
  it('persists sender_user_id and mentions', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'dc-msg-1',
      chat_jid: 'group@g.us',
      sender: 'discord:user123',
      sender_name: 'Alice',
      content: 'hey @Bob',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_user_id: 'user123',
      mentions: [{ id: 'user456', name: 'Bob', platform: 'discord' }],
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(1);
    expect(messages[0].sender_user_id).toBe('user123');
    expect(messages[0].mentions).toEqual([
      { id: 'user456', name: 'Bob', platform: 'discord' },
    ]);
  });

  it('stores undefined sender_user_id and mentions when not provided', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'dc-msg-2',
      chat_jid: 'group@g.us',
      sender: 'discord:user789',
      sender_name: 'Carol',
      content: 'plain message',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: false,
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(1);
    expect(messages[0].sender_user_id).toBeUndefined();
    expect(messages[0].mentions).toBeUndefined();
  });

  it('persists sender_user_id and mentions from NewMessage format', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'nm-msg-1',
      chat_jid: 'group@g.us',
      sender: 'discord:user111',
      sender_name: 'Dave',
      content: 'hello @Eve',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_user_id: 'user111',
      mentions: [{ id: 'user222', name: 'Eve', platform: 'discord' }],
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(1);
    expect(messages[0].sender_user_id).toBe('user111');
    expect(messages[0].mentions).toEqual([
      { id: 'user222', name: 'Eve', platform: 'discord' },
    ]);
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    const msgs = [
      {
        id: 'm1',
        content: 'first',
        ts: '2024-01-01T00:00:01.000Z',
        sender: 'Alice',
        is_from_me: false,
      },
      {
        id: 'm2',
        content: 'second',
        ts: '2024-01-01T00:00:02.000Z',
        sender: 'Bob',
        is_from_me: false,
      },
      {
        id: 'm3',
        content: 'Andy: bot reply',
        ts: '2024-01-01T00:00:03.000Z',
        sender: 'Bot',
        is_from_me: true,
      },
      {
        id: 'm4',
        content: 'third',
        ts: '2024-01-01T00:00:04.000Z',
        sender: 'Carol',
        is_from_me: false,
      },
    ];
    for (const m of msgs) {
      store({
        id: m.id,
        chat_jid: 'group@g.us',
        sender: `${m.sender}@s.whatsapp.net`,
        sender_name: m.sender,
        content: m.content,
        timestamp: m.ts,
        is_from_me: m.is_from_me,
      });
    }
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince('group@g.us', '2024-01-01T00:00:02.000Z');
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes messages from the assistant (is_from_me)', () => {
    const msgs = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z');
    const botMsgs = msgs.filter((m) => m.content.startsWith('Andy:'));
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    const msgs = [
      {
        id: 'a1',
        chat: 'group1@g.us',
        content: 'g1 msg1',
        ts: '2024-01-01T00:00:01.000Z',
        is_from_me: false,
      },
      {
        id: 'a2',
        chat: 'group2@g.us',
        content: 'g2 msg1',
        ts: '2024-01-01T00:00:02.000Z',
        is_from_me: false,
      },
      {
        id: 'a3',
        chat: 'group1@g.us',
        content: 'Andy: reply',
        ts: '2024-01-01T00:00:03.000Z',
        is_from_me: true,
      },
      {
        id: 'a4',
        chat: 'group1@g.us',
        content: 'g1 msg2',
        ts: '2024-01-01T00:00:04.000Z',
        is_from_me: false,
      },
    ];
    for (const m of msgs) {
      store({
        id: m.id,
        chat_jid: m.chat,
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: m.content,
        timestamp: m.ts,
        is_from_me: m.is_from_me,
      });
    }
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
    );
    // Excludes bot message (is_from_me=true), returns 3 messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp (strictly after)', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
    );
    // Only messages strictly after the cursor (g1 msg2 at 00:00:04)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeNull();
  });
});

// --- mapMessageRow sender canonicalization ---

describe('mapMessageRow sender canonicalization', () => {
  it('canonicalizes raw Discord sender using sender_platform', () => {
    storeChatMetadata('dc:123456', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'canon-dc-1',
      chat_jid: 'dc:123456',
      sender: '999888777', // raw ID, pre-canonicalization
      sender_name: 'Alice',
      content: 'old discord msg',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_platform: 'discord',
    });

    const messages = getMessagesSince('dc:123456', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toBe('discord:999888777');
  });

  it('canonicalizes raw Telegram sender using sender_platform', () => {
    storeChatMetadata('tg:55555', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'canon-tg-1',
      chat_jid: 'tg:55555',
      sender: '112233',
      sender_name: 'Bob',
      content: 'old telegram msg',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_platform: 'telegram',
    });

    const messages = getMessagesSince('tg:55555', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toBe('telegram:112233');
  });

  it('infers platform from WhatsApp chat_jid when sender_platform is missing', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'canon-wa-1',
      chat_jid: 'group@g.us',
      sender: '15551234567',
      sender_name: 'Carol',
      content: 'legacy whatsapp msg',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      // no sender_platform — truly legacy
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toBe('whatsapp:15551234567');
  });

  it('infers platform from Discord chat_jid when sender_platform is missing', () => {
    storeChatMetadata('dc:777', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'canon-dc-infer',
      chat_jid: 'dc:777',
      sender: '444555666',
      sender_name: 'Dave',
      content: 'legacy discord msg',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
    });

    const messages = getMessagesSince('dc:777', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toBe('discord:444555666');
  });

  it('does not double-prefix already-canonicalized senders', () => {
    storeChatMetadata('dc:123', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'canon-noop',
      chat_jid: 'dc:123',
      sender: 'discord:999888777', // already canonicalized
      sender_name: 'Eve',
      content: 'new format msg',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_platform: 'discord',
    });

    const messages = getMessagesSince('dc:123', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toBe('discord:999888777');
  });

  it('does not canonicalize system or ipc senders', () => {
    storeChatMetadata('dc:123', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'canon-sys',
      chat_jid: 'dc:123',
      sender: 'system',
      sender_name: 'System',
      content: 'system msg',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_platform: 'system',
    });

    const messages = getMessagesSince('dc:123', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(1);
    // Non-adapter platforms (system, ipc) should NOT be canonicalized via JID inference
    expect(messages[0].sender).toBe('system');
    expect(messages[0].sender_platform).toBe('system');
    expect(messages[0].sender_name).toBe('System');
    expect(messages[0].content).toBe('system msg');
  });

  it('deduplicates old and new format senders in the same conversation window', () => {
    storeChatMetadata('dc:100', '2024-01-01T00:00:00.000Z');

    // Pre-canonicalization message (raw sender)
    storeMessage({
      id: 'dedup-old',
      chat_jid: 'dc:100',
      sender: '42',
      sender_name: 'Frank',
      content: 'old format',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_platform: 'discord',
    });

    // Post-canonicalization message (canonical sender)
    storeMessage({
      id: 'dedup-new',
      chat_jid: 'dc:100',
      sender: 'discord:42',
      sender_name: 'Frank',
      content: 'new format',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: false,
      sender_platform: 'discord',
    });

    const messages = getMessagesSince('dc:100', '2024-01-01T00:00:00.000Z');
    expect(messages).toHaveLength(2);
    // Both should now have the same canonical sender
    expect(messages[0].sender).toBe('discord:42');
    expect(messages[1].sender).toBe('discord:42');

    // Verify dedup works: unique sender IDs should be 1
    const uniqueSenders = new Set(messages.map((m) => m.sender));
    expect(uniqueSenders.size).toBe(1);
  });
});
