const BEARER_TOKEN_RE = /Bearer\s+[A-Za-z0-9_\-.]{20,}/gi;
const API_KEY_RE = /\b(?:sk|key|api)[_-][A-Za-z0-9_\-]{16,}/gi;
const HEX_TOKEN_RE = /\b[a-f0-9]{32,}\b/gi;
const JWT_RE = /eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g;
const JSON_SECRET_VALUE_RE =
  /("(?:password|secret|token|api[_-]?key)"\s*:\s*)"[^"]+"/gi;

export function redactSensitiveData(text: string): string {
  return text
    .replace(BEARER_TOKEN_RE, 'Bearer [REDACTED]')
    .replace(API_KEY_RE, '[API_KEY_REDACTED]')
    .replace(HEX_TOKEN_RE, '[HEX_TOKEN_REDACTED]')
    .replace(JWT_RE, '[JWT_REDACTED]')
    .replace(JSON_SECRET_VALUE_RE, '$1"[REDACTED]"');
}
