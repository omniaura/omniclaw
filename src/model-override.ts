export const MAX_AGENT_MODEL_OVERRIDE_LENGTH = 200;

const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

export class InvalidAgentModelOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAgentModelOverrideError';
  }
}

/**
 * Normalize a per-agent model override for storage and env-file emission.
 * Model values become KEY=value lines in container env files, so control
 * characters must never be accepted.
 */
export function normalizeAgentModelOverride(
  model: string | null | undefined,
): string | null {
  if (typeof model !== 'string') return null;

  const trimmed = model.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.length > MAX_AGENT_MODEL_OVERRIDE_LENGTH) {
    throw new InvalidAgentModelOverrideError(
      `"model" must be ${MAX_AGENT_MODEL_OVERRIDE_LENGTH} characters or fewer`,
    );
  }

  if (CONTROL_CHAR_RE.test(trimmed)) {
    throw new InvalidAgentModelOverrideError(
      '"model" must not contain control characters',
    );
  }

  return trimmed;
}
