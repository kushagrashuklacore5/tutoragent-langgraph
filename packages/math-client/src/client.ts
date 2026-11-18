import http from 'node:http'
import { logger } from '@platform/observability'
import type {
  CheckStepsResult, ConvertUnitsResult, EquivalenceOptions, EquivalenceResult, EvaluateOptions, EvaluateResult,
  MathChecker, MathResult, NumericCheckInput, NumericCheckResult, UnverifiedReason, UnverifiedResult, Verdict,
} from './types.ts'

export interface MathClientOptions {
  /** e.g. http://127.0.0.1:8765 (env MATH_SOLVER_URL) */
  baseUrl: string
  /** per-request deadline including queueing on the service; default 4000 ms (the service itself kills work after ~2 s) */
  timeoutMs?: number
  /** allow a non-loopback host (production: the solver container on an internal-only network) */
  allowRemote?: boolean
}

const VERDICTS: ReadonlySet<string> = new Set<Verdict>(['pass', 'fail', 'inconclusive', 'invalid', 'unverified'])
const MAX_RESPONSE_BYTES = 256 * 1024
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function unverified(reason: UnverifiedReason, detail: string): UnverifiedResult {
  return { ok: false, verdict: 'unverified', reason, detail }
}

/** Fail-closed shape check: anything unexpected becomes `unverified`; `ok` is true only with verdict 'pass'. */
export function normalizeResult(body: unknown): MathResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return unverified('bad_response', 'solver response is not an object')
  const r = body as Record<string, unknown>
  if (typeof r.verdict !== 'string' || !VERDICTS.has(r.verdict) || typeof r.reason !== 'string' || typeof r.ok !== 'boolean') {
    return unverified('bad_response', 'solver response has an unexpected shape')
  }
  if (r.ok !== (r.verdict === 'pass')) return unverified('bad_response', 'solver response is inconsistent')
  return r as unknown as MathResult
}

/** HTTP client for services/math-solver. Never throws for solver/transport failures: returns `unverified`. */
export function createMathClient(opts: MathClientOptions): MathChecker {
  const base = new URL(opts.baseUrl)
  if (base.protocol !== 'http:') throw new Error('math-client: baseUrl must be http:// (the solver is a private sidecar)')
  if (!opts.allowRemote && !LOOPBACK.has(base.hostname)) throw new Error('math-client: non-loopback solver host requires allowRemote')
  const timeoutMs = opts.timeoutMs ?? 4000

  const request = (method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: unknown } | UnverifiedResult> =>
    new Promise((resolve) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      let settled = false
      const done = (v: { status: number; json: unknown } | UnverifiedResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      }
      const req = http.request(new URL(path, base), {
        method,
        headers: { accept: 'application/json', ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
        agent: false,
      }, (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy()
            done(unverified('bad_response', 'solver response too large'))
          } else chunks.push(c)
        })
        res.on('end', () => {
          try {
            done({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
          } catch {
            done(unverified('bad_response', 'solver response is not JSON'))
          }
        })
        res.on('error', () => done(unverified('unavailable', 'solver connection failed')))
      })
      // hard deadline over the whole exchange (connect + queue + compute + body)
      const timer = setTimeout(() => {
        req.destroy()
        done(unverified('timeout', `no solver response within ${timeoutMs} ms`))
      }, timeoutMs)
      req.on('error', (e: Error & { code?: string }) => done(unverified('unavailable', `solver unreachable (${e.code ?? 'error'})`)))
      if (payload) req.write(payload)
      req.end()
    })

  async function call<T extends MathResult>(op: string, args: Record<string, unknown>): Promise<T> {
    const r = await request('POST', `/v1/${op}`, args)
    if ('verdict' in r) {
      logger.warn('math solver unverified', { op, reason: r.reason })
      return r as unknown as T
    }
    const result = normalizeResult(r.json)
    // 200 = computed; 4xx = invalid request (body says why); 503/504 = busy/timeout (body is 'unverified')
    if (r.status !== 200 && result.verdict !== 'invalid' && result.verdict !== 'unverified') {
      return unverified('bad_response', `unexpected HTTP ${r.status}`) as unknown as T
    }
    if (result.verdict === 'unverified') logger.warn('math solver unverified', { op, reason: result.reason })
    return result as T
  }

  const eqArgs = (o?: EquivalenceOptions) => ({ ...(o?.assume ? { assume: o.assume } : {}), ...(o?.requireSymbolic ? { requireSymbolic: true } : {}) })

  return {
    equivalent: (a, b, o) => call<EquivalenceResult>('equivalent', { a, b, ...eqArgs(o) }),
    checkSteps: (steps, o) => call<CheckStepsResult>('check_steps', { steps, ...eqArgs(o) }),
    numericCheck: (input: NumericCheckInput) => call<NumericCheckResult>('numeric_check', { ...input }),
    evaluate: (expr: string, o?: EvaluateOptions) => call<EvaluateResult>('evaluate', { expr, ...(o?.substitutions ? { substitutions: o.substitutions } : {}), ...(o?.precision !== undefined ? { precision: o.precision } : {}) }),
    convertUnits: (value, from, to, o) => call<ConvertUnitsResult>('convert_units', { value, from, to, ...(o?.precision !== undefined ? { precision: o.precision } : {}) }),
    async healthy() {
      const r = await request('GET', '/health')
      if ('verdict' in r || r.status !== 200) return false
      const h = r.json as { status?: string } | null
      return h?.status === 'ok'
    },
  }
}
