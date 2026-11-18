import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { newId } from '@platform/core'
import { createScheduler, createWorker, periodStart, scheduleProblems, type JobHandler, type ScheduleDef } from '@platform/jobs'
import { setupTestDb, type PlatformTestDb } from '@platform/testing'

let t: PlatformTestDb
const A = newId()
const B = newId()
const C = newId()

before(async () => {
  t = await setupTestDb()
  await t.system.query(`insert into platform.tenants (id, slug, name, type, enabled_modules, status) values
    ($1, 'sa', 'A', 'institution', '{demo.mod}', 'active'), ($2, 'sb', 'B', 'institution', '{}', 'active'), ($3, 'sc', 'C', 'institution', '{demo.mod}', 'suspended')`, [A, B, C])
})
after(() => t.close())

const count = async (type: string) => (await t.system.query<{ n: number }>('select count(*)::int as n from platform.jobs where type = $1', [type])).rows[0]!.n

test('period boundaries: interval aligned to epoch; daily at HH:MM UTC', () => {
  const at = new Date('2026-11-17T10:07:30Z')
  assert.equal(periodStart({ everyMs: 300_000 }, at).toISOString(), '2026-11-17T10:05:00.000Z')
  assert.equal(periodStart({ dailyAtUtc: '02:30' }, at).toISOString(), '2026-11-17T02:30:00.000Z')
  assert.equal(periodStart({ dailyAtUtc: '23:00' }, at).toISOString(), '2026-11-16T23:00:00.000Z')
  assert.equal(periodStart({ dailyAtUtc: '10:07' }, at).toISOString(), '2026-11-17T10:07:00.000Z')
  assert.deepEqual(scheduleProblems({ name: 'demo.mod/x', jobType: 'demo.mod/y', spec: { dailyAtUtc: '25:00' } }).length, 1)
  assert.deepEqual(scheduleProblems({ name: 'bad', jobType: 'demo.mod/y', spec: { everyMs: 10 } }).length, 2)
  assert.throws(() => createScheduler({ system: t.system, schedules: [{ name: 'x', jobType: 'y', spec: { everyMs: 1 } }] }), /schedule/)
})

test('exactly one job per period across concurrent schedulers (multiple workers), and again next period', async () => {
  const s: ScheduleDef = { name: 'demo.mod/tick', jobType: 'demo.mod/tick', spec: { everyMs: 60_000 } }
  const workers = Array.from({ length: 4 }, () => createScheduler({ system: t.system, schedules: [s] }))
  const now = new Date('2026-11-17T10:00:30Z')
  const created = await Promise.all(workers.map((w) => w.tick(now)))
  assert.equal(created.reduce((a, b) => a + b, 0), 1)
  assert.equal(await count('demo.mod/tick'), 1)
  // same period again (also from a fresh process without in-memory state): no new job
  assert.equal(await createScheduler({ system: t.system, schedules: [s] }).tick(new Date('2026-11-17T10:00:59Z')), 0)
  assert.equal(await workers[0]!.tick(new Date('2026-11-17T10:01:00Z')), 1)
  assert.equal(await count('demo.mod/tick'), 2)
  const payload = (await t.system.query<{ payload: { scheduledFor: string }; tenant_id: string | null }>(`select payload, tenant_id from platform.jobs where type = 'demo.mod/tick' order by run_at`)).rows
  assert.equal(payload[0]!.payload.scheduledFor, '2026-11-17T10:00:00.000Z')
  assert.equal(payload[0]!.tenant_id, null)
})

test('per-tenant fan-out only to active tenants that enabled the module; idempotent', async () => {
  const s: ScheduleDef = { name: 'demo.mod/daily', jobType: 'demo.mod/daily', spec: { dailyAtUtc: '02:00' }, perTenant: { requireModule: 'demo.mod' } }
  const now = new Date('2026-11-17T03:00:00Z')
  const [x, y] = await Promise.all([createScheduler({ system: t.system, schedules: [s] }).tick(now), createScheduler({ system: t.system, schedules: [s] }).tick(now)])
  assert.equal(x + y, 1)
  const rows = (await t.system.query<{ tenant_id: string }>(`select tenant_id from platform.jobs where type = 'demo.mod/daily'`)).rows
  assert.deepEqual(rows.map((r) => r.tenant_id), [A])
  // tenant-scoped: the tenant sees its own scheduled job under RLS
  assert.equal((await t.db.withTenant({ tenantId: A }, (tx) => tx.query(`select 1 from platform.jobs where type = 'demo.mod/daily'`))).rowCount, 1)
  assert.equal((await t.db.withTenant({ tenantId: B }, (tx) => tx.query(`select 1 from platform.jobs where type = 'demo.mod/daily'`))).rowCount, 0)
})

test('scheduled jobs run once across two workers; a schedule whose module was removed dead-letters (no handler)', async () => {
  let runs = 0
  const handlers = new Map<string, JobHandler>([['demo.mod/daily', async () => { runs++ }], ['demo.mod/tick', async () => { runs++ }]])
  const w1 = createWorker({ system: t.system, db: t.db, handlers, batch: 2 })
  const w2 = createWorker({ system: t.system, db: t.db, handlers, batch: 2 })
  await createScheduler({ system: t.system, schedules: [{ name: 'gone.mod/x', jobType: 'gone.mod/x', spec: { everyMs: 60_000 } }] }).tick(new Date('2026-11-17T10:00:00Z'))
  await Promise.all([w1.drain(), w2.drain()])
  assert.equal(runs, 3) // 2 ticks + 1 daily
  const dead = (await t.system.query<{ status: string; last_error: string }>(`select status, last_error from platform.jobs where type = 'gone.mod/x'`)).rows[0]!
  assert.equal(dead.status, 'dead')
  assert.match(dead.last_error, /no_handler/)
})

test('benchmark: scheduler fan-out + two workers on the local database', async () => {
  const tenants = 200
  const ids = Array.from({ length: tenants }, () => newId())
  await t.system.query(`insert into platform.tenants (id, slug, name, type, enabled_modules)
    select id, 'bench-' || ord, 'Bench', 'institution', '{bench.mod}' from unnest($1::uuid[]) with ordinality as u(id, ord)`, [ids])
  const schedules: ScheduleDef[] = Array.from({ length: 5 }, (_, i) => ({ name: `bench.mod/s${i}`, jobType: 'bench.mod/work', spec: { everyMs: 60_000 }, perTenant: { requireModule: 'bench.mod' } }))
  const t0 = performance.now()
  const created = await createScheduler({ system: t.system, schedules }).tick(new Date('2026-11-17T12:00:00Z'))
  const t1 = performance.now()
  assert.equal(created, tenants * 5)
  let done = 0
  const handlers = new Map<string, JobHandler>([['bench.mod/work', async (ctx) => { await ctx.inTenant((tx) => tx.query('select 1')); done++ }]])
  const ws = [1, 2].map(() => createWorker({ system: t.system, db: t.db, handlers, batch: 20 }))
  await Promise.all(ws.map((w) => w.drain(1000)))
  const t2 = performance.now()
  assert.equal(done, created)
  const enqueueRate = Math.round(created / ((t1 - t0) / 1000))
  const runRate = Math.round(done / ((t2 - t1) / 1000))
  console.log(`[bench] scheduler enqueue: ${created} jobs in ${Math.round(t1 - t0)} ms = ${enqueueRate} jobs/s; 2 workers (batch 20) processed ${done} tenant jobs in ${Math.round(t2 - t1)} ms = ${runRate} jobs/s`)
})
