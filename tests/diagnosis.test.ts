/**
 * Misconception intelligence end to end (real maths service): wrong answer → diagnosis → deterministic
 * classification → only solver-verified follow-ups are graded → evidence → coach recommendation.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { startMathSolver, venvPython, DEFAULT_SERVICE_DIR, type MathSolverProcess } from '@platform/math-client'
import type { GenerateRequest } from '@platform/ai-adapter-kit'
import { setupTutorWorld, type TutorWorld } from './tutor-setup.ts'

const skip = existsSync(venvPython(DEFAULT_SERVICE_DIR)) ? false : 'maths service venv not set up'
const usage = { inputTokens: 10, outputTokens: 10, cachedInputTokens: null, reasoningTokens: null }
const prompts: string[] = []
const respond = (req: GenerateRequest) => {
  const sys = req.messages.map((m) => String(m.content)).join('\n')
  prompts.push(sys)
  const json = /diagnosing ONE wrong answer/.test(sys)
    ? {
      errorType: 'conceptual', misconception: 'Adds the constant instead of substituting x', whyWrong: 'You added 2 to 40 but wrote 40.', repair: 'Substitute x = 2 into the expression.',
      diagnosticQuestion: 'What does x -> 2 mean?',
      similar: { stem: 'Find lim x->3 of (x+15)', answerExpr: '3+15', answer: '18' }, // correct arithmetic → gradable
      transfer: { stem: 'A tank holds 7 rows of 8 tiles. How many?', answerExpr: '7*8', answer: '54' }, // wrong → never graded
    }
    : { segments: [{ text: 'ok', source: 'general' }], assessment: 'not_an_attempt' }
  return { text: JSON.stringify(json), toolCalls: [], finish: 'stop' as const, usage }
}
let solver: MathSolverProcess
let w: TutorWorld
let itemId: string, attemptId: string, diagnosisId: string
const T = '/api/m/education.tutor'

before(async () => {
  if (skip) return
  solver = await startMathSolver({ workers: 1 })
  w = await setupTutorWorld({ respond }, { math: solver.client() })
  itemId = (await w.h.call('GET', `${T}/courses/${w.courseId}/items`, w.prof)).json[0].id
})
after(async () => { await w?.close(); await solver?.stop() })

test('a wrong answer gets a diagnosis; correct answers cannot be diagnosed', { skip }, async () => {
  const wrong = await w.h.call('POST', `${T}/attempts`, w.stu, { itemId, response: '40', confidence: 'sure' })
  assert.equal(wrong.status, 200)
  attemptId = wrong.json.attemptId
  const r = await w.h.call('POST', `${T}/attempts/${attemptId}/diagnose`, w.stu, {})
  assert.equal(r.status, 200, JSON.stringify(r.json))
  diagnosisId = r.json.id
  assert.equal(r.json.errorType, 'conceptual')
  assert.equal(r.json.recurring, false)
  assert.match(r.json.whyWrong, /added 2/)
  assert.deepEqual([r.json.similar.gradable, r.json.transfer.gradable], [true, false], 'only solver-verified follow-ups are gradable')
  assert.ok(!('answer' in r.json.similar) && !('answer' in r.json.transfer) && !/answerExpr|"answer"/.test(JSON.stringify(r.json)), 'follow-up answers are never sent before answering')
  assert.match(prompts.at(-1)!, /STUDENT ANSWERED: <<<"?40"?>>>/)
  const again = await w.h.call('POST', `${T}/attempts/${attemptId}/diagnose`, w.stu, {})
  assert.equal(again.json.id, diagnosisId, 'idempotent: no second model call result stored')
  const right = await w.h.call('POST', `${T}/attempts`, w.stu2, { itemId, response: '42' })
  assert.equal((await w.h.call('POST', `${T}/attempts/${right.json.attemptId}/diagnose`, w.stu2, {})).status, 400)
})

test('follow-ups: graded by the maths service, recorded as evidence once; unverified ones are never graded', { skip }, async () => {
  const before = (await w.h.call('GET', `${T}/courses/${w.courseId}/mastery`, w.stu)).json.find((c: { conceptId: string }) => c.conceptId === w.cLimits)
  const r = await w.h.call('POST', `${T}/diagnoses/${diagnosisId}/followups/similar`, w.stu, { response: '15+3' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual([r.json.correct, r.json.answer], [true, '18'])
  assert.equal(r.json.mastery.evidenceCount, before.evidenceCount + 1)
  assert.equal((await w.h.call('POST', `${T}/diagnoses/${diagnosisId}/followups/similar`, w.stu, { response: '18' })).status, 409, 'one answer per follow-up')
  assert.equal((await w.h.call('POST', `${T}/diagnoses/${diagnosisId}/followups/transfer`, w.stu, { response: '56' })).status, 409, 'unverified problem is practice-only')
  const ev = await w.owner.query(`select kind, outcome from education_tutor.evidence where source_ref like $1`, [`diagnosis:${diagnosisId}:%`])
  assert.deepEqual(ev.rows.map((x) => [x.kind, Number(x.outcome)]), [['check', 1]])
  const list = (await w.h.call('GET', `${T}/courses/${w.courseId}/diagnoses`, w.stu)).json
  assert.equal(list[0].similar.result.correct, true)
})

test('diagnoses are private to the student', { skip }, async () => {
  assert.equal((await w.h.call('POST', `${T}/attempts/${attemptId}/diagnose`, w.stu2, {})).status, 404)
  assert.equal((await w.h.call('POST', `${T}/diagnoses/${diagnosisId}/followups/similar`, w.stu2, { response: '18' })).status, 404)
  assert.deepEqual((await w.h.call('GET', `${T}/courses/${w.courseId}/diagnoses`, w.stu2)).json, [])
})

test('a repeated error type becomes recurring and drives the coach recommendation', { skip }, async () => {
  const second = await w.h.call('POST', `${T}/attempts`, w.stu, { itemId: (await w.h.call('POST', `${T}/courses/${w.courseId}/items`, w.prof, { conceptId: w.cLimits, stem: 'lim x->1 of (x+5)?', answerSpec: { type: 'numeric', value: 6, tolerance: 0 } })).json.id, response: '5' })
  const d2 = await w.h.call('POST', `${T}/attempts/${second.json.attemptId}/diagnose`, w.stu, {})
  assert.equal(d2.json.recurring, true)
  const coach = await w.h.call('GET', `${T}/courses/${w.courseId}/coach`, w.stu)
  assert.equal(coach.status, 200, JSON.stringify(coach.json))
  assert.deepEqual([coach.json.next.action, coach.json.next.conceptId], ['repair_misconception', w.cLimits])
  const limits = coach.json.profile.find((p: { conceptId: string }) => p.conceptId === w.cLimits)
  assert.equal(limits.calibration.sureWrong, 1)
  assert.deepEqual(limits.recurringMisconceptions, ['Adds the constant instead of substituting x'])
  assert.equal((await w.h.call('GET', `${T}/courses/${w.courseId}/coach`, w.admin)).status, 404, 'not enrolled → no coach')
})

test('educators of the course see grouped misconceptions and error types, never the diagnosis text of conversations', { skip }, async () => {
  const r = await w.h.call('GET', `${T}/courses/${w.courseId}/progress`, w.prof)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const limits = r.json.concepts.find((c: { conceptId: string }) => c.conceptId === w.cLimits)
  assert.deepEqual(limits.misconceptions, [{ text: 'Adds the constant instead of substituting x', students: 1, occurrences: 2 }])
  assert.equal(limits.errorTypes.conceptual, 2)
  assert.ok(!JSON.stringify(r.json).includes('You added 2'), 'per-student feedback text is not exposed to educators')
})
