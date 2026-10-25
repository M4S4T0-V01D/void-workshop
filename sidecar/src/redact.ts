/**
 * Secret redaction for anything that leaves the sidecar: logs, UI events, persisted history.
 * Redaction is defence in depth; the key itself is never handed to code paths that log.
 */

const PATTERNS: Array<[RegExp, string]> = [
  // Anthropic keys and tokens (api, admin, oauth)
  [/sk-ant-[A-Za-z0-9]{2,8}-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[REDACTED]'],
  [/sk-ant-[A-Za-z0-9_-]{16,}/g, 'sk-ant-[REDACTED]'],
  // Generic bearer / header values
  [/(authorization\s*[:=]\s*)(bearer\s+)?[^\s"',;]+/gi, '$1[REDACTED]'],
  [/(x-api-key\s*[:=]\s*)[^\s"',;]+/gi, '$1[REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [REDACTED]'],
  // key=value style secrets
  [/\b((?:api[_-]?key|secret|token|passwd|password|client[_-]?secret|access[_-]?key)[A-Za-z0-9_]*\s*[:=]\s*)(["']?)[^\s"',;]{4,}\2/gi, '$1$2[REDACTED]$2'],
  // Well-known token formats
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED_GOOGLE_KEY]'],
  // PEM private key blocks
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
];

const SECRET_FIELD = /^(api[_-]?key|apikey|key|secret|token|password|authorization|x-api-key|anthropic_api_key)$/i;

export function redactText(input: string): string {
  let out = input;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out;
}

/** Deep-redacts strings and blanks fields whose names indicate secrets. */
export function redactValue<T>(value: T, depth = 0): T {
  if (depth > 12) return '[TRUNCATED]' as unknown as T;
  if (typeof value === 'string') return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_FIELD.test(k) && typeof v === 'string' ? '[REDACTED]' : redactValue(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** Truncate long text for UI/history, keeping head and tail. */
export function clip(text: string, max = 20_000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n… [${text.length - max} characters omitted] …\n${text.slice(-tail)}`;
}
