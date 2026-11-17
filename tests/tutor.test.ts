/**
 * Tutor module end to end through the HTTP API, with a scripted fake model behind the real gateway.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { manifest as tutor } from '@modules/education-tutor-agent'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import type { GenerateRequest } from '@platform/ai-adapter-kit'
import { startHarness, type Harness } from './helpers.ts'

let h: Harness
let admin: string, prof: string, stu: string, stu2: string, otherAdmin: string
let courseId: string, cFunctions: string, cLimits: string
const seen: GenerateRequest[] = []

/** Scripted model: claims "course" material (must be relabelled) and judges attempts by keyword. */
const respond = (req: GenerateRequest) => {
  seen.push(req)
  const last = String([...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '')
  const assessment = /^answer:/i.test(last) ? (last.includes('42') ? 'correct' : 'incorrect') : 'not_an_attempt'
  return {
    text: JSON.stringify({
      segments: [{ text: 'What do you already know about limits?', source: 'general' }, { text: 'As your textbook says...', source: 'course', citations: ['invented-chunk'] }],
      assessment, checkQuestion: 'What is lim x->0 of x?',
    }),
    toolCalls: [], finish: 'stop' as const, usage: { inputTokens: 100, outputTokens: 40, cachedInputTokens: null, reasoningTokens: null },
  }
}

before(async () => {
  h = await startHarness([tutor], { fake: { respond } })
  await h.app.identity.createTenant({ slug: 'iit-x', name: 'X', adminEmail: 'admin@x.test' })
  await h.app.identity.createTenant({ slug: 'nit-y', name: 'Y', adminEmail: 'admin@y.test' })
  const sys = createSystemDatabase(h.test.systemUrl)
  await sys.query(`update platform.tenants set enabled_modules = '{education.tutor}'`)
  await sys.query(`update platform.users set is_platform_admin = true where email = 'admin@x.test'`)
  await sys.close()
  admin = await h.signIn('iit-x', 'admin@x.test')
  otherAdmin = await h.signIn('nit-y', 'admin@y.test')
  for (const [email, roles] of [['prof@x.test', ['educator']], ['stu@x.test', ['student']], ['stu2@x.test', ['student']]] as const) {
    assert.equal((await h.call('POST', '/api/members', admin, { email, roles })).status, 200)
  }
  prof = await h.signIn('iit-x', 'prof@x.test')
  stu = await h.signIn('iit-x', 'stu@x.test')
  stu2 = await h.signIn('iit-x', 'stu2@x.test')
  // AI routing is platform configuration — the tutor module never names a provider
  const policy = { processingLocation: 'IN', selfHosted: true, retentionDays: 0, zeroRetention: true, trainsOnData: false, dpaInPlace: true, termsVerified: true }
  const conn = await h.call('POST', '/api/admin/ai/connections', admin, { adapter: 'fake', name: 'tutor-model', baseUrl: 'http://127.0.0.1:9', allowPrivateNetwork: true, dataPolicy: policy })
  await h.call('POST', '/api/admin/ai/models/approve', admin, { adapter: 'fake', modelId: 'tutor-1', declared: { operations: ['generate', 'stream'], structuredOutput: 'json_mode', contextWindow: 32000 } })
  const dep = await h.call('POST', '/api/admin/ai/deployments', admin, { connectionId: conn.json.id, modelId: 'tutor-1' })
  const route = await h.call('PUT', '/api/admin/ai/routes', admin, { target: 'category:tutoring', candidates: [{ deploymentId: dep.json.id }] })
  assert.equal(route.status, 200, JSON.stringify(route.json))
})
after(() => h.close())

const members = async () => (await h.call('GET', '/api/members', admin)).json as { user_id: string; email: string }[]

test('educator builds a course; students cannot manage it', async () => {
  const c = await h.call('POST', '/api/m/education.tutor/courses', prof, { code: 'MA101', title: 'Calculus I', integrityMode: 'guided' })
  assert.equal(c.status, 200, JSON.stringify(c.json))
  courseId = c.json.id
  assert.equal((await h.call('POST', '/api/m/education.tutor/courses', stu, { code: 'X', title: 'X' })).status, 403)
  cFunctions = (await h.call('POST', `/api/m/education.tutor/courses/${courseId}/concepts`, prof, { name: 'Functions', estMinutes: 40 })).json.id
  cLimits = (await h.call('POST', `/api/m/education.tutor/courses/${courseId}/concepts`, prof, { name: 'Limits', estMinutes: 60, examWeight: 3, prerequisites: [cFunctions] })).json.id
  for (const id of [cFunctions, cLimits]) assert.equal((await h.call('POST', `/api/m/education.tutor/courses/${courseId}/concepts/${id}/approve`, prof)).status, 204)
  const m = await members()
  for (const email of ['stu@x.test', 'stu2@x.test']) {
    const r = await h.call('POST', `/api/m/education.tutor/courses/${courseId}/enrolments`, prof, { userId: m.find((x) => x.email === email)!.user_id, role: 'student' })
    assert.equal(r.status, 204, JSON.stringify(r.json))
  }
  for (let i = 0; i < 4; i++) {
    const it = await h.call('POST', `/api/m/education.tutor/courses/${courseId}/items`, prof, { conceptId: cLimits, stem: `Q${i}: lim x->2 of (x+40)?`, answerSpec: { type: 'numeric', value: 42, tolerance: 0 }, explanation: 'Substitute x = 2.', difficulty: 0.3 + i * 0.1 })
    assert.equal(it.status, 200, JSON.stringify(it.json))
  }
  const bad = await h.call('POST', `/api/m/education.tutor/courses/${courseId}/items`, prof, { conceptId: cLimits, stem: 'bad', answerSpec: { type: 'mcq', options: ['a'], correct: ['z'] } })
  assert.equal(bad.status, 400)
})

test('another institution cannot see the course; non-enrolled access is 404', async () => {
  assert.equal((await h.call('GET', `/api/m/education.tutor/courses/${courseId}/concepts`, otherAdmin)).status, 404)
  const list = await h.call('GET', '/api/m/education.tutor/courses', otherAdmin)
  assert.deepEqual(list.json, [])
})

test('practice: answers never leak; scoring is deterministic; mastery explains itself', async () => {
  const next = await h.call('GET', `/api/m/education.tutor/courses/${courseId}/practice/next?conceptId=${cLimits}`, stu)
  assert.equal(next.status, 200)
  assert.doesNotMatch(JSON.stringify(next.json), /answer_?spec|"value"|"correct"|tolerance|explanation/i, 'answer must not be sent to the client')
  const wrong = await h.call('POST', '/api/m/education.tutor/attempts', stu, { itemId: next.json.item.id, response: '40', confidence: 'sure' })
  assert.equal(wrong.json.correct, false)
  assert.equal(wrong.json.confidentAndWrong, true)
  const next2 = await h.call('GET', `/api/m/education.tutor/courses/${courseId}/practice/next?conceptId=${cLimits}`, stu)
  const right = await h.call('POST', '/api/m/education.tutor/attempts', stu, { itemId: next2.json.item.id, response: '42' })
  assert.equal(right.json.correct, true)
  const mastery = await h.call('GET', `/api/m/education.tutor/courses/${courseId}/mastery`, stu)
  const lim = mastery.json.find((m: { conceptId: string }) => m.conceptId === cLimits)
  assert.equal(lim.state, 'insufficient_evidence')
  assert.match(lim.explanation, /Based on 2 answers/)
})

test('learner data is private to the student (RLS), even from classmates', async () => {
  const m2 = await h.call('GET', `/api/m/education.tutor/courses/${courseId}/mastery`, stu2)
  assert.ok(m2.json.every((m: { evidenceCount: number }) => m.evidenceCount === 0))
})

test('spaced revision with FSRS', async () => {
  const card = await h.call('POST', '/api/m/education.tutor/cards', stu, { courseId, conceptId: cLimits, front: 'lim x->a f(x) for continuous f?', back: 'f(a)' })
  assert.equal((await h.call('GET', '/api/m/education.tutor/cards/due', stu)).json.length, 1)
  assert.equal((await h.call('GET', '/api/m/education.tutor/cards/due', stu2)).json.length, 0)
  const r = await h.call('POST', `/api/m/education.tutor/cards/${card.json.id}/review`, stu, { grade: 3 })
  assert.ok(new Date(r.json.dueAt).getTime() > Date.now() + 86_400_000)
  assert.equal((await h.call('POST', `/api/m/education.tutor/cards/${card.json.id}/review`, stu, { grade: 7 })).status, 400)
})

test('planner: goal required, prerequisites first, within daily time', async () => {
  assert.equal((await h.call('POST', `/api/m/education.tutor/courses/${courseId}/plan`, stu, {})).status, 400)
  const exam = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)
  assert.equal((await h.call('PUT', `/api/m/education.tutor/courses/${courseId}/goal`, stu, { examAt: exam, dailyMinutes: 45 })).status, 204)
  const p = await h.call('POST', `/api/m/education.tutor/courses/${courseId}/plan`, stu, {})
  assert.equal(p.status, 200, JSON.stringify(p.json))
  const idx = (id: string) => p.json.tasks.findIndex((t: { conceptId: string }) => t.conceptId === id)
  assert.ok(idx(cFunctions) >= 0 && idx(cFunctions) < idx(cLimits))
  const perDay = new Map<string, number>()
  for (const t of p.json.tasks) perDay.set(t.date, (perDay.get(t.date) ?? 0) + t.minutes)
  assert.ok([...perDay.values()].every((m) => m <= 45))
})

