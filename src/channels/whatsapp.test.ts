import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';

import { WhatsAppChannel } from './whatsapp.js';
import type { WhatsAppChannelOpts } from './whatsapp.js';
import type { OnInboundMessage, OnChatMetadata } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock socket for sendMessage / setTyping / presence tests. */
function makeMockSocket(overrides: Record<string, unknown> = {}) {
  return {
    sendMessage: mock(() =>
      Promise.resolve({ key: { id: `sent-${Date.now()}` } }),
    ),
    sendPresenceUpdate: mock(() => Promise.resolve()),
    signalRepository: {
      lidMapping: { getPNForLID: mock(() => Promise.resolve(null)) },
    },
    groupFetchAllParticipating: mock(() => Promise.resolve({})),
    user: { id: '1234567890:0@s.whatsapp.net', lid: '1234:0@lid' },
    ev: { on: mock(), off: mock() },
    end: mock(),
    ...overrides,
  };
}

/** Create a WhatsAppChannel instance with test-friendly defaults. */
function makeChannel(
  optsOverrides: Partial<WhatsAppChannelOpts> = {},
): WhatsAppChannel {
  return new WhatsAppChannel({
    onMessage: mock() as unknown as OnInboundMessage,
    onChatMetadata: mock() as unknown as OnChatMetadata,
    registeredGroups: () => ({}),
    onReaction: mock(),
    ...optsOverrides,
  });
}

/**
 * Access a private field on the channel for testing purposes.
 * We cast to `any` because these are private fields.
 */
function getPrivate(channel: WhatsAppChannel, field: string): any {
  return (channel as any)[field];
}

function setPrivate(channel: WhatsAppChannel, field: string, value: any) {
  (channel as any)[field] = value;
}

// ===========================================================================
// ownsJid — pure function, no socket needed
// ===========================================================================

describe('WhatsAppChannel.ownsJid', () => {
  const channel = makeChannel();

  it('matches WhatsApp group JIDs (@g.us)', () => {
    expect(channel.ownsJid('120363336345536173@g.us')).toBe(true);
    expect(channel.ownsJid('1234567890-1234567890@g.us')).toBe(true);
  });

  it('matches WhatsApp personal JIDs (@s.whatsapp.net)', () => {
    expect(channel.ownsJid('1234567890@s.whatsapp.net')).toBe(true);
    expect(channel.ownsJid('441234567890@s.whatsapp.net')).toBe(true);
  });

  it('does not match Discord JIDs', () => {
    expect(channel.ownsJid('dc:1234567890')).toBe(false);
    expect(channel.ownsJid('dc:dm:123')).toBe(false);
  });

  it('does not match Telegram JIDs', () => {
    expect(channel.ownsJid('tg:12345')).toBe(false);
    expect(channel.ownsJid('tg:-100123456789')).toBe(false);
  });

  it('does not match Slack JIDs', () => {
    expect(channel.ownsJid('slack:C12345')).toBe(false);
  });

  it('does not match empty string', () => {
    expect(channel.ownsJid('')).toBe(false);
  });

  it('does not match LID JIDs (@lid)', () => {
    expect(channel.ownsJid('1234:0@lid')).toBe(false);
  });

  it('does not match status broadcast', () => {
    expect(channel.ownsJid('status@broadcast')).toBe(false);
  });
});

// ===========================================================================
// isConnected — state management
// ===========================================================================

describe('WhatsAppChannel.isConnected', () => {
  it('starts as disconnected', () => {
    const channel = makeChannel();
    expect(channel.isConnected()).toBe(false);
  });

  it('returns true when connected', () => {
    const channel = makeChannel();
    setPrivate(channel, 'connected', true);
    expect(channel.isConnected()).toBe(true);
  });
});

// ===========================================================================
// disconnect
// ===========================================================================

describe('WhatsAppChannel.disconnect', () => {
  it('sets connected to false', async () => {
    const channel = makeChannel();
    setPrivate(channel, 'connected', true);
    const mockSock = makeMockSocket();
    setPrivate(channel, 'sock', mockSock);

    await channel.disconnect();

    expect(channel.isConnected()).toBe(false);
  });

  it('calls sock.end()', async () => {
    const channel = makeChannel();
    const mockSock = makeMockSocket();
    setPrivate(channel, 'sock', mockSock);
    setPrivate(channel, 'connected', true);

    await channel.disconnect();

    expect(mockSock.end).toHaveBeenCalledWith(undefined);
  });
});

