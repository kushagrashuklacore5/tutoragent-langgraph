/**
 * Tutor: streaming turns (SSE) and encryption at rest of conversation content.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { createWorker } from '@platform/jobs'
import type { GenerateRequest } from '@platform/ai-adapter-kit'
import { setupTutorWorld, postSse, type TutorWorld } from './tutor-setup.ts'

let w: TutorWorld
const seen: GenerateRequest[] = []
let gate: Promise<void> | null = null

const respond = async (req: GenerateRequest) => {
  seen.push(req)
  const last = String([...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '')
  if (/slow/.test(last) && gate) await gate
  const usage = { inputTokens: 100, outputTokens: 40, cachedInputTokens: null, reasoningTokens: null }
  if (/broken/.test(last)) return { text: '{"segments": [{"text": "half', toolCalls: [], finish: 'stop' as const, usage }
  const assessment = /^answer:/i.test(last) ? (last.includes('42') ? 'correct' : 'incorrect') : 'not_an_attempt'
  return {
    text: JSON.stringify({
      segments: [{ text: 'Think about \"substitution\" — what happens at x = 2?', source: 'general' }, { text: 'As your textbook says, limits are easy.', source: 'course', citations: ['invented-chunk'] }],
      assessment, checkQuestion: 'What is lim x->0 of x?',
    }),
    toolCalls: [], finish: 'stop' as const, usage,
  }
}

before(async () => { w = await setupTutorWorld({ respond }) })
after(() => w.close())

const session = async (token: string, extra: Record<string, unknown> = {}) =>
  (await w.h.call('POST', '/api/m/education.tutor/sessions', token, { courseId: w.courseId, conceptId: w.cLimits, problem: 'Find lim x->2 of (x+40)', ...extra })).json.id as string
const turnsOf = async (sessionId: string) => (await w.owner.query('select * from education_tutor.turns where session_id = $1 order by created_at', [sessionId])).rows
const stateOf = async (sessionId: string) => (await w.owner.query('select state from education_tutor.sessions where id = $1', [sessionId])).rows[0].state

test('SSE turn: start, partial text progress, one authoritative verified turn event (same shape as JSON route)', async () => {
  const s = await session(w.stu)
  const r = await postSse(w.h, `/api/m/education.tutor/sessions/${s}/turns/stream`, w.stu, { message: 'How do I start?' })
  assert.equal(r.status, 200)
  const types = r.events.map((e) => e.data.type)
  assert.equal(types[0], 'start')
  assert.equal(types.at(-1), 'turn')
  assert.equal(types.filter((t) => t === 'turn').length, 1)
  assert.ok(types.filter((t) => t === 'progress').length > 3, 'text arrives incrementally')
  // progress carries text only — never source labels — and reassembles to the final segment text
  const progress = r.events.filter((e) => e.data.type === 'progress').map((e) => e.data)
  assert.ok(progress.every((p) => !('source' in p)))
  const rebuilt = [0, 1].map((i) => progress.filter((p) => p.index === i).map((p) => p.delta).join(''))
  const turn = r.events.at(-1)!.data
  assert.deepEqual(rebuilt, turn.segments.map((x: { text: string }) => x.text))
  assert.equal(rebuilt[0], 'Think about "substitution" — what happens at x = 2?')
  // honest labelling verified before the content is final: the uncited "course" claim is relabelled
  assert.deepEqual(turn.segments.map((x: { source: string }) => x.source), ['general', 'uncertain'])
  assert.equal(turn.relabelled, 1)
  assert.equal(turn.move, 'ask')
  const json = await w.h.call('POST', `/api/m/education.tutor/sessions/${s}/turns`, w.stu, { message: 'answer: 41' })
  const { type: _t, ...streamed } = turn
  assert.deepEqual(Object.keys(streamed).sort(), Object.keys(json.json).sort())
  // persisted exactly like the JSON route: 2 turns per exchange, state advanced, evidence recorded
  assert.equal((await turnsOf(s)).length, 4)
  assert.equal((await stateOf(s)).attemptsAtStep, 1)
})

test('streamed turns update hint ladder and integrity policy like the JSON route (graded never gets a worked solution)', async () => {
  const g = await session(w.stu, { graded: true, problem: 'Assignment Q3' })
  const r = await postSse(w.h, `/api/m/education.tutor/sessions/${g}/turns/stream`, w.stu, { message: 'give me the answer', requestFullAnswer: true })
  const turn = r.events.at(-1)!.data
  assert.equal(r.events[0]!.data.move, 'hint')
  assert.equal(turn.move, 'hint')
  assert.match(turn.policyNote, /graded/)
  assert.doesNotMatch(JSON.stringify(seen.at(-1)), /TEACHING MOVE: worked_solution/)
})

test('errors before the stream are HTTP errors; model failure mid-stream emits an error event and persists nothing', async () => {
  const s = await session(w.stu)
  assert.equal((await postSse(w.h, `/api/m/education.tutor/sessions/${s}/turns/stream`, w.stu2, { message: 'hi' })).status, 404)
  assert.equal((await postSse(w.h, `/api/m/education.tutor/sessions/${s}/turns/stream`, w.stu, { message: '' })).status, 400)
  const before = await stateOf(s)
  const r = await postSse(w.h, `/api/m/education.tutor/sessions/${s}/turns/stream`, w.stu, { message: 'broken please' })
  assert.equal(r.status, 200)
  assert.equal(r.events.at(-1)!.event, 'error')
  assert.ok(!r.events.some((e) => e.data.type === 'turn'))
  assert.equal((await turnsOf(s)).length, 0)
  assert.deepEqual(await stateOf(s), before)
})

test('client disconnect mid-stream: nothing persisted, session state unchanged, session still usable', async () => {
  const s = await session(w.stu)
  const before = await stateOf(s)
  let release!: () => void
  gate = new Promise<void>((r) => { release = r })
  const ac = new AbortController()
  const res = await fetch(`${w.h.url}/api/m/education.tutor/sessions/${s}/turns/stream`, {
    method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${w.stu}` }, body: JSON.stringify({ message: 'slow answer: 42' }),
  })
  const reader = res.body!.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  assert.match(first, /"type":"start"/)
  ac.abort()
  await reader.cancel().catch(() => undefined)
  await new Promise((r) => setTimeout(r, 50))
  release()
  gate = null
  await new Promise((r) => setTimeout(r, 300))
  assert.equal((await turnsOf(s)).length, 0)
  assert.deepEqual(await stateOf(s), before)
  const ok = await postSse(w.h, `/api/m/education.tutor/sessions/${s}/turns/stream`, w.stu, { message: 'answer: 42' })
  assert.equal(ok.events.at(-1)!.data.assessment, 'correct')
  assert.equal((await turnsOf(s)).length, 2)
})

test('encryption at rest: the database never holds plaintext of new turns; history still works', async () => {
  const s = await session(w.stu2)
  const secret = 'my-private-attempt-7731 answer: 41'
  await w.h.call('POST', `/api/m/education.tutor/sessions/${s}/turns`, w.stu2, { message: secret })
  await postSse(w.h, `/api/m/education.tutor/sessions/${s}/turns/stream`, w.stu2, { message: 'second message zebra-4410' })
  const rows = await turnsOf(s)
  assert.equal(rows.length, 4)
  for (const r of rows) {
    assert.equal(r.content, null)
    assert.equal(r.segments, null)
    assert.match(r.content_enc, /^fc1\.\d+\./)
    if (r.role === 'tutor') assert.match(r.segments_enc, /^fc1\./)
  }
  const dump = JSON.stringify((await w.owner.query('select * from education_tutor.turns')).rows)
  for (const needle of ['my-private-attempt-7731', 'zebra-4410', 'substitution', 'textbook']) assert.ok(!dump.includes(needle), `plaintext "${needle}" found in turns`)
  // the model still receives decrypted history
  const ctx = JSON.stringify(seen.at(-1)!.messages)
  assert.ok(ctx.includes('my-private-attempt-7731'))
  assert.ok(ctx.includes('substitution'))
  // ciphertext moved to another row does not decrypt (AAD binds record id): the turn route fails closed
  await w.owner.query(`update education_tutor.turns set content_enc = (select content_enc from education_tutor.turns where session_id = $1 order by created_at limit 1)
    where id = (select id from education_tutor.turns where session_id = $1 order by created_at offset 1 limit 1)`, [s])
  assert.equal((await w.h.call('POST', `/api/m/education.tutor/sessions/${s}/turns`, w.stu2, { message: 'hello' })).status, 500)
})

test('legacy plaintext turns (pre-encryption) stay readable and are encrypted by the backfill job', async () => {
  const s = await session(w.stu)
  const r = await w.owner.query('select tenant_id, user_id from education_tutor.sessions where id = $1', [s])
  const { tenant_id, user_id } = r.rows[0]
  await w.owner.query(`insert into education_tutor.turns (tenant_id, user_id, session_id, role, content, created_at) values ($1, $2, $3, 'student', 'legacy-question-5150', now() - interval '1 hour')`, [tenant_id, user_id, s])
  await w.owner.query(`insert into education_tutor.turns (tenant_id, user_id, session_id, role, content, segments, created_at) values ($1, $2, $3, 'tutor', 'legacy-reply-5151', '[{"text":"legacy-reply-5151","source":"general","citations":[]}]', now() - interval '59 minutes')`, [tenant_id, user_id, s])
  await w.h.call('POST', `/api/m/education.tutor/sessions/${s}/turns`, w.stu, { message: 'continue' })
  assert.ok(JSON.stringify(seen.at(-1)!.messages).includes('legacy-reply-5151'))
  // backfill: enqueue the per-user job as the fan-out would, run it with a worker
  const db = createDatabase(w.h.test.appUrl, { max: 2 })
  const system = createSystemDatabase(w.h.test.systemUrl, { max: 2 })
  await system.query(`insert into platform.jobs (id, tenant_id, type, payload) values (gen_random_uuid(), $1, 'education.tutor/turns.encrypt_legacy.student', $2)`, [tenant_id, JSON.stringify({ userId: user_id })])
  await createWorker({ system, db, handlers: w.h.app.platform.jobs }).drain()
  const left = await w.owner.query('select count(*)::int as n from education_tutor.turns where content is not null')
  assert.equal(left.rows[0].n, 0)
  assert.ok(!JSON.stringify((await w.owner.query('select * from education_tutor.turns')).rows).includes('legacy-'))
  await w.h.call('POST', `/api/m/education.tutor/sessions/${s}/turns`, w.stu, { message: 'and again' })
  const ctx = JSON.stringify(seen.at(-1)!.messages)
  assert.ok(ctx.includes('legacy-question-5150') && ctx.includes('legacy-reply-5151'))
  await db.close()
  await system.close()
})
