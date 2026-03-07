export function parseScopedSlackJid(
  jid: string,
): { botId: string; channelId: string } | null {
  const m = /^slack:([^:]+):([^\s]+)$/.exec(jid);
  if (!m) return null;
  return { botId: m[1], channelId: m[2] };
}
