import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createIdentityService, createSsoService, memorySealer, memoryTransport, type SsoService } from '@platform/identity'
import { setupTestDb, type PlatformTestDb } from '@platform/testing'
import { makeKey, signJwt, startMockProvider, type MockProvider } from './mock-oidc.ts'

let t: PlatformTestDb
let id: ReturnType<typeof createIdentityService>
let sso: SsoService
let idpA: MockProvider
let idpB: MockProvider
const sealer = memorySealer()
const mail = memoryTransport()
const admins: Record<string, { tenantId: string; userId: string; roles: string[] }> = {}
const OIDC = { allowInsecureHttp: true, allowPrivateNetwork: true, jwksMinRefetchMs: 0 }
const newSso = (oidc: Record<string, unknown> = {}) => createSsoService({ system: t.system, db: t.db, sealer, publicBaseUrl: 'https://app.test', oidc: { ...OIDC, ...oidc } })

before(async () => {
  t = await setupTestDb()
  id = createIdentityService({ system: t.system, db: t.db, mail, publicBaseUrl: 'https://app.test' })
  sso = newSso()
  idpA = await startMockProvider({ alg: 'RS256' })
  idpB = await startMockProvider({ alg: 'ES256', issuerPath: '/tenant-b/v2.0' })
  idpA.clients.set('client-a', 'secret-a-very-private')
  idpB.clients.set('client-b', 'secret-b-very-private')
  for (const [slug, idp, client, domain] of [['univ-a', idpA, 'client-a', 'a.test'], ['univ-b', idpB, 'client-b', 'b.test']] as const) {
    const r = await id.createTenant({ slug, name: slug, adminEmail: `admin@${domain}` })
    admins[slug] = { tenantId: r.tenantId, userId: r.adminUserId, roles: ['tenant_admin'] }
    await sso.setConfig(admins[slug]!, { issuer: idp.issuer, clientId: client, clientSecret: idp.clients.get(client)!, allowedDomains: [domain], enabled: true })
  }
  // admin@a.test has attested adult; members for scenarios
  await t.system.query(`update platform.users set age_attestation = 'adult' where email in ('admin@a.test', 'admin@b.test')`)
  await id.upsertMember({ ...admins['univ-a']!, email: 'admin@a.test', isPlatformAdmin: false, sessionId: '' }, { email: 'stu@a.test', roles: ['student'] })
  await t.system.query(`update platform.users set age_attestation = 'adult' where email = 'stu@a.test'`)
})
after(async () => {
  await idpA?.close()
  await idpB?.close()
  await t.close()
})

const claimsFor = (email: string, extra: Record<string, unknown> = {}) => ({ email, email_verified: true, name: 'Test User', ...extra })

async function login(slug: string, idp: MockProvider, claims: Record<string, unknown>, o: Parameters<MockProvider['authorize']>[2] & { svc?: SsoService; binder?: string } = {}) {
  const svc = o.svc ?? sso
  const s = await svc.start({ tenantSlug: slug, returnTo: '/dashboard' })
  assert.equal(s.kind, 'redirect', JSON.stringify(s))
  if (s.kind !== 'redirect') throw new Error('unreachable')
  const { code, state } = idp.authorize(s.location, claims, o)
  const r = await svc.callback({ state, code, binder: o.binder ?? s.binder })
  return { r, state, code, binder: s.binder }
}
const lastFailure = async () => (await t.system.query<{ metadata: { reason: string } }>(
  `select metadata from platform.audit_events where action = 'auth.sso.login_failed' order by created_at desc limit 1`)).rows[0]?.metadata.reason

test('start: authorization request uses code flow, PKCE S256, state and nonce, fixed redirect URI', async () => {
  const s = await sso.start({ tenantSlug: 'univ-a' })
  assert.equal(s.kind, 'redirect')
  if (s.kind !== 'redirect') return
  const u = new URL(s.location)
  assert.equal(u.origin + u.pathname, `${idpA.issuer}/authorize`)
  assert.equal(u.searchParams.get('response_type'), 'code')
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(u.searchParams.get('redirect_uri'), 'https://app.test/api/auth/sso/callback')
  assert.ok(u.searchParams.get('state')!.length >= 40 && u.searchParams.get('nonce')!.length >= 40)
  assert.match(u.searchParams.get('scope')!, /openid/)
  // nothing secret in the URL
  assert.ok(!s.location.includes('secret-a'))
  const unknown = await sso.start({ tenantSlug: 'no-such-tenant' })
  assert.equal(unknown.kind, 'error')
})

