import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { newId } from '@platform/core'
import { createWorker, enqueue, PermanentJobError, type JobHandler } from '@platform/jobs'
import { setupTestDb, type PlatformTestDb } from '@platform/testing'

let t: PlatformTestDb
const A = newId()
const B = newId()

before(async () => {
  t = await setupTestDb()
  await t.system.query(`insert into platform.tenants (id, slug, name, type) values ($1, 'a-2', 'A', 'institution'), ($2, 'b-2', 'B', 'institution')`, [A, B])
  const c = new pg.Client({ connectionString: t.test.ownerUrl })
  await c.connect()
  await c.query(`create table public.effects (key text primary key, tenant_id uuid not null)`)
  await c.query(`grant select, insert on public.effects to platform_app, platform_system`)
  await c.end()
})
after(() => t.close())

const statusOf = async (id: string) => (await t.system.query<{ status: string; attempts: number; last_error: string | null }>('select status, attempts, last_error from platform.jobs where id = $1', [id])).rows[0]!

test('enqueue is idempotent per (type, key) and tenant-scoped', async () => {
  const a1 = await t.db.withTenant({ tenantId: A }, (tx) => enqueue(tx, 'test/noop', { n: 1 }, { idempotencyKey: 'k1' }))
  const a2 = await t.db.withTenant({ tenantId: A }, (tx) => enqueue(tx, 'test/noop', { n: 2 }, { idempotencyKey: 'k1' }))
  assert.equal(a1.id, a2.id)
  assert.equal(a2.created, false)
  const visibleToB = await t.db.withTenant({ tenantId: B }, (tx) => tx.query('select id from platform.jobs where id = $1', [a1.id]))
  assert.equal(visibleToB.rowCount, 0)
  await t.system.query(`delete from platform.jobs`)
})

test('retries with backoff, then dead-letters after max attempts', async () => {
  let calls = 0
  const handlers = new Map<string, JobHandler>([['test/flaky', async () => { calls++; throw new Error('boom') }]])
  const w = createWorker({ system: t.system, db: t.db, handlers, backoffBaseMs: 1 })
  const { id } = await t.db.withTenant({ tenantId: A }, (tx) => enqueue(tx, 'test/flaky', {}, { maxAttempts: 3 }))
  for (let i = 0; i < 10 && (await statusOf(id)).status !== 'dead'; i++) {
    await w.tick()
    await new Promise((r) => setTimeout(r, 15))
  }
  const s = await statusOf(id)
  assert.equal(s.status, 'dead')
  assert.equal(s.attempts, 3)
  assert.equal(calls, 3)
  assert.match(s.last_error!, /boom/)
})

test('permanent errors dead-letter immediately; unknown job types dead-letter with no_handler', async () => {
  const handlers = new Map<string, JobHandler>([['test/bad', async () => { throw new PermanentJobError('invalid payload') }]])
  const w = createWorker({ system: t.system, db: t.db, handlers })
  const bad = await t.db.withTenant({ tenantId: A }, (tx) => enqueue(tx, 'test/bad', {}))
  const orphan = await t.db.withTenant({ tenantId: A }, (tx) => enqueue(tx, 'removed.module/thing', {}))
  await w.drain()
  assert.equal((await statusOf(bad.id)).status, 'dead')
  assert.equal((await statusOf(bad.id)).attempts, 1)
  const o = await statusOf(orphan.id)
  assert.equal(o.status, 'dead')
  assert.match(o.last_error!, /no_handler/)
})

test('crashed worker: expired lease is reclaimed and the effect happens exactly once', async () => {
  const handler: JobHandler = async (ctx) => {
    await ctx.once('write-effect', (tx) => tx.query(`insert into public.effects (key, tenant_id) values ($1, platform.current_tenant())`, [ctx.job.id]))
  }
  const { id } = await t.db.withTenant({ tenantId: A }, (tx) => enqueue(tx, 'test/effect', {}))
  // worker 1 claims the job and "crashes" after performing the effect but before finishing
  const crashing = createWorker({
    system: t.system, db: t.db, leaseMs: 50,
    handlers: new Map([['test/effect', async (ctx) => { await handler(ctx); throw Object.assign(new Error('crash'), { simulateCrash: true }) }]]),
  })
  // emulate a hard crash: claim + run handler body, but never write the outcome
  const claimed = await t.system.query<{ id: string }>(
    `update platform.jobs set status='running', attempts=attempts+1, locked_by='dead-worker', locked_until=now()+interval '50 milliseconds' where id=$1 returning id`, [id])
  assert.equal(claimed.rowCount, 1)
  await t.db.withTenant({ tenantId: A }, async (tx) => {
    await tx.query(`insert into platform.job_effects (job_id, effect_key) values ($1, 'write-effect')`, [id])
    await tx.query(`insert into public.effects (key, tenant_id) values ($1, platform.current_tenant())`, [id])
  })
  void crashing
  await new Promise((r) => setTimeout(r, 80))
  const w2 = createWorker({ system: t.system, db: t.db, handlers: new Map([['test/effect', handler]]) })
  await w2.drain()
  assert.equal((await statusOf(id)).status, 'succeeded')
  const effects = await t.system.query('select * from public.effects where key = $1', [id])
  assert.equal(effects.rowCount, 1)
})

test('two workers never run the same job concurrently', async () => {
  let runs = 0
  const handlers = new Map<string, JobHandler>([['test/count', async () => { runs++; await new Promise((r) => setTimeout(r, 20)) }]])
  for (let i = 0; i < 20; i++) await t.db.withTenant({ tenantId: B }, (tx) => enqueue(tx, 'test/count', { i }))
  const w1 = createWorker({ system: t.system, db: t.db, handlers, batch: 4 })
  const w2 = createWorker({ system: t.system, db: t.db, handlers, batch: 4 })
  await Promise.all([w1.drain(), w2.drain()])
  assert.equal(runs, 20)
})
