import { afterEach, describe, expect, it, mock } from 'bun:test';
import fs from 'fs';
import path from 'path';
import {
  buildSafeMediaPath,
  cleanupExpiredMedia,
  downloadBinaryAttachment,
  downloadTextAttachment,
  formatBinaryFileMarker,
  formatImageMarker,
  formatPlaceholder,
  formatTextFileMarker,
  isImageByTypeOrExtension,
  isTextByExtension,
  readStreamWithByteLimit,
  resolveWorkspaceFolder,
  storeMediaAttachment,
  IMAGE_EXTENSIONS,
  MAX_BINARY_DOWNLOAD_BYTES,
  MAX_TEXT_DOWNLOAD_BYTES,
  MEDIA_MAX_AGE_MS,
} from './media.js';
import { GROUPS_DIR } from './config.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createStream(
  chunks: Array<string | Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk,
        );
      }
      controller.close();
    },
  });
}

function createCancellableStream(chunks: Array<string | Uint8Array>) {
  const pending = [...chunks];
  const cancel = mock((_reason?: unknown) => undefined);

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = pending.shift();
      if (chunk === undefined) {
        controller.close();
        return;
      }

      controller.enqueue(
        typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk,
      );
    },
    cancel,
  });

  return { stream, cancel };
}

// ---------------------------------------------------------------------------
// readStreamWithByteLimit
// ---------------------------------------------------------------------------

describe('readStreamWithByteLimit', () => {
  it('reads streamed responses within the byte limit', async () => {
    const bytes = await readStreamWithByteLimit(
      createStream(['hello', ' ', 'world']),
      32,
    );
    expect(bytes.toString()).toBe('hello world');
  });

  it('rejects streamed responses that exceed the byte limit', async () => {
    await expect(
      readStreamWithByteLimit(createStream(['12345', '67890']), 8),
    ).rejects.toThrow('Download exceeded 8 bytes');
  });

  it('allows streams that exactly match the byte limit', async () => {
    const bytes = await readStreamWithByteLimit(
      createStream(['1234', '5678']),
      8,
    );

    expect(bytes.toString()).toBe('12345678');
  });

  it('cancels the reader when streamed bytes exceed the limit', async () => {
    const { stream, cancel } = createCancellableStream(['12345', '67890']);

    await expect(readStreamWithByteLimit(stream, 8)).rejects.toThrow(
      'Download exceeded 8 bytes',
    );
    expect(cancel).toHaveBeenCalledWith('Download exceeded byte limit');
  });

  it('returns empty buffer for null stream', async () => {
    const bytes = await readStreamWithByteLimit(null, 100);
    expect(bytes.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// downloadBinaryAttachment / downloadTextAttachment
// ---------------------------------------------------------------------------

describe('downloadBinaryAttachment', () => {
  it('downloads binary content within size limit', async () => {
    globalThis.fetch = mock(
      (_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(
          new Response(createStream([new Uint8Array([1, 2, 3, 4])])),
        ),
    ) as unknown as typeof globalThis.fetch;

    const bytes = await downloadBinaryAttachment(
      'https://example.test/file.png',
    );
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });

  it('rejects on HTTP error status', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    ) as unknown as typeof globalThis.fetch;

    await expect(
      downloadBinaryAttachment('https://example.test/missing.png'),
    ).rejects.toThrow('Download failed with status 404');
  });

  it('enforces default max bytes (10 MiB)', () => {
    expect(MAX_BINARY_DOWNLOAD_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('downloadTextAttachment', () => {
  it('downloads and decodes text content', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(createStream(['hello world']))),
    ) as unknown as typeof globalThis.fetch;

    const text = await downloadTextAttachment('https://example.test/file.txt');
    expect(text).toBe('hello world');
  });

  it('rejects text that exceeds the byte limit', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(createStream(['a'.repeat(70_000), 'b'.repeat(40_000)])),
      ),
    ) as unknown as typeof globalThis.fetch;

    await expect(
      downloadTextAttachment('https://example.test/file.txt'),
    ).rejects.toThrow(`Download exceeded ${MAX_TEXT_DOWNLOAD_BYTES} bytes`);
  });
});

// ---------------------------------------------------------------------------
// resolveWorkspaceFolder
// ---------------------------------------------------------------------------

describe('resolveWorkspaceFolder', () => {
  it('prefers channelFolder when set', () => {
    expect(
      resolveWorkspaceFolder({ folder: 'agent-a', channelFolder: 'ch/a' }),
    ).toBe('ch/a');
  });

  it('falls back to folder when channelFolder is empty', () => {
    expect(
      resolveWorkspaceFolder({ folder: 'agent-a', channelFolder: '' }),
    ).toBe('agent-a');
  });

  it('falls back to folder when channelFolder is whitespace', () => {
    expect(
      resolveWorkspaceFolder({ folder: 'agent-a', channelFolder: '   ' }),
    ).toBe('agent-a');
  });

  it('falls back to folder when channelFolder is undefined', () => {
    expect(resolveWorkspaceFolder({ folder: 'agent-a' })).toBe('agent-a');
  });
});

// ---------------------------------------------------------------------------
// buildSafeMediaPath
// ---------------------------------------------------------------------------

describe('buildSafeMediaPath', () => {
  it('strips directory components from filename (path traversal defense)', () => {
    const mediaDir = '/tmp/test-media';
    const result = buildSafeMediaPath(
      mediaDir,
      'msg123',
      '../../etc/passwd.png',
    );
    expect(path.basename(result)).toBe('msg123-passwd.png');
    expect(result.startsWith(mediaDir)).toBe(true);
  });

  it('includes prefix when provided', () => {
    const mediaDir = '/tmp/test-media';
    const result = buildSafeMediaPath(mediaDir, 'msg123', 'image.png', 'embed');
    expect(path.basename(result)).toBe('msg123-embed-image.png');
  });

  it('constructs path without prefix', () => {
    const mediaDir = '/tmp/test-media';
    const result = buildSafeMediaPath(mediaDir, 'msg456', 'photo.jpg');
    expect(path.basename(result)).toBe('msg456-photo.jpg');
  });
});

// ---------------------------------------------------------------------------
// storeMediaAttachment
// ---------------------------------------------------------------------------

describe('storeMediaAttachment', () => {
  const testFolder = `__store_media_test_${Date.now()}`;

  afterEach(() => {
    try {
      fs.rmSync(path.join(GROUPS_DIR, testFolder), { recursive: true });
    } catch {
      // ignore
    }
  });

  it('downloads bytes, writes a safe filename, and returns a descriptor', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(createStream(['image-bytes']))),
    ) as unknown as typeof globalThis.fetch;

    const attachment = await storeMediaAttachment({
      url: 'https://example.test/unsafe.png',
      group: { folder: testFolder },
      messageId: 'msg-1',
      rawFilename: '../unsafe.png',
      type: 'image',
      mimeType: 'image/png',
      filenamePrefix: 'photo',
      maxBytes: 100,
    });

    expect(attachment).toEqual({
      type: 'image',
      mimeType: 'image/png',
      localPath: path.join(
        GROUPS_DIR,
        testFolder,
        'media',
        'msg-1-photo-unsafe.png',
      ),
      originalUrl: 'https://example.test/unsafe.png',
      filename: 'msg-1-photo-unsafe.png',
    });
    expect(fs.readFileSync(attachment.localPath, 'utf8')).toBe('image-bytes');
  });
});