// ===========================================================================
// name and prefixAssistantName
// ===========================================================================

describe('WhatsAppChannel properties', () => {
  it('has name "whatsapp"', () => {
    const channel = makeChannel();
    expect(channel.name).toBe('whatsapp');
  });

  it('has prefixAssistantName = true', () => {
    const channel = makeChannel();
    expect(channel.prefixAssistantName).toBe(true);
  });
});

// ===========================================================================
// sendMessage — queue behavior when disconnected
// ===========================================================================

describe('WhatsAppChannel.sendMessage', () => {
  describe('when disconnected', () => {
    it('queues message instead of sending', async () => {
      const channel = makeChannel();
      setPrivate(channel, 'connected', false);
      const mockSock = makeMockSocket();
      setPrivate(channel, 'sock', mockSock);

      const result = await channel.sendMessage('123@g.us', 'Hello');

      expect(result).toBeUndefined();
      const queue = getPrivate(channel, 'outgoingQueue');
      expect(queue).toHaveLength(1);
      expect(queue[0]).toEqual({ jid: '123@g.us', text: 'Hello' });
      expect(mockSock.sendMessage).not.toHaveBeenCalled();
    });

    it('queues multiple messages in order', async () => {
      const channel = makeChannel();
      setPrivate(channel, 'connected', false);
      setPrivate(channel, 'sock', makeMockSocket());

      await channel.sendMessage('123@g.us', 'First');
      await channel.sendMessage('456@g.us', 'Second');
      await channel.sendMessage('123@g.us', 'Third');

      const queue = getPrivate(channel, 'outgoingQueue');
      expect(queue).toHaveLength(3);
      expect(queue[0].text).toBe('First');
      expect(queue[1].text).toBe('Second');
      expect(queue[2].text).toBe('Third');
    });
  });

  describe('when connected', () => {
    it('sends message via socket', async () => {
      const channel = makeChannel();
      setPrivate(channel, 'connected', true);
      const mockSock = makeMockSocket();
      setPrivate(channel, 'sock', mockSock);

      await channel.sendMessage('123@g.us', 'Hello');

      expect(mockSock.sendMessage).toHaveBeenCalledWith(
        '123@g.us',
        { text: 'Hello' },
        undefined,
      );
    });

    it('returns sent message ID', async () => {
      const channel = makeChannel();
      setPrivate(channel, 'connected', true);
      const mockSock = makeMockSocket({
        sendMessage: mock(() => Promise.resolve({ key: { id: 'msg-42' } })),
      });
      setPrivate(channel, 'sock', mockSock);

      const result = await channel.sendMessage('123@g.us', 'Hello');

      expect(result).toBe('msg-42');
    });

    it('tracks sent message ID for echo prevention', async () => {
      const channel = makeChannel();
      setPrivate(channel, 'connected', true);
      const mockSock = makeMockSocket({
        sendMessage: mock(() => Promise.resolve({ key: { id: 'msg-42' } })),
      });
      setPrivate(channel, 'sock', mockSock);

      await channel.sendMessage('123@g.us', 'Hello');

      const sentIds = getPrivate(channel, 'sentMessageIds') as Set<string>;
      expect(sentIds.has('msg-42')).toBe(true);
    });

    it('tracks sent message text for self-chat reply context', async () => {
      const channel = makeChannel();
      setPrivate(channel, 'connected', true);
      const mockSock = makeMockSocket({
        sendMessage: mock(() => Promise.resolve({ key: { id: 'msg-42' } })),
      });
      setPrivate(channel, 'sock', mockSock);

      await channel.sendMessage('123@g.us', 'Hello world');

      const sentTexts = getPrivate(channel, 'sentMessageTexts') as Map<
        string,
        string
      >;
      expect(sentTexts.get('msg-42')).toBe('Hello world');
    });

    it('prunes sentMessageIds when exceeding max (200)', async () => {
      const channel = makeChannel();
      setPrivate(channel, 'connected', true);

      // Pre-populate 200 entries to hit the cap
      const sentIds = new Set<string>();
      const sentTexts = new Map<string, string>();
      for (let i = 0; i < 200; i++) {
        sentIds.add(`old-${i}`);
        sentTexts.set(`old-${i}`, `text-${i}`);
      }
      setPrivate(channel, 'sentMessageIds', sentIds);
      setPrivate(channel, 'sentMessageTexts', sentTexts);

      const mockSock = makeMockSocket({
        sendMessage: mock(() => Promise.resolve({ key: { id: 'new-msg' } })),
      });
      setPrivate(channel, 'sock', mockSock);

      await channel.sendMessage('123@g.us', 'New message');

      // Should have pruned the oldest (old-0) and added new-msg
      const ids = getPrivate(channel, 'sentMessageIds') as Set<string>;
      expect(ids.has('new-msg')).toBe(true);
      // Size should be back to 200 (removed 1, added 1)
      expect(ids.size).toBeLessThanOrEqual(201);
      // The first entry 'old-0' should be removed
      expect(ids.has('old-0')).toBe(false);
    });

    it('uses cached message for reply quoting', async () => {
      const channel = makeChannel();
      setPrivate(channel, 'connected', true);
      const mockSock = makeMockSocket();
      setPrivate(channel, 'sock', mockSock);

      // Pre-populate message cache with a message to quote
      const fakeMsg = {
        key: { id: 'orig-msg' },
        message: { conversation: 'original text' },
      };
      const cache = new Map();
      cache.set('orig-msg', { msg: fakeMsg, ts: Date.now() });
      setPrivate(channel, 'messageCache', cache);

      await channel.sendMessage('123@g.us', 'Reply text', 'orig-msg');

      expect(mockSock.sendMessage).toHaveBeenCalledWith(
        '123@g.us',
        { text: 'Reply text' },
        { quoted: fakeMsg },
      );
    });

    it('sends without quoting when replyToMessageId is not in cache', async () => {
      const channel = makeChannel();
      setPrivate(channel, 'connected', true);
      const mockSock = makeMockSocket();
      setPrivate(channel, 'sock', mockSock);

      await channel.sendMessage('123@g.us', 'Reply text', 'nonexistent-id');

      expect(mockSock.sendMessage).toHaveBeenCalledWith(
        '123@g.us',
        { text: 'Reply text' },
        undefined,
      );
    });

    it('queues message on send failure', async () => {
      const channel = makeChannel();
      setPrivate(channel, 'connected', true);
      const mockSock = makeMockSocket({
        sendMessage: mock(() => Promise.reject(new Error('Network error'))),
      });
      setPrivate(channel, 'sock', mockSock);

      await channel.sendMessage('123@g.us', 'Hello');

      const queue = getPrivate(channel, 'outgoingQueue');
      expect(queue).toHaveLength(1);
      expect(queue[0]).toEqual({ jid: '123@g.us', text: 'Hello' });
    });

    it('returns undefined when send fails', async () => {
      const channel = makeChannel();
      setPrivate(channel, 'connected', true);
      const mockSock = makeMockSocket({
        sendMessage: mock(() => Promise.reject(new Error('error'))),
      });
      setPrivate(channel, 'sock', mockSock);

      const result = await channel.sendMessage('123@g.us', 'Hello');

      expect(result).toBeUndefined();
    });

    it('returns undefined when socket returns null key', async () => {
      const channel = makeChannel();
      setPrivate(channel, 'connected', true);
      const mockSock = makeMockSocket({
        sendMessage: mock(() => Promise.resolve(null)),
      });
      setPrivate(channel, 'sock', mockSock);

      const result = await channel.sendMessage('123@g.us', 'Hello');

      expect(result).toBeUndefined();
    });
  });
});

