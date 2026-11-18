/**
 * Marking-agreement metrics (pure). Reference = an educator's marks; candidate = the marking pipeline's validated
 * output. Definitions (marks are in half-mark units):
 *   exact       |ai - ref| < 0.25 (same half mark)            adjacent   |ai - ref| <= 0.5
 *   over/under  ai > ref + 0.5  /  ai < ref - 0.5              MAE        mean |ai - ref| (marks)
 *   QWK         quadratic-weighted kappa on the score FRACTION binned to 11 levels (0, 0.1, … 1) so items
 *               with different maxima are comparable
 *   SMD         (mean ai_frac - mean ref_frac) / sd(ref_frac)  — systematic leniency (+) or severity (−)
 *   criterion   share of rubric criteria awarded the same half mark
 *   partial     among answers the educator gave PARTIAL credit (0 < ref < max): share within ±0.5
 *   review      share sent to educator review (needs_review)
 * Two views: SETTLED (what students receive automatically: excludes answers sent to review) and PROVISIONAL (all,
 * using the conservative provisional mark). Operational benchmarks used for automated scoring of constructed
 * responses (Williamson, Xi & Breyer, 2012): QWK >= 0.70 and |SMD| <= 0.15; with small n, read the CIs.
 */
/** Wilson 95% score interval for a proportion (local copy: modules do not import the eval package). */
export interface Interval { low: number; high: number }
export function wilson(k: number, n: number, z = 1.959963984540054): Interval {
  const p = k / n
  const den = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / den
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den
  return { low: Math.round(Math.max(0, centre - half) * 1000) / 1000, high: Math.round(Math.min(1, centre + half) * 1000) / 1000 }
}

export interface MarkingOutcome {
  id: string; type: string; difficulty: number; source: string
  maxPoints: number; refTotal: number; aiTotal: number; needsReview: boolean
  /** why the pipeline sent it to review (validateMarking reasons) */
  reviewReasons?: string[]
  criteria: { id: string; ref: number; ai: number }[]
}
interface Rate { value: number | null; n: number; ci: Interval | null }
export interface MarkingMetrics {
  n: number
  reviewRate: Rate
  settled: AgreementBlock
  provisional: AgreementBlock
}
export interface AgreementBlock {
  n: number; exact: Rate; adjacent: Rate; overMark: Rate; underMark: Rate; partialAccuracy: Rate; criterionExact: Rate
  mae: number | null; qwk: number | null; smd: number | null
}

const rate = (k: number, n: number): Rate => ({ value: n ? Math.round((k / n) * 1000) / 1000 : null, n, ci: n ? wilson(k, n) : null })
const r3 = (x: number) => Math.round(x * 1000) / 1000

/** Quadratic-weighted kappa for two integer ratings on 0..k-1. */
export function quadraticWeightedKappa(a: number[], b: number[], k: number): number | null {
  const n = a.length
  if (!n || n !== b.length) return null
  const O = Array.from({ length: k }, () => new Array<number>(k).fill(0))
  const ha = new Array<number>(k).fill(0), hb = new Array<number>(k).fill(0)
  for (let i = 0; i < n; i++) { O[a[i]!]![b[i]!]!++; ha[a[i]!]!++; hb[b[i]!]!++ }
  let num = 0, den = 0
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
    const w = ((i - j) ** 2) / ((k - 1) ** 2)
    num += w * O[i]![j]!
    den += w * (ha[i]! * hb[j]!) / n
  }
  return den === 0 ? (num === 0 ? 1 : null) : r3(1 - num / den)
}

function block(rs: MarkingOutcome[]): AgreementBlock {
  const n = rs.length
  const d = rs.map((r) => r.aiTotal - r.refTotal)
  const partial = rs.filter((r) => r.refTotal > 0 && r.refTotal < r.maxPoints)
  const crit = rs.flatMap((r) => r.criteria)
  const frac = (x: number, m: number) => (m > 0 ? x / m : 0)
  const bin = (f: number) => Math.min(10, Math.max(0, Math.round(f * 10)))
  const refF = rs.map((r) => frac(r.refTotal, r.maxPoints))
  const aiF = rs.map((r) => frac(r.aiTotal, r.maxPoints))
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const sdRef = n > 1 ? Math.sqrt(refF.reduce((a, x) => a + (x - mean(refF)) ** 2, 0) / (n - 1)) : 0
  return {
    n,
    exact: rate(d.filter((x) => Math.abs(x) < 0.25).length, n),
    adjacent: rate(d.filter((x) => Math.abs(x) <= 0.5).length, n),
    overMark: rate(d.filter((x) => x > 0.5).length, n),
    underMark: rate(d.filter((x) => x < -0.5).length, n),
    partialAccuracy: rate(partial.filter((r) => Math.abs(r.aiTotal - r.refTotal) <= 0.5).length, partial.length),
    criterionExact: rate(crit.filter((c) => Math.abs(c.ai - c.ref) < 0.25).length, crit.length),
    mae: n ? r3(mean(d.map(Math.abs))) : null,
    qwk: n ? quadraticWeightedKappa(refF.map(bin), aiF.map(bin), 11) : null,
    smd: n > 1 && sdRef > 0 ? r3((mean(aiF) - mean(refF)) / sdRef) : null,
  }
}

export function markingMetrics(rs: MarkingOutcome[]): MarkingMetrics {
  return { n: rs.length, reviewRate: rate(rs.filter((r) => r.needsReview).length, rs.length), settled: block(rs.filter((r) => !r.needsReview)), provisional: block(rs) }
}

export const difficultyBand = (d: number) => (d < 0.4 ? 'easy' : d < 0.7 ? 'medium' : 'hard')

/** Overall plus per-type, per-difficulty and per-source breakdowns (source separates real educator data from fixtures). */
export function markingReport(rs: MarkingOutcome[]) {
  const by = (key: (r: MarkingOutcome) => string) => Object.fromEntries([...new Set(rs.map(key))].sort().map((k) => [k, markingMetrics(rs.filter((r) => key(r) === k))]))
  return { overall: markingMetrics(rs), byType: by((r) => r.type), byDifficulty: by((r) => difficultyBand(r.difficulty)), bySource: by((r) => r.source) }
}
