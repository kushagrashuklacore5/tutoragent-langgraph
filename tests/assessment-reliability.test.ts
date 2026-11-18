/**
 * Assessment reliability: marking crash recovery (jobs, retries, degraded fallback, sweeper), concurrent graders,
 * partial (mid-commit) failures, provider outages, and cross-institution isolation of every assessment boundary.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { createWorker, enqueueSystem as enqueue } from '@platform/jobs'
import { GatewayError, type GenerateRequest } from '@platform/ai-adapter-kit'
import { setupTutorWorld, type TutorWorld } from './tutor-setup.ts'

const usage = { inputTokens: 10, outputTokens: 10, cachedInputTokens: null, reasoningTokens: null }
const T = '/api/m/education.tutor'
let markingDown = false
let markCalls = 0
function respond(req: GenerateRequest) {
  const sys = req.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n')
  if (/strict, fair examiner/.test(sys)) {
    markCalls++
    if (markingDown) throw new GatewayError('overloaded', 'provider overloaded (503)')
    return { text: JSON.stringify({ criteria: [{ id: 'c1', awarded: 2, evidence: ['the value the function approaches'], missing: [], feedback: 'Good.' }, { id: 'c2', awarded: 0, evidence: [], missing: ['definedness'], feedback: 'Add definedness.' }], overallFeedback: 'Partly there.', confidence: 0.9 }), toolCalls: [], finish: 'stop' as const, usage }
  }
  return { text: JSON.stringify({ segments: [{ text: 'ok', source: 'general' }], assessment: 'not_an_attempt' }), toolCalls: [], finish: 'stop' as const, usage }
}
const RUBRIC = [{ id: 'c1', criterion: 'Limit is the approached value', points: 2, keyPoints: ['approaches'] }, { id: 'c2', criterion: 'Need not be defined', points: 2, keyPoints: ['not defined'] }]
const ANSWER = 'A limit is the value the function approaches near the point.'

let w: TutorWorld
let assessmentId = ''
let descId = '', numId = ''
// institution B
let profB = '', stuB = '', courseB = ''

async function drain() {
  const db = createDatabase(w.h.test.appUrl)
  const sys = createSystemDatabase(w.h.test.systemUrl)
  await createWorker({ system: sys, db, handlers: w.h.app.platform.jobs }).drain()
  await db.close(); await sys.close()
}
/** make every queued job runnable now (the safety-net job is delayed behind inline marking) */
const runJobsNow = () => w.owner.query(`update platform.jobs set run_at = now() where status = 'queued'`)
async function startAndAnswer(token: string) {
  const st = await w.h.call('POST', `${T}/assessments/${assessmentId}/attempts`, token)
  assert.equal(st.status, 200, JSON.stringify(st.json))
  for (const q of st.json.questions) {
    await w.h.call('PUT', `${T}/assessment-attempts/${st.json.id}/responses`, token, { itemId: q.itemId, response: q.type === 'descriptive' ? ANSWER : '42' })
  }
  return st.json.id as string
}
/** what a crash after the submit transaction leaves behind: status 'grading', nothing marked */
async function crashedSubmission(attemptId: string, runs = 1, minutesAgo = 30) {
  await w.owner.query(`update education_tutor.assessment_attempts set status = 'grading', submitted_at = now() - make_interval(mins => $3::int), grading_attempts = $2,
                       grading_started_at = now() - make_interval(mins => $3::int) where id = $1`, [attemptId, runs, minutesAgo])
}
const counts = async (attemptId: string) => {
  const q = async (sql: string) => Number((await w.owner.query(sql, [attemptId])).rows[0].n)
  return {
    responses: await q('select count(*) as n from education_tutor.assessment_responses where attempt_id = $1'),
    evidence: await q(`select count(*) as n from education_tutor.evidence where source_ref like 'assessment:' || $1 || ':%'`),
    itemAttempts: await q(`select count(*) as n from education_tutor.attempts a join education_tutor.assessment_responses r on r.item_attempt_id = a.id where r.attempt_id = $1`),
  }
}

