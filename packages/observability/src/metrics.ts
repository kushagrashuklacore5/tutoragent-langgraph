/** Minimal in-process metrics with Prometheus text exposition (served at /metrics). */
type Labels = Record<string, string>
const keyOf = (name: string, l: Labels) => name + JSON.stringify(Object.entries(l).sort())

interface Counter { name: string; labels: Labels; value: number }
interface Hist { name: string; labels: Labels; count: number; sum: number; counts: number[] }
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]
const counters = new Map<string, Counter>()
const hists = new Map<string, Hist>()

export function counter(name: string, labels: Labels = {}) {
  const k = keyOf(name, labels)
  let c = counters.get(k)
  if (!c) {
    c = { name, labels, value: 0 }
    counters.set(k, c)
  }
  const ref = c
  return { inc: (n = 1) => { ref.value += n }, get: () => ref.value }
}

export function histogram(name: string, labels: Labels = {}) {
  const k = keyOf(name, labels)
  let h = hists.get(k)
  if (!h) {
    h = { name, labels, count: 0, sum: 0, counts: BUCKETS.map(() => 0) }
    hists.set(k, h)
  }
  const ref = h
  return {
    observe(v: number) {
      ref.count++
      ref.sum += v
      BUCKETS.forEach((b, i) => { if (v <= b) ref.counts[i] = (ref.counts[i] ?? 0) + 1 })
    },
    snapshot: () => ({ count: ref.count, sum: ref.sum }),
  }
}

const fmt = (l: Labels) => {
  const e = Object.entries(l)
  return e.length ? '{' + e.map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`).join(',') + '}' : ''
}

export function renderPrometheus(): string {
  const out: string[] = []
  for (const c of counters.values()) out.push(`${c.name}${fmt(c.labels)} ${c.value}`)
  for (const h of hists.values()) {
    BUCKETS.forEach((b, i) => out.push(`${h.name}_bucket${fmt({ ...h.labels, le: String(b) })} ${h.counts[i]}`))
    out.push(`${h.name}_bucket${fmt({ ...h.labels, le: '+Inf' })} ${h.count}`)
    out.push(`${h.name}_sum${fmt(h.labels)} ${h.sum}`, `${h.name}_count${fmt(h.labels)} ${h.count}`)
  }
  return out.join('\n') + '\n'
}

export function resetMetrics(): void {
  registryStart = Date.now()
  counters.clear()
  hists.clear()
}

/** Histogram bucket upper bounds (ms), shared by every histogram. */
export const HISTOGRAM_BOUNDS: readonly number[] = BUCKETS
let registryStart = Date.now()

/** Point-in-time copy of the registry (cumulative since `startMs`), for push exporters. */
export function metricsSnapshot(): {
  startMs: number
  counters: { name: string; labels: Labels; value: number }[]
  histograms: { name: string; labels: Labels; count: number; sum: number; cumulativeBucketCounts: number[] }[]
} {
  return {
    startMs: registryStart,
    counters: [...counters.values()].map((c) => ({ name: c.name, labels: { ...c.labels }, value: c.value })),
    histograms: [...hists.values()].map((h) => ({ name: h.name, labels: { ...h.labels }, count: h.count, sum: h.sum, cumulativeBucketCounts: [...h.counts] })),
  }
}
