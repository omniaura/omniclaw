/**
 * Sanitize avatar URLs to prevent leaking Telegram bot tokens.
 *
 * Telegram file URLs embed the bot token in the path:
 *   https://api.telegram.org/file/bot<TOKEN>/<file_path>
 *
 * This token is a bearer credential — anyone who obtains it can act as the bot.
 * These URLs must never be stored in the DB or returned in API responses.
 */

const TG_FILE_URL_RE = /^https:\/\/api\.telegram\.org\/file\/bot[^/]+\/(.+)$/i;

/**
 * Returns true if the URL contains an embedded Telegram bot token.
 */
export function containsTelegramToken(url: string): boolean {
  return TG_FILE_URL_RE.test(url);
}

/**
 * Strip the Telegram bot token from a file URL, returning only the
 * file path portion. Returns null if the URL is not a Telegram file URL.
 *
 * Input:  https://api.telegram.org/file/bot123:ABC/photos/file_42.jpg
 * Output: photos/file_42.jpg
 */
export function extractTelegramFilePath(url: string): string | null {
  const match = TG_FILE_URL_RE.exec(url);
  return match ? match[1] : null;
}

/**
 * Reconstruct a full Telegram download URL from a file path and bot token.
 * Only used server-side for downloading — never exposed to clients.
 */
export function buildTelegramFileUrl(
  filePath: string,
  botToken: string,
): string {
  return `https://api.telegram.org/file/bot${botToken}/${filePath}`;
}

/**
 * Sanitize an avatar URL for safe inclusion in API responses.
 * Strips Telegram bot tokens, returning null for token-bearing URLs
 * (callers should replace with a proxy URL like /api/agents/{id}/avatar/image).
 */
export function sanitizeAvatarUrl(url: string | undefined): string | null {
  if (!url) return null;
  if (containsTelegramToken(url)) return null;
  return url;
}