test('happy path: verified member gets a session in the IdP tenant; audited without tokens', async () => {
  const { r, code } = await login('univ-a', idpA, claimsFor('Admin@A.test'))
  assert.equal(r.kind, 'session', JSON.stringify(r))
  if (r.kind !== 'session') return
  assert.equal(r.location, 'https://app.test/dashboard')
  const auth = await id.resolveSession(r.sessionToken)
  assert.equal(auth?.email, 'admin@a.test')
  assert.equal(auth?.tenantId, admins['univ-a']!.tenantId)
  const audit = await t.system.query<{ action: string; metadata: unknown }>(`select action, metadata from platform.audit_events where action like 'auth.sso.%'`)
  assert.ok(audit.rows.some((a) => a.action === 'auth.sso.login_succeeded'))
  const dump = JSON.stringify(audit.rows)
  assert.ok(!dump.includes(r.sessionToken) && !dump.includes(code) && !dump.includes('secret-a'))
})

test('ES256 provider with an issuer path works (Entra-style issuer)', async () => {
  const { r } = await login('univ-b', idpB, claimsFor('admin@b.test'))
  assert.equal(r.kind, 'session')
})

test('bad signature is rejected', async () => {
  const forger = makeKey('RS256', idpA.signingKey.kid)
  const { r } = await login('univ-a', idpA, {}, { rawToken: (nonce) => signJwt({ iss: idpA.issuer, aud: 'client-a', sub: 's', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, nonce, ...claimsFor('admin@a.test') }, forger) })
  assert.equal(r.kind, 'error')
  assert.equal(await lastFailure(), 'id_token_bad_signature')
})

