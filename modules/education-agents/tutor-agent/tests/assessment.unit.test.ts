import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assemble, quoteInAnswer, stemSimilarity, summarize, validateMarking, type Criterion, type MarkingPass, type PoolItem } from '../src/domain/assessment.ts'

const item = (id: string, conceptId: string, difficulty: number, o: Partial<PoolItem> = {}): PoolItem =>
  ({ id, conceptId, difficulty, type: 'numeric', cognitive: 'recall', stem: `${id} question about ${conceptId} number ${difficulty}`, points: 1, ...o })

test('near-duplicate stems are detected; different problems are not', () => {
  assert.ok(stemSimilarity('A 2 kg cart is pushed with 10 N. What is its acceleration?', 'A 2 kg cart is pushed with 10 N. Find its acceleration.') >= 0.75)
  assert.ok(stemSimilarity('A 2 kg cart is pushed with 10 N. What is its acceleration?', 'State Newton\'s first law in your own words.') < 0.3)
})

test('assembly: difficulty targets mastery, avoids recently seen items and near-duplicates, balances concepts', () => {
  const pool = [
    item('a1', 'A', 0.2), item('a2', 'A', 0.5), item('a3', 'A', 0.8), item('a4', 'A', 0.55, { stem: 'a2 question about A number 0.5' }),
    item('b1', 'B', 0.3), item('b2', 'B', 0.6),
  ]
  const mastery = new Map([['A', { pMastery: 0.45, state: 'learning', evidenceCount: 5 }], ['B', { pMastery: 0.3, state: 'learning', evidenceCount: 3 }]])
  const r = assemble({ sections: [{ title: 'S', conceptIds: ['A', 'B'], count: 3, difficulty: 'adaptive' }], pool, mastery, recentlySeen: new Set(['b1']), prerequisites: new Map(), adaptive: true })
  const ids = r.plan.map((p) => p.itemId)
  assert.equal(ids.length, 3)
  assert.ok(!ids.includes('b1'), 'recently seen excluded')
  assert.ok(ids.includes('a2'), 'A target ≈ 0.5 → a2')
  assert.ok(!(ids.includes('a2') && ids.includes('a4')), 'near-duplicate of a picked item excluded')
  assert.ok(ids.includes('b2'))
  assert.deepEqual(r.shortfall, [])
})

test('assembly: strong concept gets a transfer item; weak prerequisite is probed; shortfall reported', () => {
  const pool = [item('s1', 'S', 0.8), item('s2', 'S', 0.7, { cognitive: 'transfer' }), item('p1', 'P', 0.3)]
  const mastery = new Map([['S', { pMastery: 0.8, state: 'learning', evidenceCount: 6 }], ['P', { pMastery: 0.35, state: 'learning', evidenceCount: 4 }]])
  const r = assemble({ sections: [{ title: 'S', conceptIds: ['S'], count: 3 }], pool, mastery, recentlySeen: new Set(), prerequisites: new Map([['S', ['P']]]), adaptive: true })
  assert.equal(r.plan[0]!.itemId, 'p1')
  assert.match(r.plan[0]!.reason, /prerequisite/)
  assert.equal(r.plan[1]!.itemId, 's2', 'transfer preferred for a strong concept')
  assert.deepEqual(r.shortfall, [{ section: 0, wanted: 3, got: 3 }].filter(() => false), 'pool had exactly enough')
  const short = assemble({ sections: [{ title: 'S', conceptIds: ['S'], count: 5 }], pool, mastery, recentlySeen: new Set(), prerequisites: new Map(), adaptive: false })
  assert.deepEqual(short.shortfall, [{ section: 0, wanted: 5, got: 2 }])
})

