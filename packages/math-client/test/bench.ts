/**
 * Throughput / latency benchmark for typical checks against a locally started solver.
 *   node packages/math-client/test/bench.ts [requests=400] [concurrency=4] [workers=4]
 */
import { configureLogging } from '@platform/observability'
import { startMathSolver } from '@platform/math-client'

configureLogging({ level: 'error' })
const [total = 400, concurrency = 4, workers = 4] = process.argv.slice(2).map(Number)
const out = (s: string) => process.stdout.write(s + '\n')

const svc = await startMathSolver({ workers })
const math = svc.client({ timeoutMs: 10_000 })
const cases: Array<() => Promise<{ ok: boolean; verdict: string }>> = [
  () => math.equivalent('(x+1)^2', 'x^2+2*x+1'),
  () => math.equivalent('2*x+3=7', 'x=2'),
  () => math.checkSteps(['3*x - 5 = 10', '3*x = 15', 'x = 5']),
  () => math.numericCheck({ expected: 'sqrt(2)', actual: 1.4142, tolerance: 1e-3 }),
  () => math.numericCheck({ expected: 1.5, actual: 150, units: { expected: 'm', actual: 'cm' } }),
  () => math.evaluate('a*x^2+b', { substitutions: { a: 2, x: 3, b: 1 } }),
]

try {
  for (const c of cases) await c() // warm
  const latencies: number[] = []
  let next = 0
  let unverified = 0
  const t0 = performance.now()
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < total) {
      const i = next++
      const s = performance.now()
      const r = await cases[i % cases.length]!()
      latencies.push(performance.now() - s)
      if (r.verdict === 'unverified') unverified++
    }
  }))
  const secs = (performance.now() - t0) / 1000
  latencies.sort((a, b) => a - b)
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))]!.toFixed(1)
  out(`math-solver bench: ${total} requests, concurrency ${concurrency}, ${workers} workers`)
  out(`  throughput ${(total / secs).toFixed(1)} req/s   p50 ${pct(0.5)} ms   p95 ${pct(0.95)} ms   p99 ${pct(0.99)} ms   unverified ${unverified}`)
} finally {
  await svc.stop()
}
