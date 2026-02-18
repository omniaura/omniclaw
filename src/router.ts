import { ASSISTANT_NAME, TRIGGER_PATTERN } from './config.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map((m) =>
    `<message id="${m.id}" sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
  );
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function getAgentName(group: RegisteredGroup): string {
  // Extract agent name from trigger (e.g., "@OmarOmni" → "OmarOmni")
  return group.trigger?.replace(/^@/, '') || ASSISTANT_NAME;
}

/**
 * Build a trigger-detection regex for the given group.
 * Uses the group's own trigger (e.g. "@OmarOmni", "@PeytonOmni") so that
 * agent-to-agent messages addressed to the right bot are correctly identified.
 * Falls back to the global TRIGGER_PATTERN when no per-group trigger is set.
 */
export function getTriggerPattern(group: RegisteredGroup): RegExp {
  if (!group.trigger) return TRIGGER_PATTERN;
  const escaped = group.trigger.replace(/^@/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^@${escaped}\\b`, 'i');
}

export function formatOutbound(channel: Channel, rawText: string, agentName?: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  const name = agentName || ASSISTANT_NAME;
  const prefix =
    channel.prefixAssistantName !== false ? `${name}: ` : '';
  return `${prefix}${text}`;
}

export async function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  await channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
