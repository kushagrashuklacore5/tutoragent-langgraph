/**
 * Central redaction. Every log line, trace attribute and captured error passes through `redact`.
 * - exact secret values registered at runtime (the AI secret broker registers each decrypted key)
 * - common credential shapes (bearer tokens, vendor-style keys, key=value pairs)
 */
const known = new Set<string>()

export function registerSecret(value: string): void {
  if (value && value.length >= 8) known.add(value)
}
export function forgetSecret(value: string): void {
  known.delete(value)
}

const PATTERNS: [RegExp, string][] = [
  [/(authorization|x-api-key|x-goog-api-key|api[-_]?key|password|secret|token)("?\s*[:=]\s*"?)([^"\s,}]+)/gi, '$1$2[REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [REDACTED]'],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED_KEY]'],
  [/\b(sk|gsk|pk|rk)[-_][A-Za-z0-9_-]{12,}/g, '[REDACTED_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_KEY]'],
]

export function redactString(s: string): string {
  let out = s
  for (const k of known) if (out.includes(k)) out = out.split(k).join('[REDACTED]')
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep)
  return out
}

const SENSITIVE_KEYS = /^(authorization|password|secret|apikey|api_key|token|accesstoken|refreshtoken|plaintext|cookie|set-cookie)$/i

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]'
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value instanceof Error) return { name: value.name, message: redactString(value.message), code: (value as { code?: unknown }).code }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEYS.test(k) ? '[REDACTED]' : redact(v, depth + 1)
    return out
  }
  return value
}
