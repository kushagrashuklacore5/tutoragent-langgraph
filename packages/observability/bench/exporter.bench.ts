/**
 * Exporter overhead benchmark: requests/sec on a trivial instrumented route (one span + counter +
 * histogram per request, like apps/api/src/http.ts) with the OTLP exporter off vs on.
 *   node packages/observability/bench/exporter.bench.ts [--seconds 5] [--rounds 3] [--concurrency 32]
 * The server runs in a child process; the load generator and a mock OTLP collector run here.
 * Rounds alternate off/on to spread machine noise.
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { parseArgs } from 'node:util'

const role = process.argv[2]

if (role === '--micro') {
  // CPU cost per instrumented operation, recording off vs on, plus serialisation cost per push
  const { withSpan, setSpanRecording, drainFinishedSpans, buildTracesPayload, buildMetricsPayload, counter } = await import('../src/index.ts')
  const N = 200_000
  const loop = async () => {
    const t = performance.now()
    for (let i = 0; i < N; i++) await withSpan('op', async () => undefined, undefined, { 'http.route': '/x' })
    return ((performance.now() - t) * 1000) / N
  }
  for (let r = 0; r < 3; r++) {
    setSpanRecording(0)
    const off = await loop()
    setSpanRecording(N)
    const on = await loop()
    const spans = drainFinishedSpans(512)
    drainFinishedSpans()
    let t = performance.now()
    for (let i = 0; i < 50; i++) JSON.stringify(buildTracesPayload({ 'service.name': 'b' }, spans))
    const tracesMs = (performance.now() - t) / 50
    for (let i = 0; i < 200; i++) counter('c_total', { route: `/r${i}` }).inc()
    t = performance.now()
    for (let i = 0; i < 50; i++) JSON.stringify(buildMetricsPayload({ 'service.name': 'b' }))
    const metricsMs = (performance.now() - t) / 50
    process.stdout.write(`round ${r + 1}: span recording off ${off.toFixed(2)} µs/op, on ${on.toFixed(2)} µs/op (+${(on - off).toFixed(2)} µs); serialise 512 spans ${tracesMs.toFixed(2)} ms; metrics push (200 series + span hist) ${metricsMs.toFixed(2)} ms` + '\n')
  }
  setSpanRecording(0)
} else if (role === '--server') {
  const { counter, histogram, withSpan, createOtlpExporter } = await import('../src/index.ts')
  const endpoint = process.env.BENCH_OTLP
  const ex = endpoint ? createOtlpExporter({ metricsUrl: `${endpoint}/v1/metrics`, tracesUrl: `${endpoint}/v1/traces`, intervalMs: 1000 }) : undefined
  ex?.start()
  const server = http.createServer((req, res) => {
    const t0 = performance.now()
    void withSpan('http GET /bench', async () => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    }, undefined, { 'http.route': '/bench' }).then(() => {
      counter('http_requests_total', { route: '/bench', status: '200' }).inc()
      histogram('http_request_duration_ms', { route: '/bench' }).observe(performance.now() - t0)
    })
  })
  server.keepAliveTimeout = 30_000
  server.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${(server.address() as AddressInfo).port}\n`))
  process.on('message', async () => {
    await ex?.shutdown(2000)
    process.stdout.write(`STATS ${JSON.stringify(ex?.stats() ?? null)}\n`)
    process.exit(0)
  })
} else {
  const { values } = parseArgs({ options: { seconds: { type: 'string', default: '5' }, rounds: { type: 'string', default: '3' }, concurrency: { type: 'string', default: '32' } } })
  const seconds = Number(values.seconds)
  const conc = Number(values.concurrency)

  // mock collector: accepts and discards
  let collected = 0
  const collector = http.createServer((req, res) => { req.resume(); req.on('end', () => { collected++; res.writeHead(200).end('{}') }) })
  await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r))
  const otlpUrl = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`

  async function round(exporterOn: boolean): Promise<{ rps: number; p99: number; stats: unknown }> {
    const child = spawn(process.execPath, [import.meta.filename, '--server'], { env: { ...process.env, ...(exporterOn ? { BENCH_OTLP: otlpUrl } : {}) }, stdio: ['ignore', 'pipe', 'inherit', 'ipc'] })
    let out = ''
    const port = await new Promise<number>((r) => child.stdout!.on('data', (d) => { out += d; const m = /PORT (\d+)/.exec(out); if (m) r(Number(m[1])) }))
    const agent = new http.Agent({ keepAlive: true, maxSockets: conc })
    const get = () => new Promise<void>((r, j) => http.get({ host: '127.0.0.1', port, path: '/bench', agent }, (res) => { res.resume(); res.on('end', r) }).on('error', j))
    for (let i = 0; i < 2000; i++) await get() // warm-up
    const lat: number[] = []
    let n = 0
    const end = performance.now() + seconds * 1000
    await Promise.all(Array.from({ length: conc }, async () => {
      while (performance.now() < end) {
        const t = performance.now()
        await get()
        lat.push(performance.now() - t)
        n++
      }
    }))
    agent.destroy()
    const stats = await new Promise((r) => {
      child.stdout!.on('data', (d) => { out += d; const m = /STATS (.*)\n/.exec(out); if (m) r(JSON.parse(m[1]!)) })
      child.send('stop')
    })
    lat.sort((a, b) => a - b)
    return { rps: n / seconds, p99: lat[Math.floor(lat.length * 0.99)]!, stats }
  }

  const results: { on: boolean; rps: number; p99: number; stats: unknown }[] = []
  for (let i = 0; i < Number(values.rounds); i++) {
    for (const on of [false, true]) {
      const r = await round(on)
      results.push({ on, ...r })
      process.stdout.write(`round ${i + 1} exporter=${on ? 'on ' : 'off'}  ${r.rps.toFixed(0)} req/s  p99 ${r.p99.toFixed(2)} ms${on ? `  exporter ${JSON.stringify(r.stats)}` : ''}` + '\n')
    }
  }
  const avg = (on: boolean) => results.filter((r) => r.on === on).reduce((a, r) => a + r.rps, 0) / Number(values.rounds)
  const off = avg(false)
  const on = avg(true)
  process.stdout.write(`\nmean off ${off.toFixed(0)} req/s, on ${on.toFixed(0)} req/s → overhead ${(((off - on) / off) * 100).toFixed(1)}% (collector received ${collected} requests)` + '\n')
  collector.close()
}