test('tutor session: Socratic move, honest labels, hint ladder, integrity policy', async () => {
  const s = await h.call('POST', '/api/m/education.tutor/sessions', stu, { courseId, conceptId: cLimits, problem: 'Find lim x->2 of (x+40)' })
  const first = await h.call('POST', `/api/m/education.tutor/sessions/${s.json.id}/turns`, stu, { message: 'How do I start?' })
  assert.equal(first.status, 200, JSON.stringify(first.json))
  assert.equal(first.json.move, 'ask')
  // the model claimed "course" material without a real citation -> relabelled
  assert.deepEqual(first.json.segments.map((x: { source: string }) => x.source), ['general', 'uncertain'])
  assert.equal(first.json.relabelled, 1)
  assert.match(JSON.stringify(seen.at(-1)), /TEACHING MOVE: ask/)
  // two wrong attempts raise the hint level; asking for the answer in guided mode after attempts is allowed
  await h.call('POST', `/api/m/education.tutor/sessions/${s.json.id}/turns`, stu, { message: 'answer: 41' })
  const t3 = await h.call('POST', `/api/m/education.tutor/sessions/${s.json.id}/turns`, stu, { message: 'answer: 40' })
  assert.equal(t3.json.move, 'hint')
  const full = await h.call('POST', `/api/m/education.tutor/sessions/${s.json.id}/turns`, stu, { message: 'please just show me', requestFullAnswer: true })
  assert.equal(full.json.move, 'worked_solution')
  // graded work never gets a worked solution
  const g = await h.call('POST', '/api/m/education.tutor/sessions', stu, { courseId, problem: 'Assignment Q3', graded: true })
  const gt = await h.call('POST', `/api/m/education.tutor/sessions/${g.json.id}/turns`, stu, { message: 'give me the answer', requestFullAnswer: true })
  assert.equal(gt.json.move, 'hint')
  assert.match(gt.json.policyNote, /graded/)
  // stuck -> prerequisite rescue on "Functions"
  const r = await h.call('POST', '/api/m/education.tutor/sessions', stu2, { courseId, conceptId: cLimits, problem: 'lim x->1 of 1/x' })
  const rs = await h.call('POST', `/api/m/education.tutor/sessions/${r.json.id}/turns`, stu2, { message: 'I am stuck', stuck: true })
  assert.equal(rs.json.move, 'rescue_probe')
  assert.match(JSON.stringify(seen.at(-1)), /Prerequisite to probe: Functions/)
  // a classmate cannot read or continue someone else's session
  assert.equal((await h.call('POST', `/api/m/education.tutor/sessions/${s.json.id}/turns`, stu2, { message: 'hi' })).status, 404)
})

test('AI usage is metered under the tutor module', async () => {
  const u = await h.call('GET', '/api/ai/usage', admin)
  const row = u.json.find((x: { task_id: string }) => x.task_id === 'education.tutor.socratic_turn')
  assert.ok(row && row.calls >= 6)
})