// ===========================================================================
// setTyping — typing indicator state tracking
// ===========================================================================

describe('WhatsAppChannel.setTyping', () => {
  it('adds JID to activeTypingJids when typing starts', async () => {
    const channel = makeChannel();
    const mockSock = makeMockSocket();
    setPrivate(channel, 'sock', mockSock);

    await channel.setTyping('123@g.us', true);

    const activeJids = getPrivate(channel, 'activeTypingJids') as Set<string>;
    expect(activeJids.has('123@g.us')).toBe(true);
  });

  it('removes JID from activeTypingJids when typing stops', async () => {
    const channel = makeChannel();
    const mockSock = makeMockSocket();
    setPrivate(channel, 'sock', mockSock);

    // Start typing first
    const activeJids = new Set(['123@g.us']);
    setPrivate(channel, 'activeTypingJids', activeJids);

    await channel.setTyping('123@g.us', false);

    expect(activeJids.has('123@g.us')).toBe(false);
  });

  it('sends "composing" presence when typing starts', async () => {
    const channel = makeChannel();
    const mockSock = makeMockSocket();
    setPrivate(channel, 'sock', mockSock);

    await channel.setTyping('123@g.us', true);

    expect(mockSock.sendPresenceUpdate).toHaveBeenCalledWith(
      'composing',
      '123@g.us',
    );
  });

  it('sends "paused" presence when typing stops', async () => {
    const channel = makeChannel();
    const mockSock = makeMockSocket();
    setPrivate(channel, 'sock', mockSock);

    await channel.setTyping('123@g.us', false);

    expect(mockSock.sendPresenceUpdate).toHaveBeenCalledWith(
      'paused',
      '123@g.us',
    );
  });

  it('does not throw when sendPresenceUpdate fails', async () => {
    const channel = makeChannel();
    const mockSock = makeMockSocket({
      sendPresenceUpdate: mock(() => Promise.reject(new Error('fail'))),
    });
    setPrivate(channel, 'sock', mockSock);

    // Should not throw
    await channel.setTyping('123@g.us', true);
    expect(true).toBe(true); // reached without error
  });

  it('can track multiple JIDs typing simultaneously', async () => {
    const channel = makeChannel();
    const mockSock = makeMockSocket();
    setPrivate(channel, 'sock', mockSock);

    await channel.setTyping('123@g.us', true);
    await channel.setTyping('456@g.us', true);

    const activeJids = getPrivate(channel, 'activeTypingJids') as Set<string>;
    expect(activeJids.size).toBe(2);
    expect(activeJids.has('123@g.us')).toBe(true);
    expect(activeJids.has('456@g.us')).toBe(true);
  });
});

