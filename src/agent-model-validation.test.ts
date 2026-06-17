import { describe, expect, it } from 'bun:test';

import {
  InvalidModelOverrideError,
  MAX_MODEL_OVERRIDE_LENGTH,
  assertSafeModelOverride,
  validateModelOverride,
} from './agent-model-validation.js';

describe('validateModelOverride', () => {
  it('returns null for null / undefined / blank', () => {
    expect(validateModelOverride(null)).toEqual({ ok: true, value: null });
    expect(validateModelOverride(undefined)).toEqual({ ok: true, value: null });
    expect(validateModelOverride('')).toEqual({ ok: true, value: null });
    expect(validateModelOverride('   ')).toEqual({ ok: true, value: null });
  });

  it('trims surrounding whitespace on accept', () => {
    expect(validateModelOverride('  claude-opus-4-6  ')).toEqual({
      ok: true,
      value: 'claude-opus-4-6',
    });
  });

  it('rejects non-string non-null inputs', () => {
    expect(validateModelOverride(42)).toEqual({
      ok: false,
      error: '"model" must be a string or null',
    });
    expect(validateModelOverride({ model: 'x' })).toEqual({
      ok: false,
      error: '"model" must be a string or null',
    });
  });

  it('rejects values longer than MAX_MODEL_OVERRIDE_LENGTH after trim', () => {
    const tooLong = 'x'.repeat(MAX_MODEL_OVERRIDE_LENGTH + 1);
    const result = validateModelOverride(tooLong);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(`${MAX_MODEL_OVERRIDE_LENGTH}`);
    }
  });

  it('accepts a value exactly at MAX_MODEL_OVERRIDE_LENGTH', () => {
    const exact = 'a'.repeat(MAX_MODEL_OVERRIDE_LENGTH);
    expect(validateModelOverride(exact)).toEqual({ ok: true, value: exact });
  });

  // Core #857 regression: every byte in 0x00–0x1F plus DEL must be rejected.
  it('rejects every ASCII control character (0x00–0x1F and 0x7F)', () => {
    const codes: number[] = [];
    for (let c = 0x00; c <= 0x1f; c++) codes.push(c);
    codes.push(0x7f);
    for (const code of codes) {
      const ch = String.fromCharCode(code);
      const result = validateModelOverride(`claude-opus-4-6${ch}foo`);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('control characters');
      }
    }
  });

  it('rejects the exact #857 newline-injection payload', () => {
    const result = validateModelOverride(
      'claude-opus-4-6\nANTHROPIC_BASE_URL=https://attacker.example',
    );
    expect(result).toEqual({
      ok: false,
      error: '"model" must not contain control characters',
    });
  });
});

describe('assertSafeModelOverride', () => {
  it('returns the normalized value for safe input', () => {
    expect(assertSafeModelOverride(null)).toBeNull();
    expect(assertSafeModelOverride('  claude-opus-4-6  ')).toBe(
      'claude-opus-4-6',
    );
  });

  it('throws InvalidModelOverrideError for unsafe input', () => {
    let caught: unknown;
    try {
      assertSafeModelOverride('claude-opus-4-6\nFOO=bar');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidModelOverrideError);
    expect((caught as Error).message).toContain('control characters');
  });
});
