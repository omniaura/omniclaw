import { describe, expect, it } from 'bun:test';
import {
  InvalidAgentModelOverrideError,
  MAX_AGENT_MODEL_OVERRIDE_LENGTH,
  normalizeAgentModelOverride,
} from './model-override.js';

describe('normalizeAgentModelOverride', () => {
  it('returns null for missing, empty, or whitespace-only values', () => {
    expect(normalizeAgentModelOverride(undefined)).toBeNull();
    expect(normalizeAgentModelOverride(null)).toBeNull();
    expect(normalizeAgentModelOverride('')).toBeNull();
    expect(normalizeAgentModelOverride('   \t  ')).toBeNull();
  });

  it('trims surrounding whitespace from valid model names', () => {
    expect(normalizeAgentModelOverride('  anthropic/claude-sonnet-4-5  ')).toBe(
      'anthropic/claude-sonnet-4-5',
    );
  });

  it('allows punctuation commonly used in provider-qualified model ids', () => {
    expect(
      normalizeAgentModelOverride('openai/gpt-5.1-codex_2026:preview'),
    ).toBe('openai/gpt-5.1-codex_2026:preview');
  });

  it('allows a model id at the maximum storage length', () => {
    const model = 'a'.repeat(MAX_AGENT_MODEL_OVERRIDE_LENGTH);

    expect(normalizeAgentModelOverride(model)).toBe(model);
  });

  it('rejects a model id longer than the maximum storage length', () => {
    const model = 'a'.repeat(MAX_AGENT_MODEL_OVERRIDE_LENGTH + 1);

    expect(() => normalizeAgentModelOverride(model)).toThrow(
      InvalidAgentModelOverrideError,
    );
    expect(() => normalizeAgentModelOverride(model)).toThrow(
      `"model" must be ${MAX_AGENT_MODEL_OVERRIDE_LENGTH} characters or fewer`,
    );
  });

  it.each([
    ['newline', 'claude\nOPENCODE_MODEL=attacker'],
    ['carriage return', 'claude\rOPENCODE_MODEL=attacker'],
    ['tab after trim', 'claude\tmodel'],
    ['nul byte', 'claude\0model'],
    ['delete character', `claude${String.fromCharCode(0x7f)}model`],
  ])(
    'rejects %s control characters that could corrupt env files',
    (_name, model) => {
      expect(() => normalizeAgentModelOverride(model)).toThrow(
        InvalidAgentModelOverrideError,
      );
      expect(() => normalizeAgentModelOverride(model)).toThrow(
        '"model" must not contain control characters',
      );
    },
  );
});