// ---------------------------------------------------------------------------
// Marker formatting
// ---------------------------------------------------------------------------

describe('formatImageMarker', () => {
  it('produces the expected marker format', () => {
    expect(formatImageMarker('msg123-photo.png')).toBe(
      '[attachment:image file=msg123-photo.png]',
    );
  });
});

describe('formatTextFileMarker', () => {
  it('wraps content in file attachment tags', () => {
    const marker = formatTextFileMarker('config.json', '{"key": "value"}');
    expect(marker).toBe(
      '[attachment:file name=config.json]\n{"key": "value"}\n[/attachment:file]',
    );
  });
});

describe('formatBinaryFileMarker', () => {
  it('produces a marker with a path the agent can Read', () => {
    expect(formatBinaryFileMarker('msg123-doc.pdf')).toBe(
      '[attachment:file path=media/msg123-doc.pdf name=msg123-doc.pdf]',
    );
  });

  it('preserves the original display name when supplied', () => {
    expect(formatBinaryFileMarker('msg123-doc.pdf', 'Quantum Fund.pdf')).toBe(
      '[attachment:file path=media/msg123-doc.pdf name=Quantum Fund.pdf]',
    );
  });

  it('strips directory components from filename', () => {
    expect(formatBinaryFileMarker('../../../etc/passwd')).toBe(
      '[attachment:file path=media/passwd name=passwd]',
    );
  });
});

describe('formatPlaceholder', () => {
  it('returns [Video] for video type', () => {
    expect(formatPlaceholder('video')).toBe('[Video]');
  });

  it('returns [Audio] for audio type', () => {
    expect(formatPlaceholder('audio')).toBe('[Audio]');
  });

  it('returns [File: name] for file type with name', () => {
    expect(formatPlaceholder('file', 'readme.md')).toBe('[File: readme.md]');
  });

  it('returns [File] for file type without name', () => {
    expect(formatPlaceholder('file')).toBe('[File]');
  });
});

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

