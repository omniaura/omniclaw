import { parseScopedSlackJid } from './slack-jid.js';

export interface ContextLayerInput {
  channelJid: string;
  discordGuildId?: string;
  serverFolder?: string;
  categoryFolder?: string;
  channelFolder?: string;
}

export interface ContextLayerOutput {
  serverFolder?: string;
  categoryFolder?: string;
  channelFolder?: string;
}

export function resolveContextLayers(
  input: ContextLayerInput,
): ContextLayerOutput {
  const discord = parseDiscordChannelJid(input.channelJid);
  if (discord) {
    const serverFolder =
      input.serverFolder ||
      (input.discordGuildId ? `servers/${input.discordGuildId}` : undefined);
    const categoryFolder =
      input.categoryFolder ||
      (serverFolder && discord.channelId
        ? `${serverFolder}/channels`
        : undefined);
    const channelFolder =
      input.channelFolder ||
      (categoryFolder && discord.channelId
        ? `${categoryFolder}/${discord.channelId}`
        : undefined);
    return { serverFolder, categoryFolder, channelFolder };
  }

  const telegram = parseScopedTelegramJid(input.channelJid);
  if (telegram) {
    const serverFolder = input.serverFolder || `servers/tg-${telegram.botId}`;
    const categoryFolder = input.categoryFolder || `${serverFolder}/chats`;
    const chatSegment = telegram.chatId.replace(/^-/, 'm');
    const channelFolder =
      input.channelFolder || `${categoryFolder}/${chatSegment}`;
    return { serverFolder, categoryFolder, channelFolder };
  }

  const slack = parseScopedSlackJid(input.channelJid);
  if (slack) {
    const serverFolder = input.serverFolder || `servers/slack-${slack.botId}`;
    const categoryFolder = input.categoryFolder || `${serverFolder}/channels`;
    const channelSegment = slack.channelId.replace(/[^a-zA-Z0-9_-]/g, '-');
    const channelFolder =
      input.channelFolder || `${categoryFolder}/${channelSegment}`;
    return { serverFolder, categoryFolder, channelFolder };
  }

  return {
    serverFolder: input.serverFolder,
    categoryFolder: input.categoryFolder,
    channelFolder: input.channelFolder,
  };
}

function parseDiscordChannelJid(jid: string): { channelId: string } | null {
  const m = /^dc:(\d+)$/.exec(jid);
  if (!m) return null;
  return { channelId: m[1] };
}

function parseScopedTelegramJid(
  jid: string,
): { botId: string; chatId: string } | null {
  const m = /^tg:([^:]+):(-?\d+)$/.exec(jid);
  if (!m) return null;
  return { botId: m[1], chatId: m[2] };
}
