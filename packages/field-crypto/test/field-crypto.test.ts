import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { newId } from '@platform/core'
import { localKeyManager } from '@platform/ai-gateway'
import { createFieldCrypto, fieldCryptoMigrations, isFieldCiphertext } from '@platform/field-crypto'
import { setupTestDb, type PlatformTestDb } from '@platform/testing'

let t: PlatformTestDb
const A = newId()
const B = newId()
const km = localKeyManager(randomBytes(32))
const F = { table: 'mod.x:turns', column: 'content', recordId: 'row-1' }

before(async () => {
  t = await setupTestDb([fieldCryptoMigrations])
  await t.system.query(`insert into platform.tenants (id, slug, name, type) values ($1, 'fc-a', 'A', 'institution'), ($2, 'fc-b', 'B', 'institution')`, [A, B])
})
after(() => t.close())

test('round trip; fresh IV per value; ciphertext is not the plaintext', async () => {
  const fc = createFieldCrypto({ system: t.system, keyManager: km })
  const msg = 'मेरा उत्तर 42 है — my answer is 42'
  const c1 = await fc.encrypt(A, F, msg)
  const c2 = await fc.encrypt(A, F, msg)
  assert.ok(isFieldCiphertext(c1))
  assert.notEqual(c1, c2)
  assert.ok(!c1.includes('42'))
  assert.equal(await fc.decrypt(A, F, c1), msg)
  // a second instance (another process) decrypts with the same stored key
  assert.equal(await createFieldCrypto({ system: t.system, keyManager: km }).decrypt(A, F, c2), msg)
})

test('bound to tenant, table, column and record: moved ciphertext fails', async () => {
  const fc = createFieldCrypto({ system: t.system, keyManager: km })
  const c = await fc.encrypt(A, F, 'secret')
  await fc.encrypt(B, F, 'make B have a key')
  await assert.rejects(fc.decrypt(B, F, c), /could not be decrypted/)
  await assert.rejects(fc.decrypt(A, { ...F, recordId: 'row-2' }, c), /could not be decrypted/)
  await assert.rejects(fc.decrypt(A, { ...F, column: 'segments' }, c), /could not be decrypted/)
  await assert.rejects(fc.decrypt(A, { ...F, table: 'other.mod:turns' }, c), /could not be decrypted/)
})

test('tampering is detected (ciphertext, tag, iv, version)', async () => {
  const fc = createFieldCrypto({ system: t.system, keyManager: km })
  const c = await fc.encrypt(A, F, 'do not change me')
  const parts = c.split('.')
  const flip = (s: string) => { const b = Buffer.from(s, 'base64url'); b[0] = b[0]! ^ 1; return b.toString('base64url') }
  for (const i of [2, 3, 4]) {
    const bad = [...parts]
    bad[i] = flip(bad[i]!)
    await assert.rejects(fc.decrypt(A, F, bad.join('.')), /could not be decrypted/, `part ${i}`)
  }
  await assert.rejects(fc.decrypt(A, F, ['fc1', '99', ...parts.slice(2)].join('.')), /could not be decrypted/)
  await assert.rejects(fc.decrypt(A, F, 'plain text'), /could not be decrypted/)
})

test('a different master key cannot unwrap the tenant key', async () => {
  const c = await createFieldCrypto({ system: t.system, keyManager: km }).decrypt(A, F, await createFieldCrypto({ system: t.system, keyManager: km }).encrypt(A, F, 'x'))
  assert.equal(c, 'x')
  const other = createFieldCrypto({ system: t.system, keyManager: localKeyManager(randomBytes(32)) })
  const ct = await createFieldCrypto({ system: t.system, keyManager: km }).encrypt(A, F, 'y')
  await assert.rejects(other.decrypt(A, F, ct))
})

test('rotation: new values use the new version, old values still decrypt', async () => {
  const fc = createFieldCrypto({ system: t.system, keyManager: km })
  const old = await fc.encrypt(A, F, 'before')
  const v = await fc.rotate(A)
  assert.ok(v >= 2)
  const fresh = await fc.encrypt(A, F, 'after')
  assert.equal(fresh.split('.')[1], String(v))
  assert.equal(await fc.decrypt(A, F, old), 'before')
  assert.equal(await createFieldCrypto({ system: t.system, keyManager: km }).decrypt(A, F, fresh), 'after')
  const active = await t.system.query<{ n: number }>(`select count(*)::int as n from platform.field_data_keys where tenant_id = $1 and status = 'active'`, [A])
  assert.equal(active.rows[0]!.n, 1)
})

test('concurrent first use creates exactly one key; the app role cannot read wrapped keys', async () => {
  const C = newId()
  await t.system.query(`insert into platform.tenants (id, slug, name, type) values ($1, 'fc-c', 'C', 'institution')`, [C])
  const outs = await Promise.all(Array.from({ length: 8 }, () => createFieldCrypto({ system: t.system, keyManager: km }).encrypt(C, F, 'race')))
  const fc = createFieldCrypto({ system: t.system, keyManager: km })
  for (const o of outs) assert.equal(await fc.decrypt(C, F, o), 'race')
  assert.equal((await t.system.query<{ n: number }>('select count(*)::int as n from platform.field_data_keys where tenant_id = $1', [C])).rows[0]!.n, 1)
  await assert.rejects(t.db.withTenant({ tenantId: C }, (tx) => tx.query('select wrapped_key from platform.field_data_keys')), /permission denied/)
})
