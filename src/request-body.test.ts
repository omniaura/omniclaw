import { describe, expect, it, mock } from 'bun:test';

import {
  readJsonBody,
  readRequestBody,
  RequestBodyTooLargeError,
} from './request-body.js';

function createChunkedRequest(options: {
  chunks?: Uint8Array[];
  contentLength?: string;
  method?: string;
  url?: string;
  cancelImpl?: (reason?: unknown) => Promise<void>;
}) {
  const reads = [...(options.chunks ?? [])];
  const cancel = mock(
    options.cancelImpl ?? (async (_reason?: unknown) => undefined),
  );
  const releaseLock = mock(() => undefined);
  const read = mock(async () => {
    if (reads.length === 0) return { done: true, value: undefined };
    return { done: false, value: reads.shift() };
  });

  const req = {
    method: options.method ?? 'POST',
    url: options.url ?? 'http://localhost/test',
    headers: new Headers(
      options.contentLength
        ? { 'content-length': options.contentLength }
        : undefined,
    ),
    body: {
      getReader() {
        return { read, cancel, releaseLock };
      },
    },
  } as unknown as Request;

  return { req, read, cancel, releaseLock };
}

describe('readRequestBody', () => {
  it('returns an empty string when the request has no body', async () => {
    const req = {
      headers: new Headers(),
      body: null,
    } as unknown as Request;

    await expect(readRequestBody(req, 32)).resolves.toBe('');
  });

  it('decodes chunked utf-8 content after concatenating all bytes', async () => {
    const encoded = new TextEncoder().encode('Hello 🌍');
    const { req, read, releaseLock } = createChunkedRequest({
      chunks: [encoded.slice(0, 7), encoded.slice(7)],
      contentLength: String(encoded.byteLength),
    });

    await expect(readRequestBody(req, encoded.byteLength)).resolves.toBe(
      'Hello 🌍',
    );
    expect(read).toHaveBeenCalledTimes(3);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('ignores invalid content-length headers and reads the stream', async () => {
    const { req, read } = createChunkedRequest({
      chunks: [new TextEncoder().encode('{"ok":true}')],
      contentLength: '-1',
    });

    await expect(readRequestBody(req, 64)).resolves.toBe('{"ok":true}');
    expect(read).toHaveBeenCalled();
  });

  it('rejects oversized content-length headers before reading the body', async () => {
    const { req, read, cancel, releaseLock } = createChunkedRequest({
      chunks: [new TextEncoder().encode('unused')],
      contentLength: '99',
    });

    await expect(readRequestBody(req, 16)).rejects.toMatchObject({
      limitBytes: 16,
    });
    expect(read).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('cancels the reader and throws when streamed bytes exceed the limit', async () => {
    const first = new TextEncoder().encode('12345');
    const second = new TextEncoder().encode('6789');
    const { req, cancel, releaseLock } = createChunkedRequest({
      chunks: [first, second],
    });

    await expect(readRequestBody(req, 8)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
    expect(cancel).toHaveBeenCalledWith('Request body exceeded size limit');
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('still surfaces the size error when cancel fails', async () => {
    const { req, cancel, releaseLock } = createChunkedRequest({
      chunks: [
        new TextEncoder().encode('abcd'),
        new TextEncoder().encode('efgh'),
      ],
      cancelImpl: async () => {
        throw new Error('cancel failed');
      },
    });

    await expect(readRequestBody(req, 6)).rejects.toMatchObject({
      limitBytes: 6,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });
});

describe('readJsonBody', () => {
  it('parses JSON bodies after reading the stream', async () => {
    const payload = JSON.stringify({ ok: true, count: 2 });
    const { req } = createChunkedRequest({
      chunks: [
        new TextEncoder().encode(payload.slice(0, 5)),
        new TextEncoder().encode(payload.slice(5)),
      ],
    });

    await expect(
      readJsonBody<{ ok: boolean; count: number }>(req, 64),
    ).resolves.toEqual({
      ok: true,
      count: 2,
    });
  });
});
