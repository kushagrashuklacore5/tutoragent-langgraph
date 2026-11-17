/**
 * Module-removal matrix (platform-planning/MODULE_REMOVAL_STRATEGY.md § 4).
 * For every module and every vertical: build without it and prove routes, permissions, jobs, event
 * subscriptions, UI routes, AI tasks and migrations are exactly "full minus that module", the rest
 * keeps working, and purge leaves nothing behind.
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { manifest as hello } from '@modules/examples-hello-agent'
import { manifest as echo } from '@modules/examples-echo-agent'
import type { ModuleManifest } from '@platform/contracts'
import { createDatabase, findRlsViolations, migrate } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { createTestDatabase } from '@platform/tenancy-db/testing'
import { createWorker, enqueue } from '@platform/jobs'
import { buildPlatform, migrationSetsFor } from '@platform/module-runtime'
import { purgeModule, verifyModuleAbsent } from '@platform/module-runtime/lifecycle'
import { startHarness } from './helpers.ts'

const ALL: ModuleManifest[] = [hello, echo]
const fakeDeps = { db: {} as never, gateway: () => { throw new Error('not used') } }

function snapshot(mods: ModuleManifest[]) {
  const p = buildPlatform(mods, fakeDeps)
  return {
    routes: p.routes.map((r) => `${r.method} ${r.fullPath}`).sort(),
    permissions: p.permissions.list().map((x) => x.key),
    jobs: [...p.jobs.keys()].sort(),
    subscriptions: p.events.subscriptionKeys(),
    ui: p.ui.map((u) => `${u.moduleId} ${u.path}`).sort(),
    tasks: p.tasks.ids(),
  }
}
const belongsTo = (id: string) => (s: string) => s.includes(id)

const VARIANTS: { name: string; removed: string[] }[] = [
  { name: 'minus examples.hello', removed: ['examples.hello'] },
  { name: 'minus examples.echo', removed: ['examples.echo'] },
  { name: 'minus vertical "examples"', removed: ['examples.hello', 'examples.echo'] },
]

describe('registration snapshots: removed = full minus the module, nothing else changes', () => {
  const full = snapshot(ALL)
  for (const v of VARIANTS) {
    test(v.name, () => {
      const remaining = ALL.filter((m) => !v.removed.includes(m.id))
      const s = snapshot(remaining)
      for (const key of Object.keys(full) as (keyof typeof full)[]) {
        // subscriptions are owned by the subscriber; jobs for event deliveries are keyed by subscriber
        const expected = full[key].filter((x) => !v.removed.some((id) => key === 'subscriptions' ? x.startsWith(id + '<-') : belongsTo(id)(x.split('/event:')[0]!)))
        assert.deepEqual(s[key], expected, `${key} after ${v.name}`)
      }
    })
  }
  test('platform-only build starts with no module contributions', () => {
    const s = snapshot([])
    assert.deepEqual([s.routes, s.jobs, s.subscriptions, s.ui, s.tasks], [[], [], [], [], []])
    assert.ok(s.permissions.every((k) => k.startsWith('platform:')))
  })
  test('a required subscription to a missing publisher is a startup error; optional is fine', () => {
    const strict: ModuleManifest = { ...echo, events: { subscribes: [{ ...echo.events!.subscribes![0]!, optional: false }] } }
    assert.throws(() => buildPlatform([strict], fakeDeps), { code: 'event_subscription_unresolved' })
    assert.doesNotThrow(() => buildPlatform([echo], fakeDeps))
  })
})

describe('migrations: fresh databases for each variant', () => {
  for (const v of [...VARIANTS, { name: 'platform only', removed: ALL.map((m) => m.id) }]) {
    test(v.name, async () => {
      const t = await createTestDatabase('rm')
      try {
        const sets = migrationSetsFor(ALL.filter((m) => !v.removed.includes(m.id)))
        await migrate(t.ownerUrl, sets)
        const sys = createSystemDatabase(t.systemUrl)
        assert.deepEqual(await findRlsViolations(sys), [])
        const schemas = (await sys.query<{ nspname: string }>(`select nspname from pg_namespace where nspname like 'examples_%' order by 1`)).rows.map((r) => r.nspname)
        assert.deepEqual(schemas, ALL.filter((m) => !v.removed.includes(m.id)).map((m) => m.db!.schema).sort())
        await sys.close()
      } finally {
        await t.drop()
      }
    })
  }
})

describe('removing a module from a database that had it', () => {
  const dbs: (() => Promise<void>)[] = []
  after(async () => { for (const d of dbs) await d() })

  test('remaining modules and the platform keep working; orphan jobs dead-letter; purge leaves nothing', async () => {
    const t = await createTestDatabase('rm')
    dbs.push(() => t.drop())
    // 1. full install with data
    const full = await startHarness(ALL, { test: t })
    await full.app.identity.createTenant({ slug: 'uni-r', name: 'R', adminEmail: 'admin@r.test' })
    const sys = createSystemDatabase(t.systemUrl)
    await sys.query(`update platform.tenants set enabled_modules = '{examples.hello,examples.echo}'`)
    const tok = await full.signIn('uni-r', 'admin@r.test')
    assert.equal((await full.call('POST', '/api/m/examples.hello/greetings', tok, { text: 'hi' })).status, 200)
    const tenantId = (await full.call('GET', '/api/me', tok)).json.tenantId as string
    await full.close()

    // 2. redeploy WITHOUT examples.hello (code removed); data still there, untouched
    const without = await startHarness([echo], { test: t, migrate: true })
    const tok2 = await without.signIn('uni-r', 'admin@r.test')
    assert.equal((await without.call('GET', '/api/m/examples.hello/greetings', tok2)).status, 404, 'removed module routes are gone')
    assert.equal((await without.call('GET', '/api/m/examples.echo/echoes', tok2)).status, 200, 'other module still works')
    assert.equal((await without.call('GET', '/api/me', tok2)).status, 200, 'platform still works')
    assert.ok(!without.app.platform.permissions.has('examples.hello:greeting.read'))
    const ui = await without.call('GET', '/api/platform/modules', tok2)
    assert.ok(!ui.json.ui.some((u: { moduleId: string }) => u.moduleId === 'examples.hello'))
    const kept = await sys.query(`select count(*)::int as n from examples_hello.greetings`)
    assert.equal((kept.rows[0] as { n: number }).n, 1, 'disable/remove code never deletes data')

    // 3. a queued job of the removed module dead-letters; the worker stays healthy and runs other jobs
    const db = createDatabase(t.appUrl)
    await db.withTenant({ tenantId }, (tx) => enqueue(tx, 'examples.hello/greeting.count', { id: '00000000-0000-0000-0000-000000000000' }))
    const w = createWorker({ system: sys, db, handlers: without.app.platform.jobs })
    await w.drain()
    const dead = await sys.query<{ status: string; last_error: string }>(`select status, last_error from platform.jobs where type like 'examples.hello/%' order by created_at desc limit 1`)
    assert.equal(dead.rows[0]!.status, 'dead')
    assert.match(dead.rows[0]!.last_error, /no_handler/)
    await without.close()

    // 4. explicit, confirmed purge -> nothing remains; other module + platform untouched
    await assert.rejects(purgeModule(t.ownerUrl, sys, 'examples.hello', 'wrong'), { code: 'purge_not_confirmed' })
    await purgeModule(t.ownerUrl, sys, 'examples.hello', 'examples.hello')
    assert.deepEqual(await verifyModuleAbsent(sys, 'examples.hello'), [])
    assert.deepEqual(await verifyModuleAbsent(sys, 'examples.echo').then((l) => l.filter((x) => x.startsWith('schema'))), ['schema: 1'])
    assert.deepEqual(await findRlsViolations(sys), [])
    const audit = await sys.query(`select count(*)::int as n from platform.audit_events where action = 'module.purged'`)
    assert.equal((audit.rows[0] as { n: number }).n, 1)
    // migrations for the remaining set are still clean after purge
    await migrate(t.ownerUrl, migrationSetsFor([echo]))
    await db.close()
    await sys.close()
  })
})
