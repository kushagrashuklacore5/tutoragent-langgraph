/** Institution SSO through the real HTTP endpoints, against an in-process mock OpenID Provider. */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { migrate, createDatabase } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { createTestDatabase, type TestDatabase } from '@platform/tenancy-db/testing'
import { memorySealer, memoryTransport } from '@platform/identity'
import { configureLogging } from '@platform/observability'
import { migrationSetsFor } from '@platform/module-runtime'
import { createApp, type App } from '@platform/app-api'
import { KM } from './helpers.ts'
import { startMockProvider, type MockProvider } from '../packages/identity/test/mock-oidc.ts'

let test_: TestDatabase
let app: App
let url: string
let server: http.Server
let idp: MockProvider
let closeAll: () => Promise<void>
const mail = memoryTransport()
const logs: string[] = []

async function call(method: string, path: string, opts: { token?: string; body?: unknown; cookie?: string; origin?: string } = {}) {
  const res = await fetch(url + path, {
    method, redirect: 'manual',
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: res.status, json, location: res.headers.get('location') ?? '', cookies: res.headers.getSetCookie() }
}

async function signInMagic(slug: string, email: string) {
  mail.sent.length = 0
  await call('POST', '/api/auth/magic-link', { body: { tenantSlug: slug, email } })
  const token = /#token=([A-Za-z0-9_-]+)/.exec(mail.sent.at(-1)!.text)![1]
  return (await call('POST', '/api/auth/verify', { body: { token, ageAttestation: 'adult' } })).json.sessionToken as string
}

before(async () => {
  configureLogging({ level: 'debug', sink: (l) => logs.push(l) })
  test_ = await createTestDatabase('sso')
  await migrate(test_.ownerUrl, migrationSetsFor([]))
  const db = createDatabase(test_.appUrl, { max: 5 })
  const system = createSystemDatabase(test_.systemUrl, { max: 5 })
  app = createApp({
    env: 'test', db, system, keyManager: KM, mail, publicBaseUrl: 'http://app.test', allowedOrigins: ['http://app.test'], modules: [], moduleCacheMs: 0,
    sso: { sealer: memorySealer(), oidc: { allowInsecureHttp: true, allowPrivateNetwork: true, jwksMinRefetchMs: 0 }, startsPerIpPerMinute: 50 },
  })
  server = http.createServer((req, res) => void app.handler(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  idp = await startMockProvider()
  idp.clients.set('client-a', 'super-secret-client-value')
  await app.identity.createTenant({ slug: 'uni-a', name: 'A', adminEmail: 'admin@a.test' })
  await app.identity.createTenant({ slug: 'uni-b', name: 'B', adminEmail: 'admin@b.test' })
  closeAll = async () => {
    await idp.close()
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
    await db.close()
    await system.close()
    await test_.drop()
  }
})
after(() => closeAll())

test('SSO routes are public only for start/callback; admin routes need platform:sso.manage', async () => {
  const routes = app.routeTable()
  assert.ok(routes.includes('GET /api/auth/sso/:tenantSlug/start [public]'))
  assert.ok(routes.includes('GET /api/auth/sso/callback [public]'))
  assert.ok(routes.includes('PUT /api/admin/sso [platform:sso.manage]'))
  assert.ok(routes.includes('POST /api/admin/sso/test [platform:sso.manage]'))
})

test('tenant admin configures SSO; the client secret is never returned; students are refused', async () => {
  const adminA = await signInMagic('uni-a', 'admin@a.test')
  assert.equal((await call('POST', '/api/members', { token: adminA, body: { email: 'stu@a.test', roles: ['student'] } })).status, 200)
  const stu = await signInMagic('uni-a', 'stu@a.test')
  assert.equal((await call('PUT', '/api/admin/sso', { token: stu, body: { issuer: idp.issuer, clientId: 'x' } })).status, 403)

  const put = await call('PUT', '/api/admin/sso', { token: adminA, body: { issuer: idp.issuer, clientId: 'client-a', clientSecret: 'super-secret-client-value', allowedDomains: ['a.test'], enabled: true } })
  assert.equal(put.status, 200, JSON.stringify(put.json))
  assert.equal(put.json.config.hasClientSecret, true)
  const get = await call('GET', '/api/admin/sso', { token: adminA })
  assert.ok(!JSON.stringify(get.json).includes('super-secret'))
  assert.equal((await call('POST', '/api/admin/sso/test', { token: adminA })).json.ok, true)
  // cookie-authenticated config change from a foreign origin is rejected (CSRF)
  assert.equal((await call('PUT', '/api/admin/sso', { cookie: `ebs=${adminA}`, origin: 'https://evil.test', body: { enabled: false } })).status, 403)
  // other tenant sees nothing
  const adminB = await signInMagic('uni-b', 'admin@b.test')
  assert.equal((await call('GET', '/api/admin/sso', { token: adminB })).json.config, null)
})

test('browser flow: start redirects to the IdP with a binding cookie; callback sets the session cookie', async () => {
  const start = await call('GET', '/api/auth/sso/uni-a/start?returnTo=/learn')
  assert.equal(start.status, 302)
  assert.ok(start.location.startsWith(`${idp.issuer}/authorize?`))
  const binder = start.cookies.find((c) => c.startsWith('ebs_sso='))!
  assert.match(binder, /HttpOnly; SameSite=Lax; Path=\/api\/auth\/sso/)
  const { code, state } = idp.authorize(start.location, { email: 'stu@a.test', email_verified: true })
  const cb = await call('GET', `/api/auth/sso/callback?state=${state}&code=${code}`, { cookie: binder.split(';')[0] })
  assert.equal(cb.status, 302)
  assert.equal(cb.location, 'http://app.test/learn')
  const session = cb.cookies.find((c) => c.startsWith('ebs=') && !c.startsWith('ebs=;'))!
  assert.match(session, /HttpOnly; SameSite=Lax; Path=\//)
  const me = await call('GET', '/api/me', { cookie: session.split(';')[0] })
  assert.equal(me.json.email, 'stu@a.test')
})

test('callback without the binding cookie (login CSRF) or with a replayed state fails to the error page', async () => {
  const start = await call('GET', '/api/auth/sso/uni-a/start')
  const { code, state } = idp.authorize(start.location, { email: 'stu@a.test', email_verified: true })
  const cb = await call('GET', `/api/auth/sso/callback?state=${state}&code=${code}`)
  assert.equal(cb.status, 302)
  assert.equal(cb.location, 'http://app.test/auth/sso-error?code=sso_failed')
  assert.ok(!cb.cookies.some((c) => c.startsWith('ebs=') && !c.startsWith('ebs=;')))
  const replay = await call('GET', `/api/auth/sso/callback?state=${state}&code=${code}`, { cookie: start.cookies[0]!.split(';')[0] })
  assert.match(replay.location, /sso-error/)
})

test('unconfigured tenant and first-time users take the right paths', async () => {
  assert.match((await call('GET', '/api/auth/sso/uni-b/start')).location, /sso-error\?code=sso_not_available/)
  const adminA = await signInMagic('uni-a', 'admin@a.test')
  await call('POST', '/api/members', { token: adminA, body: { email: 'new@a.test', roles: ['student'] } })
  const start = await call('GET', '/api/auth/sso/uni-a/start')
  const { code, state } = idp.authorize(start.location, { email: 'new@a.test', email_verified: true })
  const cb = await call('GET', `/api/auth/sso/callback?state=${state}&code=${code}`, { cookie: start.cookies[0]!.split(';')[0] })
  assert.match(cb.location, /^http:\/\/app\.test\/auth\/verify#token=[A-Za-z0-9_-]+&sso=1$/)
  const token = /#token=([A-Za-z0-9_-]+)/.exec(cb.location)![1]
  assert.equal((await call('POST', '/api/auth/verify', { body: { token } })).json.error.code, 'age_attestation_required')
  assert.equal((await call('POST', '/api/auth/verify', { body: { token, ageAttestation: 'adult' } })).status, 200)
})

test('no tokens, codes or client secrets appear in logs', () => {
  const all = logs.join('\n')
  assert.ok(!all.includes('super-secret-client-value'))
  assert.ok(!/id_token|eyJ[A-Za-z0-9_-]{10,}\./.test(all))
})
