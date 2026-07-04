import { describe, expect, test } from 'bun:test';

import {
  InvalidAgentModelOverrideError,
  MAX_AGENT_MODEL_OVERRIDE_LENGTH,
  normalizeAgentModelOverride,
} from './model-override.js';

describe('normalizeAgentModelOverride', () => {
  test('returns null for missing or blank model overrides', () => {
    expect(normalizeAgentModelOverride(undefined)).toBeNull();
    expect(normalizeAgentModelOverride(null)).toBeNull();
    expect(normalizeAgentModelOverride('')).toBeNull();
    expect(normalizeAgentModelOverride('   \t  ')).toBeNull();
  });

  test('trims surrounding whitespace from non-empty model overrides', () => {
    expect(normalizeAgentModelOverride('  claude-opus-4-20250514  ')).toBe(
      'claude-opus-4-20250514',
    );
  });

  test('accepts overrides at the maximum normalized length', () => {
    const model = 'a'.repeat(MAX_AGENT_MODEL_OVERRIDE_LENGTH);

    expect(normalizeAgentModelOverride(model)).toBe(model);
    expect(normalizeAgentModelOverride(` ${model} `)).toBe(model);
  });

  test('rejects overrides longer than the maximum normalized length', () => {
    expect(() =>
      normalizeAgentModelOverride(
        'a'.repeat(MAX_AGENT_MODEL_OVERRIDE_LENGTH + 1),
      ),
    ).toThrow(InvalidAgentModelOverrideError);
  });

  test('rejects control characters after trimming', () => {
    const unsafeModels = [
      'claude\nopencode',
      'claude\ropencode',
      'claude\topencode',
      'claude\0opencode',
      `claude${String.fromCharCode(0x7f)}opencode`,
    ];

    for (const model of unsafeModels) {
      expect(() => normalizeAgentModelOverride(model)).toThrow(
        InvalidAgentModelOverrideError,
      );
    }
  });
});
