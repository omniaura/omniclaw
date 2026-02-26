import { describe, it, expect } from 'bun:test';

import {
  ASSISTANT_NAME,
  escapeRegex,
  buildTriggerPattern,
  TRIGGER_PATTERN,
} from './config.js';

// --- escapeRegex ---

describe('escapeRegex', () => {
  it('escapes dots', () => {
    expect(escapeRegex('file.txt')).toBe('file\\.txt');
  });

  it('escapes asterisks', () => {
    expect(escapeRegex('a*b')).toBe('a\\*b');
  });

  it('escapes plus signs', () => {
    expect(escapeRegex('a+b')).toBe('a\\+b');
  });

  it('escapes question marks', () => {
    expect(escapeRegex('why?')).toBe('why\\?');
  });

  it('escapes caret', () => {
    expect(escapeRegex('^start')).toBe('\\^start');
  });

  it('escapes dollar sign', () => {
    expect(escapeRegex('end$')).toBe('end\\$');
  });

  it('escapes curly braces', () => {
    expect(escapeRegex('{a}')).toBe('\\{a\\}');
  });

  it('escapes parentheses', () => {
    expect(escapeRegex('(group)')).toBe('\\(group\\)');
  });

  it('escapes pipes', () => {
    expect(escapeRegex('a|b')).toBe('a\\|b');
  });

  it('escapes square brackets', () => {
    expect(escapeRegex('[abc]')).toBe('\\[abc\\]');
  });

  it('escapes backslashes', () => {
    expect(escapeRegex('a\\b')).toBe('a\\\\b');
  });

  it('handles multiple special characters', () => {
    expect(escapeRegex('a.b*c+d')).toBe('a\\.b\\*c\\+d');
  });

  it('returns plain strings unchanged', () => {
    expect(escapeRegex('hello')).toBe('hello');
    expect(escapeRegex('Omni')).toBe('Omni');
    expect(escapeRegex('PeytonOmni')).toBe('PeytonOmni');
  });

  it('handles empty string', () => {
    expect(escapeRegex('')).toBe('');
  });
});

// --- buildTriggerPattern ---

describe('buildTriggerPattern', () => {
  it('builds pattern from trigger string with @', () => {
    const pattern = buildTriggerPattern('@OmarOmni');
    expect(pattern.test('@OmarOmni hello')).toBe(true);
    expect(pattern.test('@omaromni hello')).toBe(true); // case insensitive
    expect(pattern.test('Hello @OmarOmni')).toBe(false); // must be at start
  });

  it('builds pattern from trigger string without @', () => {
    const pattern = buildTriggerPattern('Andy');
    expect(pattern.test('@Andy what time is it')).toBe(true);
    expect(pattern.test('@andy what time is it')).toBe(true);
  });

  it('respects word boundaries', () => {
    const pattern = buildTriggerPattern('@Om');
    expect(pattern.test('@Om hello')).toBe(true);
    expect(pattern.test('@Omni hello')).toBe(false); // 'Omni' extends past 'Om' — no boundary
  });

  it('falls back to TRIGGER_PATTERN when no trigger provided', () => {
    const pattern = buildTriggerPattern();
    expect(pattern).toBe(TRIGGER_PATTERN);
  });

  it('falls back to TRIGGER_PATTERN for empty string', () => {
    const pattern = buildTriggerPattern('');
    expect(pattern).toBe(TRIGGER_PATTERN);
  });

  it('handles trigger with dots (special regex chars are escaped)', () => {
    const pattern = buildTriggerPattern('@Bot.v2');
    expect(pattern.test('@Bot.v2 hello')).toBe(true);
    expect(pattern.test('@BotXv2 hello')).toBe(false); // dot is escaped, not wildcard
  });

  it('word boundary limitation with non-word-char endings', () => {
    // Trigger names ending in non-word characters (like parentheses)
    // have a \b word boundary issue: \b after ')' won't match because
    // ')' is already a non-word character. This documents the known behavior.
    const pattern = buildTriggerPattern('@Bot(test)');
    // The regex is /^@Bot\(test\)\b/i — \b after \) fails because
    // ')' is not a word char, so there's no word→non-word transition
    expect(pattern.test('@Bot(test) hello')).toBe(false); // known limitation
    expect(pattern.test('@Bot(test)x hello')).toBe(true); // boundary before 'x' (non-word→word→...)
  });

  it('is case insensitive', () => {
    const pattern = buildTriggerPattern('@MyBot');
    expect(pattern.test('@mybot hello')).toBe(true);
    expect(pattern.test('@MYBOT hello')).toBe(true);
    expect(pattern.test('@MyBot hello')).toBe(true);
  });

  it('requires @ prefix in the tested string', () => {
    const pattern = buildTriggerPattern('@TestBot');
    expect(pattern.test('TestBot hello')).toBe(false);
    expect(pattern.test('@TestBot hello')).toBe(true);
  });

  it('matches trigger followed by end of string', () => {
    const pattern = buildTriggerPattern('@TestBot');
    expect(pattern.test('@TestBot')).toBe(true);
  });

  it('matches trigger followed by newline', () => {
    const pattern = buildTriggerPattern('@TestBot');
    expect(pattern.test('@TestBot\nhello')).toBe(true);
  });
});

// --- TRIGGER_PATTERN (global, uses ASSISTANT_NAME from env/.env) ---

describe('TRIGGER_PATTERN', () => {
  // TRIGGER_PATTERN depends on ASSISTANT_NAME from the environment.
  // We test against the actual configured name rather than hardcoding.

  it('matches @ASSISTANT_NAME at the start of a message', () => {
    expect(TRIGGER_PATTERN.test(`@${ASSISTANT_NAME} hello`)).toBe(true);
  });

  it('is case insensitive', () => {
    expect(TRIGGER_PATTERN.test(`@${ASSISTANT_NAME.toLowerCase()} hello`)).toBe(
      true,
    );
    expect(TRIGGER_PATTERN.test(`@${ASSISTANT_NAME.toUpperCase()} hello`)).toBe(
      true,
    );
  });

  it('does not match in the middle of a message', () => {
    expect(TRIGGER_PATTERN.test(`hey @${ASSISTANT_NAME} hello`)).toBe(false);
  });

  it('respects word boundaries — does not match partial prefix', () => {
    // Adding extra chars after the name should not match
    expect(TRIGGER_PATTERN.test(`@${ASSISTANT_NAME}xyz hello`)).toBe(false);
  });

  it('matches at end of string', () => {
    expect(TRIGGER_PATTERN.test(`@${ASSISTANT_NAME}`)).toBe(true);
  });
});
