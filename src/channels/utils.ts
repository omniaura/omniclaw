/**
 * Shared utilities for channel implementations.
 */

export interface SplitMessageOptions {
  /** If true, prefer splitting at newlines/spaces rather than mid-word (default: true). */
  preferBreaks?: boolean;
  /**
   * If true, only strip the delimiter character (newline/space) at the split point,
   * preserving any leading whitespace on subsequent chunks. Useful for platforms
   * where messages may contain code blocks or indented content (e.g. Telegram).
   * Default: false (strips one leading newline or space).
   */
  preserveLeadingWhitespace?: boolean;
}

/**
 * Split a long message into chunks that fit within a platform's message limit.
 *
 * @param text - The text to split
 * @param maxLength - Maximum characters per chunk (e.g. 2000 for Discord, 4000 for Slack)
 * @param optsOrPreferBreaks - Options object or legacy boolean for preferBreaks
 */
export function splitMessage(
  text: string,
  maxLength: number,
  optsOrPreferBreaks: SplitMessageOptions | boolean = true,
): string[] {
  const opts: SplitMessageOptions =
    typeof optsOrPreferBreaks === 'boolean'
      ? { preferBreaks: optsOrPreferBreaks }
      : optsOrPreferBreaks;
  const preferBreaks = opts.preferBreaks ?? true;
  const preserveLeadingWhitespace = opts.preserveLeadingWhitespace ?? false;

  if (text.length <= maxLength) return [text];

  if (!preferBreaks) {
    // Hard split at exact boundaries (used by Slack)
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLength) {
      chunks.push(text.slice(i, i + maxLength));
    }
    return chunks;
  }

  // Prefer splitting at newlines/spaces (used by Discord, Telegram)
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    const splitAtNewline = splitIdx > 0;
    if (!splitAtNewline) splitIdx = remaining.lastIndexOf(' ', maxLength);
    if (splitIdx <= 0) splitIdx = maxLength;

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);

    if (preserveLeadingWhitespace) {
      // Only strip the delimiter character at the split point:
      // - newline split: strip the leading '\n', preserve any indentation on the next line
      // - space split: strip the leading ' '
      if (splitAtNewline) {
        remaining = remaining.replace(/^\n/, '');
      } else {
        remaining = remaining.replace(/^ /, '');
      }
    } else {
      // Legacy behavior: strip one leading newline or space
      remaining = remaining.replace(/^[\n ]/, '');
    }
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
