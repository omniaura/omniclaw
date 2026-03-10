import { describe, expect, it } from 'bun:test';

import { resolveContextLayers } from './context-layers.js';

describe('resolveContextLayers', () => {
  it('derives Discord server/category/channel layers', () => {
    const layers = resolveContextLayers({
      channelJid: 'dc:1234567890',
      discordGuildId: '987654321',
    });

    expect(layers.serverFolder).toBe('servers/987654321');
    expect(layers.categoryFolder).toBe('servers/987654321/channels');
    expect(layers.channelFolder).toBe('servers/987654321/channels/1234567890');
  });

  it('respects explicit Discord folder overrides', () => {
    const layers = resolveContextLayers({
      channelJid: 'dc:1234567890',
      discordGuildId: '987654321',
      serverFolder: 'servers/custom',
      categoryFolder: 'servers/custom/team-a',
      channelFolder: 'servers/custom/team-a/spec',
    });

    expect(layers.serverFolder).toBe('servers/custom');
    expect(layers.categoryFolder).toBe('servers/custom/team-a');
    expect(layers.channelFolder).toBe('servers/custom/team-a/spec');
  });

  it('derives Telegram bot/chat layers from scoped JID', () => {
    const layers = resolveContextLayers({
      channelJid: 'tg:123456:-100123456789',
    });

    expect(layers.serverFolder).toBe('servers/tg-123456');
    expect(layers.categoryFolder).toBe('servers/tg-123456/chats');
    expect(layers.channelFolder).toBe('servers/tg-123456/chats/m100123456789');
  });

  it('does not auto-derive layers for legacy Telegram JID', () => {
    const layers = resolveContextLayers({
      channelJid: 'tg:-100123456789',
    });

    expect(layers.serverFolder).toBeUndefined();
    expect(layers.categoryFolder).toBeUndefined();
    expect(layers.channelFolder).toBeUndefined();
  });

  it('derives Slack bot/channel layers from scoped JID', () => {
    const layers = resolveContextLayers({
      channelJid: 'slack:OPS:C123ABC',
    });

    expect(layers.serverFolder).toBe('servers/slack-OPS');
    expect(layers.categoryFolder).toBe('servers/slack-OPS/channels');
    expect(layers.channelFolder).toBe('servers/slack-OPS/channels/C123ABC');
  });

  it('does not auto-derive layers for legacy Slack JID', () => {
    const layers = resolveContextLayers({
      channelJid: 'slack:C123ABC',
    });

    expect(layers.serverFolder).toBeUndefined();
    expect(layers.categoryFolder).toBeUndefined();
    expect(layers.channelFolder).toBeUndefined();
  });
});