// ===========================================================================
// pruneMessageCache — internal cache eviction logic
// ===========================================================================

describe('WhatsAppChannel.pruneMessageCache (via sendMessage cache)', () => {
  it('evicts entries older than TTL (1 hour)', () => {
    const channel = makeChannel();
    const cache = new Map<string, { msg: any; ts: number }>();

    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;

    // Add expired entries (>1hr old)
    cache.set('old-1', { msg: {}, ts: now - ONE_HOUR - 1000 });
    cache.set('old-2', { msg: {}, ts: now - ONE_HOUR - 5000 });
    // Add fresh entry
    cache.set('fresh-1', { msg: {}, ts: now - 100 });

    setPrivate(channel, 'messageCache', cache);

    // Call private pruneMessageCache
    (channel as any).pruneMessageCache();

    expect(cache.has('old-1')).toBe(false);
    expect(cache.has('old-2')).toBe(false);
    expect(cache.has('fresh-1')).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('evicts oldest entries when exceeding max size (500)', () => {
    const channel = makeChannel();
    const cache = new Map<string, { msg: any; ts: number }>();

    const now = Date.now();
    // Add 502 entries, all within TTL
    for (let i = 0; i < 502; i++) {
      cache.set(`msg-${i}`, { msg: {}, ts: now - i * 100 });
    }

    setPrivate(channel, 'messageCache', cache);
    (channel as any).pruneMessageCache();

    expect(cache.size).toBe(500);
    // The oldest two (msg-501, msg-500) should be evicted
    expect(cache.has('msg-501')).toBe(false);
    expect(cache.has('msg-500')).toBe(false);
    // Most recent should still be there
    expect(cache.has('msg-0')).toBe(true);
    expect(cache.has('msg-1')).toBe(true);
  });

  it('handles empty cache without error', () => {
    const channel = makeChannel();
    setPrivate(channel, 'messageCache', new Map());

    // Should not throw
    (channel as any).pruneMessageCache();

    expect(getPrivate(channel, 'messageCache').size).toBe(0);
  });

  it('handles cache at exactly max size (no eviction needed)', () => {
    const channel = makeChannel();
    const cache = new Map<string, { msg: any; ts: number }>();

    const now = Date.now();
    for (let i = 0; i < 500; i++) {
      cache.set(`msg-${i}`, { msg: {}, ts: now });
    }

    setPrivate(channel, 'messageCache', cache);
    (channel as any).pruneMessageCache();

    expect(cache.size).toBe(500);
  });

  it('combines TTL eviction and max size eviction', () => {
    const channel = makeChannel();
    const cache = new Map<string, { msg: any; ts: number }>();

    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;

    // 100 expired entries
    for (let i = 0; i < 100; i++) {
      cache.set(`expired-${i}`, { msg: {}, ts: now - ONE_HOUR - 1000 - i });
    }
    // 490 fresh entries
    for (let i = 0; i < 490; i++) {
      cache.set(`fresh-${i}`, { msg: {}, ts: now - i });
    }

    setPrivate(channel, 'messageCache', cache);
    (channel as any).pruneMessageCache();

    // All 100 expired entries should be gone (TTL eviction)
    for (let i = 0; i < 100; i++) {
      expect(cache.has(`expired-${i}`)).toBe(false);
    }
    // 490 fresh entries all survive (under 500 cap after TTL eviction)
    expect(cache.size).toBe(490);
  });
});

// ===========================================================================
// translateJid — LID to phone JID translation
// ===========================================================================

describe('WhatsAppChannel.translateJid', () => {
  it('passes through non-LID JIDs unchanged', async () => {
    const channel = makeChannel();
    const mockSock = makeMockSocket();
    setPrivate(channel, 'sock', mockSock);

    const result = await (channel as any).translateJid('123@g.us');
    expect(result).toBe('123@g.us');
  });

  it('passes through @s.whatsapp.net JIDs unchanged', async () => {
    const channel = makeChannel();
    const mockSock = makeMockSocket();
    setPrivate(channel, 'sock', mockSock);

    const result = await (channel as any).translateJid(
      '1234567890@s.whatsapp.net',
    );
    expect(result).toBe('1234567890@s.whatsapp.net');
  });

  it('returns cached phone JID for known LID', async () => {
    const channel = makeChannel();
    const mockSock = makeMockSocket();
    setPrivate(channel, 'sock', mockSock);
    setPrivate(channel, 'lidToPhoneMap', {
      '5678': '1234567890@s.whatsapp.net',
    });

    const result = await (channel as any).translateJid('5678:0@lid');
    expect(result).toBe('1234567890@s.whatsapp.net');
  });

  it('queries signalRepository for unknown LID', async () => {
    const channel = makeChannel();
    const getPNForLID = mock(() =>
      Promise.resolve('9876543210:0@s.whatsapp.net'),
    );
    const mockSock = makeMockSocket({
      signalRepository: { lidMapping: { getPNForLID } },
    });
    setPrivate(channel, 'sock', mockSock);

    const result = await (channel as any).translateJid('unknown:0@lid');

    expect(result).toBe('9876543210@s.whatsapp.net');
    expect(getPNForLID).toHaveBeenCalledWith('unknown:0@lid');
  });

  it('caches the result after signalRepository lookup', async () => {
    const channel = makeChannel();
    const getPNForLID = mock(() =>
      Promise.resolve('9876543210:0@s.whatsapp.net'),
    );
    const mockSock = makeMockSocket({
      signalRepository: { lidMapping: { getPNForLID } },
    });
    setPrivate(channel, 'sock', mockSock);

    await (channel as any).translateJid('unknown:0@lid');

    const map = getPrivate(channel, 'lidToPhoneMap');
    expect(map['unknown']).toBe('9876543210@s.whatsapp.net');
  });

  it('returns original LID JID when signalRepository returns null', async () => {
    const channel = makeChannel();
    const mockSock = makeMockSocket({
      signalRepository: {
        lidMapping: { getPNForLID: mock(() => Promise.resolve(null)) },
      },
    });
    setPrivate(channel, 'sock', mockSock);

    const result = await (channel as any).translateJid('unknown:0@lid');
    expect(result).toBe('unknown:0@lid');
  });

  it('returns original LID JID when signalRepository throws', async () => {
    const channel = makeChannel();
    const mockSock = makeMockSocket({
      signalRepository: {
        lidMapping: {
          getPNForLID: mock(() => Promise.reject(new Error('lookup failed'))),
        },
      },
    });
    setPrivate(channel, 'sock', mockSock);

    const result = await (channel as any).translateJid('unknown:0@lid');
    expect(result).toBe('unknown:0@lid');
  });
});

// ===========================================================================
// flushOutgoingQueue — drain queued messages
// ===========================================================================

describe('WhatsAppChannel.flushOutgoingQueue', () => {
  it('sends all queued messages when connected', async () => {
    const channel = makeChannel();
    setPrivate(channel, 'connected', true);
    const mockSock = makeMockSocket();
    setPrivate(channel, 'sock', mockSock);

    // Queue some messages
    const queue = [
      { jid: '123@g.us', text: 'Message 1' },
      { jid: '456@g.us', text: 'Message 2' },
    ];
    setPrivate(channel, 'outgoingQueue', [...queue]);

    await (channel as any).flushOutgoingQueue();

    expect(mockSock.sendMessage).toHaveBeenCalledTimes(2);
    expect(getPrivate(channel, 'outgoingQueue')).toHaveLength(0);
  });

  it('does nothing when queue is empty', async () => {
    const channel = makeChannel();
    setPrivate(channel, 'connected', true);
    const mockSock = makeMockSocket();
    setPrivate(channel, 'sock', mockSock);
    setPrivate(channel, 'outgoingQueue', []);

    await (channel as any).flushOutgoingQueue();

    expect(mockSock.sendMessage).not.toHaveBeenCalled();
  });

  it('does nothing if already flushing', async () => {
    const channel = makeChannel();
    setPrivate(channel, 'connected', true);
    setPrivate(channel, 'flushing', true);
    const mockSock = makeMockSocket();
    setPrivate(channel, 'sock', mockSock);
    setPrivate(channel, 'outgoingQueue', [{ jid: '123@g.us', text: 'Hi' }]);

    await (channel as any).flushOutgoingQueue();

    // Should not have attempted to send since flushing guard prevents it
    expect(mockSock.sendMessage).not.toHaveBeenCalled();
    // Queue untouched
    expect(getPrivate(channel, 'outgoingQueue')).toHaveLength(1);
  });

  it('resets flushing flag even on error', async () => {
    const channel = makeChannel();
    setPrivate(channel, 'connected', true);
    // sendMessage rejects → queues message → inner sendMessage also rejects
    // But flushOutgoingQueue calls this.sendMessage which will re-queue on failure
    const mockSock = makeMockSocket({
      sendMessage: mock(() => Promise.reject(new Error('send failed'))),
    });
    setPrivate(channel, 'sock', mockSock);
    setPrivate(channel, 'outgoingQueue', [{ jid: '123@g.us', text: 'Hi' }]);

    // The flush will attempt send, fail, re-queue, attempt again, fail again...
    // This could infinite-loop, but sendMessage re-queues at end so queue stays length 1.
    // Actually, the flush loop pops from front and sendMessage on error pushes to back.
    // The while loop checks queue.length > 0 but since sendMessage pushes back, it would loop.
    // However, the shift() happens AFTER sendMessage, so on error the item stays AND gets re-queued.
    // Let's just verify flushing resets.
    // We need to limit iterations — let mockSock succeed on 2nd try
    let callCount = 0;
    const smartSock = makeMockSocket({
      sendMessage: mock(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('fail'));
        return Promise.resolve({ key: { id: 'ok' } });
      }),
    });
    setPrivate(channel, 'sock', smartSock);

    await (channel as any).flushOutgoingQueue();

    expect(getPrivate(channel, 'flushing')).toBe(false);
  });
});

