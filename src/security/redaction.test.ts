import { describe, expect, it } from 'bun:test';

import { redactSensitiveData } from './redaction.js';

describe('redactSensitiveData', () => {
  it('redacts bearer, API key, hex, and JWT tokens', () => {
    const input = [
      'Bearer abcdefghijklmnopqrstuvwxyz123456',
      'sk-prod_abcdefghijklmnopqrstuvwxyz1234',
      '0123456789abcdef0123456789abcdef',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlMTIz',
    ].join(' | ');

    const redacted = redactSensitiveData(input);
    expect(redacted).toContain('Bearer [REDACTED]');
    expect(redacted).toContain('[API_KEY_REDACTED]');
    expect(redacted).toContain('[HEX_TOKEN_REDACTED]');
    expect(redacted).toContain('[JWT_REDACTED]');
  });

  it('redacts JSON secret values while preserving keys', () => {
    const input =
      '{"password":"hunter2","token":"super-secret-token-value","api_key":"abc123","secret":"x"}';

    const redacted = redactSensitiveData(input);
    expect(redacted).toBe(
      '{"password":"[REDACTED]","token":"[REDACTED]","api_key":"[REDACTED]","secret":"[REDACTED]"}',
    );
  });

  it('handles mixed text and JSON snippets without key loss', () => {
    const input =
      'request failed: {"token":"tok_abcdefghijklmnopqrstuvwxyz1234"} while using Bearer abcdefghijklmnopqrstuvwxyz123456';

    const redacted = redactSensitiveData(input);
    expect(redacted).toContain('{"token":"[REDACTED]"}');
    expect(redacted).toContain('Bearer [REDACTED]');
    expect(redacted).not.toContain('"":"[REDACTED]"');
  });

  it('does not change benign text', () => {
    const input = 'Normal status update with no credentials included.';
    expect(redactSensitiveData(input)).toBe(input);
  });
});