test('alg none and HS256 (public key as HMAC secret) are rejected', async () => {
  const body = (nonce: string) => Buffer.from(JSON.stringify({ iss: idpA.issuer, aud: 'client-a', sub: 's', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, nonce, ...claimsFor('admin@a.test') })).toString('base64url')
  const none = await login('univ-a', idpA, {}, { rawToken: (n) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${body(n)}.` })
  assert.equal(none.r.kind, 'error')
  assert.equal(await lastFailure(), 'id_token_alg_rejected')
  const hs = await login('univ-a', idpA, {}, {
    rawToken: (n) => {
      const h = Buffer.from(JSON.stringify({ alg: 'HS256', kid: idpA.signingKey.kid })).toString('base64url')
      const sig = createHmac('sha256', JSON.stringify(idpA.signingKey.publicJwk)).update(`${h}.${body(n)}`).digest('base64url')
      return `${h}.${body(n)}.${sig}`
    },
  })
  assert.equal(hs.r.kind, 'error')
  assert.equal(await lastFailure(), 'id_token_alg_rejected')
})

test('wrong audience, wrong issuer, multi-audience without azp are rejected', async () => {
  assert.equal((await login('univ-a', idpA, claimsFor('admin@a.test'), { tamper: (c) => ({ ...c, aud: 'someone-else' }) })).r.kind, 'error')
  assert.equal(await lastFailure(), 'id_token_wrong_audience')
  assert.equal((await login('univ-a', idpA, claimsFor('admin@a.test'), { tamper: (c) => ({ ...c, iss: 'https://evil.test' }) })).r.kind, 'error')
  assert.equal(await lastFailure(), 'id_token_wrong_issuer')
  assert.equal((await login('univ-a', idpA, claimsFor('admin@a.test'), { tamper: (c) => ({ ...c, aud: ['client-a', 'other'] }) })).r.kind, 'error')
  assert.equal(await lastFailure(), 'id_token_wrong_audience')
  assert.equal((await login('univ-a', idpA, claimsFor('admin@a.test'), { tamper: (c) => ({ ...c, aud: ['client-a', 'other'], azp: 'client-a' }) })).r.kind, 'session')
})

test('expired and not-yet-valid tokens are rejected (small skew tolerated)', async () => {
  const now = Math.floor(Date.now() / 1000)
  assert.equal((await login('univ-a', idpA, claimsFor('admin@a.test'), { tamper: (c) => ({ ...c, iat: now - 4000, exp: now - 3600 }) })).r.kind, 'error')
  assert.equal(await lastFailure(), 'id_token_expired')
  assert.equal((await login('univ-a', idpA, claimsFor('admin@a.test'), { tamper: (c) => ({ ...c, nbf: now + 600 }) })).r.kind, 'error')
  assert.equal(await lastFailure(), 'id_token_not_yet_valid')
  assert.equal((await login('univ-a', idpA, claimsFor('admin@a.test'), { tamper: (c) => ({ ...c, exp: now - 20 }) })).r.kind, 'session')
})

test('state is single-use and must be bound to the starting browser', async () => {
  const first = await login('univ-a', idpA, claimsFor('admin@a.test'))
  assert.equal(first.r.kind, 'session')
  const replay = await sso.callback({ state: first.state, code: first.code, binder: first.binder })
  assert.equal(replay.kind, 'error')
  assert.equal(await lastFailure(), 'state_invalid')
  const unbound = await login('univ-a', idpA, claimsFor('admin@a.test'), { binder: 'attacker-binder-value-xxxxxxxxxxxx' })
  assert.equal(unbound.r.kind, 'error')
  assert.equal(await lastFailure(), 'state_not_bound')
  // an unbound attempt burns the state: it cannot be retried with the right binder
  assert.equal((await sso.callback({ state: unbound.state, code: unbound.code, binder: unbound.binder })).kind, 'error')
  // expired state
  const s = await sso.start({ tenantSlug: 'univ-a' })
  if (s.kind !== 'redirect') return assert.fail()
  const { code, state } = idpA.authorize(s.location, claimsFor('admin@a.test'))
  await t.system.query(`update platform.sso_login_states set expires_at = now() - interval '1 second' where used_at is null`)
  assert.equal((await sso.callback({ state, code, binder: s.binder })).kind, 'error')
})

test('nonce mismatch is rejected', async () => {
  assert.equal((await login('univ-a', idpA, claimsFor('admin@a.test'), { tamper: (c) => ({ ...c, nonce: 'other-nonce' }) })).r.kind, 'error')
  assert.equal(await lastFailure(), 'id_token_nonce_mismatch')
})

test('IdP error response is handled without a session', async () => {
  const s = await sso.start({ tenantSlug: 'univ-a' })
  if (s.kind !== 'redirect') return assert.fail()
  const r = await sso.callback({ state: new URL(s.location).searchParams.get('state'), error: 'access_denied', binder: s.binder })
  assert.equal(r.kind, 'error')
  assert.equal(r.kind === 'error' && r.code, 'idp_error')
})

test('unverified email, disallowed domain and non-members are rejected', async () => {
  const unv = await login('univ-a', idpA, claimsFor('admin@a.test', { email_verified: false }))
  assert.equal(unv.r.kind === 'error' && unv.r.code, 'email_not_verified')
  const missing = await login('univ-a', idpA, { email: 'admin@a.test' })
  assert.equal(missing.r.kind === 'error' && missing.r.code, 'email_not_verified')
  const dom = await login('univ-a', idpA, claimsFor('admin@evil.test'))
  assert.equal(dom.r.kind === 'error' && dom.r.code, 'domain_not_allowed')
  const stranger = await login('univ-a', idpA, claimsFor('stranger@a.test'))
  assert.equal(stranger.r.kind === 'error' && stranger.r.code, 'not_a_member')
  assert.equal((await t.system.query(`select 1 from platform.users where email = 'stranger@a.test'`)).rowCount, 0, 'no self-provisioning by default')
})

test('disabled members cannot sign in via SSO', async () => {
  await id.upsertMember({ ...admins['univ-a']!, email: 'admin@a.test', isPlatformAdmin: false, sessionId: '' }, { email: 'gone@a.test', roles: ['student'] })
  const u = (await t.system.query<{ id: string }>(`update platform.users set age_attestation = 'adult' where email = 'gone@a.test' returning id`)).rows[0]!
  await id.disableMember({ ...admins['univ-a']!, email: 'admin@a.test', isPlatformAdmin: false, sessionId: '' }, u.id)
  const r = await login('univ-a', idpA, claimsFor('gone@a.test'))
  assert.equal(r.r.kind === 'error' && r.r.code, 'not_a_member')
})

test('JIT student provisioning only when the tenant enables it; attestation still required', async () => {
  await sso.setConfig(admins['univ-a']!, { jitStudentProvisioning: true })
  try {
    const r = await login('univ-a', idpA, claimsFor('newbie@a.test'))
    assert.equal(r.r.kind, 'attestation')
    const m = await t.system.query<{ roles: string[] }>(`select m.roles from platform.memberships m join platform.users u on u.id = m.user_id where u.email = 'newbie@a.test'`)
    assert.deepEqual(m.rows[0]?.roles, ['student'])
  } finally {
    await sso.setConfig(admins['univ-a']!, { jitStudentProvisioning: false })
  }
})

test('PD-09: first SSO login without attestation goes to the attestation step; minors are blocked', async () => {
  await id.upsertMember({ ...admins['univ-a']!, email: 'admin@a.test', isPlatformAdmin: false, sessionId: '' }, { email: 'fresh@a.test', roles: ['student'] })
  await id.upsertMember({ ...admins['univ-a']!, email: 'admin@a.test', isPlatformAdmin: false, sessionId: '' }, { email: 'young@a.test', roles: ['student'] })
  const tokenOf = (loc: string) => /#token=([A-Za-z0-9_-]+)/.exec(loc)![1]!

  const fresh = await login('univ-a', idpA, claimsFor('fresh@a.test'))
  assert.equal(fresh.r.kind, 'attestation')
  if (fresh.r.kind !== 'attestation') return
  assert.match(fresh.r.location, /^https:\/\/app\.test\/auth\/verify#token=/)
  await assert.rejects(id.verifyMagicLink({ token: tokenOf(fresh.r.location) }), { code: 'age_attestation_required' })
  const s = await id.verifyMagicLink({ token: tokenOf(fresh.r.location), ageAttestation: 'adult' })
  assert.ok(await id.resolveSession(s.sessionToken))
  assert.equal((await login('univ-a', idpA, claimsFor('fresh@a.test'))).r.kind, 'session', 'attested adult goes straight to a session')

  const young = await login('univ-a', idpA, claimsFor('young@a.test'))
  if (young.r.kind !== 'attestation') return assert.fail()
  await assert.rejects(id.verifyMagicLink({ token: tokenOf(young.r.location), ageAttestation: 'minor' }), { code: 'age_restricted' })
  const again = await login('univ-a', idpA, claimsFor('young@a.test'))
  assert.equal(again.r.kind === 'error' && again.r.code, 'age_restricted')
})

test('cross-tenant misuse: the IdP of tenant A cannot sign anyone into tenant B', async () => {
  // A's IdP vouching for a B member, inside A's flow: not a member of A (and domain not allowed)
  const viaA = await login('univ-a', idpA, claimsFor('admin@b.test'))
  assert.equal(viaA.r.kind, 'error')
  // a token minted by A's IdP injected into B's flow fails issuer/audience/signature checks
  const injected = await login('univ-b', idpB, {}, {
    rawToken: (nonce) => signJwt({ iss: idpA.issuer, aud: 'client-a', sub: 's', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, nonce, ...claimsFor('admin@b.test') }, idpA.signingKey),
  })
  assert.equal(injected.r.kind, 'error')
  // A's IdP minting a token claiming B's issuer/audience: signature is not from B's JWKS
  const forged = await login('univ-b', idpB, {}, {
    rawToken: (nonce) => signJwt({ iss: idpB.issuer, aud: 'client-b', sub: 's', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, nonce, ...claimsFor('admin@b.test') }, idpA.signingKey),
  })
  assert.equal(forged.r.kind, 'error')
  assert.match((await lastFailure())!, /^id_token_(unknown_key|bad_signature|alg_mismatch)$/)
  // a state started for tenant A cannot be completed with B's code (exchange happens at A's token endpoint)
  const sA = await sso.start({ tenantSlug: 'univ-a' })
  const sB = await sso.start({ tenantSlug: 'univ-b' })
  if (sA.kind !== 'redirect' || sB.kind !== 'redirect') return assert.fail()
  const codeB = idpB.authorize(sB.location, claimsFor('admin@b.test')).code
  const r = await sso.callback({ state: new URL(sA.location).searchParams.get('state'), code: codeB, binder: sA.binder })
  assert.equal(r.kind, 'error')
})

test('JWKS rotation: unknown kid triggers a refetch; refetches are rate-limited', async () => {
  const before = idpA.stats.jwks
  idpA.rotate('ES256')
  assert.equal((await login('univ-a', idpA, claimsFor('admin@a.test'))).r.kind, 'session')
  assert.equal(idpA.stats.jwks, before + 1)
  const limited = newSso({ jwksMinRefetchMs: 60_000 })
  assert.equal((await login('univ-a', idpA, claimsFor('admin@a.test'), { svc: limited })).r.kind, 'session')
  idpA.rotate('RS256')
  const n = idpA.stats.jwks
  assert.equal((await login('univ-a', idpA, claimsFor('admin@a.test'), { svc: limited })).r.kind, 'error')
  assert.equal((await login('univ-a', idpA, claimsFor('admin@a.test'), { svc: limited })).r.kind, 'error')
  assert.equal(idpA.stats.jwks, n, 'no refetch inside the rate-limit window')
  assert.equal(await lastFailure(), 'id_token_unknown_key')
})

test('claim mapping: Entra-style preferred_username + xms_edov', async () => {
  await sso.setConfig(admins['univ-b']!, { emailClaim: 'preferred_username', emailVerifiedClaim: 'xms_edov' })
  try {
    assert.equal((await login('univ-b', idpB, { preferred_username: 'admin@b.test', xms_edov: true })).r.kind, 'session')
    const r = await login('univ-b', idpB, { preferred_username: 'admin@b.test', email_verified: true })
    assert.equal(r.r.kind === 'error' && r.r.code, 'email_not_verified')
  } finally {
    await sso.setConfig(admins['univ-b']!, { emailClaim: 'email', emailVerifiedClaim: 'email_verified' })
  }
})

test('admin config: secret sealed and never returned; RLS isolates tenants; validation', async () => {
  const cfg = await sso.getConfig(admins['univ-a']!)
  assert.equal(cfg?.hasClientSecret, true)
  assert.ok(!JSON.stringify(cfg).includes('secret-a'))
  const raw = await t.system.query<{ client_secret_sealed: string }>('select client_secret_sealed from platform.tenant_idp_configs')
  assert.ok(raw.rows.every((r) => !r.client_secret_sealed.includes('secret-')))
  // sealed secret is bound to its tenant
  const a = raw.rows[0]!.client_secret_sealed
  await assert.rejects(sealer.unseal(a, { tenantId: admins['univ-b']!.tenantId, purpose: 'sso.client_secret' }))
  // RLS: B sees only its own config
  assert.equal((await sso.getConfig(admins['univ-b']!))?.clientId, 'client-b')
  await assert.rejects(sso.setConfig(admins['univ-a']!, { allowedDomains: [] }), { code: 'domains_required' })
  await assert.rejects(sso.setConfig(admins['univ-a']!, { allowedDomains: ['not a domain'] }), { code: 'domains_invalid' })
  // discovery issuer must match exactly
  const liar = await startMockProvider({ discoveryIssuer: 'https://accounts.example.test' })
  try {
    await assert.rejects(sso.setConfig(admins['univ-a']!, { issuer: liar.issuer }), { code: 'oidc_issuer_mismatch' })
  } finally { await liar.close() }
  assert.deepEqual(await sso.testConfig(admins['univ-a']!), { ok: true, authorizationEndpoint: `${idpA.issuer}/authorize`, tokenEndpoint: `${idpA.issuer}/token` })
  // private-network issuers are refused unless explicitly allowed (SSRF)
  const strict = createSsoService({ system: t.system, db: t.db, sealer, publicBaseUrl: 'https://app.test', oidc: { allowInsecureHttp: true } })
  await assert.rejects(strict.setConfig(admins['univ-a']!, { issuer: idpA.issuer }), { code: 'oidc_url_private' })
  const httpsOnly = createSsoService({ system: t.system, db: t.db, sealer, publicBaseUrl: 'https://app.test' })
  await assert.rejects(httpsOnly.setConfig(admins['univ-a']!, { issuer: idpA.issuer }), { code: 'oidc_url_insecure' })
  // disabling stops sign-in
  await sso.setConfig(admins['univ-a']!, { enabled: false })
  assert.equal((await sso.start({ tenantSlug: 'univ-a' })).kind, 'error')
  await sso.setConfig(admins['univ-a']!, { enabled: true })
  const audit = await t.system.query<{ metadata: unknown }>(`select metadata from platform.audit_events where action = 'sso.config_updated'`)
  assert.ok(audit.rowCount > 0 && !JSON.stringify(audit.rows).includes('secret-'))
})

test('per-tenant start rate limit', async () => {
  const limited = createSsoService({ system: t.system, db: t.db, sealer, publicBaseUrl: 'https://app.test', oidc: OIDC, startsPerTenantPerMinute: 2 })
  await t.system.query('delete from platform.sso_login_states')
  assert.equal((await limited.start({ tenantSlug: 'univ-b' })).kind, 'redirect')
  assert.equal((await limited.start({ tenantSlug: 'univ-b' })).kind, 'redirect')
  const r = await limited.start({ tenantSlug: 'univ-b' })
  assert.equal(r.kind === 'error' && r.code, 'rate_limited')
})