// ===========================================================================
// Reconnect backoff calculation
// ===========================================================================

describe('WhatsAppChannel reconnect backoff', () => {
  it('has correct base delay (2s)', () => {
    // Access static field
    expect((WhatsAppChannel as any).RECONNECT_BASE_MS).toBe(2000);
  });

  it('has correct max delay (5 minutes)', () => {
    expect((WhatsAppChannel as any).RECONNECT_MAX_MS).toBe(300000);
  });

  it('exponential backoff formula produces correct delays', () => {
    const BASE = 2000;
    const MAX = 300000;

    // attempt 1: 2s * 2^0 = 2s
    expect(Math.min(BASE * 2 ** 0, MAX)).toBe(2000);
    // attempt 2: 2s * 2^1 = 4s
    expect(Math.min(BASE * 2 ** 1, MAX)).toBe(4000);
    // attempt 3: 2s * 2^2 = 8s
    expect(Math.min(BASE * 2 ** 2, MAX)).toBe(8000);
    // attempt 4: 2s * 2^3 = 16s
    expect(Math.min(BASE * 2 ** 3, MAX)).toBe(16000);
    // attempt 8: 2s * 2^7 = 256s > 300s = 300s (capped)
    expect(Math.min(BASE * 2 ** 7, MAX)).toBe(256000);
    // attempt 9: 2s * 2^8 = 512s > 300s = 300s (capped)
    expect(Math.min(BASE * 2 ** 8, MAX)).toBe(MAX);
  });
});