before(async () => {
  w = await setupTutorWorld({ respond })
  const policy = { processingLocation: 'IN', selfHosted: true, retentionDays: 0, zeroRetention: true, trainsOnData: false, dpaInPlace: true, termsVerified: true }
  const conn = await w.h.call('POST', '/api/admin/ai/connections', w.admin, { adapter: 'fake', name: 'as', baseUrl: 'http://127.0.0.1:9', allowPrivateNetwork: true, dataPolicy: policy })
  await w.h.call('POST', '/api/admin/ai/models/approve', w.admin, { adapter: 'fake', modelId: 'marker', declared: { operations: ['generate', 'stream'], structuredOutput: 'json_mode', contextWindow: 32000 } })
  const dep = await w.h.call('POST', '/api/admin/ai/deployments', w.admin, { connectionId: conn.json.id, modelId: 'marker' })
  assert.equal((await w.h.call('PUT', '/api/admin/ai/routes', w.admin, { target: 'category:assessment', candidates: [{ deploymentId: dep.json.id }] })).status, 200)
  descId = (await w.h.call('POST', `${T}/courses/${w.courseId}/items`, w.prof, { conceptId: w.cLimits, stem: 'Explain what a limit is and whether f must be defined at the point.', answerSpec: { type: 'descriptive', modelAnswer: 'The value approached; f need not be defined there.', rubric: RUBRIC } })).json.id
  numId = (await w.h.call('GET', `${T}/courses/${w.courseId}/items`, w.prof)).json.find((i: { type: string }) => i.type === 'numeric').id
  assessmentId = (await w.h.call('POST', `${T}/courses/${w.courseId}/assessments`, w.prof, { title: 'Reliability', publish: true, adaptive: false, sections: [{ conceptIds: [w.cLimits], count: 2, types: ['numeric', 'descriptive'] }] })).json.id
  // institution B (tutor enabled), with its own educator, student and course
  const sys = createSystemDatabase(w.h.test.systemUrl)
  await sys.query(`update platform.tenants set enabled_modules = '{education.tutor}' where slug = 'nit-y'`)
  await sys.close()
  const adminB = await w.h.signIn('nit-y', 'admin@y.test')
  for (const [email, roles] of [['profb@y.test', ['educator']], ['stub@y.test', ['student']]] as const) assert.equal((await w.h.call('POST', '/api/members', adminB, { email, roles })).status, 200)
  profB = await w.h.signIn('nit-y', 'profb@y.test')
  stuB = await w.h.signIn('nit-y', 'stub@y.test')
  courseB = (await w.h.call('POST', `${T}/courses`, profB, { code: 'B1', title: 'B course' })).json.id
})
after(() => w.close())

test('a crash after submission is recovered by the grading job exactly once, even with concurrent workers', async () => {
  const id = await startAndAnswer(w.stu)
  await crashedSubmission(id) // the process died after the submit transaction: job queued, nothing marked
  assert.equal((await w.h.call('GET', `${T}/assessment-attempts/${id}`, w.stu)).json.grading.runs, 1, 'the student sees marking in progress')
  // the submit transaction would have enqueued the job; a crashed one is reconstructed the same way
  await w.owner.query(`insert into platform.jobs (id, tenant_id, type, payload, run_at, max_attempts, idempotency_key)
    select gen_random_uuid(), tenant_id, 'education.tutor/assessment.grade', jsonb_build_object('attemptId', id, 'userId', user_id), now(), 6, 'grade:' || id from education_tutor.assessment_attempts where id = $1
    on conflict do nothing`, [id])
  await Promise.all([drain(), drain(), drain()]) // three workers race for the same work
  const v = await w.h.call('GET', `${T}/assessment-attempts/${id}`, w.stu)
  assert.equal(v.json.status, 'graded')
  assert.deepEqual(await counts(id), { responses: 2, evidence: 2, itemAttempts: 2 }, 'no duplicate responses, evidence or attempt history')
})

test('concurrent grading runs on the same attempt: one commits, the rest are no-ops', async () => {
  const id = await startAndAnswer(w.stu2)
  await crashedSubmission(id)
  const sys = createSystemDatabase(w.h.test.systemUrl)
  const tenant = (await w.owner.query('select tenant_id, user_id from education_tutor.assessment_attempts where id = $1', [id])).rows[0]
  for (let i = 0; i < 4; i++) await sys.tx((t) => enqueue(t, 'education.tutor/assessment.grade', { attemptId: id, userId: tenant.user_id }, { tenantId: tenant.tenant_id, idempotencyKey: `race:${id}:${i}` }))
  await sys.close()
  await Promise.all([drain(), drain()])
  assert.deepEqual(await counts(id), { responses: 2, evidence: 2, itemAttempts: 2 })
  const cards = await w.owner.query(`select count(*) as n from education_tutor.cards where source_ref = $1 and user_id = $2`, [`item:${descId}`, tenant.user_id])
  assert.ok(Number(cards.rows[0].n) <= 1, 'at most one revision card per missed question')
})