const rubric: Criterion[] = [
  { id: 'c1', criterion: 'States F = m a', points: 2, keyPoints: ['force equals mass times acceleration'] },
  { id: 'c2', criterion: 'Explains doubling', points: 2, keyPoints: ['acceleration doubles'] },
]
const answer = 'Force equals mass times acceleration, so if the force doubles then the acceleration doubles too.'
const pass = (a1: number, a2: number, o: Partial<MarkingPass> = {}): MarkingPass => ({
  criteria: [
    { id: 'c1', awarded: a1, evidence: ['Force equals mass times acceleration'], missing: [], feedback: 'Correct law.' },
    { id: 'c2', awarded: a2, evidence: ['the acceleration doubles too'], missing: [], feedback: 'Good.' },
  ], overallFeedback: 'Clear.', confidence: 0.9, ...o,
})

test('evidence quotes must really appear in the answer', () => {
  assert.ok(quoteInAnswer('the acceleration doubles', answer))
  assert.ok(!quoteInAnswer('inversely proportional to mass', answer))
  assert.ok(!quoteInAnswer('so', answer), 'a short word proves nothing')
})

test('agreeing passes → validated marks (mean, half-mark rounding), no review', () => {
  const v = validateMarking(rubric, answer, [pass(2, 2), pass(2, 1.5)])
  assert.equal(v.needsReview, false)
  assert.equal(v.points, 4)
  assert.equal(v.maxPoints, 4)
  assert.deepEqual(v.criteria.map((c) => c.awarded), [2, 2])
})

test('partial marks', () => {
  const v = validateMarking(rubric, 'Force equals mass times acceleration.', [pass(2, 0, { criteria: [{ id: 'c1', awarded: 2, evidence: ['Force equals mass times acceleration'], missing: [], feedback: '' }, { id: 'c2', awarded: 0, evidence: [], missing: ['what happens when F doubles'], feedback: 'Missing.' }] }), pass(2, 0, { criteria: [{ id: 'c1', awarded: 2, evidence: ['Force equals mass times acceleration'], missing: [], feedback: '' }, { id: 'c2', awarded: 0, evidence: [], missing: [], feedback: '' }] })])
  assert.deepEqual([v.points, v.needsReview], [2, false])
  assert.deepEqual(v.criteria[1]!.missing, ['what happens when F doubles'])
})

test('disagreement, low confidence, ambiguity, alternative approach and off-rubric marking all go to review conservatively', () => {
  const dis = validateMarking(rubric, answer, [pass(2, 2), pass(0.5, 0.5)])
  assert.equal(dis.needsReview, true)
  assert.equal(dis.points, 1, 'provisional = lower pass')
  assert.match(dis.reasons[0]!, /disagree/)
  assert.equal(validateMarking(rubric, answer, [pass(2, 2, { confidence: 0.4 }), pass(2, 2)]).needsReview, true)
  assert.equal(validateMarking(rubric, answer, [pass(2, 2, { ambiguous: true }), pass(2, 2)]).needsReview, true)
  assert.equal(validateMarking(rubric, answer, [pass(2, 2, { alternativeApproach: true }), pass(2, 2)]).needsReview, true)
  const off = pass(2, 2)
  off.criteria.push({ id: 'zz', awarded: 5, evidence: [], missing: [], feedback: '' })
  assert.match(validateMarking(rubric, answer, [off, pass(2, 2)]).reasons.join(), /rubric/)
})

test('awards are clamped to the rubric and zeroed without evidence', () => {
  const inflated = pass(7, 2)
  const noEvidence = pass(2, 2, { criteria: [{ id: 'c1', awarded: 2, evidence: ['something the student never wrote'], missing: [], feedback: '' }, { id: 'c2', awarded: 2, evidence: ['the acceleration doubles too'], missing: [], feedback: '' }] })
  const v = validateMarking(rubric, answer, [inflated, inflated])
  assert.equal(v.criteria[0]!.awarded, 2, 'clamped to max')
  const n = validateMarking(rubric, answer, [noEvidence, noEvidence])
  assert.equal(n.criteria[0]!.awarded, 0, 'no evidence in the answer → no marks')
  assert.equal(n.needsReview, true)
})

