/**
 * Tutor recurring jobs through the real scheduler + worker: delayed checks, plan refresh, per-tenant
 * fan-out only where the tutor is enabled, idempotency across two workers, removal compatibility.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase, type Database } from '@platform/tenancy-db'
import { createSystemDatabase, type SystemDatabase } from '@platform/tenancy-db/system'
import { createScheduler, createWorker } from '@platform/jobs'
import { buildPlatform } from '@platform/module-runtime'
import { setupTutorWorld, type TutorWorld } from './tutor-setup.ts'

let w: TutorWorld
let db: Database
let system: SystemDatabase
let stuId: string, stu2Id: string, tenantX: string, tenantY: string
const DAY = 86_400_000

before(async () => {
  w = await setupTutorWorld({})
  db = createDatabase(w.h.test.appUrl, { max: 4 })
  system = createSystemDatabase(w.h.test.systemUrl, { max: 4 })
  const users = (await w.owner.query(`select id, email from platform.users`)).rows as { id: string; email: string }[]
  stuId = users.find((u) => u.email === 'stu@x.test')!.id
  stu2Id = users.find((u) => u.email === 'stu2@x.test')!.id
  tenantX = (await w.owner.query(`select id from platform.tenants where slug = 'iit-x'`)).rows[0].id
  tenantY = (await w.owner.query(`select id from platform.tenants where slug = 'nit-y'`)).rows[0].id
})
after(async () => {
  await db.close()
  await system.close()
  await w.close()
})

const runAt = async (now: Date, workers = 2) => {
  const schedules = w.h.app.platform.schedules
  await Promise.all(Array.from({ length: workers }, () => createScheduler({ system, schedules }).tick(now)))
  const ws = Array.from({ length: workers }, () => createWorker({ system, db, handlers: w.h.app.platform.jobs, batch: 3 }))
  await Promise.all(ws.map((x) => x.drain()))
}
const addEvidence = (userId: string, conceptId: string, daysAgo: number[], kind = 'practice') =>
  Promise.all(daysAgo.map((d) => w.owner.query(`insert into education_tutor.evidence (tenant_id, user_id, concept_id, kind, outcome, observed_at) values ($1, $2, $3, $4, 1, now() - make_interval(days => $5))`,
    [tenantX, userId, conceptId, kind, d])))
const pendingChecks = async (userId: string) => (await w.owner.query(`select * from education_tutor.cards where user_id = $1 and purpose = 'delayed_check'`, [userId])).rows

test('manifest schedules are namespaced, validated and registered', () => {
  const names = w.h.app.platform.schedules.map((s) => `${s.name} -> ${s.jobType}`)
  assert.deepEqual(names, [
    'education.tutor/delayed-checks -> education.tutor/delayed_checks.fanout',
    'education.tutor/plan-refresh -> education.tutor/plan_refresh.fanout',
    'education.tutor/encrypt-legacy-turns -> education.tutor/turns.encrypt_legacy.fanout',
    'education.tutor/assessment-grading-recovery -> education.tutor/assessment.recover',
    'education.tutor/agent-daily -> education.tutor/agent.daily.fanout',
  ])
  assert.ok(w.h.app.platform.schedules.every((s) => s.perTenant?.requireModule === 'education.tutor'))
  const bad = { id: 'demo.mod', vertical: 'demo', version: '1', owner: 'x', description: '', data: { stores: [] }, jobs: () => ({ a: async () => undefined }) }
  assert.throws(() => buildPlatform([{ ...bad, schedules: [{ name: 's', job: 'missing', spec: { everyMs: 60_000 } }] }], { db: {} as never, gateway: () => { throw new Error('x') } }), /unknown job/)
  assert.throws(() => buildPlatform([{ ...bad, schedules: [{ name: 's', job: 'a', spec: { dailyAtUtc: '9am' } }] }], { db: {} as never, gateway: () => { throw new Error('x') } }), /dailyAtUtc|HH:MM/)
})

test('delayed checks: created only for mastered/stale concepts lacking a check for >= 14 days; idempotent across two workers', async () => {
  // stu: strong spaced evidence on Limits, mastered as of its latest answer 15 days ago -> due a delayed check
  await addEvidence(stuId, w.cLimits, [24, 22, 20, 19, 18, 17, 16, 15])
  // stu: Functions evidence is recent (2 days) -> no check yet
  await addEvidence(stuId, w.cFunctions, [9, 6, 4, 2])
  // stu2: a single session of perfect answers 20 days ago -> never "mastered" (insufficient spacing) -> no check
  await addEvidence(stu2Id, w.cLimits, [20, 20, 20, 20, 20])
  const now = new Date()
  await runAt(now)
  const checks = await pendingChecks(stuId)
  assert.equal(checks.length, 1)
  assert.equal(checks[0].concept_id, w.cLimits)
  assert.match(checks[0].front, /Delayed check \(Limits\)/)
  assert.equal((await pendingChecks(stu2Id)).length, 0)
  // same period from more workers / a second run of the next day: still one pending card
  await runAt(now, 3)
  await runAt(new Date(now.getTime() + DAY))
  assert.equal((await pendingChecks(stuId)).length, 1)
  // it shows up in the student's due queue and answering it records delayed_check evidence
  const due = await w.h.call('GET', '/api/m/education.tutor/cards/due', w.stu)
  assert.ok(due.json.some((c: { id: string }) => c.id === checks[0].id))
  assert.equal((await w.h.call('POST', `/api/m/education.tutor/cards/${checks[0].id}/review`, w.stu, { grade: 3 })).status, 200)
  const ev = await w.owner.query(`select kind from education_tutor.evidence where source_ref = $1`, [`card:${checks[0].id}`])
  assert.deepEqual(ev.rows.map((r) => r.kind), ['delayed_check'])
  // after a passed check the concept is not due again for >= 14 days
  await runAt(new Date(now.getTime() + 2 * DAY))
  assert.equal((await pendingChecks(stuId)).filter((c) => c.reps === 0).length, 0)
})

test('plan refresh: stale (> 7 days) plans get a new version once per period; missed work triggers recovery', async () => {
  const exam = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10)
  assert.equal((await w.h.call('PUT', `/api/m/education.tutor/courses/${w.courseId}/goal`, w.stu2, { examAt: exam, dailyMinutes: 45 })).status, 204)
  assert.equal((await w.h.call('POST', `/api/m/education.tutor/courses/${w.courseId}/plan`, w.stu2, {})).status, 200)
  const plans = async () => (await w.owner.query(`select version, trigger, plan, created_at from education_tutor.plans where user_id = $1 order by version`, [stu2Id])).rows
  // fresh plan, no missed work: nothing happens (later days: periods not used by the previous test)
  await runAt(new Date(Date.now() + 9 * DAY))
  assert.equal((await plans()).length, 1)
  await w.owner.query(`update education_tutor.plans set created_at = now() - interval '8 days' where user_id = $1`, [stu2Id])
  const t1 = new Date(Date.now() + 10 * DAY)
  await runAt(t1)
  await runAt(t1, 3)
  let p = await plans()
  assert.deepEqual(p.map((x) => [x.version, x.trigger]), [[1, 'request'], [2, 'scheduled_refresh']])
  assert.match(p[1].plan.rationale[0], /Refreshed automatically/)
  // missed: a learn task dated yesterday with no evidence since the plan was made
  const plan = p[1].plan
  const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10)
  const learn = plan.tasks.find((x: { kind: string }) => x.kind === 'learn')
  learn.date = yesterday
  await w.owner.query(`update education_tutor.plans set plan = $2, created_at = now() - interval '2 days' where user_id = $1 and version = 2`, [stu2Id, JSON.stringify(plan)])
  await runAt(new Date(Date.now() + 11 * DAY))
  p = await plans()
  assert.equal(p.at(-1).trigger, 'missed_recovery')
  assert.match(p.at(-1).plan.rationale[0], /Missed work was moved forward/)
  // the student sees the newest version through the normal API (plans are student-owned)
  assert.equal((await w.owner.query(`select count(*)::int as n from education_tutor.plans where user_id <> $1`, [stu2Id])).rows[0].n, 0)
})

test('fan-out only for tenants with education.tutor enabled', async () => {
  const types = (await w.owner.query(`select distinct tenant_id from platform.jobs where type like 'education.tutor/%'`)).rows.map((r) => r.tenant_id)
  assert.ok(types.includes(tenantX))
  assert.ok(!types.includes(tenantY))
})

test('removal compatibility: without the tutor nothing is scheduled; its queued jobs dead-letter (no handler)', async () => {
  const p = buildPlatform([], { db, gateway: () => { throw new Error('unused') } })
  assert.deepEqual(p.schedules, [])
  assert.equal(await createScheduler({ system, schedules: p.schedules }).tick(new Date()), 0)
  const id = (await system.query<{ id: string }>(`insert into platform.jobs (id, tenant_id, type, payload) values (gen_random_uuid(), $1, 'education.tutor/delayed_checks.fanout', '{}') returning id`, [tenantX])).rows[0]!.id
  await createWorker({ system, db, handlers: p.jobs }).drain()
  const r = (await system.query<{ status: string; last_error: string }>('select status, last_error from platform.jobs where id = $1', [id])).rows[0]!
  assert.equal(r.status, 'dead')
  assert.match(r.last_error, /no_handler/)
})
