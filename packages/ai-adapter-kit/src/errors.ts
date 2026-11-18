export type GatewayErrorKind =
  | 'auth'
  | 'permission'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'overloaded'
  | 'timeout'
  | 'cancelled'
  | 'context_length_exceeded'
  | 'content_filtered'
  | 'invalid_request'
  | 'model_not_found'
  | 'unsupported_capability'
  | 'network'
  | 'blocked_destination'
  | 'provider_error'
  | 'invalid_output'
  | 'no_eligible_route'
  | 'budget_exceeded'
  | 'unknown_task'

const RETRYABLE = new Set<GatewayErrorKind>(['rate_limited', 'overloaded', 'timeout', 'network', 'provider_error'])
const FALLBACK = new Set<GatewayErrorKind>(['rate_limited', 'overloaded', 'timeout', 'network', 'provider_error'])

/** Normalised error for every provider. Messages never contain credentials (they are redacted by the kit). */
export class GatewayError extends Error {
  readonly kind: GatewayErrorKind
  readonly retryable: boolean
  readonly fallbackEligible: boolean
  readonly status?: number
  readonly code: string
  /** provider-advised wait before retrying (Retry-After / "try again in …"), when given */
  readonly retryAfterMs?: number
  constructor(kind: GatewayErrorKind, message: string, opts: { status?: number; cause?: unknown; retryAfterMs?: number } = {}) {
    super(message, { cause: opts.cause })
    this.name = 'GatewayError'
    this.kind = kind
    this.code = `ai_${kind}`
    this.status = opts.status
    this.retryAfterMs = opts.retryAfterMs
    this.retryable = RETRYABLE.has(kind)
    this.fallbackEligible = FALLBACK.has(kind)
  }
}

/** Map an HTTP status + provider error text to a normalised kind. Shared by all HTTP adapters. */
export function classifyHttpError(status: number, bodyText: string): GatewayErrorKind {
  const t = bodyText.toLowerCase()
  const contextHit = /context.{0,20}(length|window)|too many tokens|maximum context|prompt is too long|input.{0,20}too long|exceeds.{0,30}(context|token)/.test(t)
  if (status === 401) return 'auth'
  if (status === 403) return 'permission'
  if (status === 404) return /model/.test(t) ? 'model_not_found' : 'invalid_request'
  if (status === 408 || status === 504) return 'timeout'
  if (status === 413) return 'context_length_exceeded'
  // per-minute/day rate limits are transient even when the message also advertises paid tiers (Groq: "Rate limit reached … try again in 2.5s … billing")
  if (status === 429) return /rate.?limit|try again in|per minute|tokens per|requests per/.test(t) ? 'rate_limited' : /quota|insufficient_quota|billing|credit/.test(t) ? 'quota_exhausted' : 'rate_limited'
  if (status === 503 || status === 529) return 'overloaded'
  if (status >= 500) return 'provider_error'
  if (status === 400 || status === 422) {
    if (contextHit) return 'context_length_exceeded'
    if (/content.{0,10}(filter|policy)|safety/.test(t)) return 'content_filtered'
    if (/model.{0,40}(not found|does not exist|not exist|unknown)/.test(t)) return 'model_not_found'
    // the model emitted a malformed or unrequested tool call (a sampling glitch, e.g. gpt-oss on Groq): retryable
    if (/tool_use_failed|failed to (call|parse) (a )?(function|tool)/.test(t)) return 'provider_error'
    // the provider's own constrained decoding failed for this sample (Groq json_validate_failed): retryable
    if (/json_validate_failed|failed to generate json/.test(t)) return 'provider_error'
    return 'invalid_request'
  }
  return 'provider_error'
}

/**
 * Provider-advised retry delay: the Retry-After header (seconds or HTTP date) or a "try again in 2.5s /
 * 1m30s / 450ms" hint in the body. Undefined when neither is present or parseable.
 */
export function retryAfterMs(bodyText: string, header?: string | string[]): number | undefined {
  const h = Array.isArray(header) ? header[0] : header
  if (h) {
    const secs = Number(h)
    if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000)
    const at = Date.parse(h)
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now())
  }
  const m = /try again in\s+(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:([\d.]+)s)?\s*(?:([\d.]+)ms)?/i.exec(bodyText)
  if (!m || !(m[1] || m[2] || m[3] || m[4])) return undefined
  return Math.round(((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000 + Number(m[4] ?? 0))
}
