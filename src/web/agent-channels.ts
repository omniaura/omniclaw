import type { WebStateProvider } from './types.js';
import { escapeHtml } from './shared.js';

export interface ChannelInfo {
  jid: string;
  displayName: string;
  channelFolder?: string;
  categoryFolder?: string;
  iconUrl?: string;
  discordGuildId?: string;
  discordBotId?: string;
}

export interface AgentChannelData {
  id: string;
  name: string;
  folder: string;
  backend: string;
  agentRuntime: string;
  isAdmin: boolean;
  serverFolder?: string;
  agentContextFolder?: string;
  avatarUrl?: string;
  serverIconUrl?: string;
  channels: ChannelInfo[];
}

/** Build enriched agent+channel data with human-readable channel names. */
export function buildAgentChannelData(
  state: WebStateProvider,
): AgentChannelData[] {
  const agents = Object.values(state.getAgents());
  const subs = state.getChannelSubscriptions();
  const chats = state.getChats();

  const chatNameMap: Record<string, string> = {};
  for (const c of chats) {
    if (c.name) chatNameMap[c.jid] = c.name;
  }

  function channelDisplayName(jid: string, channelFolder?: string): string {
    if (chatNameMap[jid]) return chatNameMap[jid];
    if (channelFolder) {
      const lastSeg = channelFolder.split('/').pop();
      if (lastSeg) return '#' + lastSeg;
    }
    return jid;
  }

  return agents.map((a) => {
    const channels: ChannelInfo[] = [];
    let serverIconUrl: string | undefined;
    for (const [jid, subList] of Object.entries(subs)) {
      const sub = subList.find((s) => s.agentId === a.id);
      if (sub) {
        if (!serverIconUrl && sub.discordGuildId) {
          const botQuery = sub.discordBotId
            ? `?botId=${encodeURIComponent(sub.discordBotId)}`
            : '';
          serverIconUrl = `/api/discord/guilds/${encodeURIComponent(sub.discordGuildId)}/icon${botQuery}`;
        }

        const isTelegramChat = /^tg:(?:[^:]+:)?-?\d+$/.test(jid);
        channels.push({
          jid,
          displayName: channelDisplayName(jid, sub.channelFolder),
          channelFolder: sub.channelFolder,
          categoryFolder: sub.categoryFolder,
          iconUrl: isTelegramChat
            ? `/api/chats/${encodeURIComponent(jid)}/icon`
            : undefined,
          discordGuildId: sub.discordGuildId,
          discordBotId: sub.discordBotId,
        });
      }
    }
    return {
      id: a.id,
      name: a.name,
      folder: a.folder,
      backend: a.backend,
      agentRuntime: a.agentRuntime,
      isAdmin: a.isAdmin,
      serverFolder: a.serverFolder,
      agentContextFolder: a.agentContextFolder,
      avatarUrl: a.avatarUrl,
      serverIconUrl,
      channels,
    };
  });
}

/**
 * Render collapsible agent groups with channels.
 * Used by both dashboard and context-viewer.
 * @param includeContextAttrs  If true, adds data-folder/data-select-channel attrs for context editor
 */
export function renderAgentGroups(
  agentData: AgentChannelData[],
  options?: { includeContextAttrs?: boolean },
): string {
  const ctx = options?.includeContextAttrs ?? false;
  const esc = escapeHtml;

  return agentData
    .map((a) => {
      const badgeClass =
        a.backend === 'apple-container'
          ? 'badge-apple-container'
          : a.backend === 'docker'
            ? 'badge-docker'
            : '';

      const channelsHtml = a.channels
        .map((ch) => {
          const contextAttrs = ctx
            ? ` data-folder="${esc(a.folder)}"` +
              ` data-server-folder="${esc(a.serverFolder || '')}"` +
              ` data-agent-context-folder="${esc(a.agentContextFolder || '')}"` +
              ` data-channel-folder="${esc(ch.channelFolder || '')}"` +
              ` data-category-folder="${esc(ch.categoryFolder || '')}"` +
              ` data-select-channel`
            : '';

          return (
            `<div class="channel-item"` +
            ` data-agent-id="${esc(a.id)}"` +
            ` data-jid="${esc(ch.jid)}"` +
            contextAttrs +
            `>` +
            `<span class="ch-name">${esc(ch.displayName)}</span>` +
            `<span class="ch-jid-row">` +
            `<span class="ch-jid">${esc(ch.jid)}</span>` +
            `<button class="copy-btn" data-copy="${esc(ch.jid)}" title="Copy ID">\u2398</button>` +
            `</span>` +
            `</div>`
          );
        })
        .join('');

      return (
        `<div class="agent-group" data-agent-id="${esc(a.id)}">` +
        `<div class="agent-header" data-toggle-agent>` +
        `<span class="chevron">&#9654;</span>` +
        `<span class="agent-name">${esc(a.name)}</span>` +
        `<span class="badge badge-sm ${badgeClass}">${esc(a.backend)}</span>` +
        `<span class="badge badge-sm">${esc(a.agentRuntime)}</span>` +
        (a.isAdmin
          ? `<span class="badge badge-sm badge-admin">admin</span>`
          : '') +
        `<span class="channel-count">${a.channels.length}</span>` +
        `</div>` +
        `<div class="channel-list">${channelsHtml}</div>` +
        `</div>`
      );
    })
    .join('');
}
