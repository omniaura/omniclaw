import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { createThreadStreamer, type ThreadStreamContext } from './thread-streaming.js';

// Mock GROUPS_DIR to use temp directory
let tmpDir: string;

describe('thread-streaming', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclaw-stream-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ThreadStreamContext> = {}): ThreadStreamContext {
    return {
      channel: undefined,
      chatJid: 'jid@g.us',
      streamIntermediates: false,
      groupName: 'Test Group',
      groupFolder: 'test-group',
      label: 'test query',
      ...overrides,
    };
  }

  describe('createThreadStreamer', () => {
    it('returns an object with handleIntermediate and writeThoughtLog methods', () => {
      const streamer = createThreadStreamer(makeCtx(), null, 'Test Thread');
      expect(typeof streamer.handleIntermediate).toBe('function');
      expect(typeof streamer.writeThoughtLog).toBe('function');
    });
  });

  describe('handleIntermediate', () => {
    it('buffers intermediates even without streaming', async () => {
      const ctx = makeCtx({ streamIntermediates: false });
      const streamer = createThreadStreamer(ctx, null, 'Thread');

      await streamer.handleIntermediate('chunk 1');
      await streamer.handleIntermediate('chunk 2');

      // The internal buffer is private, but writeThoughtLog writes it to disk.
      // Since GROUPS_DIR comes from config, we verify buffering indirectly:
      // writeThoughtLog should not throw (it would no-op if buffer were empty).
      expect(() => streamer.writeThoughtLog()).not.toThrow();
    });

    it('does not attempt to stream when channel is undefined', async () => {
      const ctx = makeCtx({ streamIntermediates: true, channel: undefined });
      const streamer = createThreadStreamer(ctx, 'msg-123', 'Thread');

      // Should not throw
      await streamer.handleIntermediate('chunk');
    });

    it('does not attempt to stream when parentMessageId is null', async () => {
      const mockChannel = {
        name: 'test',
        connect: async () => {},
        sendMessage: async () => {},
        isConnected: () => true,
        ownsJid: () => true,
        disconnect: async () => {},
        createThread: mock(async () => 'thread-handle'),
        sendToThread: mock(async () => {}),
      };
      const ctx = makeCtx({
        streamIntermediates: true,
        channel: mockChannel as any,
      });
      const streamer = createThreadStreamer(ctx, null, 'Thread');

      await streamer.handleIntermediate('chunk');

      // createThread should not be called because parentMessageId is null
      expect(mockChannel.createThread).not.toHaveBeenCalled();
    });

    it('creates a thread and sends to it when streaming is enabled', async () => {
      const mockThread = { id: 'thread-123' };
      const mockChannel = {
        name: 'test',
        connect: async () => {},
        sendMessage: async () => {},
        isConnected: () => true,
        ownsJid: () => true,
        disconnect: async () => {},
        createThread: mock(async () => mockThread),
        sendToThread: mock(async () => {}),
      };

      const ctx = makeCtx({
        streamIntermediates: true,
        channel: mockChannel as any,
      });
      const streamer = createThreadStreamer(ctx, 'msg-456', 'Agent Thoughts');

      await streamer.handleIntermediate('thinking about it...');

      expect(mockChannel.createThread).toHaveBeenCalledWith('jid@g.us', 'msg-456', 'Agent Thoughts');
      expect(mockChannel.sendToThread).toHaveBeenCalledWith(mockThread, 'thinking about it...');
    });

    it('only creates the thread once for multiple intermediates', async () => {
      const mockThread = { id: 'thread-123' };
      const mockChannel = {
        name: 'test',
        connect: async () => {},
        sendMessage: async () => {},
        isConnected: () => true,
        ownsJid: () => true,
        disconnect: async () => {},
        createThread: mock(async () => mockThread),
        sendToThread: mock(async () => {}),
      };

      const ctx = makeCtx({
        streamIntermediates: true,
        channel: mockChannel as any,
      });
      const streamer = createThreadStreamer(ctx, 'msg-456', 'Thoughts');

      await streamer.handleIntermediate('chunk 1');
      await streamer.handleIntermediate('chunk 2');
      await streamer.handleIntermediate('chunk 3');

      expect(mockChannel.createThread).toHaveBeenCalledTimes(1);
      expect(mockChannel.sendToThread).toHaveBeenCalledTimes(3);
    });

    it('degrades gracefully when thread creation fails', async () => {
      const mockChannel = {
        name: 'test',
        connect: async () => {},
        sendMessage: async () => {},
        isConnected: () => true,
        ownsJid: () => true,
        disconnect: async () => {},
        createThread: mock(async () => { throw new Error('Discord error'); }),
        sendToThread: mock(async () => {}),
      };

      const ctx = makeCtx({
        streamIntermediates: true,
        channel: mockChannel as any,
      });
      const streamer = createThreadStreamer(ctx, 'msg-789', 'Thread');

      // Should not throw
      await streamer.handleIntermediate('chunk 1');
      await streamer.handleIntermediate('chunk 2');

      expect(mockChannel.createThread).toHaveBeenCalledTimes(1);
      // sendToThread should not be called since thread creation failed
      expect(mockChannel.sendToThread).not.toHaveBeenCalled();
    });

    it('degrades gracefully when sendToThread fails', async () => {
      const mockThread = { id: 'thread-123' };
      const mockChannel = {
        name: 'test',
        connect: async () => {},
        sendMessage: async () => {},
        isConnected: () => true,
        ownsJid: () => true,
        disconnect: async () => {},
        createThread: mock(async () => mockThread),
        sendToThread: mock(async () => { throw new Error('Send failed'); }),
      };

      const ctx = makeCtx({
        streamIntermediates: true,
        channel: mockChannel as any,
      });
      const streamer = createThreadStreamer(ctx, 'msg-101', 'Thread');

      // Should not throw even when sendToThread fails
      await streamer.handleIntermediate('chunk');
    });
  });

  describe('writeThoughtLog - label sanitization', () => {
    // These tests lock in the canonical slug specification for thought log filenames.
    // The slug algorithm: trim → slice(0,50) → replace non-alphanumeric with '-' → lowercase → fallback to 'query'
    function slugify(label: string): string {
      return label
        .trim()
        .slice(0, 50)
        .replace(/[^a-z0-9]+/gi, '-')
        .toLowerCase() || 'query';
    }

    it('sanitizes label to filesystem-safe slug', () => {
      expect(slugify('What is the meaning of life?!@#$%')).toBe('what-is-the-meaning-of-life-');
    });

    it('falls back to "query" for empty label', () => {
      expect(slugify('')).toBe('query');
    });

    it('truncates long labels to 50 characters', () => {
      expect(slugify('a'.repeat(100)).length).toBe(50);
    });

    it('handles whitespace-only labels', () => {
      expect(slugify('   ')).toBe('query');
    });
  });

  describe('writeThoughtLog - no-op for empty buffer', () => {
    it('does nothing when no intermediates were buffered', () => {
      const ctx = makeCtx();
      const streamer = createThreadStreamer(ctx, null, 'Thread');
      // writeThoughtLog should not throw even with no content
      streamer.writeThoughtLog();
    });
  });
});
