/**
 * Symbolic practice items graded by the real maths service (SymPy sidecar), end to end through the
 * HTTP API: educator authoring, equivalence grading, mastery evidence, and fail-closed behaviour.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { startMathSolver, venvPython, DEFAULT_SERVICE_DIR, type MathSolverProcess } from '@platform/math-client'
import { setupTutorWorld, type TutorWorld } from './tutor-setup.ts'

const skip = existsSync(venvPython(DEFAULT_SERVICE_DIR)) ? false : 'maths service venv not set up (python services/math-solver/setup_env.py)'
// scripted tutor that states one true and one false calculation and declares both as checks
const turnJson = JSON.stringify({
  segments: [{ text: 'Expanding gives (x+1)^2 = x^2 + 2x + 1.', source: 'general' }, { text: 'And 3 times 4 is 13.', source: 'general' }, { text: 'What do you notice?', source: 'general' }],
  assessment: 'not_an_attempt',
  checks: [{ segment: 0, a: '(x+1)^2', b: 'x^2+2*x+1' }, { segment: 1, a: '3*4', b: '13' }, { segment: 2, a: 'import os', b: '1' }],
})
const fake = { respond: () => ({ text: turnJson, toolCalls: [], finish: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null } }) }
let solver: MathSolverProcess
let w: TutorWorld
let itemId: string
const T = '/api/m/education.tutor'

before(async () => {
  if (skip) return
  solver = await startMathSolver({ workers: 1 })
  w = await setupTutorWorld(fake, { math: solver.client() })
})
after(async () => { await w?.close(); await solver?.stop() })

test('educators author expression items; an unparseable reference answer is refused', { skip }, async () => {
  const bad = await w.h.call('POST', `${T}/courses/${w.courseId}/items`, w.prof, { conceptId: w.cFunctions, stem: 'Expand 2(x+1)', answerSpec: { type: 'expression', value: '2*(x+' } })
  assert.equal(bad.status, 400, JSON.stringify(bad.json))
  const ok = await w.h.call('POST', `${T}/courses/${w.courseId}/items`, w.prof, { conceptId: w.cFunctions, stem: 'Expand 2(x+1)', answerSpec: { type: 'expression', value: '2*x + 2' }, explanation: 'Distribute the 2.' })
  assert.equal(ok.status, 200, JSON.stringify(ok.json))
  itemId = ok.json.id
  const next = await w.h.call('GET', `${T}/courses/${w.courseId}/practice/next?conceptId=${w.cFunctions}`, w.stu)
  assert.equal(next.json.item.type, 'expression')
  assert.ok(!JSON.stringify(next.json).includes('2*x + 2'), 'the answer is never sent to the student')
  assert.equal((await w.h.call('POST', `${T}/courses/${w.courseId}/items`, w.stu, { conceptId: w.cFunctions, stem: 's', answerSpec: { type: 'expression', value: 'x' } })).status, 403)
})

test('equivalent forms are graded correct by the maths service and update mastery', { skip }, async () => {
  const before = (await w.h.call('GET', `${T}/courses/${w.courseId}/mastery`, w.stu)).json.find((c: { conceptId: string }) => c.conceptId === w.cFunctions)
  const r = await w.h.call('POST', `${T}/attempts`, w.stu, { itemId, response: '2*(1 + x)', confidence: 'sure' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.correct, true)
  assert.ok(r.json.mastery.pMastery > before.pMastery)
  const wrong = await w.h.call('POST', `${T}/attempts`, w.stu2, { itemId, response: '2*x + 1', confidence: 'sure' })
  assert.deepEqual([wrong.json.correct, wrong.json.confidentAndWrong], [false, true])
  assert.equal((await w.h.call('POST', `${T}/attempts`, w.stu, { itemId, response: 'os.system(1)' })).status, 400)
})

test('a repeated submission is one answer: concurrent duplicates add one attempt and one piece of evidence', { skip }, async () => {
  const count = async (table: string, col: string, v: string) => Number((await w.owner.query(`select count(*) from education_tutor.${table} where ${col} = $1`, [v])).rows[0].count)
  const [a0, e0] = [await count('attempts', 'item_id', itemId), await count('evidence', 'source_ref', `item:${itemId}`)]
  const rs = await Promise.all([1, 2, 3].map(() => w.h.call('POST', `${T}/attempts`, w.stu, { itemId, response: '2 + 2*x', confidence: 'sure' })))
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200])
  assert.equal(new Set(rs.map((r) => r.json.attemptId)).size, 1, 'every caller gets the same attempt')
  assert.equal(await count('attempts', 'item_id', itemId), a0 + 1)
  assert.equal(await count('evidence', 'source_ref', `item:${itemId}`), e0 + 1)
  // a different answer is a real new attempt
  assert.equal((await w.h.call('POST', `${T}/attempts`, w.stu, { itemId, response: '2*x + 3' })).json.correct, false)
  assert.equal(await count('attempts', 'item_id', itemId), a0 + 2)
})

test('tutor calculations are checked by the maths service: true ones marked, false ones relabelled', { skip }, async () => {
  const sess = (await w.h.call('POST', `${T}/sessions`, w.stu, { courseId: w.courseId })).json.id
  const r = await w.h.call('POST', `${T}/sessions/${sess}/turns`, w.stu, { message: 'how do I expand (x+1)^2?' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual(r.json.segments.map((x: { math?: string }) => x.math ?? null), ['verified', 'failed', null])
  assert.equal(r.json.segments[1].source, 'uncertain')
  assert.deepEqual(r.json.mathChecks, { verified: 1, failed: 1 })
  const hist = await w.h.call('GET', `${T}/sessions/${sess}`, w.stu)
  assert.equal(hist.json.turns[1].segments[0].math, 'verified', 'the verification is stored with the transcript')
})

test('when answers cannot be checked, nothing is recorded (fail closed)', { skip }, async () => {
  const count = async () => Number((await w.owner.query('select count(*) from education_tutor.attempts where item_id = $1', [itemId])).rows[0].count)
  const n = await count()
  await solver.stop()
  const r = await w.h.call('POST', `${T}/attempts`, w.stu, { itemId, response: '2*x + 2' })
  assert.equal(r.status, 503)
  assert.equal(r.json.error?.code ?? r.json.code, 'math_unavailable')
  assert.equal(await count(), n)
  // with the solver down, tutor turns still work; nothing is marked verified or failed
  const sess = (await w.h.call('POST', `${T}/sessions`, w.stu, { courseId: w.courseId })).json.id
  const t = await w.h.call('POST', `${T}/sessions/${sess}/turns`, w.stu, { message: 'expand (x+1)^2' })
  assert.equal(t.status, 200, JSON.stringify(t.json))
  assert.ok(t.json.segments.every((x: { math?: string }) => !x.math))
  assert.deepEqual(t.json.mathChecks, { verified: 0, failed: 0 })
})
