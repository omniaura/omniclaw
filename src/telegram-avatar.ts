const TELEGRAM_FILE_DESCRIPTOR_PREFIX = 'tg-file:';
const TELEGRAM_FILE_URL_RE =
  /^https:\/\/api\.telegram\.org\/file\/bot([^/]+)\/(.+)$/;

export interface TelegramFileDescriptor {
  botId: string;
  filePath: string;
}

export function buildTelegramFileDescriptor(
  botId: string,
  filePath: string,
): string {
  return `${TELEGRAM_FILE_DESCRIPTOR_PREFIX}${encodeURIComponent(botId)}:${encodeURIComponent(filePath)}`;
}

export function parseTelegramFileDescriptor(
  value: string,
): TelegramFileDescriptor | null {
  if (!value.startsWith(TELEGRAM_FILE_DESCRIPTOR_PREFIX)) return null;

  const rest = value.slice(TELEGRAM_FILE_DESCRIPTOR_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator === -1) return null;

  try {
    const botId = decodeURIComponent(rest.slice(0, separator));
    const filePath = decodeURIComponent(rest.slice(separator + 1));
    if (!botId || !filePath) return null;
    return { botId, filePath };
  } catch {
    return null;
  }
}

export function parseTelegramApiFileUrl(value: string): {
  botToken: string;
  botId: string;
  filePath: string;
} | null {
  const match = TELEGRAM_FILE_URL_RE.exec(value);
  if (!match) return null;

  const botToken = match[1];
  const filePath = match[2];
  if (!botToken || !filePath) return null;

  const botId = botToken.split(':', 1)[0] || '';
  if (!botId) return null;

  return { botToken, botId, filePath };
}

export function buildTelegramApiFileUrl(
  botToken: string,
  filePath: string,
): string {
  return `https://api.telegram.org/file/bot${botToken}/${filePath}`;
}

export function sanitizeTelegramAvatarUrl(
  avatarUrl: string | undefined,
  _avatarSource?: string,
): string | undefined {
  if (!avatarUrl) return avatarUrl;
  const parsed = parseTelegramApiFileUrl(avatarUrl);
  if (!parsed) return avatarUrl;
  return buildTelegramFileDescriptor(parsed.botId, parsed.filePath);
}