describe('isImageByTypeOrExtension', () => {
  it('matches when contentType starts with image/', () => {
    expect(isImageByTypeOrExtension('image/png', null)).toBe(true);
    expect(isImageByTypeOrExtension('image/jpeg', null)).toBe(true);
    expect(isImageByTypeOrExtension('image/gif', 'test.txt')).toBe(true);
  });

  it('rejects when contentType is a known non-image type', () => {
    expect(isImageByTypeOrExtension('application/pdf', 'photo.png')).toBe(
      false,
    );
    expect(isImageByTypeOrExtension('text/plain', null)).toBe(false);
  });

  it('falls back to extension when contentType is null', () => {
    expect(isImageByTypeOrExtension(null, 'photo.png')).toBe(true);
    expect(isImageByTypeOrExtension(null, 'photo.jpg')).toBe(true);
    expect(isImageByTypeOrExtension(null, 'photo.webp')).toBe(true);
    expect(isImageByTypeOrExtension(null, 'data.csv')).toBe(false);
  });

  it('falls back to extension when contentType is undefined', () => {
    expect(isImageByTypeOrExtension(undefined, 'photo.gif')).toBe(true);
  });

  it('handles missing name when contentType is null', () => {
    expect(isImageByTypeOrExtension(null, null)).toBe(false);
    expect(isImageByTypeOrExtension(null, undefined)).toBe(false);
  });
});

describe('isTextByExtension', () => {
  it('recognises text file extensions', () => {
    expect(isTextByExtension('readme.md')).toBe(true);
    expect(isTextByExtension('config.json')).toBe(true);
    expect(isTextByExtension('script.sh')).toBe(true);
    expect(isTextByExtension('data.csv')).toBe(true);
  });

  it('rejects binary file extensions', () => {
    expect(isTextByExtension('photo.png')).toBe(false);
    expect(isTextByExtension('archive.zip')).toBe(false);
    expect(isTextByExtension('binary.exe')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cleanupExpiredMedia
// ---------------------------------------------------------------------------

describe('cleanupExpiredMedia', () => {
  const testFolder = `__media_test_${Date.now()}`;
  const testMediaDir = path.join(GROUPS_DIR, testFolder, 'media');

  afterEach(() => {
    try {
      fs.rmSync(path.join(GROUPS_DIR, testFolder), { recursive: true });
    } catch {
      // ignore
    }
  });

  it('removes files older than maxAgeMs', () => {
    fs.mkdirSync(testMediaDir, { recursive: true });

    // Create a file and backdate its mtime
    const oldFile = path.join(testMediaDir, 'old.png');
    const freshFile = path.join(testMediaDir, 'fresh.png');
    fs.writeFileSync(oldFile, 'old');
    fs.writeFileSync(freshFile, 'fresh');

    // Backdate the old file by 25 hours
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, oldTime, oldTime);

    cleanupExpiredMedia({ folder: testFolder });

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
  });

  it('cleans the channel workspace when channelFolder is set', () => {
    const channelFolder = `${testFolder}-channel`;
    const channelMediaDir = path.join(GROUPS_DIR, channelFolder, 'media');
    const baseMediaDir = path.join(GROUPS_DIR, testFolder, 'media');
    fs.mkdirSync(channelMediaDir, { recursive: true });
    fs.mkdirSync(baseMediaDir, { recursive: true });

    const oldChannelFile = path.join(channelMediaDir, 'old-channel.png');
    const oldBaseFile = path.join(baseMediaDir, 'old-base.png');
    fs.writeFileSync(oldChannelFile, 'old-channel');
    fs.writeFileSync(oldBaseFile, 'old-base');

    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(oldChannelFile, oldTime, oldTime);
    fs.utimesSync(oldBaseFile, oldTime, oldTime);

    cleanupExpiredMedia({ folder: testFolder, channelFolder });

    expect(fs.existsSync(oldChannelFile)).toBe(false);
    expect(fs.existsSync(oldBaseFile)).toBe(true);

    fs.rmSync(path.join(GROUPS_DIR, channelFolder), {
      recursive: true,
      force: true,
    });
  });

  it('does nothing when media dir does not exist', () => {
    // Should not throw
    cleanupExpiredMedia({ folder: 'nonexistent-folder-xyz' });
  });

  it('swallows non-critical cleanup errors', () => {
    cleanupExpiredMedia({ folder: '../outside-groups' });
  });
});

// ---------------------------------------------------------------------------
// Constants sanity checks
// ---------------------------------------------------------------------------

describe('media constants', () => {
  it('IMAGE_EXTENSIONS contains standard web image formats', () => {
    expect(IMAGE_EXTENSIONS.has('.png')).toBe(true);
    expect(IMAGE_EXTENSIONS.has('.jpg')).toBe(true);
    expect(IMAGE_EXTENSIONS.has('.webp')).toBe(true);
    expect(IMAGE_EXTENSIONS.has('.gif')).toBe(true);
  });

  it('MEDIA_MAX_AGE_MS is 24 hours', () => {
    expect(MEDIA_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
});
