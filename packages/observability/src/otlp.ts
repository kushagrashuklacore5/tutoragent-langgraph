/**
 * OTLP/HTTP JSON exporter for the in-process metrics registry and finished spans.
 *
 * Off by default: nothing is recorded or sent unless an endpoint is configured
 * (`OTEL_EXPORTER_OTLP_ENDPOINT`, or the per-signal `..._METRICS_ENDPOINT` / `..._TRACES_ENDPOINT`).
 * The Prometheus `/metrics` endpoint keeps working independently.
 *
 * - periodic push (`intervalMs`), spans sent in batches of `maxBatchSpans`
 * - bounded memory: span buffer capacity (`maxBufferedSpans`) + bounded send queue (`maxQueuedRequests`);
 *   when either is full the oldest data is dropped and counted (`otlp_exporter_dropped_total`)
 * - retry with exponential backoff + jitter on network errors, 429 and 5xx (honours Retry-After)
 * - every span name, attribute, error message and metric label passes through `redact`
 * - `shutdown()` stops the timer and flushes what is buffered, bounded by a deadline
 * Wire format: https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding (ids hex, uint64 as strings, enums as ints).
 */
import { redact, redactString } from './redact.ts'
import { counter, HISTOGRAM_BOUNDS, metricsSnapshot } from './metrics.ts'
import { drainFinishedSpans, setSpanRecording, spanBufferStats, type FinishedSpan } from './trace.ts'

export interface OtlpExporterOptions {
  /** full URLs of the collector's OTLP/HTTP endpoints; an omitted signal is not exported */
  metricsUrl?: string
  tracesUrl?: string
  /** sent with every request (e.g. collector API key); never logged */
  headers?: Record<string, string>
  /** resource attributes, e.g. service.name */
  resource?: Record<string, string>
  intervalMs?: number
  timeoutMs?: number
  maxBatchSpans?: number
  maxBufferedSpans?: number
  maxQueuedRequests?: number
  retry?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number }
  /** injectable for tests */
  fetch?: typeof fetch
  /** called (redacted message only) when an export finally fails */
  onError?: (message: string) => void
}

export interface OtlpExporter {
  start(): void
  /** collect now and send everything queued */
  flush(): Promise<void>
  /** stop the timer, collect a final time and flush (bounded by `deadlineMs`) */
  shutdown(deadlineMs?: number): Promise<void>
  stats(): { sent: number; failed: number; dropped: number; retries: number; queued: number }
}

type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean }
const attr = (key: string, v: string | number | boolean): { key: string; value: AnyValue } => {
  if (typeof v === 'boolean') return { key, value: { boolValue: v } }
  if (typeof v === 'number') return { key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } }
  return { key, value: { stringValue: redactString(v) } }
}
const attrs = (o: Record<string, string | number | boolean>) => Object.entries(redact(o) as Record<string, string | number | boolean>).map(([k, v]) => attr(k, v))
const msToNs = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString()
const SCOPE = { name: '@platform/observability', version: '0.1.0' }

/** Build the OTLP `ExportMetricsServiceRequest` JSON from the current registry (cumulative temporality). */
export function buildMetricsPayload(resource: Record<string, string>, nowMs = Date.now()) {
  const snap = metricsSnapshot()
  const start = msToNs(snap.startMs)
  const time = msToNs(nowMs)
  const byName = new Map<string, unknown>()
  for (const c of snap.counters) {
    let m = byName.get(c.name) as { name: string; sum: { dataPoints: unknown[]; aggregationTemporality: number; isMonotonic: boolean } } | undefined
    if (!m) byName.set(c.name, (m = { name: c.name, sum: { dataPoints: [], aggregationTemporality: 2, isMonotonic: true } }))
    m.sum.dataPoints.push({ attributes: attrs(c.labels), startTimeUnixNano: start, timeUnixNano: time, ...(Number.isInteger(c.value) ? { asInt: String(c.value) } : { asDouble: c.value }) })
  }
  for (const h of snap.histograms) {
    let m = byName.get(h.name) as { name: string; unit: string; histogram: { dataPoints: unknown[]; aggregationTemporality: number } } | undefined
    if (!m) byName.set(h.name, (m = { name: h.name, unit: 'ms', histogram: { dataPoints: [], aggregationTemporality: 2 } }))
    // registry buckets are cumulative (Prometheus `le`); OTLP wants per-bucket counts incl. the +Inf bucket
    const cum = h.cumulativeBucketCounts
    const bucketCounts = cum.map((n, i) => String(n - (i ? cum[i - 1]! : 0)))
    bucketCounts.push(String(h.count - (cum.at(-1) ?? 0)))
    m.histogram.dataPoints.push({ attributes: attrs(h.labels), startTimeUnixNano: start, timeUnixNano: time, count: String(h.count), sum: h.sum, bucketCounts, explicitBounds: [...HISTOGRAM_BOUNDS] })
  }
  return { resourceMetrics: [{ resource: { attributes: attrs(resource) }, scopeMetrics: [{ scope: SCOPE, metrics: [...byName.values()] }] }] }
}

