import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { newId } from '@platform/core'
import { recordAudit, listAudit } from '@platform/audit'
import { setupTestDb, type PlatformTestDb } from '@platform/testing'

let t: PlatformTestDb
const A = newId()
const B = newId()

before(async () => {
  t = await setupTestDb()
  await t.system.query(`insert into platform.tenants (id, slug, name, type) values ($1, 'a-1', 'A', 'institution'), ($2, 'b-1', 'B', 'institution')`, [A, B])
})
after(() => t.close())

test('audit events are tenant-scoped', async () => {
  await t.db.withTenant({ tenantId: A }, (tx) => recordAudit(tx, { userId: null }, { action: 'x.done', targetType: 'thing', targetId: '1' }))
  const a = await t.db.withTenant({ tenantId: A }, (tx) => listAudit(tx))
  const b = await t.db.withTenant({ tenantId: B }, (tx) => listAudit(tx))
  assert.equal(a.length, 1)
  assert.equal(b.length, 0)
})

test('audit log is append-only for app and system roles', async () => {
  await assert.rejects(t.db.withTenant({ tenantId: A }, (tx) => tx.query(`update platform.audit_events set action = 'tampered'`)), /permission denied/)
  await assert.rejects(t.db.withTenant({ tenantId: A }, (tx) => tx.query(`delete from platform.audit_events`)), /permission denied/)
  await assert.rejects(t.system.query(`delete from platform.audit_events`), /permission denied/)
})

test('audit events roll back with the failed change', async () => {
  await assert.rejects(
    t.db.withTenant({ tenantId: B }, async (tx) => {
      await recordAudit(tx, { userId: null }, { action: 'y.done', targetType: 'thing' })
      throw new Error('business failure')
    }),
  )
  const b = await t.db.withTenant({ tenantId: B }, (tx) => listAudit(tx))
  assert.equal(b.length, 0)
})
