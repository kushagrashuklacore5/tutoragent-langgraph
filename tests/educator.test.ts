/**
 * Educator workflows: learner-progress dashboard and question management, with course-level
 * authorization (an educator of course A sees nothing of course B) and student privacy.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '@platform/tenancy-db'
import { setupTutorWorld, type TutorWorld } from './tutor-setup.ts'

const usage = { inputTokens: 5, outputTokens: 5, cachedInputTokens: null, reasoningTokens: null }
const fake = { respond: () => ({ text: JSON.stringify({ segments: [{ text: 'ok', source: 'general' }], assessment: 'not_an_attempt' }), toolCalls: [], finish: 'stop' as const, usage }) }
const T = '/api/m/education.tutor'
let w: TutorWorld
let prof2: string, otherCourse: string, itemId: string

before(async () => {
  w = await setupTutorWorld(fake)
  assert.equal((await w.h.call('POST', '/api/members', w.admin, { email: 'prof2@x.test', roles: ['educator'] })).status, 200)
  prof2 = await w.h.signIn('iit-x', 'prof2@x.test')
  otherCourse = (await w.h.call('POST', `${T}/courses`, prof2, { code: 'PH9', title: 'Other course' })).json.id
  const list = await w.h.call('GET', `${T}/courses/${w.courseId}/items`, w.prof)
  assert.equal(list.status, 200, JSON.stringify(list.json))
  itemId = list.json[0].id
  // stu: right answer (sure); stu2: confidently wrong twice
  const item2 = (await w.h.call('POST', `${T}/courses/${w.courseId}/items`, w.prof, { conceptId: w.cLimits, stem: 'lim x->3 of 2x?', answerSpec: { type: 'numeric', value: 6, tolerance: 0 } })).json.id
  assert.equal((await w.h.call('POST', `${T}/attempts`, w.stu, { itemId, response: '42', confidence: 'sure' })).status, 200)
  assert.equal((await w.h.call('POST', `${T}/attempts`, w.stu2, { itemId, response: '40', confidence: 'sure' })).status, 200)
  assert.equal((await w.h.call('POST', `${T}/attempts`, w.stu2, { itemId: item2, response: '5', confidence: 'sure' })).status, 200)
  const card = await w.h.call('POST', `${T}/cards`, w.stu, { courseId: w.courseId, conceptId: w.cLimits, front: 'lim?', back: 'substitute' })
  assert.equal(card.status, 200, JSON.stringify(card.json))
})
after(() => w.close())

test('progress dashboard: per-student mastery, practice, revision, flags and concept insights', async () => {
  const r = await w.h.call('GET', `${T}/courses/${w.courseId}/progress`, w.prof)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.students.length, 2)
  const s1 = r.json.students.find((s: { email: string }) => s.email === 'stu@x.test')
  const s2 = r.json.students.find((s: { email: string }) => s.email === 'stu2@x.test')
  assert.deepEqual([s1.practice.attempts, s1.practice.correctRate], [1, 1])
  assert.deepEqual([s2.practice.attempts, s2.practice.correctRate, s2.practice.confidentWrong], [2, 0, 2])
  assert.ok(s2.flags.some((f: string) => /confident wrong/.test(f)))
  assert.equal(s1.revision.cards, 1)
  assert.ok(s1.concepts[w.cLimits].pMastery > s2.concepts[w.cLimits].pMastery)
  const limits = r.json.concepts.find((c: { conceptId: string }) => c.conceptId === w.cLimits)
  assert.equal(limits.practice.attempts, 3)
  assert.equal(limits.practice.confidentWrong, 2)
  assert.ok(!JSON.stringify(r.json).includes('substitute'), 'card contents are not exposed')
})

test('progress is educator-only and course-scoped', async () => {
  assert.equal((await w.h.call('GET', `${T}/courses/${w.courseId}/progress`, w.stu)).status, 403)
  assert.equal((await w.h.call('GET', `${T}/courses/${w.courseId}/progress`, prof2)).status, 404)
  const empty = await w.h.call('GET', `${T}/courses/${otherCourse}/progress`, prof2)
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.json.students, [])
})

test('students still only see their own learning records', async () => {
  const m = (await w.h.call('GET', `${T}/courses/${w.courseId}/mastery`, w.stu)).json.find((c: { conceptId: string }) => c.conceptId === w.cLimits)
  assert.equal(m.evidenceCount, 1)
  assert.equal((await w.h.call('GET', `${T}/cards/due`, w.stu2)).json.length, 0)
})

test('question management: list with answer keys and stats, edit, lock answer after attempts, retire/restore', async () => {
  const list = await w.h.call('GET', `${T}/courses/${w.courseId}/items`, w.prof)
  const it = list.json.find((i: { id: string }) => i.id === itemId)
  assert.equal(it.answerSpec.value, 42)
  assert.deepEqual(it.stats, { attempts: 2, correctRate: 0.5 })
  assert.equal((await w.h.call('PUT', `${T}/items/${itemId}`, w.prof, { stem: 'Evaluate lim x->2 of (x+40)', difficulty: 0.3 })).status, 200)
  const locked = await w.h.call('PUT', `${T}/items/${itemId}`, w.prof, { answerSpec: { type: 'numeric', value: 41, tolerance: 0 } })
  assert.equal(locked.status, 409)
  assert.match(JSON.stringify(locked.json), /answer_locked/)
  assert.equal((await w.h.call('PUT', `${T}/items/${itemId}`, w.prof, { difficulty: 7 })).status, 400)
  const fresh = (await w.h.call('POST', `${T}/courses/${w.courseId}/items`, w.prof, { conceptId: w.cFunctions, stem: 'f(x)=x+1, f(1)?', answerSpec: { type: 'numeric', value: 3, tolerance: 0 } })).json.id
  assert.equal((await w.h.call('PUT', `${T}/items/${fresh}`, w.prof, { answerSpec: { type: 'numeric', value: 2, tolerance: 0 } })).status, 200, 'unanswered items can be corrected')
  assert.equal((await w.h.call('POST', `${T}/items/${itemId}/retire`, w.prof)).status, 204)
  assert.ok(!(await w.h.call('GET', `${T}/courses/${w.courseId}/items`, w.prof)).json.some((i: { id: string }) => i.id === itemId))
  assert.ok((await w.h.call('GET', `${T}/courses/${w.courseId}/items?includeRetired=true`, w.prof)).json.find((i: { id: string }) => i.id === itemId).retired)
  assert.equal((await w.h.call('POST', `${T}/attempts`, w.stu, { itemId, response: '42' })).status, 409)
  const next = await w.h.call('GET', `${T}/courses/${w.courseId}/practice/next?conceptId=${w.cLimits}`, w.stu)
  assert.notEqual(next.json.item?.id, itemId, 'retired items are not served')
  assert.equal((await w.h.call('POST', `${T}/items/${itemId}/restore`, w.prof)).status, 204)
  const stored = await w.owner.query('select count(*) from education_tutor.attempts where item_id = $1', [itemId])
  assert.equal(Number(stored.rows[0].count), 2, 'attempt history survives retirement')
})

test('question management is limited to educators of that course', async () => {
  assert.equal((await w.h.call('GET', `${T}/courses/${w.courseId}/items`, w.stu)).status, 403)
  assert.equal((await w.h.call('GET', `${T}/courses/${w.courseId}/items`, prof2)).status, 404)
  assert.equal((await w.h.call('PUT', `${T}/items/${itemId}`, prof2, { stem: 'hijack' })).status, 404)
  assert.equal((await w.h.call('POST', `${T}/items/${itemId}/retire`, prof2)).status, 404)
  assert.equal((await w.h.call('POST', `${T}/courses/${w.courseId}/items`, prof2, { conceptId: w.cLimits, stem: 'x', answerSpec: { type: 'numeric', value: 1, tolerance: 0 } })).status, 404)
})

test('RLS: an educator of another course reads none of these learners\' records, even with raw SQL', async () => {
  const ids = async (email: string) => (await w.owner.query(`select u.id as uid, m.tenant_id from platform.users u join platform.memberships m on m.user_id = u.id where u.email = $1`, [email])).rows[0] as { uid: string; tenant_id: string }
  const db = createDatabase(w.h.test.appUrl)
  const countAs = async (email: string) => {
    const { uid, tenant_id } = await ids(email)
    return db.withTenant({ tenantId: tenant_id, userId: uid, roles: ['educator'] }, async (t) =>
      Promise.all(['evidence', 'attempts', 'cards'].map(async (tb) => Number((await t.query<{ n: string }>(`select count(*) as n from education_tutor.${tb}`)).rows[0]!.n))))
  }
  try {
    assert.deepEqual(await countAs('prof2@x.test'), [0, 0, 0])
    const own = await countAs('prof@x.test')
    assert.ok(own[0]! > 0 && own[1]! > 0 && own[2]! > 0, `the course's own educator can read them (control): ${own}`)
  } finally { await db.close() }
})

test('concept fields are range-checked (no NaN or absurd weights reach the database)', async () => {
  for (const bad of [{ examWeight: 'abc' }, { examWeight: 0 }, { examWeight: 50 }, { estMinutes: 2 }, { estMinutes: 30.5 }, { estMinutes: 'NaN' }]) {
    const r = await w.h.call('POST', `${T}/courses/${w.courseId}/concepts`, w.prof, { name: 'Bad', ...bad })
    assert.equal(r.status, 400, JSON.stringify(bad))
  }
  assert.equal((await w.h.call('POST', `${T}/courses/${w.courseId}/concepts`, w.prof, { name: 'Fine', examWeight: 2.5, estMinutes: 45 })).status, 200)
})
