import fs from 'fs';
import path from 'path';
import { afterEach, describe, it, expect, mock } from 'bun:test';

// Mock @slack/bolt before importing SlackChannel so Bolt's internal
// auth.test call never fires (it leaks unhandled rejections with fake tokens).
mock.module('@slack/bolt', () => ({
  App: class MockApp {
    message() {}
    event() {}
    command() {}
    assistant() {}
    async start() {}
    async stop() {}
  },
  Assistant: class MockAssistant {
    constructor(public config: unknown) {}
    getMiddleware() {
      return async () => {};
    }
  },
}));

import { GROUPS_DIR } from '../config.js';
import {
  formatImageMarker,
  formatPlaceholder,
  formatTextFileMarker,
} from '../media.js';
import {
  jidToChannelId,
  channelIdToJid,
  parseScopedSlackJid,
  SlackChannel,
} from './slack.js';

// --- jidToChannelId ---

describe('Slack jidToChannelId', () => {
  it('extracts channel ID from slack: JID', () => {
    expect(jidToChannelId('slack:C12345678')).toBe('C12345678');
  });

  it('extracts DM channel ID from slack: JID', () => {
    expect(jidToChannelId('slack:D98765432')).toBe('D98765432');
  });

  it('extracts channel ID from scoped slack JID', () => {
    expect(jidToChannelId('slack:OPS:C12345678')).toBe('C12345678');
  });

  it('returns null for non-Slack JIDs', () => {
    expect(jidToChannelId('dc:123456')).toBeNull();
    expect(jidToChannelId('tg:123456')).toBeNull();
    expect(jidToChannelId('main@g.us')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(jidToChannelId('')).toBeNull();
  });

  it('handles JID with just the slack: prefix', () => {
    expect(jidToChannelId('slack:')).toBe('');
  });

  it('preserves special characters in channel ID', () => {
    expect(jidToChannelId('slack:C_ABC-123')).toBe('C_ABC-123');
  });
});

// --- channelIdToJid ---

describe('Slack channelIdToJid', () => {
  it('creates a slack: JID from channel ID', () => {
    expect(channelIdToJid('C12345678')).toBe('slack:C12345678');
  });

  it('creates a slack: JID from DM channel ID', () => {
    expect(channelIdToJid('D98765432')).toBe('slack:D98765432');
  });

  it('handles empty channel ID', () => {
    expect(channelIdToJid('')).toBe('slack:');
  });

  it('creates a scoped slack JID when bot ID is provided', () => {
    expect(channelIdToJid('C12345678', 'OPS')).toBe('slack:OPS:C12345678');
  });
});

describe('parseScopedSlackJid', () => {
  it('parses scoped Slack JIDs', () => {
    expect(parseScopedSlackJid('slack:OPS:C12345678')).toEqual({
      botId: 'OPS',
      channelId: 'C12345678',
    });
  });

  it('returns null for legacy Slack JIDs', () => {
    expect(parseScopedSlackJid('slack:C12345678')).toBeNull();
  });

  it('returns null for non-Slack JIDs', () => {
    expect(parseScopedSlackJid('dc:123')).toBeNull();
  });
});

// --- Roundtrip ---

describe('Slack JID roundtrip', () => {
  it('jidToChannelId and channelIdToJid are inverses', () => {
    const channelId = 'C12345678';
    const jid = channelIdToJid(channelId);
    expect(jidToChannelId(jid)).toBe(channelId);
  });

  it('roundtrips DM channel IDs', () => {
    const channelId = 'D98765432';
    expect(jidToChannelId(channelIdToJid(channelId))).toBe(channelId);
  });

  it('roundtrips various channel types', () => {
    for (const id of ['C001', 'D002', 'G003']) {
      expect(jidToChannelId(channelIdToJid(id))).toBe(id);
    }
  });
});

// --- SlackChannel.ownsJid ---

describe('SlackChannel.ownsJid', () => {
  const ownsJid = (jid: string, botId = 'OPS', allowLegacy = true) =>
    SlackChannel.prototype.ownsJid.call(
      { botId, allowLegacyJidRouting: allowLegacy } as unknown as SlackChannel,
      jid,
    );

  it('matches slack: prefixed JIDs', () => {
    expect(ownsJid('slack:C123')).toBe(true);
    expect(ownsJid('slack:D456')).toBe(true);
  });

  it('matches scoped JIDs for the same bot', () => {
    expect(ownsJid('slack:OPS:C123', 'OPS')).toBe(true);
  });

  it('does not match scoped JIDs for a different bot', () => {
    expect(ownsJid('slack:SUPPORT:C123', 'OPS')).toBe(false);
  });

  it('can disable legacy JID ownership in multi-bot mode', () => {
    expect(ownsJid('slack:C123', 'OPS', false)).toBe(false);
  });

  it('does not match non-Slack JIDs', () => {
    expect(ownsJid('dc:123')).toBe(false);
    expect(ownsJid('tg:456')).toBe(false);
    expect(ownsJid('main@g.us')).toBe(false);
  });
});

describe('SlackChannel.handleMessage multi-bot mention routing', () => {
  const makeClient = () => ({
    users: {
      info: mock(({ user }: { user: string }) =>
        Promise.resolve({
          user: {
            name: user === 'UOTHERBOT' ? 'otherbot' : 'peyton',
            profile: {
              display_name: user === 'UOTHERBOT' ? 'OtherBot' : 'Peyton',
            },
          },
        }),
      ),
    },
    conversations: {
      info: mock(() => Promise.resolve({ channel: { name: 'test-channel' } })),
    },
  });

  it('ignores messages that mention a different bot in multi-bot mode', async () => {
    const onMessage = mock(() => {});
    const channel = new SlackChannel({
      botId: 'CLAYTON',
      token: 'xoxb-test',
      appToken: 'xapp-test',
      multiBotMode: true,
      onMessage,
      onChatMetadata: () => {},
      registeredGroups: () => ({
        'slack:CLAYTON:C123': {
          name: 'Clayton',
          folder: 'clayton-discord',
          trigger: '@Clayton',
          added_at: new Date().toISOString(),
        },
      }),
    });

    (channel as any).botUserId = 'UCLAYTON';
    (channel as any).client = makeClient();

    await (channel as any).handleMessage({
      channel: 'C123',
      ts: '1700000000.000100',
      text: '<@UOTHERBOT> hello',
      user: 'UPEYTON',
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('stores messages that mention this bot in multi-bot mode', async () => {
    const onMessage = mock(() => {});
    const channel = new SlackChannel({
      botId: 'CLAYTON',
      token: 'xoxb-test',
      appToken: 'xapp-test',
      multiBotMode: true,
      onMessage,
      onChatMetadata: () => {},
      registeredGroups: () => ({
        'slack:CLAYTON:C123': {
          name: 'Clayton',
          folder: 'clayton-discord',
          trigger: '@Clayton',
          added_at: new Date().toISOString(),
        },
      }),
    });

    (channel as any).botUserId = 'UCLAYTON';
    (channel as any).client = makeClient();

    await (channel as any).handleMessage({
      channel: 'C123',
      ts: '1700000000.000100',
      text: '<@UCLAYTON> hello',
      user: 'UPEYTON',
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    const calls = onMessage.mock.calls as unknown as Array<[string]>;
    expect(calls[0][0]).toBe('slack:CLAYTON:C123');
  });
});

// --- Outbound sending: markdown blocks, threading, streaming ---

const makeSendChannel = () =>
  new SlackChannel({
    botId: 'TEST',
    token: 'xoxb-test',
    appToken: 'xapp-test',
    onMessage: () => {},
    onChatMetadata: () => {},
    registeredGroups: () => ({}),
  });

describe('SlackChannel.sendMessage', () => {
  it('sends markdown blocks with a plain-text notification fallback', async () => {
    const channel = makeSendChannel();
    const postMessage = mock(() => Promise.resolve({ ts: '1.100' }));
    (channel as any).client = { chat: { postMessage } };

    const ts = await channel.sendMessage('slack:C123', '**bold** and `code`');

    expect(ts).toBe('1.100');
    expect(postMessage).toHaveBeenCalledTimes(1);
    const args = (postMessage.mock.calls[0] as unknown as [any])[0];
    expect(args.channel).toBe('C123');
    expect(args.blocks).toEqual([
      { type: 'markdown', text: '**bold** and `code`' },
    ]);
    expect(args.text).toBe('**bold** and `code`');
    expect(args.thread_ts).toBeUndefined();
  });

  it('falls back to plain text when the markdown block is rejected', async () => {
    const channel = makeSendChannel();
    let calls = 0;
    const postMessage = mock((args: any) => {
      calls++;
      if (args.blocks) return Promise.reject(new Error('invalid_blocks'));
      return Promise.resolve({ ts: '2.200' });
    });
    (channel as any).client = { chat: { postMessage } };

    const ts = await channel.sendMessage('slack:C123', 'hello');

    expect(ts).toBe('2.200');
    expect(calls).toBe(2);
    const fallbackArgs = (postMessage.mock.calls[1] as unknown as [any])[0];
    expect(fallbackArgs.blocks).toBeUndefined();
    expect(fallbackArgs.text).toBe('hello');
  });

  it('threads replies under the thread root, not the child message', async () => {
    const channel = makeSendChannel();
    const postMessage = mock(() => Promise.resolve({ ts: '3.300' }));
    (channel as any).client = { chat: { postMessage } };
    // Inbound threaded message "200.2" belonged to thread rooted at "100.1"
    (channel as any).rememberThreadRoot('200.2', '100.1');

    await channel.sendMessage('slack:C123', 'reply', '200.2');

    const args = (postMessage.mock.calls[0] as unknown as [any])[0];
    expect(args.thread_ts).toBe('100.1');
  });

  it('streams responses into active assistant threads', async () => {
    const channel = makeSendChannel();
    const startStream = mock(() => Promise.resolve({ ts: '4.400' }));
    const appendStream = mock(() => Promise.resolve({}));
    const stopStream = mock(() => Promise.resolve({}));
    const postMessage = mock(() => Promise.resolve({ ts: '9.999' }));
    (channel as any).client = {
      chat: { startStream, appendStream, stopStream, postMessage },
    };
    (channel as any).assistantThreads.set('D123', '50.5');

    const ts = await channel.sendMessage('slack:D123', 'streamed answer');

    expect(ts).toBe('4.400');
    expect(postMessage).not.toHaveBeenCalled();
    const startArgs = (startStream.mock.calls[0] as unknown as [any])[0];
    expect(startArgs.channel).toBe('D123');
    expect(startArgs.thread_ts).toBe('50.5');
    expect(startArgs.chunks).toEqual([
      { type: 'markdown_text', text: 'streamed answer' },
    ]);
    expect(stopStream).toHaveBeenCalledTimes(1);
  });

  it('streams threaded replies in regular channels with recipient info', async () => {
    const channel = makeSendChannel();
    const startStream = mock(() => Promise.resolve({ ts: '6.600' }));
    const stopStream = mock(() => Promise.resolve({}));
    const postMessage = mock(() => Promise.resolve({ ts: '9.999' }));
    (channel as any).client = {
      chat: { startStream, stopStream, postMessage },
    };
    (channel as any).teamId = 'T999';
    (channel as any).lastHumanSenderByChannel.set('C123', 'UPEYTON');
    (channel as any).rememberThreadRoot('100.1', '100.1');

    const ts = await channel.sendMessage('slack:C123', 'answer', '100.1');

    expect(ts).toBe('6.600');
    expect(postMessage).not.toHaveBeenCalled();
    const startArgs = (startStream.mock.calls[0] as unknown as [any])[0];
    expect(startArgs.thread_ts).toBe('100.1');
    expect(startArgs.recipient_user_id).toBe('UPEYTON');
    expect(startArgs.recipient_team_id).toBe('T999');
  });

  it('does not stream in channels when the recipient is unknown', async () => {
    const channel = makeSendChannel();
    const startStream = mock(() => Promise.resolve({ ts: '6.600' }));
    const postMessage = mock(() => Promise.resolve({ ts: '7.700' }));
    (channel as any).client = { chat: { startStream, postMessage } };
    (channel as any).teamId = 'T999'; // no lastHumanSenderByChannel entry

    const ts = await channel.sendMessage('slack:C123', 'answer', '100.1');

    expect(ts).toBe('7.700');
    expect(startStream).not.toHaveBeenCalled();
  });

  it('falls back to postMessage when streaming is unavailable', async () => {
    const channel = makeSendChannel();
    const startStream = mock(() =>
      Promise.reject(new Error('feature_not_enabled')),
    );
    const postMessage = mock(() => Promise.resolve({ ts: '5.500' }));
    (channel as any).client = { chat: { startStream, postMessage } };
    (channel as any).assistantThreads.set('D123', '50.5');

    const ts = await channel.sendMessage('slack:D123', 'answer');

    expect(ts).toBe('5.500');
    const args = (postMessage.mock.calls[0] as unknown as [any])[0];
    expect(args.thread_ts).toBe('50.5');
  });
});

describe('SlackChannel.startMessageStream', () => {
  it('updates a single progress card in place and streams the final as markdown', async () => {
    const channel = makeSendChannel();
    const startStream = mock(() => Promise.resolve({ ts: '8.800' }));
    const appendStream = mock(() => Promise.resolve({}));
    const stopStream = mock(() => Promise.resolve({}));
    (channel as any).client = {
      chat: { startStream, appendStream, stopStream },
    };
    (channel as any).teamId = 'T999';
    (channel as any).lastHumanSenderByChannel.set('C123', 'UPEYTON');

    const stream = await channel.startMessageStream('slack:C123', '100.1');
    expect(stream).not.toBeNull();

    await stream!.appendStatus('Reading src/index.ts\nsome detail');
    await stream!.appendStatus('Running tests');
    await stream!.appendText('All done **bold**');
    const ts = await stream!.stop();

    expect(ts).toBe('8.800');
    // First status opens the stream with the single progress card (#850: one
    // evolving card per run, not one card per agent action).
    const startArgs = (startStream.mock.calls[0] as unknown as [any])[0];
    expect(startArgs.task_display_mode).toBe('timeline');
    expect(startArgs.chunks).toEqual([
      {
        type: 'task_update',
        id: 'agent-progress',
        title: 'Reading src/index.ts',
        status: 'in_progress',
        details: 'Reading src/index.ts\nsome detail',
      },
    ]);
    // Second status reuses the SAME id, updating the card in place — no new card
    const append1 = (appendStream.mock.calls[0] as unknown as [any])[0];
    expect(append1.chunks).toEqual([
      {
        type: 'task_update',
        id: 'agent-progress',
        title: 'Running tests',
        status: 'in_progress',
      },
    ]);
    // Final text completes the progress card and appends markdown
    const append2 = (appendStream.mock.calls[1] as unknown as [any])[0];
    expect(append2.chunks).toEqual([
      {
        type: 'task_update',
        id: 'agent-progress',
        title: 'Running tests',
        status: 'complete',
      },
      { type: 'markdown_text', text: 'All done **bold**' },
    ]);
    expect(stopStream).toHaveBeenCalledTimes(1);
  });

  it('collapses many tool actions into one card and skips code-fence titles', async () => {
    const channel = makeSendChannel();
    const startStream = mock(() => Promise.resolve({ ts: '8.800' }));
    const appendStream = mock(() => Promise.resolve({}));
    const stopStream = mock(() => Promise.resolve({}));
    (channel as any).client = {
      chat: { startStream, appendStream, stopStream },
    };
    (channel as any).teamId = 'T999';
    (channel as any).lastHumanSenderByChannel.set('C123', 'UPEYTON');

    const stream = await channel.startMessageStream('slack:C123', '100.1');
    // A tool call followed by its (code-fenced) result — both update one card.
    await stream!.appendStatus('> **Bash**: `gh pr view 1379`');
    await stream!.appendStatus('```\nPR #1379: Fix streaming\n```');
    await stream!.stop();

    // Exactly one startStream → one Slack message for the whole run (#850).
    expect(startStream).toHaveBeenCalledTimes(1);
    // Every status update reuses the single card id.
    const allChunks = [
      ...(startStream.mock.calls as unknown as [any][]).flatMap(
        (c) => c[0].chunks,
      ),
      ...(appendStream.mock.calls as unknown as [any][]).flatMap(
        (c) => c[0].chunks,
      ),
    ].filter((chunk: any) => chunk.type === 'task_update');
    expect(allChunks.every((c: any) => c.id === 'agent-progress')).toBe(true);
    // The code-fenced tool result surfaces its content, not a bare ```.
    const resultUpdate = (appendStream.mock.calls[0] as unknown as [any])[0]
      .chunks[0];
    expect(resultUpdate.title).toBe('PR #1379: Fix streaming');
  });

  it('keeps the stream alive when a status append fails after start', async () => {
    const channel = makeSendChannel();
    let appendCalls = 0;
    const startStream = mock(() => Promise.resolve({ ts: '8.800' }));
    const appendStream = mock(() => {
      appendCalls++;
      if (appendCalls === 1) return Promise.reject(new Error('rate_limited'));
      return Promise.resolve({});
    });
    const stopStream = mock(() => Promise.resolve({}));
    (channel as any).client = {
      chat: { startStream, appendStream, stopStream },
    };
    (channel as any).teamId = 'T999';
    (channel as any).lastHumanSenderByChannel.set('C123', 'UPEYTON');

    const stream = await channel.startMessageStream('slack:C123', '100.1');
    await stream!.appendStatus('first');
    // This append fails transiently — must not throw or kill the stream
    await stream!.appendStatus('second');
    await stream!.appendText('final');
    const ts = await stream!.stop();

    expect(ts).toBe('8.800');
    expect(stopStream).toHaveBeenCalledTimes(1);
  });

  it('returns null without a thread anchor', async () => {
    const channel = makeSendChannel();
    (channel as any).teamId = 'T999';
    (channel as any).lastHumanSenderByChannel.set('C123', 'UPEYTON');

    expect(await channel.startMessageStream('slack:C123')).toBeNull();
  });

  it('returns null in channels without recipient info', async () => {
    const channel = makeSendChannel();
    expect(await channel.startMessageStream('slack:C123', '100.1')).toBeNull();
  });

  it('uses the active assistant thread as anchor for bare DM streams', async () => {
    const channel = makeSendChannel();
    const startStream = mock(() => Promise.resolve({ ts: '9.900' }));
    const stopStream = mock(() => Promise.resolve({}));
    (channel as any).client = { chat: { startStream, stopStream } };
    (channel as any).assistantThreads.set('D123', '50.5');

    const stream = await channel.startMessageStream('slack:D123');
    expect(stream).not.toBeNull();
    await stream!.appendText('hi');
    await stream!.stop();

    const startArgs = (startStream.mock.calls[0] as unknown as [any])[0];
    expect(startArgs.thread_ts).toBe('50.5');
    expect(startArgs.recipient_user_id).toBeUndefined();
  });
});

describe('SlackChannel.editMessage', () => {
  it('updates the message with a markdown block', async () => {
    const channel = makeSendChannel();
    const update = mock(() => Promise.resolve({}));
    (channel as any).client = { chat: { update } };

    await channel.editMessage('slack:C123', '1.100', 'new *content*');

    expect(update).toHaveBeenCalledTimes(1);
    const args = (update.mock.calls[0] as unknown as [any])[0];
    expect(args.channel).toBe('C123');
    expect(args.ts).toBe('1.100');
    expect(args.blocks).toEqual([{ type: 'markdown', text: 'new *content*' }]);
  });

  it('retries as plain text when the block edit fails', async () => {
    const channel = makeSendChannel();
    const update = mock((args: any) =>
      args.blocks?.length
        ? Promise.reject(new Error('invalid_blocks'))
        : Promise.resolve({}),
    );
    (channel as any).client = { chat: { update } };

    await channel.editMessage('slack:C123', '1.100', 'plain');

    expect(update).toHaveBeenCalledTimes(2);
    const retryArgs = (update.mock.calls[1] as unknown as [any])[0];
    expect(retryArgs.text).toBe('plain');
    expect(retryArgs.blocks).toEqual([]);
  });
});

describe('SlackChannel.setTyping', () => {
  it('sets assistant thread status while typing', async () => {
    const channel = makeSendChannel();
    const setStatus = mock(() => Promise.resolve({}));
    (channel as any).client = { assistant: { threads: { setStatus } } };
    (channel as any).assistantThreads.set('D123', '50.5');

    await channel.setTyping('slack:D123', true);

    expect(setStatus).toHaveBeenCalledTimes(1);
    const args = (setStatus.mock.calls[0] as unknown as [any])[0];
    expect(args.channel_id).toBe('D123');
    expect(args.thread_ts).toBe('50.5');
    expect(args.status).toContain('thinking');
    expect(Array.isArray(args.loading_messages)).toBe(true);
  });

  it('clears the status when typing stops', async () => {
    const channel = makeSendChannel();
    const setStatus = mock(() => Promise.resolve({}));
    (channel as any).client = { assistant: { threads: { setStatus } } };
    (channel as any).assistantThreads.set('D123', '50.5');

    await channel.setTyping('slack:D123', false);

    const args = (setStatus.mock.calls[0] as unknown as [any])[0];
    expect(args.status).toBe('');
    expect(args.loading_messages).toBeUndefined();
  });

  it('no-ops outside assistant threads', async () => {
    const channel = makeSendChannel();
    const setStatus = mock(() => Promise.resolve({}));
    (channel as any).client = { assistant: { threads: { setStatus } } };

    await channel.setTyping('slack:C123', true);

    expect(setStatus).not.toHaveBeenCalled();
  });
});

// --- Inbound handling: dedup and thread context ---

describe('SlackChannel.handleMessage extras', () => {
  const makeInboundClient = (rootText?: string) => ({
    users: {
      info: mock(() =>
        Promise.resolve({
          user: { name: 'peyton', profile: { display_name: 'Peyton' } },
        }),
      ),
    },
    conversations: {
      info: mock(() => Promise.resolve({ channel: { name: 'general' } })),
      replies: mock(() =>
        Promise.resolve({
          messages: rootText !== undefined ? [{ text: rootText }] : [],
        }),
      ),
    },
  });

  const makeInboundChannel = (onMessage: () => void) => {
    const channel = new SlackChannel({
      botId: 'TEST',
      token: 'xoxb-test',
      appToken: 'xapp-test',
      onMessage,
      onChatMetadata: () => {},
      registeredGroups: () => ({
        'slack:C123': {
          name: 'general',
          folder: 'general',
          trigger: '@bot',
          added_at: new Date().toISOString(),
        },
      }),
    });
    (channel as any).botUserId = 'UBOT';
    return channel;
  };

  it('processes duplicate deliveries of the same message only once', async () => {
    const onMessage = mock(() => {});
    const channel = makeInboundChannel(onMessage);
    (channel as any).client = makeInboundClient();

    const event = {
      channel: 'C123',
      ts: '1700000000.000100',
      text: 'hello',
      user: 'UPEYTON',
    };
    await (channel as any).handleMessage(event);
    await (channel as any).handleMessage({ ...event, type: 'app_mention' });

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('annotates threaded replies with the root message excerpt', async () => {
    const onMessage = mock(() => {});
    const channel = makeInboundChannel(onMessage);
    (channel as any).client = makeInboundClient('What is the deploy status?');

    await (channel as any).handleMessage({
      channel: 'C123',
      ts: '1700000000.000200',
      thread_ts: '1700000000.000100',
      text: 'any update?',
      user: 'UPEYTON',
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    const msg = (onMessage.mock.calls[0] as unknown as [string, any])[1];
    expect(msg.content).toBe(
      '[Thread reply to: "What is the deploy status?"] any update?',
    );
  });

  it('skips the thread annotation in assistant threads', async () => {
    const onMessage = mock(() => {});
    const channel = makeInboundChannel(onMessage);
    (channel as any).client = makeInboundClient('root');

    await (channel as any).handleMessage(
      {
        channel: 'C123',
        ts: '1700000000.000300',
        thread_ts: '1700000000.000100',
        text: 'assistant question',
        user: 'UPEYTON',
      },
      { assistantThread: true },
    );

    const msg = (onMessage.mock.calls[0] as unknown as [string, any])[1];
    expect(msg.content).toBe('assistant question');
  });

  it('records thread roots so replies thread correctly', async () => {
    const onMessage = mock(() => {});
    const channel = makeInboundChannel(onMessage);
    (channel as any).client = makeInboundClient('root');

    await (channel as any).handleMessage({
      channel: 'C123',
      ts: '1700000000.000400',
      thread_ts: '1700000000.000100',
      text: 'threaded',
      user: 'UPEYTON',
    });

    expect((channel as any).threadRootByTs.get('1700000000.000400')).toBe(
      '1700000000.000100',
    );
  });
});

// --- Slack media download helpers ---

describe('SlackChannel.downloadSlackFile', () => {
  it('sends Authorization Bearer header with bot token', async () => {
    const token = 'xoxb-test-token-12345';
    const channel = new SlackChannel({
      botId: 'TEST',
      token,
      appToken: 'xapp-test',
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    });

    const testData = Buffer.from('fake-image-data');
    const mockFetch = mock(() =>
      Promise.resolve(new Response(testData, { status: 200 })),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;

    try {
      const result = await (channel as any).downloadSlackFile(
        'https://files.slack.com/files-pri/T123/download/photo.png',
        10 * 1024 * 1024,
      );
      expect(result).toEqual(testData);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const callArgs = mockFetch.mock.calls[0] as unknown as [
        string,
        RequestInit & { headers: Record<string, string> },
      ];
      expect(callArgs[0]).toBe(
        'https://files.slack.com/files-pri/T123/download/photo.png',
      );
      expect(callArgs[1].headers.Authorization).toBe(`Bearer ${token}`);
      expect(callArgs[1].redirect).toBe('manual');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not follow redirects with the bot token', async () => {
    const channel = new SlackChannel({
      botId: 'TEST',
      token: 'xoxb-test',
      appToken: 'xapp-test',
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    });

    const originalFetch = globalThis.fetch;
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://evil.test/file' },
        }),
      ),
    );
    globalThis.fetch = mockFetch as any;

    try {
      await expect(
        (channel as any).downloadSlackFile('https://files.slack.com/x', 1024),
      ).rejects.toThrow('302');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(callArgs[1].redirect).toBe('manual');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws on non-OK response', async () => {
    const channel = new SlackChannel({
      botId: 'TEST',
      token: 'xoxb-test',
      appToken: 'xapp-test',
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 403 })),
    ) as any;

    try {
      await expect(
        (channel as any).downloadSlackFile('https://files.slack.com/x', 1024),
      ).rejects.toThrow('403');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects non-Slack hosts before sending the bot token', async () => {
    const channel = new SlackChannel({
      botId: 'TEST',
      token: 'xoxb-test',
      appToken: 'xapp-test',
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    });

    const originalFetch = globalThis.fetch;
    const mockFetch = mock(() => Promise.resolve(new Response(null)));
    globalThis.fetch = mockFetch as any;

    try {
      await expect(
        (channel as any).downloadSlackFile('https://evil.test/file', 1024),
      ).rejects.toThrow('Rejected non-Slack file URL');
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects non-HTTPS Slack file URLs before fetch', async () => {
    const channel = new SlackChannel({
      botId: 'TEST',
      token: 'xoxb-test',
      appToken: 'xapp-test',
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    });

    const originalFetch = globalThis.fetch;
    const mockFetch = mock(() => Promise.resolve(new Response(null)));
    globalThis.fetch = mockFetch as any;

    try {
      await expect(
        (channel as any).downloadSlackFile('http://files.slack.com/file', 1024),
      ).rejects.toThrow('Rejected non-Slack file URL');
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('SlackChannel.processFileAttachments', () => {
  const testFolder = `slack-media-test-${Date.now()}`;
  const makeGroup = () => ({
    name: 'test',
    folder: testFolder,
    trigger: '@test',
    added_at: new Date().toISOString(),
  });

  afterEach(() => {
    const dir = path.join(GROUPS_DIR, testFolder);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns file placeholder when no download URL is available', async () => {
    const channel = new SlackChannel({
      botId: 'TEST',
      token: 'xoxb-test',
      appToken: 'xapp-test',
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    });

    const markers = await (channel as any).processFileAttachments(
      [{ name: 'report.pdf', mimetype: 'application/pdf', size: 5000 }],
      makeGroup(),
      'msg1',
    );

    expect(markers).toEqual(['[File: report.pdf]']);
  });

  it('uses video placeholder for video files', async () => {
    const channel = new SlackChannel({
      botId: 'TEST',
      token: 'xoxb-test',
      appToken: 'xapp-test',
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    });

    // Mock download to fail so it falls to type detection
    (channel as any).downloadSlackFile = mock(() => {
      throw new Error('fail');
    });

    const markers = await (channel as any).processFileAttachments(
      [
        {
          name: 'clip.mp4',
          mimetype: 'video/mp4',
          size: 5000,
          url_private_download: 'https://files.slack.com/clip.mp4',
        },
      ],
      makeGroup(),
      'msg1',
    );

    expect(markers).toEqual(['[Video]']);
  });

  it('uses audio placeholder for audio files', async () => {
    const channel = new SlackChannel({
      botId: 'TEST',
      token: 'xoxb-test',
      appToken: 'xapp-test',
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    });

    const markers = await (channel as any).processFileAttachments(
      [
        {
          name: 'voice.ogg',
          mimetype: 'audio/ogg',
          size: 5000,
          url_private_download: 'https://files.slack.com/voice.ogg',
        },
      ],
      makeGroup(),
      'msg1',
    );

    expect(markers).toEqual(['[Audio]']);
  });

  it('downloads and stores image attachments', async () => {
    const channel = new SlackChannel({
      botId: 'TEST',
      token: 'xoxb-test',
      appToken: 'xapp-test',
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    });

    const testBytes = Buffer.from('fake-png');
    (channel as any).downloadSlackFile = mock(() => Promise.resolve(testBytes));

    const group = makeGroup();
    const markers = await (channel as any).processFileAttachments(
      [
        {
          name: 'screenshot.png',
          mimetype: 'image/png',
          size: 1024,
          url_private_download: 'https://files.slack.com/screenshot.png',
        },
      ],
      group,
      'msg1',
    );

    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatch(
      /\[attachment:image file=msg1-screenshot\.png\]/,
    );

    // Verify file was written
    const mediaDir = path.join(GROUPS_DIR, testFolder, 'media');
    expect(fs.existsSync(path.join(mediaDir, 'msg1-screenshot.png'))).toBe(
      true,
    );
  });

  it('inlines small text file attachments', async () => {
    const channel = new SlackChannel({
      botId: 'TEST',
      token: 'xoxb-test',
      appToken: 'xapp-test',
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    });

    const textContent = '{"key": "value"}';
    (channel as any).downloadSlackFile = mock(() =>
      Promise.resolve(Buffer.from(textContent)),
    );

    const markers = await (channel as any).processFileAttachments(
      [
        {
          name: 'config.json',
          mimetype: 'application/json',
          size: textContent.length,
          url_private_download: 'https://files.slack.com/config.json',
        },
      ],
      makeGroup(),
      'msg1',
    );

    expect(markers).toEqual([
      '[attachment:file name=config.json]\n{"key": "value"}\n[/attachment:file]',
    ]);
  });

  it('falls back to placeholder on download failure', async () => {
    const channel = new SlackChannel({
      botId: 'TEST',
      token: 'xoxb-test',
      appToken: 'xapp-test',
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    });

    (channel as any).downloadSlackFile = mock(() => {
      throw new Error('Network error');
    });

    const markers = await (channel as any).processFileAttachments(
      [
        {
          name: 'photo.jpg',
          mimetype: 'image/jpeg',
          size: 1024,
          url_private_download: 'https://files.slack.com/photo.jpg',
        },
      ],
      makeGroup(),
      'msg1',
    );

    expect(markers).toEqual(['[File: photo.jpg]']);
  });
});

// --- Slack media marker formatting ---

describe('Slack media marker formatting', () => {
  it('formats image marker', () => {
    expect(formatImageMarker('msg1-photo.png')).toBe(
      '[attachment:image file=msg1-photo.png]',
    );
  });

  it('formats text file marker', () => {
    expect(formatTextFileMarker('data.csv', 'a,b\n1,2')).toBe(
      '[attachment:file name=data.csv]\na,b\n1,2\n[/attachment:file]',
    );
  });

  it('formats placeholders', () => {
    expect(formatPlaceholder('video')).toBe('[Video]');
    expect(formatPlaceholder('audio')).toBe('[Audio]');
    expect(formatPlaceholder('file', 'doc.pdf')).toBe('[File: doc.pdf]');
    expect(formatPlaceholder('file')).toBe('[File]');
  });

  it('appends file markers to existing text content', () => {
    const text = 'Check this file';
    const markers = ['[attachment:image file=msg1-photo.png]'];
    const suffix = markers.join(' ');
    const content = `${text} ${suffix}`;
    expect(content).toBe(
      'Check this file [attachment:image file=msg1-photo.png]',
    );
  });

  it('uses file markers alone when no text', () => {
    const markers = ['[attachment:image file=msg1-photo.png]'];
    const suffix = markers.join(' ');
    const content = suffix;
    expect(content).toBe('[attachment:image file=msg1-photo.png]');
  });
});

// --- Media directory security ---

describe('Slack media directory security', () => {
  const testFolder = `slack-security-test-${Date.now()}`;

  afterEach(() => {
    const dir = path.join(GROUPS_DIR, testFolder);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prevents path traversal in filenames', () => {
    const { ensureMediaDir, buildSafeMediaPath } = require('../media.js');
    const group = {
      name: 'test',
      folder: testFolder,
      trigger: '@test',
      added_at: new Date().toISOString(),
    };
    const mediaDir = ensureMediaDir(group);
    const filePath = buildSafeMediaPath(
      mediaDir,
      'msg1',
      '../../../etc/passwd',
    );
    expect(filePath).not.toContain('..');
    expect(path.dirname(filePath)).toBe(mediaDir);
  });
});

// --- Slack slash command routing ---

describe('SlackChannel slash command routing', () => {
  type RespondCall = {
    response_type?: 'ephemeral' | 'in_channel';
    text?: string;
  };

  const slashClient = (
    options: { admin?: boolean; lookupFails?: boolean } = {},
  ) => ({
    users: {
      info: mock(() =>
        options.lookupFails
          ? Promise.reject(new Error('users.info exploded'))
          : Promise.resolve({
              user: {
                is_admin: options.admin !== false,
                is_owner: false,
                is_primary_owner: false,
              },
            }),
      ),
    },
    conversations: {
      info: mock(() => Promise.resolve({ channel: { name: 'test-channel' } })),
    },
  });

  const buildSlashChannel = (opts: {
    onSyntheticMessage?: ReturnType<typeof mock>;
    onSessionCommand?: ReturnType<typeof mock>;
    multiBotMode?: boolean;
    admin?: boolean;
    adminLookupFails?: boolean;
    slashCommandGroups?: () => Array<{
      name: string;
      folder: string;
      trigger: string;
      added_at: string;
    }>;
  }) => {
    const channel = new SlackChannel({
      botId: opts.multiBotMode ? 'CLAYTON' : 'default',
      token: 'xoxb-test',
      appToken: 'xapp-test',
      multiBotMode: opts.multiBotMode === true,
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({
        'slack:C123': {
          name: 'Clayton',
          folder: 'clayton-discord',
          trigger: '@Clayton',
          added_at: new Date().toISOString(),
        },
        'slack:CLAYTON:C123': {
          name: 'Clayton',
          folder: 'clayton-discord',
          trigger: '@Clayton',
          added_at: new Date().toISOString(),
        },
      }),
      slashCommandGroups: opts.slashCommandGroups,
      onSyntheticMessage: opts.onSyntheticMessage,
      onSessionCommand: opts.onSessionCommand,
    });
    (channel as unknown as { client: unknown }).client = slashClient({
      admin: opts.admin !== false,
      lookupFails: opts.adminLookupFails === true,
    });
    return channel;
  };

  const slashCommand = (overrides: Partial<Record<string, string>> = {}) => ({
    token: 'verif',
    command: '/research-driver',
    text: '',
    response_url: 'https://hooks.slack.com/x',
    trigger_id: 'trg-1',
    user_id: 'UPEYTON',
    user_name: 'peyton',
    team_id: 'T1',
    team_domain: 'omniaura',
    channel_id: 'C123',
    channel_name: 'test-channel',
    api_app_id: 'A1',
    ...overrides,
  });

  it('queues a flow slash command as a synthetic message', async () => {
    const onSyntheticMessage = mock(() => {});
    const channel = buildSlashChannel({ onSyntheticMessage });
    const respond = mock(async (_: RespondCall) => {});

    await (
      channel as unknown as {
        handleSlashCommand: (
          c: ReturnType<typeof slashCommand>,
          r: typeof respond,
        ) => Promise<void>;
      }
    ).handleSlashCommand(
      slashCommand({ text: 'investigate the foo bug' }),
      respond,
    );

    expect(respond).toHaveBeenCalledTimes(1);
    expect((respond.mock.calls[0][0] as RespondCall).response_type).toBe(
      'ephemeral',
    );

    expect(onSyntheticMessage).toHaveBeenCalledTimes(1);
    const synthetic = (
      onSyntheticMessage.mock.calls[0] as unknown as [
        { content: string; chat_jid: string; sender_platform: string },
      ]
    )[0];
    expect(synthetic.sender_platform).toBe('slack');
    expect(synthetic.chat_jid).toBe('slack:C123');
    expect(synthetic.content).toContain('@Clayton');
    expect(synthetic.content).toContain('investigate the foo bug');
  });

  it('rejects a flow command missing a required option without queueing', async () => {
    const onSyntheticMessage = mock(() => {});
    const channel = buildSlashChannel({ onSyntheticMessage });
    const respond = mock(async (_: RespondCall) => {});

    await (
      channel as unknown as {
        handleSlashCommand: (
          c: ReturnType<typeof slashCommand>,
          r: typeof respond,
        ) => Promise<void>;
      }
    ).handleSlashCommand(
      slashCommand({ command: '/research-driver', text: '' }),
      respond,
    );

    expect(onSyntheticMessage).not.toHaveBeenCalled();
    const reply = respond.mock.calls[0][0] as RespondCall;
    expect(reply.response_type).toBe('ephemeral');
    expect(reply.text).toContain('needs more input');
  });

  it('uses scoped JIDs when running in multi-bot mode', async () => {
    const onSyntheticMessage = mock(() => {});
    const channel = buildSlashChannel({
      onSyntheticMessage,
      multiBotMode: true,
    });
    const respond = mock(async (_: RespondCall) => {});

    await (
      channel as unknown as {
        handleSlashCommand: (
          c: ReturnType<typeof slashCommand>,
          r: typeof respond,
        ) => Promise<void>;
      }
    ).handleSlashCommand(
      slashCommand({ text: 'investigate the foo bug' }),
      respond,
    );

    const synthetic = (
      onSyntheticMessage.mock.calls[0] as unknown as [{ chat_jid: string }]
    )[0];
    expect(synthetic.chat_jid).toBe('slack:CLAYTON:C123');
  });

  it('routes /session list to the host session handler', async () => {
    const onSessionCommand = mock(() => ({ message: 'No sessions.' }));
    const channel = buildSlashChannel({ onSessionCommand });
    const respond = mock(async (_: RespondCall) => {});

    await (
      channel as unknown as {
        handleSlashCommand: (
          c: ReturnType<typeof slashCommand>,
          r: typeof respond,
        ) => Promise<void>;
      }
    ).handleSlashCommand(
      slashCommand({ command: '/session', text: 'list limit=5' }),
      respond,
    );

    expect(onSessionCommand).toHaveBeenCalledTimes(1);
    const [cmd, chatJid, group, options] = onSessionCommand.mock
      .calls[0] as unknown as [
      string,
      string,
      { folder: string },
      { limit?: number },
    ];
    expect(cmd).toBe('list');
    expect(chatJid).toBe('slack:C123');
    expect(group.folder).toBe('clayton-discord');
    expect(options.limit).toBe(5);

    const reply = respond.mock.calls[0][0] as RespondCall;
    expect(reply.response_type).toBe('ephemeral');
    expect(reply.text).toBe('No sessions.');
  });

  it('routes the legacy /resume alias with deprecation metadata', async () => {
    const onSessionCommand = mock(() => ({ message: 'Resumed.' }));
    const channel = buildSlashChannel({ onSessionCommand });
    const respond = mock(async (_: RespondCall) => {});

    await (
      channel as unknown as {
        handleSlashCommand: (
          c: ReturnType<typeof slashCommand>,
          r: typeof respond,
        ) => Promise<void>;
      }
    ).handleSlashCommand(
      slashCommand({
        command: '/resume',
        text: '123e4567-e89b-12d3-a456-426614174000',
      }),
      respond,
    );

    expect(onSessionCommand).toHaveBeenCalledTimes(1);
    const [cmd, , , options] = onSessionCommand.mock.calls[0] as unknown as [
      string,
      string,
      unknown,
      { sessionId?: string; deprecatedAlias?: string },
    ];
    expect(cmd).toBe('resume');
    expect(options.sessionId).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(options.deprecatedAlias).toBe('resume');
  });

  it('rejects unknown slash commands with an ephemeral hint', async () => {
    const onSyntheticMessage = mock(() => {});
    const channel = buildSlashChannel({ onSyntheticMessage });
    const respond = mock(async (_: RespondCall) => {});

    await (
      channel as unknown as {
        handleSlashCommand: (
          c: ReturnType<typeof slashCommand>,
          r: typeof respond,
        ) => Promise<void>;
      }
    ).handleSlashCommand(
      slashCommand({ command: '/not-a-flow', text: '' }),
      respond,
    );

    expect(onSyntheticMessage).not.toHaveBeenCalled();
    const reply = respond.mock.calls[0][0] as RespondCall;
    expect(reply.text).toContain('not a configured flow');
  });

  it('refuses /session commands for non-admin users', async () => {
    const onSessionCommand = mock(() => ({ message: 'should not run' }));
    const channel = buildSlashChannel({
      onSessionCommand,
      admin: false,
    });
    const respond = mock(async (_: RespondCall) => {});

    await (
      channel as unknown as {
        handleSlashCommand: (
          c: ReturnType<typeof slashCommand>,
          r: typeof respond,
        ) => Promise<void>;
      }
    ).handleSlashCommand(
      slashCommand({ command: '/session', text: 'list' }),
      respond,
    );

    expect(onSessionCommand).not.toHaveBeenCalled();
    const reply = respond.mock.calls[0][0] as RespondCall;
    expect(reply.text).toContain('workspace admins');
  });

  it('refuses to queue commands from unregistered channels', async () => {
    const onSyntheticMessage = mock(() => {});
    const channel = buildSlashChannel({ onSyntheticMessage });
    const respond = mock(async (_: RespondCall) => {});

    await (
      channel as unknown as {
        handleSlashCommand: (
          c: ReturnType<typeof slashCommand>,
          r: typeof respond,
        ) => Promise<void>;
      }
    ).handleSlashCommand(
      slashCommand({ channel_id: 'C-UNKNOWN', text: 'goal=something' }),
      respond,
    );

    expect(onSyntheticMessage).not.toHaveBeenCalled();
    const reply = respond.mock.calls[0][0] as RespondCall;
    expect(reply.text).toContain('not registered');
  });

  it('rejects flow commands when slashCommandGroups excludes the group', async () => {
    const onSyntheticMessage = mock(() => {});
    const respond = mock(async (_: RespondCall) => {});
    // slashCommandGroups returns a *different* group than the channel resolves
    // to — typical of subscription-scoped multi-bot setups where this bot does
    // not own the channel's commands. Must not fall back to the channel group.
    const channel = buildSlashChannel({
      onSyntheticMessage,
      slashCommandGroups: () => [
        {
          name: 'OtherBot',
          folder: 'other-bot',
          trigger: '@OtherBot',
          added_at: new Date().toISOString(),
        },
      ],
    });

    await (
      channel as unknown as {
        handleSlashCommand: (
          c: ReturnType<typeof slashCommand>,
          r: typeof respond,
        ) => Promise<void>;
      }
    ).handleSlashCommand(
      slashCommand({ text: 'investigate the foo bug' }),
      respond,
    );

    expect(onSyntheticMessage).not.toHaveBeenCalled();
    const reply = respond.mock.calls[0][0] as RespondCall;
    expect(reply.text).toContain('not a configured flow');
  });

  it('refuses /session commands when users.info lookup fails', async () => {
    const onSessionCommand = mock(() => ({ message: 'should not run' }));
    const channel = buildSlashChannel({
      onSessionCommand,
      adminLookupFails: true,
    });
    const respond = mock(async (_: RespondCall) => {});

    await (
      channel as unknown as {
        handleSlashCommand: (
          c: ReturnType<typeof slashCommand>,
          r: typeof respond,
        ) => Promise<void>;
      }
    ).handleSlashCommand(
      slashCommand({ command: '/session', text: 'list' }),
      respond,
    );

    expect(onSessionCommand).not.toHaveBeenCalled();
    const reply = respond.mock.calls[0][0] as RespondCall;
    expect(reply.text).toContain('workspace admins');
  });
});
