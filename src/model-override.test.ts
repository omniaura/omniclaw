import { describe, expect, it } from 'bun:test';

import {
  InvalidAgentModelOverrideError,
  MAX_AGENT_MODEL_OVERRIDE_LENGTH,
  normalizeAgentModelOverride,
} from './model-override.js';

describe('normalizeAgentModelOverride', () => {
  it('returns null for absent or blank model values', () => {
    expect(normalizeAgentModelOverride(undefined)).toBeNull();
    expect(normalizeAgentModelOverride(null)).toBeNull();
    expect(normalizeAgentModelOverride('')).toBeNull();
    expect(normalizeAgentModelOverride('   \t  ')).toBeNull();
  });

  it('trims surrounding whitespace while preserving internal content', () => {
    expect(normalizeAgentModelOverride('  gpt-5.5  ')).toBe('gpt-5.5');
    expect(normalizeAgentModelOverride('\tgpt-5 mini\t')).toBe('gpt-5 mini');
  });

  it('accepts values at the maximum allowed boundary', () => {
    const model = 'm'.repeat(MAX_AGENT_MODEL_OVERRIDE_LENGTH);

    expect(normalizeAgentModelOverride(model)).toBe(model);
  });

  it('rejects values longer than the maximum allowed boundary', () => {
    const model = 'm'.repeat(MAX_AGENT_MODEL_OVERRIDE_LENGTH + 1);

    expect(() => normalizeAgentModelOverride(model)).toThrow(
      InvalidAgentModelOverrideError,
    );
    expect(() => normalizeAgentModelOverride(model)).toThrow(
      '"model" must be 200 characters or fewer',
    );
  });

  it.each([
    ['newline', 'gpt-5\nMODEL=attacker'],
    ['carriage return', 'gpt-5\rMODEL=attacker'],
    ['nul byte', 'gpt-5\u0000'],
    ['delete character', 'gpt-5\u007F'],
  ])('rejects %s control characters', (_label, model) => {
    expect(() => normalizeAgentModelOverride(model)).toThrow(
      InvalidAgentModelOverrideError,
    );
    expect(() => normalizeAgentModelOverride(model)).toThrow(
      '"model" must not contain control characters',
    );
  });

  it('allows non-control punctuation used by provider model names', () => {
    expect(
      normalizeAgentModelOverride('openai/gpt-5.5:preview_2026-07-01'),
    ).toBe('openai/gpt-5.5:preview_2026-07-01');
  });
});
