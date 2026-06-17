/**
 * Shared validation for per-agent model overrides.
 *
 * Model overrides flow from the Web UI into the agent container env file
 * (`data/env/<agent>/env`) where they are concatenated as `KEY=value` lines.
 * A value containing `\r`, `\n`, NUL, or other ASCII control characters
 * could inject additional env entries (e.g. `ANTHROPIC_BASE_URL=...`) into
 * the next container run. See issue #857.
 *
 * This module is the single source of truth for accepting / rejecting a
 * model override string. Both the HTTP handler (`handleSetAgentModel` in
 * `src/web/routes.ts`) and the SQLite write (`setAgentModel` in `src/db.ts`)
 * call into it, so an unsafe value cannot reach the env file even if a
 * future caller forgets to validate upstream.
 */

export const MAX_MODEL_OVERRIDE_LENGTH = 200;

/**
 * Matches any ASCII control character (0x00–0x1F, including \r, \n, \t, NUL,
 * and 0x7F DEL). These are forbidden in model override values because env-file
 * writers concatenate raw `KEY=value` lines separated by `\n`.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_REGEX = /[\x00-\x1F\x7F]/;

export type ValidateModelOverrideResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

/**
 * Normalize and validate a model override value submitted from an
 * untrusted source (Web UI body, IPC, etc.).
 *
 * - `null` / `undefined` → cleared override (`{ ok: true, value: null }`).
 * - Whitespace-only string → cleared override.
 * - Non-string, non-null → rejected.
 * - Longer than `MAX_MODEL_OVERRIDE_LENGTH` after trimming → rejected.
 * - Contains any ASCII control character after trimming → rejected.
 * - Otherwise returns the trimmed value.
 */
export function validateModelOverride(
  raw: unknown,
): ValidateModelOverrideResult {
  if (raw === null || raw === undefined) {
    return { ok: true, value: null };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: '"model" must be a string or null' };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }
  if (trimmed.length > MAX_MODEL_OVERRIDE_LENGTH) {
    return {
      ok: false,
      error: `"model" must be ${MAX_MODEL_OVERRIDE_LENGTH} characters or fewer`,
    };
  }
  if (CONTROL_CHAR_REGEX.test(trimmed)) {
    return {
      ok: false,
      error: '"model" must not contain control characters',
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Thrown by `assertSafeModelOverride` when a value would be rejected by
 * `validateModelOverride`. Used as a defense-in-depth tripwire at the
 * persistence layer so a bypassed HTTP validator cannot silently land an
 * unsafe value in SQLite (and then in the env file).
 */
export class InvalidModelOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidModelOverrideError';
  }
}

/**
 * Throwing variant of {@link validateModelOverride}. Returns the normalized
 * value (or null) on success, throws {@link InvalidModelOverrideError} on
 * failure. Intended for the SQLite write path, where reaching the function
 * with an unsafe value indicates an upstream bug rather than user input.
 */
export function assertSafeModelOverride(raw: unknown): string | null {
  const result = validateModelOverride(raw);
  if (!result.ok) {
    throw new InvalidModelOverrideError(result.error);
  }
  return result.value;
}
