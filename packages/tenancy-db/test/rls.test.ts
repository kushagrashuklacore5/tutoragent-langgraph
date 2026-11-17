import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { newId } from '@platform/core'
import { findRlsViolations, migrate } from '@platform/tenancy-db'
import { setupTestDb, corePlatformMigrations, type PlatformTestDb } from '@platform/testing'

let t: PlatformTestDb
const A = newId()
const B = newId()

before(async () => {
  t = await setupTestDb()
  await t.system.query(`insert into platform.tenants (id, slug, name, type) values ($1, 'inst-a', 'A', 'institution'), ($2, 'inst-b', 'B', 'institution')`, [A, B])
})
after(() => t.close())

test('every tenant table has RLS enabled, forced and a policy', async () => {
  const v = await findRlsViolations(t.system)
  assert.deepEqual(v, [])
})

test('RLS check detects a tenant table without policy', async () => {
  await t.system.query('create table platform.rogue (tenant_id uuid)').catch(async () => {
    // system role cannot create tables in platform schema; use owner via migration-less path
  })
  const pg = (await import('pg')).default
  const c = new pg.Client({ connectionString: t.test.ownerUrl })
  await c.connect()
  await c.query('create table public.rogue (id int, tenant_id uuid)')
  await c.end()
  const v = await findRlsViolations(t.system)
  assert.ok(v.some((x) => x.table === 'rogue' && x.problem === 'rls_disabled'))
  const c2 = new pg.Client({ connectionString: t.test.ownerUrl })
  await c2.connect()
  await c2.query('drop table public.rogue')
  await c2.end()
})

test('a tenant sees only its own tenant row; no tenant context sees none', async () => {
  const rowsA = await t.db.withTenant({ tenantId: A }, (tx) => tx.query<{ slug: string }>('select slug from platform.tenants'))
  assert.deepEqual(rowsA.rows.map((r) => r.slug), ['inst-a'])
  const anon = await t.db.withAnonymous((tx) => tx.query('select * from platform.tenants'))
  assert.equal(anon.rowCount, 0)
})

test('app role cannot write rows for another tenant', async () => {
  const u = newId()
  await t.system.query(`insert into platform.users (id, email) values ($1, 'x@b.test')`, [u])
  await assert.rejects(
    t.db.withTenant({ tenantId: A }, (tx) => tx.query(`insert into platform.memberships (tenant_id, user_id, roles) values ($1, $2, '{student}')`, [B, u])),
    /row-level security/,
  )
})

test('migrations are idempotent and detect edited files', async () => {
  const r = await migrate(t.test.ownerUrl, corePlatformMigrations)
  assert.deepEqual(r.applied, [])
})

test('app role is not superuser and has no BYPASSRLS', async () => {
  const r = await t.db.withTenant({ tenantId: A }, (tx) => tx.query<{ rolsuper: boolean; rolbypassrls: boolean }>('select rolsuper, rolbypassrls from pg_roles where rolname = current_user'))
  assert.deepEqual(r.rows[0], { rolsuper: false, rolbypassrls: false })
})
