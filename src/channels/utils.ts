/**
 * Shared utilities for channel implementations.
 */

/**
 * Split a long message into chunks that fit within a platform's message limit.
 *
 * @param text - The text to split
 * @param maxLength - Maximum characters per chunk (e.g. 2000 for Discord, 4000 for Slack)
 * @param preferBreaks - If true, prefer splitting at newlines/spaces rather than mid-word.
 *                       If false, splits at exact maxLength boundaries.
 */
export function splitMessage(text: string, maxLength: number, preferBreaks = true): string[] {
  if (text.length <= maxLength) return [text];

  if (!preferBreaks) {
    // Hard split at exact boundaries (used by Slack)
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLength) {
      chunks.push(text.slice(i, i + maxLength));
    }
    return chunks;
  }

  // Prefer splitting at newlines/spaces (used by Discord)
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx <= 0) splitIdx = remaining.lastIndexOf(' ', maxLength);
    if (splitIdx <= 0) splitIdx = maxLength;

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^[\n ]/, '');
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
