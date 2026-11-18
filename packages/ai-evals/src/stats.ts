/** Small, dependency-free statistics used by reports and learning-outcome analysis. */

export interface Interval {
  low: number
  high: number
}

/** z for a two-sided 95% interval */
export const Z95 = 1.959963984540054

/** Wilson score interval for a binomial rate (well-behaved at 0, 1 and small n). */
export function wilson(successes: number, n: number, z = Z95): Interval {
  if (n <= 0) return { low: 0, high: 1 }
  const p = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) }
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
}

/** Sample standard deviation (n − 1). */
export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}

/** Normal-approximation 95% interval for a mean (reported, not used for gating). */
export function meanInterval(xs: number[], z = Z95): Interval {
  const m = mean(xs)
  if (xs.length < 2) return { low: m, high: m }
  const half = (z * stdev(xs)) / Math.sqrt(xs.length)
  return { low: m - half, high: m + half }
}

/** Percentile with linear interpolation between closest ranks (p in [0, 100]). */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const rank = (p / 100) * (s.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  return s[lo]! + (s[hi]! - s[lo]!) * (rank - lo)
}

/** Cohen's kappa for two raters over the same items (categorical labels). */
export function cohensKappa(a: string[], b: string[]): number {
  if (a.length !== b.length || !a.length) return NaN
  const n = a.length
  const labels = [...new Set([...a, ...b])]
  const po = a.filter((x, i) => x === b[i]).length / n
  const pe = labels.reduce((acc, l) => acc + (a.filter((x) => x === l).length / n) * (b.filter((x) => x === l).length / n), 0)
  return pe === 1 ? 1 : (po - pe) / (1 - pe)
}
