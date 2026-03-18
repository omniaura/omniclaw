import { ASSISTANT_NAME } from './config.js';
import { logger } from './logger.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface FormatMessagesOptions {
  channelRosterNames?: string[];
  channelRosterHasRoleLabels?: boolean;
}

export function formatMessages(
  messages: NewMessage[],
  options: FormatMessagesOptions = {},
): string {
  const uniqueSenderKeys = new Set<string>();
  const uniqueSenderLabels = new Set<string>();
  const lines = messages.map((m) => {
    if (m.sender) uniqueSenderKeys.add(m.sender);
    if (m.sender_name && m.sender_name !== 'System') {
      uniqueSenderLabels.add(m.sender_name);
    }
    return (
      `<message id="${m.id}" sender="${escapeXml(m.sender_name)}" ` +
      `sender_id="${escapeXml(m.sender)}" ` +
      `sender_key="${escapeXml(m.sender)}" ` +
      `sender_label="${escapeXml(m.sender_name)}" ` +
      `time="${m.timestamp}">${escapeXml(m.content)}</message>`
    );
  });

  // Build a participant roster so that conversation compaction/summarization
  // preserves correct sender attribution (see Issue #13).
  // Deduplicate by immutable sender ID to prevent roster inflation when
  // a user changes their display name mid-conversation.
  const seen = new Set<string>();
  const senders: string[] = [];
  for (const m of messages) {
    if (!m.sender_name || m.sender_name === 'System') continue;
    const key = m.sender;
    if (!key) continue; // skip messages with no immutable ID from roster
    if (seen.has(key)) continue;
    seen.add(key);
    senders.push(m.sender_name);
  }

  const attrs: string[] = [];
  if (senders.length > 0) {
    const roster = senders.map(escapeXml).join(', ');
    attrs.push(`excerpt_participants="${roster}"`);
    // Backward-compatible alias for existing prompts/parsers.
    attrs.push(`participants="${roster}"`);
  }

  if (seen.size > 0) {
    attrs.push(
      `participant_keys="${Array.from(seen).map(escapeXml).join(', ')}"`,
    );
  }

  if (
    uniqueSenderLabels.size > uniqueSenderKeys.size &&
    uniqueSenderKeys.size > 0
  ) {
    logger.info(
      {
        op: 'senderIdentity',
        counter: 'participant_roster_inflation',
        expected_count: uniqueSenderKeys.size,
        actual_count: uniqueSenderLabels.size,
      },
      'Participant roster labels exceed unique sender identities in message batch',
    );
  }

  const uniqueRosterNames = Array.from(
    new Set((options.channelRosterNames || []).filter(Boolean)),
  );
  if (uniqueRosterNames.length > 0) {
    attrs.push(
      `channel_roster="${uniqueRosterNames.map(escapeXml).join(', ')}"`,
    );
    if (options.channelRosterHasRoleLabels === false) {
      attrs.push('channel_roster_roles="unavailable"');
    }
  }

  const header =
    attrs.length > 0 ? `<messages ${attrs.join(' ')}>` : '<messages>';

  return `${header}\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function getAgentName(group: RegisteredGroup): string {
  // Extract agent name from trigger (e.g., "@OmarOmni" → "OmarOmni")
  return group.trigger?.replace(/^@/, '') || ASSISTANT_NAME;
}

export function formatOutbound(
  channel: Channel,
  rawText: string,
  agentName?: string,
): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  const name = agentName || ASSISTANT_NAME;
  const prefix = channel.prefixAssistantName !== false ? `${name}: ` : '';
  return `${prefix}${text}`;
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  const owned = channels.find((c) => c.ownsJid(jid));
  if (owned) return owned;

  // Multi-Discord mode: if no instance has learned this JID yet,
  // fall back to the first connected Discord channel.
  if (jid.startsWith('dc:')) {
    return channels.find((c) => c.name === 'discord');
  }

  return undefined;
}