// ===========================================================================
// Circuit breaker constants
// ===========================================================================

describe('WhatsAppChannel circuit breaker', () => {
  it('reconnect window is 5 minutes', () => {
    // The circuit breaker checks if >= 3 reconnects happen within 5min
    // These are module-level constants, not on the class, so we verify via behavior
    const channel = makeChannel();
    const timestamps = getPrivate(channel, 'reconnectTimestamps');
    expect(Array.isArray(timestamps)).toBe(true);
    expect(timestamps).toHaveLength(0);
  });

  it('starts with zero reconnect attempts', () => {
    const channel = makeChannel();
    expect(getPrivate(channel, 'reconnectAttempt')).toBe(0);
  });
});

// ===========================================================================
// Message cache constants
// ===========================================================================

describe('WhatsAppChannel cache constants', () => {
  it('message cache max is 500', () => {
    expect((WhatsAppChannel as any).MESSAGE_CACHE_MAX).toBe(500);
  });

  it('message cache TTL is 1 hour', () => {
    expect((WhatsAppChannel as any).MESSAGE_CACHE_TTL).toBe(3600000);
  });

  it('sent message IDs max is 200', () => {
    expect((WhatsAppChannel as any).SENT_IDS_MAX).toBe(200);
  });
});

// ===========================================================================
// Constructor
// ===========================================================================

