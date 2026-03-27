import fs from 'fs';
import path from 'path';
import { afterEach, describe, it, expect, mock } from 'bun:test';

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
