import { describe, expect, it } from 'bun:test';

import {
  InvalidAgentModelOverrideError,
  MAX_AGENT_MODEL_OVERRIDE_LENGTH,
  normalizeAgentModelOverride,
} from './model-override.js';

describe('normalizeAgentModelOverride', () => {
  it('returns null for missing or blank model overrides', () => {
    expect(normalizeAgentModelOverride(undefined)).toBeNull();
    expect(normalizeAgentModelOverride(null)).toBeNull();
    expect(normalizeAgentModelOverride('')).toBeNull();
    expect(normalizeAgentModelOverride('   \t\n  ')).toBeNull();
  });

  it('trims whitespace around a model override', () => {
    expect(normalizeAgentModelOverride('  claude-opus-4-6  ')).toBe(
      'claude-opus-4-6',
    );
  });

  it('accepts model overrides at the maximum allowed length', () => {
    const model = 'a'.repeat(MAX_AGENT_MODEL_OVERRIDE_LENGTH);

    expect(normalizeAgentModelOverride(model)).toBe(model);
  });

  it('rejects model overrides above the maximum allowed length', () => {
    const model = 'a'.repeat(MAX_AGENT_MODEL_OVERRIDE_LENGTH + 1);

    expect(() => normalizeAgentModelOverride(model)).toThrow(
      InvalidAgentModelOverrideError,
    );
    expect(() => normalizeAgentModelOverride(model)).toThrow(
      `${MAX_AGENT_MODEL_OVERRIDE_LENGTH} characters or fewer`,
    );
  });

  it.each(['claude\nmodel', 'claude\rmodel', 'claude\tmodel', 'claude\0model'])(
    'rejects control character in %p',
    (model) => {
      expect(() => normalizeAgentModelOverride(model)).toThrow(
        InvalidAgentModelOverrideError,
      );
      expect(() => normalizeAgentModelOverride(model)).toThrow(
        'must not contain control characters',
      );
    },
  );
});
