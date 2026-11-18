import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyError, conceptProfile, misconceptionSimilarity, nextAction, SAME_MISCONCEPTION, type ConceptProfile } from '../src/domain/insight.ts'
import { estimate, type Evidence } from '../src/domain/learner-model.ts'

const now = new Date('2026-11-18T10:00:00Z')
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000)

test('careless slip vs genuine error vs recurring misconception', () => {
  const strong = { pMastery: 0.8, unassistedCorrect: 3 }
  const weak = { pMastery: 0.4, unassistedCorrect: 0 }
  assert.deepEqual(classifyError('calculation', strong, [], now), { errorType: 'careless', recurring: false })
  assert.deepEqual(classifyError('calculation', weak, [], now), { errorType: 'calculation', recurring: false })
  assert.deepEqual(classifyError('conceptual', strong, [], now), { errorType: 'conceptual', recurring: false }, 'conceptual errors are never "careless"')
  assert.deepEqual(classifyError('calculation', strong, [{ type: 'calculation', at: daysAgo(3) }], now), { errorType: 'calculation', recurring: true }, 'a repeated slip is not careless')
  assert.deepEqual(classifyError('conceptual', weak, [{ type: 'conceptual', at: daysAgo(30) }], now).recurring, false, 'outside the 14-day window')
  assert.equal(classifyError('careless', weak, [], now).errorType, 'unknown', 'the model cannot declare "careless" itself')
  assert.equal(classifyError('made-up', weak, [], now).errorType, 'unknown')
})

test('profile: hint dependency, calibration, forgetting risk, error types, transfer', () => {
  const evidence: Evidence[] = [{ kind: 'practice', outcome: 1, hintsUsed: 2, observedAt: daysAgo(20) }, { kind: 'practice', outcome: 1, hintsUsed: 0, observedAt: daysAgo(20) }, { kind: 'practice', outcome: 0, hintsUsed: 0, observedAt: daysAgo(20) }]
  const p = conceptProfile({
    conceptId: 'c', name: 'Limits', est: estimate(evidence, now), evidence, now,
    attempts: [
      { conceptId: 'c', correct: true, confidence: 'unsure', hintsUsed: 2, at: daysAgo(20) },
      { conceptId: 'c', correct: true, confidence: 'sure', hintsUsed: 0, at: daysAgo(20) },
      { conceptId: 'c', correct: false, confidence: 'sure', hintsUsed: 0, at: daysAgo(20) },
    ],
    diagnoses: [{ errorType: 'conceptual', recurring: true, misconception: 'thinks the limit is f(a)' }, { errorType: 'calculation', recurring: false, misconception: '' }],
    transfer: [{ passed: false }],
  })
  assert.equal(p.hintDependency, 0.5)
  assert.deepEqual(p.calibration, { sureWrong: 1, unsureRight: 1, rated: 3, unresolvedSureWrong: 1 })
  assert.ok(p.forgettingRisk! > 0.6 && p.forgettingRisk! < 0.65, `20 days on a 14-day horizon: ${p.forgettingRisk}`)
  assert.deepEqual(p.errorTypes, { conceptual: 1, calculation: 1 })
  assert.deepEqual(p.recurringMisconceptions, ['thinks the limit is f(a)'])
  assert.deepEqual(p.transfer, { attempted: 1, passed: 0 })
})

const prof = (id: string, name: string, o: Partial<ConceptProfile> & { p?: number; state?: ConceptProfile['mastery']['state']; n?: number }): ConceptProfile => ({
  conceptId: id, name, mastery: { pMastery: o.p ?? 0.5, state: o.state ?? 'learning', evidenceCount: o.n ?? 5, unassistedCorrect: 1 },
  hintDependency: o.hintDependency ?? 0, forgettingRisk: o.forgettingRisk ?? 0.1, calibration: o.calibration ?? { sureWrong: 0, unsureRight: 0, rated: 0, unresolvedSureWrong: 0 },
  errorTypes: {}, recurringMisconceptions: o.recurringMisconceptions ?? [], transfer: o.transfer ?? { attempted: 0, passed: 0 },
})
const concepts = [{ id: 'f', name: 'Functions', prerequisites: [], examWeight: 1 }, { id: 'l', name: 'Limits', prerequisites: ['f'], examWeight: 3 }]
const run = (profiles: ConceptProfile[], dueCards = 0, examInDays: number | null = null) => nextAction({ concepts, profiles: new Map(profiles.map((p) => [p.conceptId, p])), dueCards, examInDays })

