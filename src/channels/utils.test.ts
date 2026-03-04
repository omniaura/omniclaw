import { describe, it, expect } from 'bun:test';
import { splitMessage } from './utils.js';

describe('splitMessage', () => {
  // --- Short text (no split needed) ---

  it('returns single chunk when text is within limit', () => {
    expect(splitMessage('hello', 10)).toEqual(['hello']);
  });

  it('returns single chunk when text equals limit exactly', () => {
    const text = 'abcde';
    expect(splitMessage(text, 5)).toEqual(['abcde']);
  });

  it('handles empty string', () => {
    expect(splitMessage('', 10)).toEqual(['']);
  });

  // --- Hard split (preferBreaks = false) ---

  describe('hard split (preferBreaks = false)', () => {
    it('splits at exact boundaries', () => {
      expect(splitMessage('abcdefghij', 5, false)).toEqual(['abcde', 'fghij']);
    });

    it('handles text not evenly divisible by limit', () => {
      expect(splitMessage('abcdefg', 3, false)).toEqual(['abc', 'def', 'g']);
    });

    it('single character limit', () => {
      expect(splitMessage('abc', 1, false)).toEqual(['a', 'b', 'c']);
    });

    it('accepts options object form', () => {
      expect(splitMessage('abcdef', 3, { preferBreaks: false })).toEqual([
        'abc',
        'def',
      ]);
    });
  });

  // --- Prefer breaks (default behavior) ---

  describe('prefer breaks (default)', () => {
    it('splits at newline when available', () => {
      const text = 'line one\nline two\nline three';
      const chunks = splitMessage(text, 15);
      expect(chunks[0]).toBe('line one');
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('splits at space when no newline in range', () => {
      const text = 'hello world again';
      const chunks = splitMessage(text, 12);
      expect(chunks[0]).toBe('hello world');
      expect(chunks[1]).toBe('again');
    });

    it('falls back to hard split when no break point exists', () => {
      const text = 'abcdefghijklmnop';
      const chunks = splitMessage(text, 5);
      expect(chunks[0]).toBe('abcde');
      expect(chunks[1]).toBe('fghij');
      expect(chunks[2]).toBe('klmno');
      expect(chunks[3]).toBe('p');
    });

    it('prefers newline over space', () => {
      // "hello world\nfoo" with limit 12 — newline is at index 11, space at 5
      const text = 'hello world\nfoo bar';
      const chunks = splitMessage(text, 14);
      expect(chunks[0]).toBe('hello world');
      expect(chunks[1]).toBe('foo bar');
    });

    it('strips leading newline/space from next chunk by default', () => {
      const text = 'aaa\nbbb';
      const chunks = splitMessage(text, 4);
      // Split at newline (index 3), next chunk should strip \n
      expect(chunks).toEqual(['aaa', 'bbb']);
    });
  });

  // --- preserveLeadingWhitespace option ---

  describe('preserveLeadingWhitespace', () => {
    it('strips only the delimiter when splitting at newline', () => {
      // "abc\n  def" split at newline — should preserve "  " indentation
      const text = 'abc\n  def';
      const chunks = splitMessage(text, 6, { preserveLeadingWhitespace: true });
      expect(chunks[0]).toBe('abc');
      expect(chunks[1]).toBe('  def');
    });

    it('strips only the space delimiter when splitting at space', () => {
      const text = 'abcdef ghijk';
      const chunks = splitMessage(text, 7, { preserveLeadingWhitespace: true });
      expect(chunks[0]).toBe('abcdef');
      expect(chunks[1]).toBe('ghijk');
    });

    it('preserves indentation in code-like content', () => {
      const text = 'Header:\n  line1\n  line2';
      const chunks = splitMessage(text, 10, {
        preserveLeadingWhitespace: true,
      });
      expect(chunks[0]).toBe('Header:');
      expect(chunks[1]).toBe('  line1');
    });
  });

  // --- Platform-specific limits ---

  describe('platform limits', () => {
    it('Discord 2000 char limit', () => {
      const text = 'a'.repeat(4500);
      const chunks = splitMessage(text, 2000);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(2000);
      }
      expect(chunks.join('')).toBe(text);
    });

    it('Slack 4000 char hard split', () => {
      const text = 'b'.repeat(8500);
      const chunks = splitMessage(text, 4000, false);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(4000);
      }
      expect(chunks.join('')).toBe(text);
    });

    it('Telegram 4096 char limit', () => {
      const text = 'word '.repeat(1000); // 5000 chars
      const chunks = splitMessage(text, 4096, {
        preserveLeadingWhitespace: true,
      });
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(4096);
      }
    });
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    it('text is all newlines', () => {
      const text = '\n\n\n\n\n';
      const chunks = splitMessage(text, 2);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(2);
      }
    });

    it('text is all spaces', () => {
      const text = '     ';
      const chunks = splitMessage(text, 2);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(2);
      }
    });

    it('very long word followed by short words', () => {
      const text = 'a'.repeat(20) + ' short words here';
      const chunks = splitMessage(text, 10);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(10);
      }
    });

    it('boolean true as third argument (legacy API)', () => {
      const text = 'hello world again';
      const chunks = splitMessage(text, 12, true);
      expect(chunks[0]).toBe('hello world');
    });
  });
});