test('blank answers score zero without AI; unavailable marking is reviewed', () => {
  assert.deepEqual([validateMarking(rubric, '   ', []).points, validateMarking(rubric, '   ', []).needsReview], [0, false])
  assert.equal(validateMarking(rubric, answer, []).needsReview, true)
})

test('summary: breakdowns, strengths/weaknesses, recall-not-applied, pending review excluded from score', () => {
  const s = summarize([
    { itemId: '1', conceptId: 'A', conceptName: 'Newton', type: 'mcq', cognitive: 'recall', points: 1, maxPoints: 1, needsReview: false, confidence: 'sure' },
    { itemId: '2', conceptId: 'A', conceptName: 'Newton', type: 'short', cognitive: 'understand', points: 2, maxPoints: 2, needsReview: false, confidence: null },
    { itemId: '3', conceptId: 'A', conceptName: 'Newton', type: 'numeric', cognitive: 'apply', points: 0, maxPoints: 2, needsReview: false, confidence: 'sure' },
    { itemId: '4', conceptId: 'B', conceptName: 'Energy', type: 'descriptive', cognitive: 'explain', points: 1, maxPoints: 4, needsReview: true, confidence: null },
  ])
  assert.deepEqual([s.score, s.maxScore, s.pendingReview], [3, 9, 1])
  assert.deepEqual(s.recallNotApplied, ['Newton'])
  assert.equal(s.confidentWrong, 1)
  assert.equal(s.byConcept.find((c) => c.conceptId === 'B')!.percent, null, 'pending review not counted')
})

test('a full split on one criterion goes to review even when totals are within tolerance (live regression)', () => {
  const r4: Criterion[] = [...rubric, { id: 'c3', criterion: 'Correct value', points: 1, keyPoints: ['2'] }]
  const a = 'Force equals mass times acceleration, so if the force doubles then the acceleration doubles too. The value is 2 m/s^2.'
  const mk = (c3: number): MarkingPass => ({ ...pass(2, 2), criteria: [...pass(2, 2).criteria, { id: 'c3', awarded: c3, evidence: ['The value is 2 m s 2'], missing: [], feedback: '' }] })
  const v = validateMarking(r4, a, [mk(1), mk(0)])
  assert.equal(v.needsReview, true)
  assert.match(v.reasons.join(), /disagree on: Correct value/)
  assert.equal(validateMarking(r4, a, [mk(1), mk(1)]).needsReview, false)
})

test('criterion-level override: total is the sum, AI feedback kept, changes flagged, invalid input rejected', async () => {
  const { applyCriterionOverride } = await import('../src/domain/assessment.ts')
  const current = [{ id: 'c1', criterion: 'States F = m a', points: 2, awarded: 2, feedback: 'ok', missing: [] }, { id: 'c2', criterion: 'Explains doubling', points: 2, awarded: 0.5, feedback: 'partial', missing: ['why'] }]
  const r = applyCriterionOverride(rubric, current, [{ id: 'c1', awarded: 2 }, { id: 'c2', awarded: 1.5 }])
  assert.ok('criteria' in r)
  assert.equal(r.points, 3.5)
  assert.deepEqual(r.criteria.map((c) => [c.awarded, c.educatorAdjusted, c.feedback]), [[2, false, 'ok'], [1.5, true, 'partial']])
  for (const bad of [[{ id: 'c1', awarded: 2 }], [{ id: 'c1', awarded: 3 }, { id: 'c2', awarded: 0 }], [{ id: 'c1', awarded: 1.25 }, { id: 'c2', awarded: 0 }], [{ id: 'zz', awarded: 1 }, { id: 'c1', awarded: 1 }, { id: 'c2', awarded: 1 }]]) {
    assert.ok('problems' in applyCriterionOverride(rubric, current, bad), JSON.stringify(bad))
  }
})
