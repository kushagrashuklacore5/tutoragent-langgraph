import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MathChecker } from '@platform/contracts'
import { applyNumericVerification, MASK, verifyCalculations } from '../src/domain/calculations.ts'

/** Minimal deterministic checker: evaluates simple arithmetic, or reports the service as down. */
function fakeMath(down = false): MathChecker {
  const VALUES: Record<string, number> = { '2 + 40': 42, '7 * 6': 42, '1+1': 2, '1000 * 1.5': 1500 }
  const ev = (e: string) => VALUES[e] ?? NaN
  const numericCheck = async ({ expected, actual }: { expected: number | string; actual: number | string }) => {
    if (down) return { ok: false, verdict: 'unverified' as const, reason: 'unavailable' }
    const ok = Math.abs(ev(String(expected)) - Number(actual)) <= 1e-6 * Math.max(1, Math.abs(ev(String(expected))))
    return { ok, verdict: ok ? ('pass' as const) : ('fail' as const), reason: ok ? 'within_tolerance' : 'outside_tolerance' }
  }
  return { numericCheck } as unknown as MathChecker
}

test('verified results stay; wrong or unverifiable results are masked and labelled uncertain', async () => {
  const checks = await verifyCalculations([
    { expression: '2 + 40', claimedValue: '42' },
    { expression: '7 * 6', claimedValue: '41' },
  ], fakeMath())
  assert.deepEqual(checks.map((c) => c.status), ['verified', 'wrong'])
  const { segments, masked } = applyNumericVerification([
    { text: 'Substitute x = 2: 2 + 40 = 42.', source: 'general' },
    { text: 'Then 7 × 6 = 41, so the area ≈ 41.', source: 'general' },
    { text: 'No computed result here.', source: 'general' },
  ], checks)
  assert.equal(segments[0]!.source, 'uncertain', '"x = 2" is not a verified computation either')
  assert.match(segments[0]!.text, /= 42\./)
  assert.equal(segments[1]!.text, `Then 7 × 6 = ${MASK}, so the area ≈ ${MASK}.`)
  assert.equal(segments[1]!.source, 'uncertain')
  assert.equal(segments[2]!.source, 'general')
  assert.equal(masked, 3)
})

test('the model cannot certify itself: with the maths service down nothing passes', async () => {
  const checks = await verifyCalculations([{ expression: '2 + 40', claimedValue: '42' }], fakeMath(true))
  assert.equal(checks[0]!.status, 'unverified')
  assert.equal(applyNumericVerification([{ text: 'so x = 42', source: 'general' }], checks).segments[0]!.text, `so x = ${MASK}`)
  const none = await verifyCalculations([{ expression: '1+1', claimedValue: '2' }], undefined)
  assert.equal(none[0]!.status, 'unverified')
})

test('formatting variants of the same number match (commas, trailing zeros)', async () => {
  const checks = await verifyCalculations([{ expression: '1000 * 1.5', claimedValue: '1500.0' }], fakeMath())
  const r = applyNumericVerification([{ text: 'Total = 1,500', source: 'general' }], checks)
  assert.equal(r.masked, 0)
})
