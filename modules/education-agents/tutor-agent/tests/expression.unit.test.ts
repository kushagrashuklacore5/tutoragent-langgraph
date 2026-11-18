import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreExpression, validateSpec, type EquivalenceChecker } from '../src/domain/scoring.ts'

const checker = (verdict: string, ok = verdict === 'pass'): EquivalenceChecker & { calls: number } => {
  const c = { calls: 0, async equivalent() { c.calls++; return { ok, verdict, reason: verdict } } }
  return c
}
const spec = { type: 'expression' as const, value: '2*x + 2' }

test('expression scoring grades only on a definite verdict (fail closed)', async () => {
  assert.deepEqual(await scoreExpression(checker('pass'), spec, '2*(x+1)'), { outcome: 1, correct: true, feedbackKey: 'correct' })
  assert.equal((await scoreExpression(checker('fail'), spec, '2*x'))!.feedbackKey, 'incorrect')
  assert.equal((await scoreExpression(checker('invalid'), spec, '2*x+'))!.feedbackKey, 'invalid_response')
  for (const v of ['unverified', 'inconclusive']) assert.equal(await scoreExpression(checker(v), spec, '2*x+2'), null, v)
})

test('malformed or oversized responses never reach the maths service', async () => {
  for (const bad of ['', '   ', 42, null, 'x'.repeat(501), 'import os; os.system("x")', '__import__("os")`']) {
    const c = checker('pass')
    assert.equal((await scoreExpression(c, spec, bad))!.feedbackKey, 'invalid_response', String(bad))
    assert.equal(c.calls, 0)
  }
})

test('expression specs are validated', () => {
  assert.deepEqual(validateSpec(spec), [])
  assert.equal(validateSpec({ type: 'expression', value: '' }).length, 1)
  assert.equal(validateSpec({ type: 'expression', value: 'x', assume: 'imaginary' as never }).length, 1)
})
