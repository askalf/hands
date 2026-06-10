/**
 * Best-effort secret scrubbing for audit-log text. The audit log
 * records the `text` the agent types and the commands it runs — when a
 * task involves logging into something, credentials would otherwise be
 * persisted in plaintext (and survive into the rotated archive and the
 * replay tooling). This catches well-known token shapes and obvious
 * `password=...` assignments; it cannot recognize an arbitrary string
 * typed into a password field with no context. Pure — exported for
 * tests.
 */
export function redactSecrets(text: string): string {
  return text
    // Vendor-prefixed tokens
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED:anthropic-key]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED:github-pat]')
    .replace(/\bgh[opurs]_[A-Za-z0-9]{20,}\b/g, '[REDACTED:github-token]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key-id]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED:slack-token]')
    // JWTs (three base64url segments)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED:jwt]')
    // Authorization headers
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[REDACTED]')
    // key=value / key: value assignments with secret-ish names
    .replace(
      /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*)(["']?)[^\s"']{6,}\2/gi,
      '$1$2[REDACTED]$2',
    );
}