test('a write failure mid-commit leaves nothing half-written; the failure is visible and the retry completes', async () => {
  // a fresh attempt for stu (first attempt is graded)
  const id = await startAndAnswer(w.stu)
  await w.owner.query(`alter table education_tutor.assessment_responses add constraint simulate_failure check (points < -1) not valid`)
  const sub = await w.h.call('POST', `${T}/assessment-attempts/${id}/submit`, w.stu)
  assert.equal(sub.status, 200)
  assert.equal(sub.json.status, 'grading', 'the submission is kept; marking will retry')
  assert.match(sub.json.grading.lastError, /interrupted.*retried automatically/)
  assert.deepEqual(await counts(id), { responses: 0, evidence: 0, itemAttempts: 0 }, 'atomic: nothing from the failed run')
  await w.owner.query(`alter table education_tutor.assessment_responses drop constraint simulate_failure`)
  await runJobsNow()
  await drain()
  const v = await w.h.call('GET', `${T}/assessment-attempts/${id}`, w.stu)
  assert.equal(v.json.status, 'graded')
  assert.deepEqual(await counts(id), { responses: 2, evidence: 2, itemAttempts: 2 })
})

test('after the AI retry limit, marking completes without AI: written answers go to educator review, no evidence from them', async () => {
  const id = await startAndAnswer(w.stu2)
  await crashedSubmission(id, 3) // three AI runs already used up
  markCalls = 0
  const tenant = (await w.owner.query('select tenant_id, user_id from education_tutor.assessment_attempts where id = $1', [id])).rows[0]
  const sys = createSystemDatabase(w.h.test.systemUrl)
  await sys.tx((t) => enqueue(t, 'education.tutor/assessment.grade', { attemptId: id, userId: tenant.user_id }, { tenantId: tenant.tenant_id, idempotencyKey: `degraded:${id}` }))
  await sys.close()
  await drain()
  assert.equal(markCalls, 0, 'no AI call in degraded mode')
  const v = await w.h.call('GET', `${T}/assessment-attempts/${id}`, w.stu2)
  assert.equal(v.json.status, 'needs_review')
  const desc = v.json.results.find((r: { type: string }) => r.type === 'descriptive')
  assert.equal(desc.needsReview, true)
  const reason = (await w.owner.query(`select review_reason from education_tutor.assessment_responses where attempt_id = $1 and item_id = $2`, [id, descId])).rows[0].review_reason
  assert.match(reason, /failed repeatedly/)
  assert.deepEqual(await counts(id), { responses: 2, evidence: 1, itemAttempts: 1 }, 'only the deterministic answer became evidence')
})

test('a provider outage is retried by the job (not sent to educators); marking completes when the provider recovers', async () => {
  await w.owner.query(`update education_tutor.assessments set max_attempts = null where id = $1`, [assessmentId])
  const id = await startAndAnswer(w.stu)
  markingDown = true
  const sub = await w.h.call('POST', `${T}/assessment-attempts/${id}/submit`, w.stu)
  assert.equal(sub.json.status, 'grading', 'not guessed, not dumped on educators')
  assert.match(sub.json.grading.lastError, /marking_unavailable/)
  assert.deepEqual(await counts(id), { responses: 0, evidence: 0, itemAttempts: 0 })
  markingDown = false
  await runJobsNow(); await drain()
  const v = await w.h.call('GET', `${T}/assessment-attempts/${id}`, w.stu)
  assert.equal(v.json.status, 'graded')
  assert.equal(v.json.results.find((r: { type: string }) => r.type === 'descriptive').points, 2)
})

