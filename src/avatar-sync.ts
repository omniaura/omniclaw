import { logger } from './logger.js';
import { updateAgentAvatar } from './db.js';
import { sanitizeTelegramAvatarUrl } from './telegram-avatar.js';
import type { Agent, Channel } from './types.js';

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
      const fetchedUrl = await candidate.channel.getAvatarUrl();
      const safeUrl = sanitizeTelegramAvatarUrl(fetchedUrl || undefined, candidate.platform);
      if (safeUrl && safeUrl !== agent.avatarUrl) {
        updateAgentAvatar(agent.id, safeUrl, candidate.platform);
        agent.avatarUrl = safeUrl;
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
