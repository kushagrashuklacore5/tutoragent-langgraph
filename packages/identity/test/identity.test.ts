import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createIdentityService, memoryTransport, PermissionRegistry, definePlatformPermissions } from '@platform/identity'
import { setupTestDb, type PlatformTestDb } from '@platform/testing'

let t: PlatformTestDb
let mail: ReturnType<typeof memoryTransport>
let id: ReturnType<typeof createIdentityService>

const tokenFrom = (text: string) => /#token=([A-Za-z0-9_-]+)/.exec(text)![1]!

before(async () => {
  t = await setupTestDb()
  mail = memoryTransport()
  id = createIdentityService({ system: t.system, db: t.db, mail, publicBaseUrl: 'https://app.test' })
  await id.createTenant({ slug: 'univ-a', name: 'University A', adminEmail: 'admin@a.test' })
  await id.createTenant({ slug: 'univ-b', name: 'University B', adminEmail: 'admin@b.test' })
})
after(() => t.close())

async function signIn(slug: string, email: string, age: 'adult' | 'minor' | undefined = 'adult') {
  mail.sent.length = 0
  await id.requestMagicLink({ tenantSlug: slug, email })
  const msg = mail.sent.at(-1)
  assert.ok(msg, 'magic link sent')
  const r = await id.verifyMagicLink({ token: tokenFrom(msg.text), ageAttestation: age })
  return (await id.resolveSession(r.sessionToken))!
}

test('magic-link sign-in creates a session with tenant roles', async () => {
  const auth = await signIn('univ-a', 'Admin@A.test')
  assert.equal(auth.email, 'admin@a.test')
  assert.deepEqual(auth.roles, ['tenant_admin'])
})

test('non-members get no link and the response does not reveal it', async () => {
  mail.sent.length = 0
  await id.requestMagicLink({ tenantSlug: 'univ-a', email: 'stranger@x.test' })
  await id.requestMagicLink({ tenantSlug: 'univ-a', email: 'admin@b.test' }) // member of another tenant
  assert.equal(mail.sent.length, 0)
})

test('links are single-use and expire', async () => {
  mail.sent.length = 0
  await id.requestMagicLink({ tenantSlug: 'univ-b', email: 'admin@b.test' })
  const token = tokenFrom(mail.sent[0]!.text)
  await id.verifyMagicLink({ token, ageAttestation: 'adult' })
  await assert.rejects(id.verifyMagicLink({ token, ageAttestation: 'adult' }), { code: 'unauthorized' })
  await t.system.query(`update platform.login_tokens set expires_at = now() - interval '1 second'`)
  mail.sent.length = 0
  await id.requestMagicLink({ tenantSlug: 'univ-b', email: 'admin@b.test' })
  const t2 = tokenFrom(mail.sent[0]!.text)
  await t.system.query(`update platform.login_tokens set expires_at = now() - interval '1 second' where used_at is null`)
  await assert.rejects(id.verifyMagicLink({ token: t2 }), { code: 'unauthorized' })
})

test('adults-only pilot: attestation required, minors blocked (PD-09)', async () => {
  const admin = await signIn('univ-a', 'admin@a.test')
  await id.upsertMember(admin, { email: 'young@a.test', roles: ['student'] })
  mail.sent.length = 0
  await id.requestMagicLink({ tenantSlug: 'univ-a', email: 'young@a.test' })
  await assert.rejects(id.verifyMagicLink({ token: tokenFrom(mail.sent[0]!.text) }), { code: 'age_attestation_required' })
  mail.sent.length = 0
  await id.requestMagicLink({ tenantSlug: 'univ-a', email: 'young@a.test' })
  await assert.rejects(id.verifyMagicLink({ token: tokenFrom(mail.sent[0]!.text), ageAttestation: 'minor' }), { code: 'age_restricted' })
  // a later "adult" claim does not override the recorded minor attestation
  mail.sent.length = 0
  await id.requestMagicLink({ tenantSlug: 'univ-a', email: 'young@a.test' })
  await assert.rejects(id.verifyMagicLink({ token: tokenFrom(mail.sent[0]!.text), ageAttestation: 'adult' }), { code: 'age_restricted' })
})

test('rate limit on magic links per user', async () => {
  const adminB = await signIn('univ-b', 'admin@b.test')
  await id.upsertMember(adminB, { email: 'spam@b.test', roles: ['student'] })
  mail.sent.length = 0
  for (let i = 0; i < 8; i++) await id.requestMagicLink({ tenantSlug: 'univ-b', email: 'spam@b.test' })
  assert.ok(mail.sent.length <= 5)
})

test('tenant admin manages members only in their own tenant', async () => {
  const adminA = await signIn('univ-a', 'admin@a.test')
  const adminB = await signIn('univ-b', 'admin@b.test')
  await id.upsertMember(adminA, { email: 'stu@a.test', roles: ['student'] })
  const a = await id.listMembers(adminA)
  const b = await id.listMembers(adminB)
  assert.ok(a.some((m) => m.email === 'stu@a.test'))
  assert.ok(!b.some((m) => m.email === 'stu@a.test'))
})

test('disabling a member revokes their sessions', async () => {
  const adminA = await signIn('univ-a', 'admin@a.test')
  await id.upsertMember(adminA, { email: 'temp@a.test', roles: ['student'] })
  const stu = await signIn('univ-a', 'temp@a.test')
  mail.sent.length = 0
  await id.requestMagicLink({ tenantSlug: 'univ-a', email: 'temp@a.test' })
  const s = await id.verifyMagicLink({ token: tokenFrom(mail.sent[0]!.text) })
  assert.ok(await id.resolveSession(s.sessionToken))
  await id.disableMember(adminA, stu.userId)
  assert.equal(await id.resolveSession(s.sessionToken), null)
})

test('permission registry: namespacing, default roles, unknown keys denied', () => {
  const reg = new PermissionRegistry()
  definePlatformPermissions(reg)
  reg.define({ key: 'education.tutor:session.create', description: '', roles: ['student'], owner: 'education.tutor' })
  assert.throws(() => reg.define({ key: 'other:x.y', description: '', roles: [], owner: 'education.tutor' }), { code: 'permission_namespace' })
  assert.ok(reg.allows({ roles: ['student'], isPlatformAdmin: false }, 'education.tutor:session.create'))
  assert.ok(!reg.allows({ roles: ['student'], isPlatformAdmin: false }, 'platform:members.manage'))
  assert.ok(!reg.allows({ roles: ['tenant_admin'], isPlatformAdmin: false }, 'platform:ai.admin'))
  assert.ok(reg.allows({ roles: [], isPlatformAdmin: true }, 'platform:ai.admin'))
  assert.ok(!reg.allows({ roles: ['student'], isPlatformAdmin: true }, 'removed.module:anything'))
})