test('the recovery sweep re-enqueues attempts whose job was lost, and stops after the run limit', async () => {
  const id = await startAndAnswer(w.stu2)
  await crashedSubmission(id, 1, 60)
  await w.owner.query(`delete from platform.jobs where payload->>'attemptId' = $1`, [id]) // the job is gone too
  const stuck = await startAndAnswer(w.stu)
  await crashedSubmission(stuck, 10, 60) // MAX_RECOVERY_RUNS reached: left for people, not retried forever
  const tenant = (await w.owner.query('select tenant_id from education_tutor.assessment_attempts where id = $1', [id])).rows[0].tenant_id
  const sys = createSystemDatabase(w.h.test.systemUrl)
  await sys.tx((t) => enqueue(t, 'education.tutor/assessment.recover', {}, { tenantId: tenant, idempotencyKey: `sweep:${id}` }))
  await sys.close()
  await drain() // sweep → grade job
  await runJobsNow(); await drain()
  assert.equal((await w.owner.query('select status from education_tutor.assessment_attempts where id = $1', [id])).rows[0].status, 'graded')
  assert.equal((await w.owner.query('select status from education_tutor.assessment_attempts where id = $1', [stuck])).rows[0].status, 'grading')
  const prof = await w.h.call('GET', `${T}/assessments/${assessmentId}/results`, w.prof)
  const row = prof.json.attempts.find((a: { id: string }) => a.id === stuck)
  assert.equal(row.gradingRuns, 10, 'educators can see a stuck attempt')
  const retry = await w.h.call('POST', `${T}/assessment-attempts/${stuck}/retry-marking`, w.prof)
  assert.equal(retry.status, 200)
  assert.equal((await w.h.call('POST', `${T}/assessment-attempts/${stuck}/retry-marking`, w.stu)).status, 403)
  await drain()
  assert.notEqual((await w.owner.query('select status from education_tutor.assessment_attempts where id = $1', [stuck])).rows[0].status, 'grading', 'an educator retry completes it')
})

test('cross-institution: every assessment boundary refuses another institution', async () => {
  const attempt = (await w.owner.query(`select id from education_tutor.assessment_attempts where assessment_id = $1 limit 1`, [assessmentId])).rows[0].id
  const response = (await w.owner.query(`select id from education_tutor.assessment_responses where attempt_id = $1 limit 1`, [attempt])).rows[0].id
  const tries: [string, string, string, object?][] = [
    ['GET', `${T}/courses/${w.courseId}/assessments`, profB],
    ['POST', `${T}/courses/${w.courseId}/assessments`, profB, { title: 'x', sections: [{ conceptIds: [w.cLimits], count: 1 }] }],
    ['PUT', `${T}/assessments/${assessmentId}`, profB, { status: 'archived' }],
    ['GET', `${T}/assessments/${assessmentId}/results`, profB],
    ['GET', `${T}/assessments/${assessmentId}/review?all=true`, profB],
    ['POST', `${T}/assessment-responses/${response}/override`, profB, { points: 1, reason: 'cross-tenant attempt' }],
    ['POST', `${T}/assessment-attempts/${attempt}/retry-marking`, profB],
    ['POST', `${T}/courses/${w.courseId}/items/generate`, profB, { conceptId: w.cLimits }],
    ['POST', `${T}/items/${numId}/approve`, profB],
    ['POST', `${T}/assessments/${assessmentId}/attempts`, stuB],
    ['GET', `${T}/assessment-attempts/${attempt}`, stuB],
    ['PUT', `${T}/assessment-attempts/${attempt}/responses`, stuB, { itemId: numId, response: '1' }],
    ['POST', `${T}/assessment-attempts/${attempt}/submit`, stuB],
  ]
  for (const [m, path, tok, body] of tries) {
    const r = await w.h.call(m, path, tok, body)
    assert.ok([403, 404].includes(r.status), `${m} ${path} → ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`)
  }
  // RLS directly: institution B's educator context sees no rows of A's assessment tables, and the sweeper function is tenant-scoped
  const ids = (await w.owner.query(`select u.id, m.tenant_id from platform.users u join platform.memberships m on m.user_id = u.id where u.email = 'profb@y.test'`)).rows[0]
  const db = createDatabase(w.h.test.appUrl)
  try {
    const seen = await db.withTenant({ tenantId: ids.tenant_id, userId: ids.id, roles: ['educator'] }, async (t) => Promise.all([
      ...['assessments', 'assessment_attempts', 'assessment_responses'].map(async (tb) => Number((await t.query<{ n: string }>(`select count(*) as n from education_tutor.${tb}`)).rows[0]!.n)),
      t.query(`select count(*) as n from education_tutor.stale_grading_attempts('0 seconds')`).then((r) => Number((r.rows[0] as { n: string }).n)),
    ]))
    assert.deepEqual(seen, [0, 0, 0, 0])
  } finally { await db.close() }
  // a grading job carrying another institution's attempt id does nothing
  const sys = createSystemDatabase(w.h.test.systemUrl)
  await sys.tx((t) => enqueue(t, 'education.tutor/assessment.grade', { attemptId: attempt, userId: ids.id }, { tenantId: ids.tenant_id, idempotencyKey: `xt:${attempt}` }))
  await sys.close()
  const before = await counts(attempt)
  await drain()
  assert.deepEqual(await counts(attempt), before)
  void courseB
})
