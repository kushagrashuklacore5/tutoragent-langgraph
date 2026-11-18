import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  counter, histogram, withSpan, resetMetrics, registerSecret, renderPrometheus, setSpanRecording, spanBufferStats, drainFinishedSpans,
  createOtlpExporter, otlpOptionsFromEnv, parseOtlpHeaders, buildMetricsPayload,
} from '../src/index.ts'

/** In-process OTLP/HTTP collector. `plan` decides each response status (default 200). */
async function mockCollector(plan: (n: number, path: string) => number | { status: number; headers?: Record<string, string> } = () => 200) {
  const received: { path: string; headers: http.IncomingHttpHeaders; body: any; raw: string }[] = []
  let n = 0
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const p = plan(n++, req.url!)
      const r = typeof p === 'number' ? { status: p } : p
      if (r.status === 200) received.push({ path: req.url!, headers: req.headers, body: JSON.parse(raw), raw })
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) }).end('{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, received, attempts: () => n, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }) }
}

beforeEach(() => {
  resetMetrics()
  setSpanRecording(0)
})
after(() => setSpanRecording(0))

test('off by default: no endpoint → no exporter options, no span recording', () => {
  assert.equal(otlpOptionsFromEnv({}, { serviceName: 'api' }), null)
  assert.equal(otlpOptionsFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_SDK_DISABLED: 'true' }, { serviceName: 'api' }), null)
  assert.equal(spanBufferStats().capacity, 0)
  const o = otlpOptionsFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://c.example:4318/', OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=abc%3D1,team=core' }, { serviceName: 'api', environment: 'production' })!
  assert.equal(o.metricsUrl, 'https://c.example:4318/v1/metrics')
  assert.equal(o.tracesUrl, 'https://c.example:4318/v1/traces')
  assert.deepEqual(o.headers, { 'x-api-key': 'abc=1', team: 'core' })
  assert.equal(o.resource!['deployment.environment'], 'production')
  assert.throws(() => otlpOptionsFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://x' }, { serviceName: 'api' }))
  assert.deepEqual(parseOtlpHeaders('bad,=x,a=b'), { a: 'b' })
})

test('metrics payload: OTLP JSON shape for counters and histograms; Prometheus endpoint unaffected', async () => {
  counter('http_requests_total', { route: '/x', status: '200' }).inc(3)
  const h = histogram('http_request_ms', { route: '/x' })
  for (const v of [3, 7, 40, 99999]) h.observe(v)
  const c = await mockCollector()
  const ex = createOtlpExporter({ metricsUrl: `${c.url}/v1/metrics`, headers: { authorization: 'Bearer collector-token-123456' }, resource: { 'service.name': 'api' } })
  await ex.flush()
  assert.equal(c.received.length, 1)
  const r = c.received[0]!
  assert.equal(r.path, '/v1/metrics')
  assert.equal(r.headers['content-type'], 'application/json')
  assert.equal(r.headers.authorization, 'Bearer collector-token-123456') // headers are sent…
  const rm = r.body.resourceMetrics[0]
  assert.deepEqual(rm.resource.attributes, [{ key: 'service.name', value: { stringValue: 'api' } }])
  const metrics = rm.scopeMetrics[0].metrics
  const sum = metrics.find((m: any) => m.name === 'http_requests_total').sum
  assert.equal(sum.isMonotonic, true)
  assert.equal(sum.aggregationTemporality, 2)
  assert.equal(sum.dataPoints[0].asInt, '3')
  assert.match(sum.dataPoints[0].timeUnixNano, /^\d{19}$/)
  const hist = metrics.find((m: any) => m.name === 'http_request_ms').histogram
  const dp = hist.dataPoints[0]
  assert.equal(dp.count, '4')
  assert.equal(dp.bucketCounts.length, dp.explicitBounds.length + 1)
  assert.deepEqual(dp.bucketCounts.slice(0, 4), ['1', '1', '0', '1']) // ≤5, ≤10, ≤25, ≤50
  assert.equal(dp.bucketCounts.at(-1), '1') // +Inf
  assert.equal(dp.bucketCounts.reduce((a: number, b: string) => a + Number(b), 0), 4)
  assert.match(renderPrometheus(), /http_requests_total\{route="\/x",status="200"\} 3/)
  await c.close()
})

