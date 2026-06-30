export interface ParsedSlackJid {
  botId?: string;
  channelId: string;
  threadTs?: string;
  parentJid: string;
  legacyParentJid: string;
}

const SLACK_THREAD_RE = /^slack:([^:\s]+):([^:\s]+):thread:([0-9]+\.[0-9]+)$/;
const SCOPED_SLACK_RE = /^slack:([^:]+):([^\s]+)$/;
const LEGACY_SLACK_RE = /^slack:([^:\s]+)$/;

export function parseScopedSlackJid(
  jid: string,
): { botId: string; channelId: string } | null {
  if (SLACK_THREAD_RE.test(jid)) return null;
  const m = SCOPED_SLACK_RE.exec(jid);
  if (!m) return null;
  if (m[2].includes(':thread:')) return null;
  return { botId: m[1], channelId: m[2] };
}

export function parseSlackJid(jid: string): ParsedSlackJid | null {
  const thread = SLACK_THREAD_RE.exec(jid);
  if (thread) {
    const [, botId, channelId, threadTs] = thread;
    return {
      botId,
      channelId,
      threadTs,
      parentJid: channelIdToSlackJid(channelId, botId),
      legacyParentJid: channelIdToSlackJid(channelId),
    };
  }

  const scoped = parseScopedSlackJid(jid);
  if (scoped) {
    return {
      botId: scoped.botId,
      channelId: scoped.channelId,
      parentJid: jid,
      legacyParentJid: channelIdToSlackJid(scoped.channelId),
    };
  }

  const legacy = LEGACY_SLACK_RE.exec(jid);
  if (!legacy) return null;
  return {
    channelId: legacy[1],
    parentJid: jid,
    legacyParentJid: jid,
  };
}

export function channelIdToSlackJid(channelId: string, botId?: string): string {
  if (botId) return `slack:${botId}:${channelId}`;
  return `slack:${channelId}`;
}

export function slackThreadIdToJid(
  channelId: string,
  threadTs: string,
  botId: string,
): string {
  return `slack:${botId}:${channelId}:thread:${threadTs}`;
}
