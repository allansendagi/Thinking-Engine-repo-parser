/**
 * On-device first pass: strip credentials from captured text BEFORE it leaves the machine.
 * People paste API keys, tokens and private keys into AI chats all the time; none of that is
 * thinking, and none of it should reach Thread's server or the model that reads transcripts.
 *
 * High-precision patterns only (each has a distinctive shape), so ordinary prose and code are
 * never touched. Kept identical in extension/src/lib/redact.ts (the browser) and mirrored in
 * macos-app/.../Redaction.swift (the Mac importer); the server runs the same pass again for
 * captures from older clients. Shared vectors: src/capture/redact.test.ts.
 */

const PATTERNS: [kind: string, re: RegExp][] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["api key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g],
  ["stripe key", /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["aws key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["github token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ["slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["google key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["bearer token", /(?<=\bBearer\s+)[A-Za-z0-9._~+/-]{24,}=*/g],
  // `password = "..."`, `API_KEY: ...` -- only the value goes.
  ["secret", /(?<=\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']?)(?!\[redacted)[^\s"'`,;]{8,}/gi],
];

export function redactSecrets(text: string): string {
  if (text.length < 8) return text;
  let out = text;
  for (const [kind, re] of PATTERNS) out = out.replace(re, `[redacted ${kind}]`);
  return out;
}

/** Every string inside a JSON-shaped value (export conversations, message lists). */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}
