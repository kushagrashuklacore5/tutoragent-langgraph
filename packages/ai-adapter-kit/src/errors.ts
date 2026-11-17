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
  constructor(kind: GatewayErrorKind, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: opts.cause })
    this.name = 'GatewayError'
    this.kind = kind
    this.code = `ai_${kind}`
    this.status = opts.status
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
  if (status === 429) return /quota|insufficient_quota|billing|credit/.test(t) ? 'quota_exhausted' : 'rate_limited'
  if (status === 503 || status === 529) return 'overloaded'
  if (status >= 500) return 'provider_error'
  if (status === 400 || status === 422) {
    if (contextHit) return 'context_length_exceeded'
    if (/content.{0,10}(filter|policy)|safety/.test(t)) return 'content_filtered'
    if (/model.{0,40}(not found|does not exist|not exist|unknown)/.test(t)) return 'model_not_found'
    return 'invalid_request'
  }
  return 'provider_error'
}