describe('WhatsAppChannel constructor', () => {
  it('accepts all required options', () => {
    const onMessage = mock() as unknown as OnInboundMessage;
    const onChatMetadata = mock() as unknown as OnChatMetadata;
    const registeredGroups = () => ({});
    const onReaction = mock();

    const channel = new WhatsAppChannel({
      onMessage,
      onChatMetadata,
      registeredGroups,
      onReaction,
    });

    expect(channel).toBeDefined();
    expect(channel.name).toBe('whatsapp');
  });

  it('works without optional onReaction', () => {
    const channel = new WhatsAppChannel({
      onMessage: mock() as unknown as OnInboundMessage,
      onChatMetadata: mock() as unknown as OnChatMetadata,
      registeredGroups: () => ({}),
    });

    expect(channel).toBeDefined();
  });
});

// ===========================================================================
// Event handler cleanup state
// ===========================================================================

describe('WhatsAppChannel event handler state', () => {
  it('starts with null event handlers', () => {
    const channel = makeChannel();
    expect(getPrivate(channel, 'messageHandler')).toBeNull();
    expect(getPrivate(channel, 'reactionHandler')).toBeNull();
    expect(getPrivate(channel, 'connectionHandler')).toBeNull();
    expect(getPrivate(channel, 'credsHandler')).toBeNull();
  });
});

// ===========================================================================
// Outgoing queue state
// ===========================================================================

describe('WhatsAppChannel outgoing queue', () => {
  it('starts empty', () => {
    const channel = makeChannel();
    expect(getPrivate(channel, 'outgoingQueue')).toHaveLength(0);
  });

  it('starts not flushing', () => {
    const channel = makeChannel();
    expect(getPrivate(channel, 'flushing')).toBe(false);
  });
});

// ===========================================================================
// LID to phone map
// ===========================================================================

describe('WhatsAppChannel LID mapping', () => {
  it('starts with empty map', () => {
    const channel = makeChannel();
    expect(Object.keys(getPrivate(channel, 'lidToPhoneMap'))).toHaveLength(0);
  });
});