test('next action: precedence with stated reasons', () => {
  assert.equal(run([prof('f', 'Functions', {}), prof('l', 'Limits', {})], 6).action, 'revise_due_cards')
  assert.equal(run([prof('f', 'Functions', {}), prof('l', 'Limits', {})], 2, 5).action, 'revise_due_cards', 'exam close: even a few due cards first')
  const rep = run([prof('f', 'Functions', {}), prof('l', 'Limits', { recurringMisconceptions: ['limit = f(a)'] })])
  assert.deepEqual([rep.action, rep.conceptId], ['repair_misconception', 'l'])
  assert.match(rep.reason, /limit = f\(a\)/)
  const pre = run([prof('f', 'Functions', { p: 0.4 }), prof('l', 'Limits', { p: 0.3 })])
  assert.deepEqual([pre.action, pre.conceptId], ['review_prerequisite', 'f'])
  assert.equal(run([prof('f', 'Functions', { state: 'mastered', p: 0.9, forgettingRisk: 0.7 }), prof('l', 'Limits', { p: 0.6 })]).action, 'refresh_fading')
  assert.equal(run([prof('f', 'Functions', { state: 'mastered', p: 0.9 }), prof('l', 'Limits', { n: 0, p: 0.5 })]).action, 'learn_new')
  assert.equal(run([prof('f', 'Functions', { state: 'mastered', p: 0.9 }), prof('l', 'Limits', { state: 'insufficient_evidence', n: 2 })]).action, 'diagnostic_practice')
  assert.equal(run([prof('f', 'Functions', { state: 'mastered', p: 0.9 }), prof('l', 'Limits', { p: 0.6, hintDependency: 0.7 })]).action, 'guided_practice')
  assert.equal(run([prof('f', 'Functions', { state: 'mastered', p: 0.9 }), prof('l', 'Limits', { p: 0.6, calibration: { sureWrong: 2, unsureRight: 0, rated: 4, unresolvedSureWrong: 2 } })]).action, 'guided_practice')
  assert.equal(run([prof('f', 'Functions', { state: 'mastered', p: 0.9 }), prof('l', 'Limits', { p: 0.75 })]).action, 'transfer_challenge')
  assert.equal(run([prof('f', 'Functions', { state: 'mastered', p: 0.9 }), prof('l', 'Limits', { p: 0.75, transfer: { attempted: 1, passed: 1 } })]).action, 'independent_practice')
  assert.equal(run([prof('f', 'Functions', { state: 'mastered', p: 0.9 }), prof('l', 'Limits', { state: 'mastered', p: 0.92 })]).action, 'advanced_challenge')
  for (const r of [rep, pre]) assert.ok(r.reason.length > 20 && r.minutes > 0)
})

test('the same misconception under a different error label is recurring (real model outputs)', () => {
  const a = 'The student thinks the acceleration is found by multiplying force and mass instead of dividing force by mass.'
  const b = 'Used division instead of multiplication for F = m a.'
  const unrelated = 'Confuses velocity with speed and ignores direction.'
  assert.ok(misconceptionSimilarity(a, b) >= SAME_MISCONCEPTION, String(misconceptionSimilarity(a, b)))
  assert.ok(misconceptionSimilarity(a, unrelated) < SAME_MISCONCEPTION, String(misconceptionSimilarity(a, unrelated)))
  const weak = { pMastery: 0.4, unassistedCorrect: 0 }
  assert.equal(classifyError('procedural', weak, [{ type: 'conceptual', at: daysAgo(1), misconception: a }], now, b).recurring, true)
  assert.equal(classifyError('procedural', weak, [{ type: 'conceptual', at: daysAgo(1), misconception: unrelated }], now, b).recurring, false)
})

test('confident mistakes outrank "not enough evidence"; mixed results are described as such (live regression)', () => {
  const sure = run([prof('f', 'Functions', { state: 'mastered', p: 0.9 }), prof('l', 'Limits', { state: 'insufficient_evidence', n: 11, calibration: { sureWrong: 3, unsureRight: 0, rated: 5, unresolvedSureWrong: 3 } })])
  assert.equal(sure.action, 'guided_practice')
  const mixed = run([prof('f', 'Functions', { state: 'mastered', p: 0.9 }), prof('l', 'Limits', { state: 'insufficient_evidence', n: 11 })])
  assert.match(mixed.reason, /mixed so far/)
})

test('confident errors stop driving "guided practice" once followed by 3 confident correct answers', () => {
  const evidence: Evidence[] = [{ kind: 'practice', outcome: 1, hintsUsed: 0, observedAt: daysAgo(1) }]
  const a = (correct: boolean, d: number) => ({ conceptId: 'c', correct, confidence: 'sure', hintsUsed: 0, at: daysAgo(d) })
  const mk = (attempts: ReturnType<typeof a>[]) => conceptProfile({ conceptId: 'c', name: 'N2', est: estimate(evidence, now), evidence, now, attempts, diagnoses: [], transfer: [] }).calibration
  assert.equal(mk([a(false, 5), a(false, 4)]).unresolvedSureWrong, 2)
  assert.equal(mk([a(false, 5), a(false, 4), a(true, 1), a(true, 1), a(true, 1)]).unresolvedSureWrong, 0, 'fixed: 3 confident correct since')
  assert.equal(mk([a(false, 5), a(false, 4), a(true, 2), a(true, 2), a(false, 1)]).unresolvedSureWrong, 3, 'a streak broken by a new confident error does not resolve')
  assert.equal(mk([a(false, 5), a(false, 4), a(true, 1), a(true, 1), a(true, 1)]).sureWrong, 2, 'all-time count is kept for profiles')
  const cal = (unresolvedSureWrong: number) => run([prof('f', 'Functions', { state: 'mastered', p: 0.9 }), prof('l', 'Limits', { p: 0.6, calibration: { sureWrong: 4, unsureRight: 0, rated: 6, unresolvedSureWrong } })]).action
  assert.equal(cal(2), 'guided_practice')
  assert.notEqual(cal(0), 'guided_practice')
})
