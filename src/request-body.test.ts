import { describe, expect, it } from 'bun:test';

import {
  readJsonBody,
  readRequestBody,
  RequestBodyTooLargeError,
} from './request-body.js';

type ReadResult = ReadableStreamReadResult<Uint8Array>;

function createMockRequest(options: {
  contentLength?: string | null;
  body?: { getReader: () => ReadableStreamDefaultReader<Uint8Array> } | null;
}): Request {
  const headers = new Headers();
  if (options.contentLength !== undefined && options.contentLength !== null) {
    headers.set('content-length', options.contentLength);
  }

  return {
    headers,
    body:
      (options.body as unknown as Request['body']) === undefined
        ? null
        : (options.body as unknown as Request['body']),
  } as Request;
}

function createMockReader(options: {
  reads: ReadResult[];
  onCancel?: () => void | Promise<void>;
  onReleaseLock?: () => void;
}): ReadableStreamDefaultReader<Uint8Array> {
  const queue = [...options.reads];

  return {
    read: async () => queue.shift() ?? { done: true, value: undefined },
    cancel: async () => {
      await options.onCancel?.();
    },
    releaseLock: () => {
      options.onReleaseLock?.();
    },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

describe('request-body helpers', () => {
  it('returns an empty string when the request has no body', async () => {
    const req = createMockRequest({ body: null });

    await expect(readRequestBody(req, 32)).resolves.toBe('');
  });

  it('rejects oversized content-length headers before reading the stream', async () => {
    let getReaderCalled = false;
    const req = createMockRequest({
      contentLength: '33',
      body: {
        getReader() {
          getReaderCalled = true;
          throw new Error('should not read body');
        },
      },
    });

    await expect(readRequestBody(req, 32)).rejects.toEqual(
      expect.objectContaining({
        limitBytes: 32,
        message: 'Request body exceeded 32 bytes',
      }),
    );
    expect(getReaderCalled).toBe(false);
  });

  it('treats malformed content-length headers as unknown and reads the body', async () => {
    const reader = createMockReader({
      reads: [
        { done: false, value: new TextEncoder().encode('ok') },
        { done: true, value: undefined },
      ],
    });
    const req = createMockRequest({
      contentLength: '-5',
      body: { getReader: () => reader },
    });

    await expect(readRequestBody(req, 32)).resolves.toBe('ok');
  });

  it('concatenates streamed chunks and ignores empty reads', async () => {
    let released = false;
    const reader = createMockReader({
      reads: [
        { done: false, value: new TextEncoder().encode('{"ok":') },
        { done: false, value: undefined },
        { done: false, value: new TextEncoder().encode('true}') },
        { done: true, value: undefined },
      ],
      onReleaseLock: () => {
        released = true;
      },
    });
    const req = createMockRequest({ body: { getReader: () => reader } });

    await expect(readRequestBody(req, 64)).resolves.toBe('{"ok":true}');
    expect(released).toBe(true);
  });

  it('cancels oversized streams, releases the lock, and throws a typed error', async () => {
    let cancelled = false;
    let released = false;
    const reader = createMockReader({
      reads: [
        { done: false, value: new TextEncoder().encode('hello') },
        { done: false, value: new TextEncoder().encode('!') },
      ],
      onCancel: () => {
        cancelled = true;
      },
      onReleaseLock: () => {
        released = true;
      },
    });
    const req = createMockRequest({ body: { getReader: () => reader } });

    await expect(readRequestBody(req, 5)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
    expect(cancelled).toBe(true);
    expect(released).toBe(true);
  });

  it('still throws the size-limit error when reader cancellation fails', async () => {
    let released = false;
    const reader = createMockReader({
      reads: [{ done: false, value: new TextEncoder().encode('toolarge') }],
      onCancel: async () => {
        throw new Error('cancel failed');
      },
      onReleaseLock: () => {
        released = true;
      },
    });
    const req = createMockRequest({ body: { getReader: () => reader } });

    await expect(readRequestBody(req, 4)).rejects.toEqual(
      expect.objectContaining({
        limitBytes: 4,
        message: 'Request body exceeded 4 bytes',
      }),
    );
    expect(released).toBe(true);
  });

  it('parses JSON after reading the complete request body', async () => {
    const reader = createMockReader({
      reads: [
        { done: false, value: new TextEncoder().encode('{"count":') },
        { done: false, value: new TextEncoder().encode('2}') },
        { done: true, value: undefined },
      ],
    });
    const req = createMockRequest({ body: { getReader: () => reader } });

    await expect(readJsonBody<{ count: number }>(req, 32)).resolves.toEqual({
      count: 2,
    });
  });
});
