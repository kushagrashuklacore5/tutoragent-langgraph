/**
 * Numeric claims in tutor output are never certified by the model itself (AI_TUTOR_DESIGN § 4).
 * The model must list every computation it shows; each is recomputed by the deterministic maths
 * service. Any shown result (a number after "=" or "≈") that is not backed by a PASSING check is
 * masked and its segment is labelled "uncertain". If the service is unavailable, nothing passes.
 */
import type { MathChecker } from '@platform/contracts'

export interface ClaimedCalculation {
  expression: string
  claimedValue: string
  unit?: string
}
export interface CalculationCheck extends ClaimedCalculation {
  status: 'verified' | 'wrong' | 'unverified'
  reason: string
}

export const MAX_CALCULATIONS = 8
export const MASK = '[number not verified]'

export async function verifyCalculations(calcs: ClaimedCalculation[] | undefined, math: MathChecker | undefined): Promise<CalculationCheck[]> {
  const list = (calcs ?? []).slice(0, MAX_CALCULATIONS).filter((c) => typeof c?.expression === 'string' && typeof c?.claimedValue === 'string')
  return Promise.all(list.map(async (c): Promise<CalculationCheck> => {
    if (!math) return { ...c, status: 'unverified', reason: 'maths service not configured' }
    const r = await math.numericCheck({ expected: c.expression, actual: c.claimedValue, tolerance: 1e-6, relative: true, ...(c.unit ? { units: c.unit } : {}) })
    if (r.ok) return { ...c, status: 'verified', reason: r.reason }
    return { ...c, status: r.verdict === 'fail' ? 'wrong' : 'unverified', reason: r.reason }
  }))
}

const norm = (s: string) => s.replace(/,/g, '').replace(/^\+/, '').replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
/** numbers presented as results: "= 42", "≈ 3.14", "= -0.5" */
const RESULT = /([=≈])(\s*)(-?(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d+)?)/g

export function applyNumericVerification<S extends { text: string; source: string }>(segments: S[], checks: CalculationCheck[]): { segments: S[]; masked: number } {
  const verified = new Set(checks.filter((c) => c.status === 'verified').map((c) => norm(c.claimedValue)))
  let masked = 0
  const out = segments.map((s) => {
    let changed = false
    const text = s.text.replace(RESULT, (m, op: string, sp: string, num: string) => {
      if (verified.has(norm(num))) return m
      changed = true
      masked++
      return `${op}${sp}${MASK}`
    })
    return changed ? { ...s, text, source: 'uncertain' } : s
  })
  return { segments: out, masked }
}
