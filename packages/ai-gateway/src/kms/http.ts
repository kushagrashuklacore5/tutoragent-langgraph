import { AppError } from '@platform/core'
import { redactString } from '@platform/observability'

export type FetchLike = typeof fetch

export interface KmsHttpOptions {
  fetch?: FetchLike
  /** per attempt; default 5000 ms */
  timeoutMs?: number
  /** total attempts for retryable failures; default 3 */
  maxAttempts?: number
  /** first backoff delay; default 100 ms (doubles, with jitter) */
  baseDelayMs?: number
}

export interface KmsResponse {
  status: number
  headers: Headers
  text: string
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Error for KMS failures. Messages carry the provider, operation, HTTP status and the provider's
 * error code only — never request headers, tokens, key material or plaintext.
 */
export function kmsError(provider: string, op: string, detail: string, opts: { status?: number; code?: string; retryable?: boolean } = {}): AppError {
  return new AppError(opts.code ?? 'kms_error', redactString(`${provider} KMS ${op} failed: ${detail}`).slice(0, 300), {
    status: 503,
    expose: false,
    details: { provider, op, upstreamStatus: opts.status, retryable: opts.retryable ?? false },
  })
}

/**
 * One HTTP exchange with timeout + bounded retries. `prepare` is called per attempt (signatures carry a
 * timestamp; tokens may refresh). `isRetryable` decides on non-2xx responses.
 */
export async function kmsRequest(
  provider: string,
  op: string,
  o: KmsHttpOptions,
  prepare: () => Promise<{ url: string; init: RequestInit }>,
  isRetryable: (r: KmsResponse) => boolean = (r) => r.status === 429 || r.status >= 500,
): Promise<KmsResponse> {
  const doFetch = o.fetch ?? fetch
  const attempts = o.maxAttempts ?? 3
  let last = 'no attempt'
  for (let i = 1; i <= attempts; i++) {
    const { url, init } = await prepare()
    try {
      const res = await doFetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(o.timeoutMs ?? 5000) })
      const r = { status: res.status, headers: res.headers, text: await res.text() }
      if (r.status < 300) return r
      if (!isRetryable(r) || i === attempts) return r
      last = `HTTP ${r.status}`
    } catch (e) {
      const name = (e as Error).name
      last = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network error'
      if (i === attempts) throw kmsError(provider, op, `${last} after ${attempts} attempt(s)`, { code: 'kms_unavailable', retryable: true })
    }
    await sleep((o.baseDelayMs ?? 100) * 2 ** (i - 1) * (0.5 + Math.random() / 2))
  }
  throw kmsError(provider, op, last, { code: 'kms_unavailable', retryable: true })
}
