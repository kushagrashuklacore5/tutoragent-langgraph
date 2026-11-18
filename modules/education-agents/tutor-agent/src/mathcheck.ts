import type { CitedSegment } from './materials.ts'

/**
 * Conversational maths verification. The model declares the checkable claims it made
 * (`checks: [{segment, a, b}]` meaning "in segment i, a = b"); each is checked for equivalence by the
 * maths service. Outcomes:
 *   pass                      → the segment is marked `math: 'verified'`
 *   fail on a NUMERIC claim   → the segment is relabelled "uncertain" and marked `math: 'failed'`
 *   fail on a symbolic claim  → no change (it may be a definition such as a = F/m, not an identity)
 *   invalid / inconclusive / service down / timeout → no change (never blocks the explanation)
 * Only claims attached to a real segment are checked, at most MAX_CHECKS per turn, run in parallel.
 */

export interface MathClaim {
  segment: number; a: string; b: string
  /** no free variables: a "fail" is a real arithmetic error. Symbolic claims (e.g. a vs F/m) are often
   *  definitions or equations, not identities, so a counterexample there proves nothing about the reply. */
  numeric: boolean
}
const KNOWN = /\b(sqrt|sin|cos|tan|asin|acos|atan|sinh|cosh|tanh|log|ln|exp|abs|pi|e|E|oo)\b/g
export const isNumeric = (s: string) => !/[\p{L}_]/u.test(s.replace(KNOWN, ''))
export interface ClaimChecker {
  equivalent(a: string, b: string): Promise<{ ok: boolean; verdict: string; reason: string }>
}
export type CheckedSegment = CitedSegment & { math?: 'verified' | 'failed' }

export const MAX_CHECKS = 4
const MAX_LEN = 300
// same maths-notation alphabet as practice answers; anything else is not sent to the solver
const EXPR = /^[\p{L}\p{N}\s+\-*/^().,_!|]+$/u

export function parseClaims(raw: unknown, segmentCount: number): MathClaim[] {
  if (!Array.isArray(raw)) return []
  const out: MathClaim[] = []
  for (const c of raw) {
    if (out.length >= MAX_CHECKS) break
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    const segment = Number(o.segment)
    const a = typeof o.a === 'string' ? o.a.trim() : ''
    const b = typeof o.b === 'string' ? o.b.trim() : ''
    if (!Number.isInteger(segment) || segment < 0 || segment >= segmentCount) continue
    if (!a || !b || a.length > MAX_LEN || b.length > MAX_LEN || !EXPR.test(a) || !EXPR.test(b)) continue
    out.push({ segment, a, b, numeric: isNumeric(a) && isNumeric(b) })
  }
  return out
}

export async function verifyClaims(math: ClaimChecker | undefined, segments: CitedSegment[], claims: MathClaim[]): Promise<{ segments: CheckedSegment[]; verified: number; failed: number }> {
  const result: CheckedSegment[] = segments.map((s) => ({ ...s }))
  if (!math || !claims.length) return { segments: result, verified: 0, failed: 0 }
  const verdicts = await Promise.all(claims.map(async (c) => {
    try { return { c, v: await math.equivalent(c.a, c.b) } } catch { return { c, v: null } }
  }))
  const passed = new Set<number>()
  const failedSeg = new Set<number>()
  for (const { c, v } of verdicts) {
    if (!v) continue
    if (v.ok) passed.add(c.segment)
    else if (v.verdict === 'fail' && c.numeric) failedSeg.add(c.segment)
  }
  for (const i of failedSeg) result[i] = { text: result[i]!.text, source: 'uncertain', citations: [], math: 'failed' }
  for (const i of passed) if (!failedSeg.has(i)) result[i] = { ...result[i]!, math: 'verified' }
  return { segments: result, verified: [...passed].filter((i) => !failedSeg.has(i)).length, failed: failedSeg.size }
}
