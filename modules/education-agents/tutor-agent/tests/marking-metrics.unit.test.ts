import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markingMetrics, markingReport, quadraticWeightedKappa, type MarkingOutcome } from '../evals/marking/metrics.ts'

const o = (id: string, ref: number, ai: number, max = 4, x: Partial<MarkingOutcome> = {}): MarkingOutcome =>
  ({ id, type: 'descriptive', difficulty: 0.5, source: 'synthetic', maxPoints: max, refTotal: ref, aiTotal: ai, needsReview: false, criteria: [{ id: 'c1', ref: Math.min(2, ref), ai: Math.min(2, ai) }], ...x })

test('QWK: perfect agreement = 1, chance-level ≈ 0, systematic offset reduces it', () => {
  assert.equal(quadraticWeightedKappa([0, 5, 10, 3], [0, 5, 10, 3], 11), 1)
  assert.ok(quadraticWeightedKappa([0, 2, 4, 6, 8, 10], [1, 3, 5, 7, 9, 10], 11)! > 0.9)
  assert.ok(quadraticWeightedKappa([0, 10, 0, 10], [10, 0, 10, 0], 11)! < 0)
})

test('agreement, over/under-marking, partial accuracy, review rate and settled vs provisional views', () => {
  const m = markingMetrics([o('a', 4, 4), o('b', 2, 2.5), o('c', 2, 3.5), o('d', 0, 0), o('e', 3, 1, 4, { needsReview: true })])
  assert.equal(m.reviewRate.value, 0.2)
  assert.equal(m.settled.n, 4)
  assert.deepEqual([m.settled.exact.value, m.settled.adjacent.value, m.settled.overMark.value, m.settled.underMark.value], [0.5, 0.75, 0.25, 0])
  assert.equal(m.settled.partialAccuracy.n, 2) // b and c had partial reference credit
  assert.equal(m.settled.partialAccuracy.value, 0.5)
  assert.equal(m.provisional.underMark.value, 0.2, 'the reviewed answer was provisionally under-marked (conservative)')
  assert.ok(m.settled.smd! > 0, 'net lenient on settled answers')
  assert.ok(m.settled.exact.ci!.low <= 0.5 && m.settled.exact.ci!.high >= 0.5)
})

test('report breaks down by type, difficulty band and data source', () => {
  const r = markingReport([o('a', 4, 4, 4, { type: 'short', difficulty: 0.2, source: 'educator' }), o('b', 2, 2, 4, { difficulty: 0.8 })])
  assert.deepEqual(Object.keys(r.byType), ['descriptive', 'short'])
  assert.deepEqual(Object.keys(r.byDifficulty), ['easy', 'hard'])
  assert.deepEqual(Object.keys(r.bySource), ['educator', 'synthetic'])
})

test('runner: drives the production marking pipeline over a dataset; malformed cases are reported, not scored', async () => {
  const { readFileSync } = await import('node:fs')
  const { runMarkingEval, checkMarkingCase } = await import('../evals/marking/run.ts')
  // (the shared eval-case schema check of this file lives in packages/ai-evals/test/core.unit.test.ts: modules do not import ai-evals)
  const ds = { cases: readFileSync(new URL('../evals/marking/fixtures.synthetic.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; source: string }) }
  assert.equal(ds.cases.length, 12)
  assert.ok(ds.cases.every((c) => c.source === 'synthetic'), 'fixtures are labelled synthetic')
  for (const c of ds.cases) assert.deepEqual(checkMarkingCase(c as never), [], c.id)
  // scripted marker: full marks for every criterion, quoting the first 4 words of the answer
  const run = async (_t: string, input: { messages: { role: string; content: string }[] }) => {
    const sys = input.messages[0]!.content
    const ans = /<<<\n([\s\S]*)\n>>>/.exec(input.messages[1]!.content)?.[1] ?? ''
    const ids = [...sys.matchAll(/- id=(\w+) \((\d+(?:\.\d+)?) marks\)/g)]
    return { json: { criteria: ids.map((m) => ({ id: m[1], awarded: Number(m[2]), evidence: [ans.split(' ').slice(0, 4).join(' ')], missing: [], feedback: '' })), overallFeedback: '', confidence: 0.9 }, route: { modelId: 'scripted' } }
  }
  const bad = { ...ds.cases[0]!, id: 'bad', expect: [{ grader: 'reference_marks', total: 9, criteria: { c1: 5 } }] }
  const r = await runMarkingEval(run as never, [...ds.cases, bad] as never)
  assert.equal(r.failures.length, 1)
  assert.match(r.failures[0]!.error, /no reference mark for criterion c2|must be 0-2/)
  assert.equal(r.outcomes.length, 12)
  assert.deepEqual(r.models, ['scripted'])
  assert.equal(r.outcomes.find((o) => o.id === 'fx-n2-blank')!.aiTotal, 0, 'blank answers score 0 without the model')
  assert.ok(r.report.overall.provisional.overMark.value! > 0, 'an always-full-marks marker is caught over-marking')
})
