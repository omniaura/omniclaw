import { logger } from './logger.js';
import { updateAgentAvatar } from './db.js';
import type { Agent, Channel } from './types.js';

type AvatarSource = 'discord' | 'telegram' | 'slack';

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
  subscriptions: Array<{ channelJid: string }>,
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

/** Map a Channel adapter to its platform name. */
function channelPlatform(ch: Channel): AvatarSource | undefined {
  if (ch.name === 'discord') return 'discord';
  if (ch.name === 'telegram') return 'telegram';
  if (ch.name === 'slack') return 'slack';
  return undefined;
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
  getSubscriptions: (agentId: string) => Array<{ channelJid: string }>,
): Promise<void> {
  // Build platform → channel map (first matching adapter wins per platform)
  const platformChannels = new Map<AvatarSource, Channel>();
  for (const ch of channels) {
    const p = channelPlatform(ch);
    if (p && ch.getAvatarUrl && !platformChannels.has(p)) {
      platformChannels.set(p, ch);
    }
  }

  if (platformChannels.size === 0) return;

  for (const agent of Object.values(agents)) {
    // Skip agents with custom avatars (user-uploaded)
    if (agent.avatarSource === 'custom') continue;

    const subs = getSubscriptions(agent.id);
    const dominant = detectDominantPlatform(subs);
    if (!dominant) continue;

    const ch = platformChannels.get(dominant);
    if (!ch?.getAvatarUrl) continue;

    try {
      const url = await ch.getAvatarUrl();
      if (url && url !== agent.avatarUrl) {
        updateAgentAvatar(agent.id, url, dominant);
        agent.avatarUrl = url;
        agent.avatarSource = dominant;
        logger.info(
          { agentId: agent.id, platform: dominant },
          'Agent avatar synced from platform',
        );
      }
    } catch (err) {
      logger.warn(
        { agentId: agent.id, platform: dominant, err },
        'Failed to sync avatar',
      );
    }
  }
}
