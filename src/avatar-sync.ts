import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { updateAgentAvatar } from './db.js';
import type { Agent, Channel } from './types.js';
import { containsTelegramToken } from './web/sanitize-avatar.js';

type AvatarSource = 'discord' | 'telegram' | 'slack';
type AvatarSubscription = {
  channelJid: string;
  discordBotId?: string;
};
type AvatarCandidate = {
  platform: AvatarSource;
  identity: string;
  count: number;
  channel: Channel;
};

/** Map a channel JID prefix to its platform name. */
function jidPlatform(jid: string): AvatarSource | undefined {
  if (jid.startsWith('dc:')) return 'discord';
  if (jid.startsWith('tg:')) return 'telegram';
  if (jid.startsWith('slack:')) return 'slack';
  return undefined;
}

/**
 * Determine which platform an agent has the most channel subscriptions on.
 * Returns the platform name, or undefined if the agent has no platform subscriptions.
 */
export function detectDominantPlatform(
  subscriptions: AvatarSubscription[],
): AvatarSource | undefined {
  const counts: Partial<Record<AvatarSource, number>> = {};
  for (const sub of subscriptions) {
    const platform = jidPlatform(sub.channelJid);
    if (platform) counts[platform] = (counts[platform] || 0) + 1;
  }
  let best: AvatarSource | undefined;
  let bestCount = 0;
  for (const [platform, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = platform as AvatarSource;
      bestCount = count;
    }
  }
  return best;
}

function parseTelegramBotId(jid: string): string | undefined {
  const match = /^tg:([^:]+):/.exec(jid);
  return match?.[1];
}

function getChannelForCandidate(
  platform: AvatarSource,
  identity: string,
  channels: Channel[],
): Channel | undefined {
  if (platform === 'discord') {
    return channels.find(
      (channel) =>
        channel.name === 'discord' &&
        channel.getAvatarUrl &&
        (!identity || channel.botId === identity),
    );
  }
  if (platform === 'telegram') {
    return channels.find(
      (channel) =>
        channel.name === 'telegram' &&
        channel.getAvatarUrl &&
        (identity === 'legacy' || channel.botId === identity),
    );
  }
  return channels.find(
    (channel) => channel.name === 'slack' && !!channel.getAvatarUrl,
  );
}

export function buildAvatarCandidates(
  subscriptions: AvatarSubscription[],
  channels: Channel[],
): AvatarCandidate[] {
  const counts = new Map<string, { platform: AvatarSource; count: number }>();
  for (const sub of subscriptions) {
    const platform = jidPlatform(sub.channelJid);
    if (!platform) continue;

    let identity: string;
    if (platform === 'discord') {
      identity = sub.discordBotId || '';
    } else if (platform === 'telegram') {
      identity = parseTelegramBotId(sub.channelJid) || 'legacy';
    } else {
      identity = 'workspace';
    }

    const key = `${platform}:${identity}`;
    const current = counts.get(key);
    counts.set(key, {
      platform,
      count: (current?.count || 0) + 1,
    });
  }

  const candidates: AvatarCandidate[] = [];
  for (const [key, value] of counts.entries()) {
    const identity = key.slice(value.platform.length + 1);
    const channel = getChannelForCandidate(value.platform, identity, channels);
    if (!channel) continue;
    candidates.push({
      platform: value.platform,
      identity,
      count: value.count,
      channel,
    });
  }

  const platformRank: Record<AvatarSource, number> = {
    telegram: 0,
    slack: 1,
    discord: 2,
  };
  candidates.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return platformRank[a.platform] - platformRank[b.platform];
  });
  return candidates;
}

/**
 * Sync avatar URLs from connected channel adapters to agent records.
 * Called once after all channels connect on startup.
 *
 * For each agent without a 'custom' avatar:
 * 1. Determine the dominant platform (most subscribed channels)
 * 2. Find the matching channel adapter
 * 3. Fetch the avatar URL
 * 4. Persist to the agents table
 */
export async function syncAvatars(
  agents: Record<string, Agent>,
  channels: Channel[],
  getSubscriptions: (agentId: string) => AvatarSubscription[],
): Promise<void> {
  const candidatesByAgent = new Map<string, AvatarCandidate[]>();
  const ownersByIdentity = new Map<string, Set<string>>();

  for (const agent of Object.values(agents)) {
    const candidates = buildAvatarCandidates(
      getSubscriptions(agent.id),
      channels,
    );
    candidatesByAgent.set(agent.id, candidates);
    for (const candidate of candidates) {
      const key = `${candidate.platform}:${candidate.identity}`;
      const owners = ownersByIdentity.get(key) || new Set<string>();
      owners.add(agent.id);
      ownersByIdentity.set(key, owners);
    }
  }

  for (const agent of Object.values(agents)) {
    // Skip agents with custom avatars (user-uploaded)
    if (agent.avatarSource === 'custom') continue;

    const candidate = (candidatesByAgent.get(agent.id) || []).find((entry) => {
      const owners = ownersByIdentity.get(
        `${entry.platform}:${entry.identity}`,
      );
      return owners?.size === 1;
    });
    if (!candidate?.channel.getAvatarUrl) continue;

    try {
      const url = await candidate.channel.getAvatarUrl();
      if (!url) continue;

      // For Telegram URLs that contain the bot token, download the image
      // and store a local path. This prevents the token from leaking
      // through API responses, DB backups, or peer sync.
      let storedUrl = url;
      if (containsTelegramToken(url)) {
        const localPath = await downloadAvatarLocally(url, agent.folder);
        if (!localPath) continue;
        storedUrl = localPath;
      }

      if (storedUrl !== agent.avatarUrl) {
        updateAgentAvatar(agent.id, storedUrl, candidate.platform);
        agent.avatarUrl = storedUrl;
        agent.avatarSource = candidate.platform;
        logger.info(
          {
            agentId: agent.id,
            platform: candidate.platform,
            identity: candidate.identity || undefined,
          },
          'Agent avatar synced from platform',
        );
      }
    } catch (err) {
      logger.warn(
        { agentId: agent.id, platform: candidate.platform, err },
        'Failed to sync avatar',
      );
    }
  }
}

/**
 * Download a remote avatar image and save it locally under the agent's
 * group folder. Returns the local path suitable for storage in the DB
 * (e.g., "/avatars/{folder}/avatar.png"), or null on failure.
 */
async function downloadAvatarLocally(
  url: string,
  agentFolder: string,
): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      logger.warn(
        { status: response.status, agentFolder },
        'Failed to download avatar image',
      );
      return null;
    }

    const dir = path.join(GROUPS_DIR, agentFolder);
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, 'avatar.png');
    const bytes = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filePath, bytes);

    return `/avatars/${agentFolder}/avatar.png`;
  } catch (err) {
    logger.warn({ err, agentFolder }, 'Failed to download avatar locally');
    return null;
  }
}
