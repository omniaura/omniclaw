import type { ChannelSubscription, RegisteredGroup } from './types.js';

export const STARTUP_CONFIRMATION_PROMPT =
  '[SYSTEM] OmniClaw just restarted. Review any recent context or thoughts files if useful, then send a brief confirmation to this channel that you are back online.';

export interface StartupConfirmationTarget {
  chatJid: string;
  agentId?: string;
  trigger: string;
}

export function hasPriorRuntimeState(params: {
  lastTimestamp: string;
  lastAgentTimestamp: Record<string, string>;
  sessions: Record<string, string>;
}): boolean {
  return Boolean(
    params.lastTimestamp ||
    Object.keys(params.lastAgentTimestamp).length > 0 ||
    Object.keys(params.sessions).length > 0,
  );
}

export function buildStartupConfirmationTargets(
  registeredGroups: Record<string, RegisteredGroup>,
  channelSubscriptions: Record<string, ChannelSubscription[]>,
): StartupConfirmationTarget[] {
  const targets: StartupConfirmationTarget[] = [];
  const coveredAgents = new Set<string>();

  for (const [chatJid, subs] of Object.entries(channelSubscriptions)) {
    if (subs.length === 0) continue;

    const preferredSubs = subs.filter((sub) => sub.isPrimary);
    const chosenSubs = preferredSubs.length > 0 ? preferredSubs : [subs[0]];

    for (const sub of chosenSubs) {
      if (coveredAgents.has(sub.agentId)) continue;
      coveredAgents.add(sub.agentId);
      targets.push({
        chatJid,
        agentId: sub.agentId,
        trigger: sub.trigger || registeredGroups[chatJid]?.trigger || '',
      });
    }
  }

  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    if ((channelSubscriptions[chatJid] || []).length > 0) continue;
    targets.push({ chatJid, trigger: group.trigger });
  }

  return targets;
}