test('traces: finished spans exported in batches with parent links and error status', async () => {
  const c = await mockCollector()
  const ex = createOtlpExporter({ tracesUrl: `${c.url}/v1/traces`, maxBatchSpans: 2 })
  await withSpan('outer', async () => {
    await withSpan('inner', async () => undefined, undefined, { 'http.route': '/a', attempt: 2 })
  })
  await withSpan('fails', async () => { throw new Error('boom') }).catch(() => undefined)
  await ex.flush()
  assert.equal(c.received.length, 2) // 3 spans, batch size 2
  const spans = c.received.flatMap((r) => r.body.resourceSpans[0].scopeSpans[0].spans)
  assert.equal(spans.length, 3)
  const inner = spans.find((s: any) => s.name === 'inner')
  const outer = spans.find((s: any) => s.name === 'outer')
  assert.equal(inner.parentSpanId, outer.spanId)
  assert.equal(inner.traceId, outer.traceId)
  assert.match(outer.traceId, /^[0-9a-f]{32}$/)
  assert.match(outer.spanId, /^[0-9a-f]{16}$/)
  assert.ok(BigInt(inner.endTimeUnixNano) >= BigInt(inner.startTimeUnixNano))
  assert.deepEqual(inner.attributes, [{ key: 'http.route', value: { stringValue: '/a' } }, { key: 'attempt', value: { intValue: '2' } }])
  const failed = spans.find((s: any) => s.name === 'fails')
  assert.equal(failed.status.code, 2)
  assert.match(failed.status.message, /boom/)
  await ex.shutdown()
  assert.equal(spanBufferStats().capacity, 0) // recording stops with the exporter
  await c.close()
})

test('redaction is preserved: no registered secret or credential shape reaches the collector', async () => {
  const secret = ['sk', 'live', 'supersecretvalue', '0001'].join('-') // assembled at runtime so the repo secret scan stays meaningful
  registerSecret(secret)
  const c = await mockCollector()
  const ex = createOtlpExporter({ metricsUrl: `${c.url}/v1/metrics`, tracesUrl: `${c.url}/v1/traces` })
  counter('leaky_total', { note: `key=${secret}` }).inc()
  await withSpan(`call ${secret}`, async () => { throw new Error(`upstream said Bearer abcdefghijklmnop and ${secret}`) }, undefined, { password: 'hunter2hunter2', url: `https://x/?api_key=${secret}` }).catch(() => undefined)
  await ex.flush()
  const all = c.received.map((r) => r.raw).join('\n')
  assert.ok(c.received.length >= 2)
  assert.ok(!all.includes(secret), 'registered secret leaked')
  assert.ok(!all.includes('hunter2hunter2'))
  assert.ok(!all.includes('abcdefghijklmnop'))
  assert.match(all, /REDACTED/)
  await ex.shutdown()
  await c.close()
})

