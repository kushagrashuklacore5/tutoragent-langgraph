/**
 * Intelligent assessment engine, end to end through the HTTP API with a real database, real document
 * processing + retrieval, and the real maths service (AI responses are scripted):
 * generate from approved material → validate → educator approval → assessment → evidence-based assembly →
 * autosave → one-shot submit → deterministic + validated rubric marking → evidence / FSRS cards →
 * educator review and audited override. Plus answer-key leakage, isolation and time limits.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { startMathSolver, venvPython, DEFAULT_SERVICE_DIR, type MathSolverProcess } from '@platform/math-client'
import { createDatabase } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { createWorker } from '@platform/jobs'
import { hashingEmbed } from '@platform/testing'
import type { GenerateRequest } from '@platform/ai-adapter-kit'
import { setupTutorWorld, type TutorWorld } from './tutor-setup.ts'

const skip = existsSync(venvPython(DEFAULT_SERVICE_DIR)) ? false : 'maths service venv not set up'
const usage = { inputTokens: 100, outputTokens: 100, cachedInputTokens: null, reasoningTokens: null }
const T = '/api/m/education.tutor'
const reply = (json: unknown) => ({ text: JSON.stringify(json), toolCalls: [], finish: 'stop' as const, usage })

const RUBRIC = [
  { id: 'c1', criterion: 'Says the limit is the value the function approaches', points: 2, keyPoints: ['approaches', 'value'] },
  { id: 'c2', criterion: 'Explains that the function need not be defined at the point', points: 2, keyPoints: ['not defined', 'need not equal'] },
]
let srcId = ''
function respond(req: GenerateRequest) {
  const sys = req.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n')
  const user = req.messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n')
  if (/You write assessment questions/.test(sys)) {
    srcId = /<<<SOURCE id="([^"]+)"/.exec(sys)?.[1] ?? ''
    return reply({ items: [
      { type: 'mcq', stem: 'Which statement best describes the limit of a function as x approaches a?', learningObjective: 'Define a limit', cognitive: 'understand', difficulty: 0.4, sourceIds: [srcId],
        explanation: 'The limit is the value the function approaches as x gets close to a.', options: ['The value the function approaches as x gets close to a', 'Always the value of f at a', 'The largest value of the function', 'The slope at a'], correct: ['The value the function approaches as x gets close to a'] },
      { type: 'numeric', stem: 'A function f(x) = 3x + 6 is evaluated near x = 4. What value does f approach as x approaches 4?', learningObjective: 'Evaluate a limit by substitution', cognitive: 'apply', difficulty: 0.5, sourceIds: [srcId],
        explanation: 'Substitute: 3 times 4 plus 6 is 18, the value the function approaches.', value: 18, tolerance: 0, answerExpr: '3*4+6' },
      { type: 'numeric', stem: 'What value does g(x) = 2x + 1 approach as x approaches 5?', learningObjective: 'Evaluate a limit', cognitive: 'apply', difficulty: 0.5, sourceIds: [srcId],
        explanation: 'Substitute x = 5 into the function to find the value it approaches.', value: 12, tolerance: 0, answerExpr: '2*5+1' }, // wrong key → rejected by the maths check
      { type: 'descriptive', stem: 'Explain in your own words what the limit of a function at a point means, and whether the function must be defined there.', learningObjective: 'Explain the limit concept', cognitive: 'explain', difficulty: 0.6, sourceIds: [srcId],
        explanation: 'A limit describes the value the function approaches; the function need not be defined at the point.', modelAnswer: 'The limit is the value the function approaches as x approaches the point. The function need not be defined at that point.', rubric: RUBRIC },
      { type: 'mcq', stem: 'Which planet is largest in the solar system?', learningObjective: 'Astronomy', cognitive: 'recall', difficulty: 0.2, sourceIds: ['00000000-0000-0000-0000-000000000000'], explanation: 'Jupiter.', options: ['Jupiter', 'Mars', 'Venus', 'Earth'], correct: ['Jupiter'] }, // ungrounded
    ] })
  }
  if (/strict, fair examiner/.test(sys)) {
    const ans = user.toLowerCase()
    const t = req.temperature ?? 0
    if (ans.includes('borderline')) return reply({ criteria: [{ id: 'c1', awarded: t > 0 ? 0.5 : 2, evidence: ['value it approaches'], missing: [], feedback: 'ok' }, { id: 'c2', awarded: t > 0 ? 0 : 2, evidence: ['borderline idea'], missing: [], feedback: 'ok' }], overallFeedback: 'Mixed.', confidence: 0.5 })
    const c1 = ans.includes('approaches') ? 2 : 0
    const c2 = ans.includes('need not be defined') ? 2 : 0
    return reply({ criteria: [
      { id: 'c1', awarded: c1, evidence: c1 ? ['the value the function approaches'] : [], missing: c1 ? [] : ['what a limit is'], feedback: c1 ? 'Correct idea of a limit.' : 'Say what a limit is.' },
      { id: 'c2', awarded: c2, evidence: c2 ? ['need not be defined at the point'] : [], missing: c2 ? [] : ['whether f must be defined at a'], feedback: c2 ? 'Good.' : 'Explain whether the function must be defined at the point.' },
    ], overallFeedback: c2 ? 'Complete answer.' : 'Add whether the function must be defined at the point.', incorrectAssumptions: [], confidence: 0.92 })
  }
  return reply({ segments: [{ text: 'ok', source: 'general' }], assessment: 'not_an_attempt' })
}

let solver: MathSolverProcess
let w: TutorWorld
let assessmentId = ''
let attemptId = ''
const generated: { id: string; stem: string; type: string }[] = []

async function drainWorker() {
  const db = createDatabase(w.h.test.appUrl)
  const sys = createSystemDatabase(w.h.test.systemUrl)
  await createWorker({ system: sys, db, handlers: w.h.app.platform.jobs }).drain()
  await db.close(); await sys.close()
}

before(async () => {
  if (skip) return
  solver = await startMathSolver({ workers: 1 })
  w = await setupTutorWorld({ respond, embed: hashingEmbed }, { math: solver.client(), documents: true })
  const policy = { processingLocation: 'IN', selfHosted: true, retentionDays: 0, zeroRetention: true, trainsOnData: false, dpaInPlace: true, termsVerified: true }
  const conn = await w.h.call('POST', '/api/admin/ai/connections', w.admin, { adapter: 'fake', name: 'm2', baseUrl: 'http://127.0.0.1:9', allowPrivateNetwork: true, dataPolicy: policy })
  await w.h.call('POST', '/api/admin/ai/models/approve', w.admin, { adapter: 'fake', modelId: 'emb', declared: { operations: ['embed'], embeddingDimensions: [256] } })
  await w.h.call('POST', '/api/admin/ai/models/approve', w.admin, { adapter: 'fake', modelId: 'assessor', declared: { operations: ['generate', 'stream'], structuredOutput: 'json_mode', contextWindow: 32000 } })
  const emb = await w.h.call('POST', '/api/admin/ai/deployments', w.admin, { connectionId: conn.json.id, modelId: 'emb' })
  const as = await w.h.call('POST', '/api/admin/ai/deployments', w.admin, { connectionId: conn.json.id, modelId: 'assessor' })
  assert.equal((await w.h.call('PUT', '/api/admin/ai/routes', w.admin, { target: 'category:embeddings', candidates: [{ deploymentId: emb.json.id }] })).status, 200)
  assert.equal((await w.h.call('PUT', '/api/admin/ai/routes', w.admin, { target: 'category:assessment', candidates: [{ deploymentId: as.json.id }] })).status, 200)
  const up = await fetch(`${w.h.url}${T}/courses/${w.courseId}/materials?filename=limits.txt`, { method: 'POST', headers: { authorization: `Bearer ${w.prof}`, 'content-type': 'text/plain' },
    body: 'Limits. The limit of a function as x approaches a is the value the function approaches as x gets close to a. The function need not be defined at the point a, and the limit need not equal f(a). For a polynomial, evaluate the limit by substitution: f(x) = 3x + 6 approaches 3 times 4 plus 6 as x approaches 4.' })
  assert.equal(up.status, 200, await up.text())
  await drainWorker()
})
after(async () => { await w?.close(); await solver?.stop() })

test('generation: grounded, validated questions become drafts; bad ones are rejected with reasons', { skip }, async () => {
  assert.equal((await w.h.call('POST', `${T}/courses/${w.courseId}/items/generate`, w.stu, { conceptId: w.cLimits, count: 4 })).status, 403, 'students cannot generate')
  const r = await w.h.call('POST', `${T}/courses/${w.courseId}/items/generate`, w.prof, { conceptId: w.cLimits, count: 4, types: ['mcq', 'numeric', 'descriptive'] })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  generated.push(...r.json.accepted)
  assert.deepEqual(generated.map((g) => g.type).sort(), ['descriptive', 'mcq', 'numeric'])
  const reasons = r.json.rejected.map((x: { reasons: string[] }) => x.reasons.join(' ')).join(' | ')
  assert.match(reasons, /maths check/, 'wrong numeric key rejected by the maths service')
  assert.match(reasons, /does not cite any of the retrieved course material/, 'ungrounded question rejected')
  const list = (await w.h.call('GET', `${T}/courses/${w.courseId}/items?status=draft`, w.prof)).json
  assert.equal(list.length, 3)
  assert.ok(list.every((i: { origin: string; sourceRefs: { filename: string }[]; validation: { checks: string[] } }) => i.origin === 'ai_generated' && i.sourceRefs[0]?.filename === 'limits.txt' && i.validation.checks.length >= 3))
  assert.ok(list.find((i: { type: string; validation: { checks: string[] } }) => i.type === 'numeric').validation.checks.some((c: string) => /maths engine/.test(c)))
  // drafts are never served to students
  const next = await w.h.call('GET', `${T}/courses/${w.courseId}/practice/next?conceptId=${w.cLimits}`, w.stu)
  assert.ok(!generated.some((g) => g.id === next.json.item?.id))
})

test('educator approves drafts and publishes an assessment; validation rejects bad configuration', { skip }, async () => {
  for (const g of generated) assert.equal((await w.h.call('POST', `${T}/items/${g.id}/approve`, w.prof)).status, 204)
  assert.equal((await w.h.call('POST', `${T}/items/${generated[0]!.id}/approve`, w.stu)).status, 403)
  assert.equal((await w.h.call('POST', `${T}/courses/${w.courseId}/assessments`, w.prof, { title: 'Bad', sections: [{ conceptIds: [w.cLimits], count: 0 }] })).status, 400)
  const r = await w.h.call('POST', `${T}/courses/${w.courseId}/assessments`, w.prof, { title: 'Limits check', mode: 'exam', timeLimitMinutes: 30, maxAttempts: 2, adaptive: true, publish: true,
    sections: [{ title: 'Limits', conceptIds: [w.cLimits], count: 4, types: ['mcq', 'numeric', 'descriptive'] }] })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assessmentId = r.json.id
  const seen = (await w.h.call('GET', `${T}/courses/${w.courseId}/assessments`, w.stu)).json
  assert.equal(seen.length, 1)
  assert.ok(!('conceptIds' in seen[0].sections[0]), 'students see section titles and counts only')
})

test('student attempt: evidence-based assembly, no answer keys before submission, isolation, autosave', { skip }, async () => {
  const r = await w.h.call('POST', `${T}/assessments/${assessmentId}/attempts`, w.stu)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  attemptId = r.json.id
  assert.equal(r.json.questions.length, 4)
  assert.ok(r.json.deadlineAt)
  const raw = JSON.stringify(r.json)
  for (const leak of ['modelAnswer', 'rubric', 'keyPoints', '"correct"', 'explanation', 'answerExpr', 'need not be defined at the point']) assert.ok(!raw.includes(leak), `leaked ${leak}`)
  assert.equal((await w.h.call('POST', `${T}/assessments/${assessmentId}/attempts`, w.stu)).json.id, attemptId, 'starting again resumes the open attempt')
  assert.equal((await w.h.call('GET', `${T}/assessment-attempts/${attemptId}`, w.stu2)).status, 404, 'another student cannot see it')
  assert.equal((await w.h.call('POST', `${T}/assessments/${assessmentId}/attempts`, w.prof)).status, 403, 'educators do not take assessments')
  const q = (type: string, pred = (_s: string) => true) => r.json.questions.find((x: { type: string; stem: string }) => x.type === type && pred(x.stem))
  const save = (itemId: string, response: unknown, confidence?: string) => w.h.call('PUT', `${T}/assessment-attempts/${attemptId}/responses`, w.stu, { itemId, response, confidence })
  const mcq = q('mcq')
  assert.equal((await save(mcq.itemId, 'The value the function approaches as x gets close to a', 'sure')).status, 200)
  assert.equal((await save(q('numeric', (s) => /3x \+ 6/.test(s)).itemId, '15', 'sure')).status, 200) // wrong
  assert.equal((await save(q('numeric', (s) => /x->2/.test(s)).itemId, '42', 'unsure')).status, 200)
  assert.equal((await save(q('descriptive').itemId, 'A limit is the value the function approaches as x gets close to the point.')).status, 200) // partial: misses c2
  assert.equal((await save('00000000-0000-4000-8000-000000000000', 'x')).status, 404, 'cannot answer a question outside the attempt')
  const resumed = await w.h.call('GET', `${T}/assessment-attempts/${attemptId}`, w.stu)
  assert.equal(resumed.json.drafts[mcq.itemId].confidence, 'sure', 'autosaved answers survive a reload')
})

test('submission is one-shot; marking is deterministic or validated; feedback, evidence and FSRS cards follow', { skip }, async () => {
  const [a, b] = await Promise.all([w.h.call('POST', `${T}/assessment-attempts/${attemptId}/submit`, w.stu), w.h.call('POST', `${T}/assessment-attempts/${attemptId}/submit`, w.stu)])
  assert.equal(a.status, 200, JSON.stringify(a.json)); assert.equal(b.status, 200)
  const res = a.json.results ? a.json : b.json
  assert.equal(res.status, 'graded')
  const n = await w.owner.query('select count(*) from education_tutor.assessment_responses where attempt_id = $1', [attemptId])
  assert.equal(Number(n.rows[0].count), 4, 'concurrent submits graded once')
  const by = (t: string, p = (_s: string) => true) => res.results.find((x: { type: string; stem: string }) => x.type === t && p(x.stem))
  assert.equal(by('mcq').points, 1)
  assert.equal(by('numeric', (s: string) => /3x \+ 6/.test(s)).points, 0)
  const desc = by('descriptive')
  assert.deepEqual([desc.points, desc.needsReview], [2, false], 'partial marks: c1 only')
  assert.deepEqual(desc.criteria.map((c: { awarded: number }) => c.awarded), [2, 0])
  assert.match(desc.criteria[1].feedback, /must be defined/)
  assert.ok(desc.correctAnswer && desc.explanation, 'answers and explanations are shown after submission')
  assert.equal(res.score, 4); assert.equal(res.maxScore, 7)
  assert.equal(res.summary.confidentWrong, 1)
  const ev = await w.owner.query(`select kind, outcome from education_tutor.evidence where source_ref like $1 order by outcome`, [`assessment:${attemptId}:%`])
  assert.equal(ev.rows.length, 4)
  assert.ok(ev.rows.every((x) => x.kind === 'diagnostic'))
  const cards = await w.owner.query(`select front from education_tutor.cards where source_ref like 'item:%'`)
  assert.equal(cards.rows.length, 2, 'missed questions (numeric 0/1, descriptive 2/4) became revision cards')
  const wrong = by('numeric', (s: string) => /3x \+ 6/.test(s))
  assert.ok(wrong.attemptId, 'objective mistakes link to the diagnosis flow')
  const coach = await w.h.call('GET', `${T}/courses/${w.courseId}/coach`, w.stu)
  const limits = coach.json.profile.find((p: { conceptId: string }) => p.conceptId === w.cLimits)
  assert.ok(limits.mastery.evidenceCount >= 4)
  assert.equal(limits.calibration.sureWrong, 1)
})

test('ambiguous marking goes to educator review: no evidence until resolved; audited override settles it', { skip }, async () => {
  const st = await w.h.call('POST', `${T}/assessments/${assessmentId}/attempts`, w.stu2)
  const id = st.json.id
  const desc = st.json.questions.find((x: { type: string }) => x.type === 'descriptive')
  await w.h.call('PUT', `${T}/assessment-attempts/${id}/responses`, w.stu2, { itemId: desc.itemId, response: 'This is a borderline idea: the value it approaches maybe.' })
  const sub = await w.h.call('POST', `${T}/assessment-attempts/${id}/submit`, w.stu2)
  assert.equal(sub.json.status, 'needs_review')
  const d = sub.json.results.find((x: { type: string }) => x.type === 'descriptive')
  assert.equal(d.needsReview, true)
  assert.match(d.reviewNote, /educator will confirm/)
  const before = await w.owner.query(`select count(*) from education_tutor.evidence where source_ref = $1`, [`assessment:${id}:${desc.itemId}`])
  assert.equal(Number(before.rows[0].count), 0, 'no evidence from an unsettled mark')
  const queue = (await w.h.call('GET', `${T}/assessments/${assessmentId}/review`, w.prof)).json
  const item = queue.find((x: { attemptId: string }) => x.attemptId === id)
  assert.match(item.reason, /disagree|confidence/)
  assert.ok(item.rubric && item.modelAnswer, 'educators see the rubric and model answer')
  assert.equal((await w.h.call('GET', `${T}/assessments/${assessmentId}/review`, w.stu2)).status, 403)
  const ov = (body: object, tok = w.prof) => w.h.call('POST', `${T}/assessment-responses/${item.responseId}/override`, tok, body)
  const crit = (c1: number, c2: number) => [{ id: 'c1', awarded: c1 }, { id: 'c2', awarded: c2 }]
  assert.equal((await ov({ criteria: crit(1.5, 0) })).status, 400, 'a reason is required')
  assert.equal((await ov({ criteria: crit(3, 0), reason: 'too many for c1' })).status, 400)
  assert.equal((await ov({ points: 3, reason: 'total only, changed' })).status, 400, 'changing a written mark needs criterion marks')
  assert.equal((await ov({ criteria: crit(1, 1), reason: 'nice try' }, w.stu2)).status, 403)
  const ok = await ov({ criteria: crit(1.5, 0), reason: 'Gets the idea of approaching but not the definedness point.' })
  assert.equal(ok.status, 200, JSON.stringify(ok.json))
  const after = await w.owner.query(`select outcome from education_tutor.evidence where source_ref = $1`, [`assessment:${id}:${desc.itemId}`])
  assert.deepEqual(after.rows.map((x) => Number(x.outcome)), [0.375], 'evidence recorded once, from the educator mark')
  const audit = await w.owner.query(`select action from platform.audit_events where target_id = $1`, [item.responseId])
  assert.ok(audit.rows.some((x) => /mark_overridden/.test(x.action)))
  const view = await w.h.call('GET', `${T}/assessment-attempts/${id}`, w.stu2)
  assert.equal(view.json.status, 'graded')
  assert.equal(view.json.results.find((x: { type: string }) => x.type === 'descriptive').overridden, true)
  // a second override corrects the same single evidence row and keeps the full history
  const again = await ov({ criteria: crit(1, 0), reason: 'On reflection only partial credit for c1.' })
  assert.equal(again.status, 200)
  assert.equal(again.json.overrides, 2)
  const ev2 = await w.owner.query(`select outcome from education_tutor.evidence where source_ref = $1`, [`assessment:${id}:${desc.itemId}`])
  assert.deepEqual(ev2.rows.map((x) => Number(x.outcome)), [0.25])
  const g = (await w.owner.query(`select grading from education_tutor.assessment_responses where id = $1`, [item.responseId])).rows[0].grading
  assert.equal(g.history.length, 2)
  assert.deepEqual(g.criteria.map((c: { awarded: number }) => c.awarded), [1, 0], 'breakdown matches the total')
  assert.equal(g.original.points, item.points, 'the original AI marking is preserved')
})

test('overriding an already-settled AI mark corrects the existing evidence instead of adding a contradictory record', { skip }, async () => {
  const all = (await w.h.call('GET', `${T}/assessments/${assessmentId}/review?all=true`, w.prof)).json
  const settled = all.find((x: { attemptId: string; needsReview: boolean }) => x.attemptId === attemptId && !x.needsReview)
  assert.ok(settled, 'settled AI-marked answers are listed for checking')
  const ref = (await w.owner.query(`select item_id from education_tutor.assessment_responses where id = $1`, [settled.responseId])).rows[0].item_id
  const ok = await w.h.call('POST', `${T}/assessment-responses/${settled.responseId}/override`, w.prof, { criteria: [{ id: 'c1', awarded: 2 }, { id: 'c2', awarded: 2 }], reason: 'The second criterion is met implicitly by the example.' })
  assert.equal(ok.status, 200, JSON.stringify(ok.json))
  const ev = await w.owner.query(`select outcome from education_tutor.evidence where source_ref = $1`, [`assessment:${attemptId}:${ref}`])
  assert.deepEqual(ev.rows.map((x) => Number(x.outcome)), [1], 'one evidence row, now matching the educator mark')
  const att = await w.owner.query(`select a.outcome from education_tutor.attempts a join education_tutor.assessment_responses r on r.item_attempt_id = a.id where r.id = $1`, [settled.responseId])
  assert.equal(Number(att.rows[0].outcome), 1, 'attempt history follows the final mark')
  assert.equal((await w.h.call('GET', `${T}/assessment-attempts/${attemptId}`, w.stu)).json.score, 6, 'attempt score recomputed (4 + 1 + 1 + 0)')
})

test('educator analytics: attempts, item facility, weaknesses; students and other courses are refused', { skip }, async () => {
  const r = await w.h.call('GET', `${T}/assessments/${assessmentId}/results`, w.prof)
  assert.equal(r.status, 200)
  assert.equal(r.json.attempts.length, 2)
  assert.ok(r.json.items.some((i: { facility: number | null }) => i.facility === 0))
  assert.equal((await w.h.call('GET', `${T}/assessments/${assessmentId}/results`, w.stu)).status, 403)
})

test('time limits: an expired attempt is auto-submitted with its saved answers; no saves after time', { skip }, async () => {
  await w.owner.query(`update education_tutor.assessments set max_attempts = null where id = $1`, [assessmentId])
  const st = await w.h.call('POST', `${T}/assessments/${assessmentId}/attempts`, w.stu)
  const id = st.json.id
  const mcq = st.json.questions.find((x: { type: string }) => x.type === 'mcq')
  await w.h.call('PUT', `${T}/assessment-attempts/${id}/responses`, w.stu, { itemId: mcq.itemId, response: 'Always the value of f at a' })
  await w.owner.query(`update education_tutor.assessment_attempts set deadline_at = now() - interval '5 minutes' where id = $1`, [id])
  assert.equal((await w.h.call('PUT', `${T}/assessment-attempts/${id}/responses`, w.stu, { itemId: mcq.itemId, response: 'x' })).status, 409)
  const v = await w.h.call('GET', `${T}/assessment-attempts/${id}`, w.stu)
  assert.equal(v.json.status, 'graded')
  assert.equal(v.json.results.find((x: { type: string }) => x.type === 'mcq').points, 0)
})