/** Build an OTLP `ExportTraceServiceRequest` JSON for finished spans. */
export function buildTracesPayload(resource: Record<string, string>, spans: FinishedSpan[]) {
  return {
    resourceSpans: [{
      resource: { attributes: attrs(resource) },
      scopeSpans: [{
        scope: SCOPE,
        spans: spans.map((s) => ({
          traceId: s.traceId,
          spanId: s.spanId,
          ...(s.parentId ? { parentSpanId: s.parentId } : {}),
          name: redactString(s.name),
          kind: 1, // SPAN_KIND_INTERNAL
          startTimeUnixNano: s.startTimeUnixNano,
          endTimeUnixNano: s.endTimeUnixNano,
          attributes: attrs(s.attributes),
          status: s.error ? { code: 2, message: redactString(`${s.error.name}: ${s.error.message}`) } : { code: 0 },
        })),
      }],
    }],
  }
}

/** Parse `k1=v1,k2=v2` (values URL-encoded) as used by OTEL_EXPORTER_OTLP_HEADERS. */
export function parseOtlpHeaders(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (s ?? '').split(',')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    out[decodeURIComponent(part.slice(0, i).trim())] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

/**
 * Exporter options from the standard OpenTelemetry environment variables, or null when no endpoint is set.
 * OTEL_EXPORTER_OTLP_ENDPOINT (base; /v1/metrics and /v1/traces appended), OTEL_EXPORTER_OTLP_{METRICS,TRACES}_ENDPOINT
 * (used as-is), OTEL_EXPORTER_OTLP_HEADERS, OTEL_EXPORTER_OTLP_TIMEOUT (ms), OTEL_SERVICE_NAME,
 * OTEL_METRIC_EXPORT_INTERVAL (ms), OTEL_SDK_DISABLED=true.
 */
export function otlpOptionsFromEnv(env: NodeJS.ProcessEnv, defaults: { serviceName: string; environment?: string; version?: string }): OtlpExporterOptions | null {
  if (env.OTEL_SDK_DISABLED === 'true') return null
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/+$/, '')
  const metricsUrl = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? (base ? `${base}/v1/metrics` : undefined)
  const tracesUrl = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? (base ? `${base}/v1/traces` : undefined)
  if (!metricsUrl && !tracesUrl) return null
  for (const u of [metricsUrl, tracesUrl]) if (u && !/^https?:\/\//.test(u)) throw new Error('OTLP endpoint must be an http(s) URL')
  const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
  return {
    metricsUrl,
    tracesUrl,
    headers: parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    timeoutMs: num(env.OTEL_EXPORTER_OTLP_TIMEOUT, 10_000),
    intervalMs: num(env.OTEL_METRIC_EXPORT_INTERVAL, 15_000),
    resource: {
      'service.name': env.OTEL_SERVICE_NAME ?? defaults.serviceName,
      ...(defaults.environment ? { 'deployment.environment': defaults.environment } : {}),
      ...(defaults.version ? { 'service.version': defaults.version } : {}),
    },
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.())

export function createOtlpExporter(o: OtlpExporterOptions): OtlpExporter {
  const doFetch = o.fetch ?? fetch
  const intervalMs = o.intervalMs ?? 15_000
  const timeoutMs = o.timeoutMs ?? 10_000
  const maxBatch = o.maxBatchSpans ?? 512
  const maxQueue = o.maxQueuedRequests ?? 32
  const maxAttempts = o.retry?.maxAttempts ?? 5
  const baseDelay = o.retry?.baseDelayMs ?? 500
  const maxDelay = o.retry?.maxDelayMs ?? 30_000
  const resource = o.resource ?? { 'service.name': 'ekbharat-platform' }
  const headers = { 'content-type': 'application/json', ...(o.headers ?? {}) }
  const queue: { url: string; body: string }[] = []
  const st = { sent: 0, failed: 0, dropped: 0, retries: 0 }
  let timer: NodeJS.Timeout | undefined
  let draining: Promise<void> | undefined
  let stopped = false
  let lastSpanDrops = 0

  if (o.tracesUrl) setSpanRecording(o.maxBufferedSpans ?? 4096)

  function enqueue(url: string, payload: unknown) {
    if (queue.length >= maxQueue) {
      queue.shift() // backpressure: drop the oldest request rather than grow without bound
      st.dropped++
      counter('otlp_exporter_dropped_total', { reason: 'queue_full' }).inc()
    }
    queue.push({ url, body: JSON.stringify(payload) })
  }

  function collect() {
    if (o.tracesUrl) {
      const drops = spanBufferStats().dropped
      if (drops > lastSpanDrops) counter('otlp_exporter_dropped_total', { reason: 'span_buffer_full' }).inc(drops - lastSpanDrops)
      lastSpanDrops = drops
      for (let batch = drainFinishedSpans(maxBatch); batch.length; batch = drainFinishedSpans(maxBatch)) enqueue(o.tracesUrl, buildTracesPayload(resource, batch))
    }
    if (o.metricsUrl) enqueue(o.metricsUrl, buildMetricsPayload(resource))
  }

  /** Send one request, retrying transient failures until `maxAttempts` or the deadline. */
  async function send(req: { url: string; body: string }, deadline: number): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      let retryable = true
      let wait = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2)
      let reason: string
      try {
        const res = await doFetch(req.url, { method: 'POST', headers, body: req.body, signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, deadline - Date.now()))) })
        await res.arrayBuffer().catch(() => undefined) // drain; partial-success bodies are ignored
        if (res.ok) {
          st.sent++
          return
        }
        reason = `HTTP ${res.status}`
        retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504
        const ra = Number(res.headers.get('retry-after'))
        if (retryable && Number.isFinite(ra) && ra > 0) wait = Math.min(maxDelay, ra * 1000)
      } catch (e) {
        reason = (e as Error).name === 'TimeoutError' ? 'timeout' : `network error (${(e as Error).message})`
      }
      if (!retryable || attempt >= maxAttempts || Date.now() + wait > deadline) {
        st.failed++
        counter('otlp_exporter_failed_total', {}).inc()
        // the URL may carry credentials in its query; report the path only
        o.onError?.(redactString(`OTLP export to ${new URL(req.url).pathname} failed after ${attempt} attempt(s): ${reason}`))
        return
      }
      st.retries++
      await sleep(wait)
    }
  }

  function drain(deadline: number): Promise<void> {
    if (draining) return draining // one sender at a time: requests are never sent concurrently
    draining = (async () => {
      try {
        while (queue.length && Date.now() < deadline) await send(queue.shift()!, deadline)
      } finally {
        draining = undefined
      }
    })()
    return draining
  }

  return {
    start() {
      if (timer || stopped) return
      timer = setInterval(() => {
        collect()
        void drain(Date.now() + intervalMs * 4)
      }, intervalMs)
      timer.unref()
    },
    async flush() {
      collect()
      if (draining) await draining
      await drain(Date.now() + timeoutMs * maxAttempts)
    },
    async shutdown(deadlineMs = 5_000) {
      if (timer) clearInterval(timer)
      timer = undefined
      stopped = true
      collect()
      const deadline = Date.now() + deadlineMs
      if (draining) await Promise.race([draining, sleep(deadlineMs)])
      await drain(deadline)
      if (o.tracesUrl) setSpanRecording(0)
    },
    stats: () => ({ ...st, queued: queue.length }),
  }
}
