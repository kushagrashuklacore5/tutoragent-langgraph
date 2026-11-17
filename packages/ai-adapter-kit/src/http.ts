import http from 'node:http'
import https from 'node:https'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import type { IncomingMessage } from 'node:http'
import { redactString } from '@platform/observability'
import { GatewayError, classifyHttpError } from './errors.ts'
import { checkBaseUrl, isPrivateAddress, type DestinationPolicy } from './net-guard.ts'

export interface HttpRequest {
  method: 'GET' | 'POST'
  url: string
  headers?: Record<string, string>
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
}

export interface HttpResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  text(): Promise<string>
  json<T = unknown>(): Promise<T>
  /** iterate the body line by line (SSE and NDJSON) */
  lines(): AsyncIterable<string>
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>
}

type Resolver = (host: string) => Promise<{ address: string; family: number }[]>
const defaultResolver: Resolver = (host) =>
  new Promise((res, rej) => dnsLookup(host, { all: true }, (err, addrs) => (err ? rej(err) : res(addrs as LookupAddress[]))))

/**
 * Outbound HTTP for adapters, with SSRF protection enforced on the real connection:
 * every resolved address is checked inside the socket's lookup, redirects are never followed,
 * requests time out, and error messages are redacted.
 */
export function createHttpClient(policy: DestinationPolicy, opts: { resolver?: Resolver; defaultTimeoutMs?: number } = {}): HttpClient {
  const resolver = opts.resolver ?? defaultResolver

  const guardedLookup = (hostname: string, _o: unknown, cb: (err: Error | null, address: string, family: number) => void) => {
    const literal = isIP(hostname)
    const p = literal ? Promise.resolve([{ address: hostname, family: literal }]) : resolver(hostname)
    p.then((addrs) => {
      const first = addrs[0]
      if (!first) return cb(new Error(`no address for ${hostname}`), '', 0)
      if (!policy.allowPrivateNetwork && addrs.some((a) => isPrivateAddress(a.address))) {
        return cb(Object.assign(new Error('destination resolves to a blocked address'), { blocked: true }), '', 0)
      }
      cb(null, first.address, first.family)
    }, (e: Error) => cb(e, '', 0))
  }

  return {
    request(req) {
      const check = checkBaseUrl(req.url, policy)
      if (!check.ok) return Promise.reject(new GatewayError('blocked_destination', check.reason))
      const url = check.url
      const timeoutMs = req.timeoutMs ?? opts.defaultTimeoutMs ?? 60_000
      const body = req.body === undefined ? undefined : typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
      const lib = url.protocol === 'https:' ? https : http
      return new Promise<HttpResponse>((resolve, reject) => {
        if (req.signal?.aborted) return reject(new GatewayError('cancelled', 'request cancelled'))
        const r = lib.request(
          url,
          {
            method: req.method,
            headers: { 'content-type': 'application/json', accept: 'application/json', ...(req.headers ?? {}), ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) },
            lookup: guardedLookup as never,
            timeout: timeoutMs,
          },
          (res) => resolve(wrapResponse(res, req.signal)),
        )
        const onAbort = () => r.destroy(new GatewayError('cancelled', 'request cancelled'))
        req.signal?.addEventListener('abort', onAbort, { once: true })
        r.on('timeout', () => r.destroy(new GatewayError('timeout', `no response within ${timeoutMs} ms`)))
        r.on('error', (e: Error & { blocked?: boolean; code?: string }) => {
          req.signal?.removeEventListener('abort', onAbort)
          if (e instanceof GatewayError) return reject(e)
          if (e.blocked) return reject(new GatewayError('blocked_destination', e.message))
          reject(new GatewayError('network', redactString(`${e.code ?? 'network error'}: ${e.message}`)))
        })
        if (body) r.write(body)
        r.end()
      })
    },
  }
}

function wrapResponse(res: IncomingMessage, signal?: AbortSignal): HttpResponse {
  let consumed = false
  const take = () => {
    if (consumed) throw new Error('body already consumed')
    consumed = true
  }
  const readAll = async () => {
    take()
    const chunks: Buffer[] = []
    for await (const c of res) chunks.push(c as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  }
  return {
    status: res.statusCode ?? 0,
    headers: res.headers,
    text: readAll,
    async json<T>() {
      const t = await readAll()
      try {
        return JSON.parse(t) as T
      } catch {
        throw new GatewayError('provider_error', 'provider returned invalid JSON')
      }
    },
    async *lines() {
      take()
      let buf = ''
      res.setEncoding('utf8')
      try {
        for await (const chunk of res) {
          if (signal?.aborted) throw new GatewayError('cancelled', 'stream cancelled')
          buf += chunk as string
          let i: number
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, '')
            buf = buf.slice(i + 1)
            yield line
          }
        }
        if (buf) yield buf
      } catch (e) {
        if (e instanceof GatewayError) throw e
        throw new GatewayError(signal?.aborted ? 'cancelled' : 'network', 'stream interrupted')
      } finally {
        res.destroy()
      }
    },
  }
}

/** Throw a normalised GatewayError for non-2xx responses (body text redacted, truncated). */
export async function ensureOk(res: HttpResponse, provider: string): Promise<void> {
  if (res.status >= 200 && res.status < 300) return
  const text = await res.text().catch(() => '')
  const kind = classifyHttpError(res.status, text)
  throw new GatewayError(kind, `${provider} HTTP ${res.status}: ${redactString(text).slice(0, 300)}`, { status: res.status })
}

/** Parse a Server-Sent Events line stream into `data:` payloads (ignores comments, joins multi-line data). */
export async function* sseData(lines: AsyncIterable<string>): AsyncIterable<{ event?: string; data: string }> {
  let event: string | undefined
  let data: string[] = []
  for await (const line of lines) {
    if (line === '') {
      if (data.length) yield { event, data: data.join('\n') }
      event = undefined
      data = []
      continue
    }
    if (line.startsWith(':')) continue
    const idx = line.indexOf(':')
    const field = idx < 0 ? line : line.slice(0, idx)
    const value = idx < 0 ? '' : line.slice(idx + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (data.length) yield { event, data: data.join('\n') }
}

export const joinUrl = (base: string, path: string) => base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '')
