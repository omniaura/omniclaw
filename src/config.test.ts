import { describe, it, expect } from 'bun:test';

import {
  buildDiscordBotConfigFromEnv,
  buildSlackBotConfigFromEnv,
  buildTelegramBotTokensFromEnv,
  escapeRegex,
  buildTriggerPattern,
  parseEnvList,
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

// --- parseEnvList ---

describe('parseEnvList', () => {
  it('returns empty array for undefined', () => {
    expect(parseEnvList(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseEnvList('')).toEqual([]);
  });

  it('parses comma-separated values', () => {
    expect(parseEnvList('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('parses newline-separated values', () => {
    expect(parseEnvList('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('parses mixed separators and trims whitespace', () => {
    expect(parseEnvList(' a, b\n c ,\n d ')).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('buildDiscordBotConfigFromEnv', () => {
  it('parses prefixed Discord bot config with default ID', () => {
    const parsed = buildDiscordBotConfigFromEnv({
      DISCORD_BOT_IDS: 'CLAUDE,OPENCODE',
      DISCORD_BOT_CLAUDE_TOKEN: 'token-a',
      DISCORD_BOT_OPENCODE_TOKEN: 'token-b',
      DISCORD_BOT_OPENCODE_RUNTIME: 'opencode',
      DISCORD_BOT_DEFAULT: 'OPENCODE',
    });

    expect(parsed.bots).toEqual([
      { id: 'CLAUDE', token: 'token-a', runtime: undefined },
      { id: 'OPENCODE', token: 'token-b', runtime: 'opencode' },
    ]);
    expect(parsed.defaultBotId).toBe('OPENCODE');
  });

  it('falls back default ID to first configured bot when DISCORD_BOT_DEFAULT is missing', () => {
    const parsed = buildDiscordBotConfigFromEnv({
      DISCORD_BOT_IDS: 'CLAUDE,OPENCODE',
      DISCORD_BOT_CLAUDE_TOKEN: 'token-a',
      DISCORD_BOT_OPENCODE_TOKEN: 'token-b',
    });

    expect(parsed.defaultBotId).toBe('CLAUDE');
  });

  it('parses codex runtime', () => {
    const parsed = buildDiscordBotConfigFromEnv({
      DISCORD_BOT_IDS: 'CODEX',
      DISCORD_BOT_CODEX_TOKEN: 'token-codex',
      DISCORD_BOT_CODEX_RUNTIME: 'codex',
    });

    expect(parsed.bots).toEqual([
      { id: 'CODEX', token: 'token-codex', runtime: 'codex' },
    ]);
  });

  it('supports legacy DISCORD_BOT_TOKEN', () => {
    const parsed = buildDiscordBotConfigFromEnv({
      DISCORD_BOT_TOKEN: 'legacy-token',
    });

    expect(parsed.bots).toEqual([
      { id: 'PRIMARY', token: 'legacy-token', runtime: undefined },
    ]);
    expect(parsed.defaultBotId).toBe('PRIMARY');
  });
});

describe('buildTelegramBotTokensFromEnv', () => {
  it('parses TELEGRAM_BOT_TOKENS as a comma-separated list', () => {
    const tokens = buildTelegramBotTokensFromEnv({
      TELEGRAM_BOT_TOKENS: 'token-a,token-b',
    });

    expect(tokens).toEqual(['token-a', 'token-b']);
  });

  it('parses TELEGRAM_BOT_TOKENS as a newline-separated list', () => {
    const tokens = buildTelegramBotTokensFromEnv({
      TELEGRAM_BOT_TOKENS: 'token-a\ntoken-b',
    });

    expect(tokens).toEqual(['token-a', 'token-b']);
  });

  it('falls back to legacy TELEGRAM_BOT_TOKEN when multi-token var is unset', () => {
    const tokens = buildTelegramBotTokensFromEnv({
      TELEGRAM_BOT_TOKEN: 'legacy-token',
    });

    expect(tokens).toEqual(['legacy-token']);
  });

  it('prefers TELEGRAM_BOT_TOKENS over TELEGRAM_BOT_TOKEN', () => {
    const tokens = buildTelegramBotTokensFromEnv({
      TELEGRAM_BOT_TOKENS: 'token-a,token-b',
      TELEGRAM_BOT_TOKEN: 'legacy-token',
    });

    expect(tokens).toEqual(['token-a', 'token-b']);
  });

  it('deduplicates identical tokens', () => {
    const tokens = buildTelegramBotTokensFromEnv({
      TELEGRAM_BOT_TOKENS: 'token-a,token-b,token-a',
    });

    expect(tokens).toEqual(['token-a', 'token-b']);
  });
});

describe('buildSlackBotConfigFromEnv', () => {
  it('parses prefixed Slack bot config with default ID', () => {
    const parsed = buildSlackBotConfigFromEnv({
      SLACK_BOT_IDS: 'OPS,SUPPORT',
      SLACK_BOT_OPS_TOKEN: 'xoxb-ops',
      SLACK_BOT_OPS_APP_TOKEN: 'xapp-ops',
      SLACK_BOT_SUPPORT_TOKEN: 'xoxb-support',
      SLACK_BOT_SUPPORT_APP_TOKEN: 'xapp-support',
      SLACK_BOT_DEFAULT: 'SUPPORT',
    });

    expect(parsed.bots).toEqual([
      { id: 'OPS', token: 'xoxb-ops', appToken: 'xapp-ops' },
      {
        id: 'SUPPORT',
        token: 'xoxb-support',
        appToken: 'xapp-support',
      },
    ]);
    expect(parsed.defaultBotId).toBe('SUPPORT');
  });

  it('falls back default ID to first configured Slack bot', () => {
    const parsed = buildSlackBotConfigFromEnv({
      SLACK_BOT_IDS: 'OPS,SUPPORT',
      SLACK_BOT_OPS_TOKEN: 'xoxb-ops',
      SLACK_BOT_OPS_APP_TOKEN: 'xapp-ops',
      SLACK_BOT_SUPPORT_TOKEN: 'xoxb-support',
      SLACK_BOT_SUPPORT_APP_TOKEN: 'xapp-support',
    });

    expect(parsed.defaultBotId).toBe('OPS');
  });

  it('supports legacy SLACK_BOT_TOKEN + SLACK_APP_TOKEN', () => {
    const parsed = buildSlackBotConfigFromEnv({
      SLACK_BOT_TOKEN: 'xoxb-legacy',
      SLACK_APP_TOKEN: 'xapp-legacy',
    });

    expect(parsed.bots).toEqual([
      { id: 'PRIMARY', token: 'xoxb-legacy', appToken: 'xapp-legacy' },
    ]);
    expect(parsed.defaultBotId).toBe('PRIMARY');
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

  it('returns never-match regex when no trigger provided', () => {
    const pattern = buildTriggerPattern();
    expect(pattern.test('@Omni hello')).toBe(false);
    expect(pattern.test('@anything')).toBe(false);
  });

  it('returns never-match regex for empty string', () => {
    const pattern = buildTriggerPattern('');
    expect(pattern.test('@Omni hello')).toBe(false);
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

