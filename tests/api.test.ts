import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { manifest as hello } from '@modules/examples-hello-agent'
import { manifest as echo } from '@modules/examples-echo-agent'
import { createWorker } from '@platform/jobs'
import { createDatabase } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { startHarness, type Harness } from './helpers.ts'

let h: Harness
let adminA: string
let adminB: string
let studentA: string

before(async () => {
  h = await startHarness([hello, echo])
  await h.app.identity.createTenant({ slug: 'uni-a', name: 'A', adminEmail: 'admin@a.test' })
  await h.app.identity.createTenant({ slug: 'uni-b', name: 'B', adminEmail: 'admin@b.test' })
  adminA = await h.signIn('uni-a', 'admin@a.test')
  adminB = await h.signIn('uni-b', 'admin@b.test')
  assert.equal((await h.call('POST', '/api/members', adminA, { email: 'stu@a.test', roles: ['student'] })).status, 200)
  studentA = await h.signIn('uni-a', 'stu@a.test')
})
after(() => h.close())

test('health and auth basics', async () => {
  assert.deepEqual((await h.call('GET', '/health')).json, { status: 'ok' })
  assert.equal((await h.call('GET', '/api/me')).status, 401)
  const me = await h.call('GET', '/api/me', studentA)
  assert.equal(me.json.email, 'stu@a.test')
  assert.deepEqual(me.json.roles, ['student'])
})

test('every non-public route declares a known permission', () => {
  const pub = h.app.routes.filter((r) => r.permission === 'public').map((r) => `${r.method} ${r.path}`).sort()
  assert.deepEqual(pub, ['GET /health', 'GET /metrics', 'POST /api/auth/magic-link', 'POST /api/auth/verify'])
  for (const r of h.app.routes.filter((x) => x.permission !== 'public')) assert.ok(h.app.platform.permissions.has(r.permission), `${r.path}`)
})

test('permissions: a student cannot manage members or configure AI', async () => {
  assert.equal((await h.call('POST', '/api/members', studentA, { email: 'x@a.test', roles: ['student'] })).status, 403)
  assert.equal((await h.call('GET', '/api/admin/ai/connections', adminA)).status, 403) // tenant admin is not platform admin
})

test('CSRF: cookie-authenticated POST from a foreign origin is rejected', async () => {
  const r = await h.call('POST', '/api/members', undefined, { email: 'y@a.test', roles: ['student'] }, { cookie: `ebs=${adminA}`, origin: 'https://evil.test' })
  assert.equal(r.status, 403)
  const ok = await h.call('POST', '/api/members', undefined, { email: 'y@a.test', roles: ['student'] }, { cookie: `ebs=${adminA}`, origin: 'http://app.test' })
  assert.equal(ok.status, 200)
})

test('module routes are 404 until the module is enabled for the tenant', async () => {
  assert.equal((await h.call('GET', '/api/m/examples.hello/greetings', studentA)).status, 404)
  const sys = createSystemDatabase(h.test.systemUrl)
  await sys.query(`update platform.tenants set enabled_modules = '{examples.hello,examples.echo}'`)
  await sys.close()
})

test('module data is isolated per tenant; jobs and events flow through the worker', async () => {
  const created = await h.call('POST', '/api/m/examples.hello/greetings', studentA, { text: 'namaste' })
  if (created.status === 404) return assert.fail('module should be enabled (cache?)')
  assert.equal(created.status, 200)
  const listA = await h.call('GET', '/api/m/examples.hello/greetings', studentA)
  const listB = await h.call('GET', '/api/m/examples.hello/greetings', adminB)
  assert.equal(listA.json.length, 1)
  assert.equal(listB.json.length, 0)
  const db = createDatabase(h.test.appUrl)
  const sys = createSystemDatabase(h.test.systemUrl)
  const w = createWorker({ system: sys, db, handlers: h.app.platform.jobs })
  await w.drain()
  const echoes = await h.call('GET', '/api/m/examples.echo/echoes', studentA)
  assert.equal(echoes.json.length, 1, 'echo module received the event')
  const processed = await db.withTenant({ tenantId: (await h.call('GET', '/api/me', studentA)).json.tenantId }, (tx) => tx.query<{ processed: boolean }>('select processed from examples_hello.greetings'))
  assert.equal(processed.rows[0]!.processed, true)
  await db.close()
  await sys.close()
})

test('modules reach AI only through the gateway, by routing configuration', async () => {
  // platform admin configures a connection + route (provider choice is config, not module code)
  const sys = createSystemDatabase(h.test.systemUrl)
  await sys.query(`update platform.users set is_platform_admin = true where email = 'admin@a.test'`)
  await sys.close()
  const policy = { processingLocation: 'IN', selfHosted: true, retentionDays: 0, zeroRetention: true, trainsOnData: false, dpaInPlace: true, termsVerified: true }
  const conn = await h.call('POST', '/api/admin/ai/connections', adminA, { adapter: 'fake', name: 'fake', baseUrl: 'http://127.0.0.1:9', allowPrivateNetwork: true, dataPolicy: policy })
  assert.equal(conn.status, 200, JSON.stringify(conn.json))
  assert.equal((await h.call('POST', '/api/admin/ai/models/approve', adminA, { adapter: 'fake', modelId: 'fake-chat', declared: { operations: ['generate', 'stream'] } })).status, 204)
  const dep = await h.call('POST', '/api/admin/ai/deployments', adminA, { connectionId: conn.json.id, modelId: 'fake-chat' })
  assert.equal((await h.call('PUT', '/api/admin/ai/routes', adminA, { target: 'category:examples_chat', candidates: [{ deploymentId: dep.json.id }] })).status, 200)
  const r = await h.call('POST', '/api/m/examples.hello/greetings/ai', studentA, { prompt: 'hello there' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.match(r.json.text, /fake\(fake-chat\): hello there/)
  const usage = await h.call('GET', '/api/ai/usage', adminA)
  assert.ok(usage.json.some((u: { task_id: string }) => u.task_id === 'examples.hello.compose'))
})

test('errors do not leak internals', async () => {
  const r = await h.call('POST', '/api/m/examples.hello/greetings', studentA, { text: '' })
  assert.equal(r.status, 400)
  assert.equal(r.json.error.code, 'text_invalid')
  const bad = await h.call('POST', '/api/auth/verify', undefined, { token: 'x'.repeat(40) })
  assert.equal(bad.status, 401)
  assert.ok(!JSON.stringify(bad.json).includes('stack'))
})
