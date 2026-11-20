/**
 * Thin API client. Same-origin requests (dev: Vite proxies /api) so the HttpOnly session cookie is sent
 * and the browser adds the Origin header the API's CSRF check requires on state-changing requests.
 */

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/** Build an ApiError from an HTTP status and the API's `{error:{code,message}}` body (or anything else). */
export function toApiError(status: number, body: unknown): ApiError {
  const e = body && typeof body === 'object' && 'error' in body ? (body as { error?: { code?: unknown; message?: unknown; details?: unknown } }).error : undefined
  const code = typeof e?.code === 'string' ? e.code : status === 0 ? 'network' : `http_${status}`
  const message = typeof e?.message === 'string' ? e.message : status === 0 ? 'Network error' : `Request failed (${status})`
  return new ApiError(status, code, message, e?.details)
}

/**
 * True when the endpoint itself does not exist on this server (not deployed yet, or module disabled):
 * the router answers a bare "Not found", while missing records say "<Thing> not found".
 */
export function isEndpointMissing(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false
  // the route exists but the platform service behind it is not configured on this server
  if (e.status === 503 && e.code.endsWith('_unavailable')) return true
  return (e.status === 404 && e.message === 'Not found') || e.status === 405
}

/** Plain-language message for people, never internals. */
export function describeError(e: unknown): string {
  if (e instanceof DOMException && e.name === 'AbortError') return 'Cancelled.'
  if (!(e instanceof ApiError)) return e instanceof TypeError ? 'You appear to be offline or the server cannot be reached. Check your connection and try again.' : 'Something went wrong. Please try again.'
  switch (e.code.replace(/^ai_/, '')) {
    case 'auth': case 'quota_exhausted': case 'provider_error': return 'The AI tutor is unavailable right now (the AI service connection needs attention from your administrator). Practice, revision and your plan still work.'
    case 'network': return 'You appear to be offline or the server cannot be reached. Check your connection and try again.'
    case 'unauthorized': return 'Your session has ended. Please sign in again.'
    case 'budget_exceeded': return 'Your institution has used its AI allowance for now. Practice and revision still work.'
    case 'no_eligible_route': return 'The tutor is not available right now: no AI model is configured for it. Practice, revision and your plan still work.'
    case 'overloaded': case 'rate_limited': return 'The tutor is busy right now. Please try again in a minute.'
    case 'timeout': return 'The tutor took too long to answer. Please try again.'
    case 'invalid_output': return 'The tutor produced an answer we could not use safely. Please try again.'
    case 'payload_too_large': return 'That is too large to send.'
    case 'age_attestation_required': return 'Please confirm you are 18 or older to continue.'
  }
  if (e.status === 401) return 'Your session has ended. Please sign in again.'
  if (e.status === 403) return e.message && e.message !== 'Forbidden' ? e.message : 'You do not have access to this.'
  if (e.status === 404) return isEndpointMissing(e) ? 'This feature is not available on this server yet.' : e.message
  if (e.status === 400 || e.status === 409 || e.status === 422) return e.message
  if (e.status === 503) return 'The service is temporarily unavailable. Please try again shortly.'
  if (e.status >= 500) return 'Something went wrong on our side. Please try again.'
  return e.message
}

let onUnauthorized: (() => void) | null = null
/** The shell registers a handler so an expired session sends the person back to sign-in. */
export function setUnauthorizedHandler(fn: (() => void) | null): void { onUnauthorized = fn }

export interface RequestOptions {
  signal?: AbortSignal
  /** raw body (e.g. a File) instead of JSON */
  raw?: BodyInit
  contentType?: string
}

export async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  let payload: BodyInit | undefined
  if (opts.raw !== undefined) {
    payload = opts.raw
    if (opts.contentType) headers['content-type'] = opts.contentType
  } else if (body !== undefined) {
    payload = JSON.stringify(body)
    headers['content-type'] = 'application/json'
  }
  let res: Response
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', signal: opts.signal })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw toApiError(0, null)
  }
  const text = res.status === 204 ? '' : await res.text()
  let json: unknown = null
  if (text) {
    try { json = JSON.parse(text) } catch { json = null }
  }
  if (!res.ok) {
    const err = toApiError(res.status, json)
    if (res.status === 401 && !path.startsWith('/api/auth/') && path !== '/api/me') onUnauthorized?.()
    throw err
  }
  return json as T
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, { signal }),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>('POST', path, body ?? {}, { signal }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
}

/** Tutor module base path. */
export const TUTOR = '/api/m/education.tutor'