test('retry with backoff on 503/429, gives up on 400, honours max attempts', async () => {
  const c = await mockCollector((n) => (n === 0 ? 503 : n === 1 ? { status: 429, headers: { 'retry-after': '0' } } : 200))
  const errors: string[] = []
  const ex = createOtlpExporter({ metricsUrl: `${c.url}/v1/metrics`, retry: { baseDelayMs: 5, maxDelayMs: 20 }, onError: (m) => errors.push(m) })
  counter('x_total').inc()
  await ex.flush()
  assert.equal(c.attempts(), 3)
  assert.equal(c.received.length, 1)
  assert.deepEqual({ sent: ex.stats().sent, retries: ex.stats().retries, failed: ex.stats().failed }, { sent: 1, retries: 2, failed: 0 })
  await c.close()

  const bad = await mockCollector(() => 400)
  const ex2 = createOtlpExporter({ metricsUrl: `${bad.url}/v1/metrics?token=querysecret123`, retry: { baseDelayMs: 1 }, onError: (m) => errors.push(m) })
  await ex2.flush()
  assert.equal(bad.attempts(), 1) // 4xx other than 429 is not retried
  assert.equal(ex2.stats().failed, 1)
  assert.match(errors.at(-1)!, /\/v1\/metrics failed after 1 attempt\(s\): HTTP 400/)
  assert.ok(!errors.join().includes('querysecret123'))
  await bad.close()

  const down = await mockCollector(() => 503)
  const ex3 = createOtlpExporter({ metricsUrl: `${down.url}/v1/metrics`, retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } })
  await ex3.flush()
  assert.equal(down.attempts(), 3)
  assert.equal(ex3.stats().failed, 1)
  await down.close()
})

test('network errors and timeouts are retried and bounded', async () => {
  let calls = 0
  const ex = createOtlpExporter({
    metricsUrl: 'http://collector.invalid/v1/metrics', timeoutMs: 50, retry: { maxAttempts: 2, baseDelayMs: 1 },
    fetch: (async (_u: unknown, init?: RequestInit) => {
      calls++
      if (calls === 1) throw new TypeError('fetch failed')
      return new Promise((_r, rej) => init!.signal!.addEventListener('abort', () => rej(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))))
    }) as typeof fetch,
  })
  const t0 = Date.now()
  await ex.flush()
  assert.equal(calls, 2)
  assert.equal(ex.stats().failed, 1)
  assert.ok(Date.now() - t0 < 2000)
})

test('backpressure: bounded span buffer and bounded request queue drop oldest, never grow', async () => {
  const c = await mockCollector(() => 503)
  const ex = createOtlpExporter({ tracesUrl: `${c.url}/v1/traces`, maxBufferedSpans: 10, maxBatchSpans: 1, maxQueuedRequests: 3, retry: { maxAttempts: 1 } })
  for (let i = 0; i < 25; i++) await withSpan(`s${i}`, async () => undefined)
  assert.equal(spanBufferStats().buffered, 10)
  assert.ok(spanBufferStats().dropped >= 15)
  await ex.flush() // 10 batches into a queue of 3 → 7 dropped, 3 attempted and failed
  assert.equal(ex.stats().dropped, 7)
  assert.equal(ex.stats().failed, 3)
  assert.equal(ex.stats().queued, 0)
  await ex.shutdown(200)
  await c.close()
})

test('periodic push and shutdown flush', async () => {
  const c = await mockCollector()
  const ex = createOtlpExporter({ metricsUrl: `${c.url}/v1/metrics`, tracesUrl: `${c.url}/v1/traces`, intervalMs: 30 })
  counter('tick_total').inc()
  ex.start()
  await new Promise((r) => setTimeout(r, 120))
  assert.ok(c.received.filter((r) => r.path === '/v1/metrics').length >= 2)
  await withSpan('last-span', async () => undefined)
  await ex.shutdown()
  const spans = c.received.filter((r) => r.path === '/v1/traces').flatMap((r) => r.body.resourceSpans[0].scopeSpans[0].spans)
  assert.ok(spans.some((s: any) => s.name === 'last-span'), 'span finished just before shutdown is flushed')
  const before = c.received.length
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(c.received.length, before, 'no pushes after shutdown')
  assert.equal(drainFinishedSpans().length, 0)
  await c.close()
})

test('payload builder handles an empty registry', () => {
  const p = buildMetricsPayload({ 'service.name': 'w' })
  assert.deepEqual(p.resourceMetrics[0]!.scopeMetrics[0]!.metrics, [])
})
