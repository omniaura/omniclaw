import fs from 'fs';

import type { ChannelInfo } from '@omniclaw/protocol';

export interface SendMessageRoutingContext {
  channels: ChannelInfo[];
  currentChatFile: string;
  initialChatJid: string;
  originChatJid: string;
}

export function buildChannelMaps(channels: ChannelInfo[]): {
  channelById: Map<string, ChannelInfo>;
  channelByJid: Map<string, ChannelInfo>;
  channelByName: Map<string, ChannelInfo>;
} {
  const channelById = new Map<string, ChannelInfo>();
  const channelByJid = new Map<string, ChannelInfo>();
  const channelByName = new Map<string, ChannelInfo>();
  for (const channel of channels) {
    channelById.set(channel.id, channel);
    channelByJid.set(channel.jid, channel);
    channelByName.set(channel.name.toLowerCase(), channel);
  }
  return { channelById, channelByJid, channelByName };
}

export function resolveTargetJid(
  target: string,
  channelMaps: Pick<
    ReturnType<typeof buildChannelMaps>,
    'channelById' | 'channelByName'
  >,
): string {
  const byId = channelMaps.channelById.get(target);
  if (byId) return byId.jid;
  const byName = channelMaps.channelByName.get(target.toLowerCase());
  if (byName) return byName.jid;
  return target;
}

export function getCurrentChatJid(
  context: Pick<
    SendMessageRoutingContext,
    'channels' | 'currentChatFile' | 'initialChatJid'
  >,
): string {
  if (context.channels.length > 1) {
    try {
      const current = fs.readFileSync(context.currentChatFile, 'utf-8').trim();
      if (current) return current;
    } catch {
      /* ignore */
    }
  }
  return context.initialChatJid;
}

export function resolveSendMessageTarget(
  rawTarget: string | undefined,
  context: SendMessageRoutingContext,
): { targetJid: string; currentChatJid: string; targetWasExplicit: boolean } {
  const currentChatJid = getCurrentChatJid(context);
  if (rawTarget) {
    return {
      targetJid: resolveTargetJid(
        rawTarget,
        buildChannelMaps(context.channels),
      ),
      currentChatJid,
      targetWasExplicit: true,
    };
  }
  return {
    targetJid: context.originChatJid,
    currentChatJid,
    targetWasExplicit: false,
  };
}

export function buildSendMessageChannelDescription(
  channels: ChannelInfo[],
): string {
  if (channels.length <= 1) return '';
  return `\n\nThis agent has multiple channels:\n${channels.map((ch) => `  • "${ch.name}" (ID: ${ch.id}, JID: ${ch.jid})`).join('\n')}\nOmit target_jid to reply in the channel that started this turn. To opt into a sibling channel for explicit delegation, use channel name, ID, or full JID as target_jid.`;
}
