/** Past conversations: list + reopen a session transcript; strictly owner-only, enrolment-checked. */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupTutorWorld, type TutorWorld } from './tutor-setup.ts'

const usage = { inputTokens: 5, outputTokens: 5, cachedInputTokens: null, reasoningTokens: null }
const fake = { respond: () => ({ text: JSON.stringify({ segments: [{ text: 'What happens to x+40 as x gets close to 2?', source: 'general' }], assessment: 'not_an_attempt' }), toolCalls: [], finish: 'stop' as const, usage }) }
let w: TutorWorld
const T = '/api/m/education.tutor'
let older: string, newer: string

before(async () => {
  w = await setupTutorWorld(fake)
  older = (await w.h.call('POST', `${T}/sessions`, w.stu, { courseId: w.courseId, conceptId: w.cLimits, problem: 'Find lim x->2 of (x+40)' })).json.id
  newer = (await w.h.call('POST', `${T}/sessions`, w.stu, { courseId: w.courseId, language: 'hinglish' })).json.id
  assert.equal((await w.h.call('POST', `${T}/sessions/${older}/turns`, w.stu, { message: 'I think I plug in 2?' })).status, 200)
  assert.equal((await w.h.call('POST', `${T}/sessions/${older}/turns`, w.stu, { message: 'so it is 42', stuck: true })).status, 200)
})
after(() => w.close())

test('a student lists their sessions, most recently active first, with concept and turn counts', async () => {
  const r = await w.h.call('GET', `${T}/courses/${w.courseId}/sessions`, w.stu)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual(r.json.map((s: { id: string }) => s.id), [older, newer])
  assert.equal(r.json[0].conceptName, 'Limits')
  assert.equal(r.json[0].turns, 4)
  assert.equal(r.json[1].turns, 0)
  assert.equal(r.json[1].language, 'hinglish')
})

test('reopening a session returns the decrypted transcript in order, with tutor moves and segments', async () => {
  const r = await w.h.call('GET', `${T}/sessions/${older}`, w.stu)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.problem, 'Find lim x->2 of (x+40)')
  assert.deepEqual(r.json.turns.map((t: { role: string }) => t.role), ['student', 'tutor', 'student', 'tutor'])
  assert.equal(r.json.turns[0].content, 'I think I plug in 2?')
  assert.equal(r.json.turns[1].segments[0].source, 'general')
  assert.ok(r.json.turns[1].move)
  assert.equal(r.json.turns[0].segments, null)
  const stored = await w.owner.query('select count(*) from education_tutor.turns where session_id = $1 and content is not null', [older])
  assert.equal(Number(stored.rows[0].count), 0, 'transcripts stay encrypted at rest')
})

test('the conversation continues after reopening', async () => {
  assert.equal((await w.h.call('POST', `${T}/sessions/${older}/turns`, w.stu, { message: 'is it 42?' })).status, 200)
  assert.equal((await w.h.call('GET', `${T}/sessions/${older}`, w.stu)).json.turns.length, 6)
})

test('other students, educators and other institutions cannot see a session', async () => {
  assert.equal((await w.h.call('GET', `${T}/sessions/${older}`, w.stu2)).status, 404)
  assert.deepEqual((await w.h.call('GET', `${T}/courses/${w.courseId}/sessions`, w.stu2)).json, [])
  assert.equal((await w.h.call('GET', `${T}/sessions/${older}`, w.prof)).status, 404)
  assert.ok([403, 404].includes((await w.h.call('GET', `${T}/sessions/${older}`, w.admin)).status))
  assert.equal((await w.h.call('GET', `${T}/sessions/not-a-uuid`, w.stu)).status, 400)
})

test('a student removed from the course can no longer reopen its sessions', async () => {
  await w.owner.query(`delete from education_tutor.enrolments where course_id = $1 and user_id = (select user_id from education_tutor.sessions where id = $2)`, [w.courseId, older])
  assert.equal((await w.h.call('GET', `${T}/sessions/${older}`, w.stu)).status, 404)
  assert.equal((await w.h.call('GET', `${T}/courses/${w.courseId}/sessions`, w.stu)).status, 404)
})
