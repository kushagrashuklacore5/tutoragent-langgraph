import type { IncomingMessage, ServerResponse } from 'node:http'
import { AppError, badRequest } from '@platform/core'
import { captureError, counter, histogram, logger, withSpan } from '@platform/observability'
import type { StreamResponse } from '@platform/contracts'

export interface HttpRoute {
  method: string
  path: string
  /** permission key, or 'public' for unauthenticated endpoints */
  permission: string
  moduleId: string | null
  /** accept a raw body (uploads) up to maxBytes instead of JSON */
  rawBody?: { maxBytes: number }
  handler: (req: ParsedRequest) => Promise<unknown>
}

export interface ParsedRequest {
  raw: IncomingMessage
  res: ServerResponse
  method: string
  path: string
  params: Record<string, string>
  query: URLSearchParams
  body: unknown
  signal: AbortSignal
  cookies: Record<string, string>
}

const MAX_BODY = 1_000_000

function compile(path: string): { re: RegExp; keys: string[] } {
  const keys: string[] = []
  const re = new RegExp('^' + path.replace(/\/+$/, '').replace(/:([a-zA-Z_]+)/g, (_, k: string) => { keys.push(k); return '([^/]+)' }) + '/?$')
  return { re, keys }
}

async function readRaw(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > maxBytes) throw new AppError('payload_too_large', 'File too large', { status: 413 })
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > maxBytes) throw new AppError('payload_too_large', 'File too large', { status: 413 })
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY) throw new AppError('payload_too_large', 'Request body too large', { status: 413 })
    chunks.push(c as Buffer)
  }
  if (!size) return undefined
  const ct = req.headers['content-type'] ?? ''
  if (!ct.includes('application/json')) throw new AppError('unsupported_media_type', 'Use application/json', { status: 415 })
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw badRequest('invalid_json', 'Body is not valid JSON')
  }
}

function parseCookies(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (h ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
}

export function isStream(v: unknown): v is StreamResponse {
  return !!v && typeof v === 'object' && 'stream' in v && typeof (v as StreamResponse).stream?.[Symbol.asyncIterator] === 'function'
}

export function createRouter(routes: HttpRoute[], opts: { allowedOrigins: string[] }) {
  const compiled = routes.map((r) => ({ ...r, ...compile(r.path) }))

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now()
    const url = new URL(req.url ?? '/', 'http://local')
    const origin = req.headers.origin
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v)
    if (origin && opts.allowedOrigins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('access-control-allow-credentials', 'true')
      res.setHeader('vary', 'origin')
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE')
      res.setHeader('access-control-allow-headers', 'content-type,authorization')
      res.writeHead(204).end()
      return
    }
    const match = compiled.find((r) => r.method === req.method && r.re.test(url.pathname))
    const label = match ? `${match.method} ${match.path}` : 'unmatched'
    const ac = new AbortController()
    res.on('close', () => { if (!res.writableEnded) ac.abort() })
    await withSpan(`http ${label}`, async (span) => {
      res.setHeader('x-trace-id', span.traceId)
      try {
        if (!match) throw new AppError('not_found', 'Not found', { status: 404 })
        const m = match.re.exec(url.pathname)!
        const params: Record<string, string> = {}
        match.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)))
        const out = await match.handler({
          raw: req, res, method: req.method!, path: url.pathname, params, query: url.searchParams,
          body: match.rawBody ? await readRaw(req, match.rawBody.maxBytes) : await readBody(req), signal: ac.signal, cookies: parseCookies(req.headers.cookie),
        })
        if (res.writableEnded) return
        if (isStream(out)) {
          res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
          try {
            for await (const ev of out.stream) {
              if (ac.signal.aborted) break
              res.write(`data: ${JSON.stringify(ev)}\n\n`)
            }
          } catch (e) {
            const err = e instanceof AppError || (e as { code?: string }).code ? e as { code: string; message: string } : { code: 'internal', message: 'Internal error' }
            res.write(`event: error\ndata: ${JSON.stringify({ code: err.code, message: err.message })}\n\n`)
          }
          res.end()
        } else if (out === undefined) {
          res.writeHead(204).end()
        } else {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
        }
      } catch (e) {
        const known = e instanceof AppError ? e : (e as { kind?: string; code?: string }).kind ? new AppError((e as { code: string }).code, (e as Error).message, { status: gatewayStatus((e as { kind: string }).kind) }) : null
        if (!known || known.status >= 500) captureError(e, { route: label })
        const status = known?.status ?? 500
        const body = { error: { code: known?.code ?? 'internal', message: known?.expose ? known.message : 'Internal error', ...(known?.expose && known.details ? { details: known.details } : {}) } }
        if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
        else res.end()
      } finally {
        counter('http_requests_total', { route: label, status: String(res.statusCode) }).inc()
        histogram('http_request_duration_ms', { route: label }).observe(performance.now() - started)
        if (res.statusCode >= 500) logger.warn('request failed', { route: label, status: res.statusCode })
      }
    })
  }
}

function gatewayStatus(kind: string): number {
  switch (kind) {
    case 'unknown_task': case 'invalid_request': return 400
    case 'budget_exceeded': return 402
    case 'auth': case 'quota_exhausted': case 'provider_error': case 'no_eligible_route': case 'overloaded': case 'rate_limited': case 'network': case 'timeout': return 503
    case 'invalid_output': return 502
    default: return 502
  }
}
