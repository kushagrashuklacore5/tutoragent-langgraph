import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { newId } from '@platform/core'
import { configureLogging } from '@platform/observability'
import { setupTestDb, type PlatformTestDb } from '@platform/testing'
import {
  ADAPTERS, GatewayError, TaskRegistry, aiGatewayMigrations, createGateway, localKeyManager,
  type Actor, type Capabilities, type DataPolicy, type Gateway, type TaskDefinition,
} from '@platform/ai-gateway'
import { createFakeAdapter } from '@platform/ai-gateway/testing'
import { startMock, MOCK_KEY } from '../conformance/mocks.ts'

const VERIFIED: DataPolicy = { processingLocation: 'IN', selfHosted: false, retentionDays: 0, zeroRetention: true, trainsOnData: false, dpaInPlace: true, termsVerified: true }
const UNVERIFIED: DataPolicy = { ...VERIFIED, termsVerified: false, trainsOnData: null, zeroRetention: false, dpaInPlace: false }
const CHAT: Partial<Capabilities> = { operations: ['generate', 'stream'], structuredOutput: 'json_mode', tools: 'single', contextWindow: 32000 }
const PLAIN: Partial<Capabilities> = { operations: ['generate', 'stream'], structuredOutput: 'none', tools: 'none', contextWindow: 32000 }

const TASKS: TaskDefinition[] = [
  { id: 'hello.chat', owner: 'hello', category: 'tutoring', requires: { operation: 'generate' }, dataClass: 'course_content', determinism: 'flexible', fallback: 'eligible_only' },
  { id: 'hello.stream', owner: 'hello', category: 'tutoring_stream', requires: { operation: 'stream' }, dataClass: 'course_content', determinism: 'flexible', fallback: 'eligible_only' },
  { id: 'hello.extract', owner: 'hello', category: 'extraction', requires: { operation: 'generate', structuredOutput: 'json_mode' }, dataClass: 'student_content', determinism: 'flexible', fallback: 'eligible_only',
    outputSchema: { type: 'object', properties: { answer: { type: 'string' }, n: { type: 'integer' } }, required: ['answer', 'n'] } },
  { id: 'hello.grade', owner: 'hello', category: 'assessment', requires: { operation: 'generate', structuredOutput: 'json_mode' }, dataClass: 'student_content', determinism: 'pinned', fallback: 'none',
    outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } },
  { id: 'hello.embed', owner: 'hello', category: 'embeddings', requires: { operation: 'embed', embeddingDimensions: 4 }, dataClass: 'course_content', determinism: 'flexible', fallback: 'none' },
]

let t: PlatformTestDb
let gw: Gateway
const A = newId()
const B = newId()
const admin: Actor = { userId: null, tenantId: null, isPlatformAdmin: true, roles: [] }
const fakeA = createFakeAdapter('fake-a', { failModels: { 'flaky': 'rate_limited', 'broken': 'provider_error' } })
const fakeB = createFakeAdapter('fake-b')
const logs: string[] = []
const KM = localKeyManager(randomBytes(32)) // one master key per database, as in production

async function deploy(adapter: string, model: string, declared: Partial<Capabilities>, policy: DataPolicy = VERIFIED, extra: Record<string, unknown> = {}, g = gw) {
  const conn = await g.admin.createConnection(admin, { adapter, name: `${adapter}-${model}-${randomBytes(2).toString('hex')}`, baseUrl: 'http://127.0.0.1:9', allowPrivateNetwork: true, dataPolicy: policy, ...extra })
  await g.admin.approveModel(admin, { adapter, modelId: model, declared, sourceUrl: 'https://example.test/docs' })
  return g.admin.createDeployment(admin, { connectionId: conn.id, modelId: model, pricing: { currency: 'INR', inputPerMTok: 100, outputPerMTok: 400 } })
}

before(async () => {
  configureLogging({ level: 'debug', sink: (l) => logs.push(l) })
  t = await setupTestDb([aiGatewayMigrations])
  await t.system.query(`insert into platform.tenants (id, slug, name, type, policy) values ($1, 'ga', 'A', 'institution', '{"ai":{"byok":"byok_preferred"}}'), ($2, 'gb', 'B', 'institution', '{}')`, [A, B])
  const tasks = new TaskRegistry()
  TASKS.forEach((x) => tasks.register(x))
  gw = createGateway({ system: t.system, keyManager: KM, environment: 'test', adapters: { ...ADAPTERS, 'fake-a': fakeA, 'fake-b': fakeB }, tasks, retryDelayMs: 1 })
})
after(() => t.close())

describe('routing and switching', () => {
  test('a task runs on the configured deployment and is metered with tokens and cost', async () => {
    const d = await deploy('fake-a', 'chat-1', CHAT)
    await gw.admin.setRoute(admin, { target: 'task:hello.chat', candidates: [{ deploymentId: d.id }] })
    const r = await gw.run('hello.chat', { messages: [{ role: 'user', content: 'hi' }] }, { tenantId: A })
    assert.match(r.text, /fake\(chat-1\): hi/)
    assert.equal(r.route.adapter, 'fake-a')
    const op = (await t.system.query<{ input_tokens: number; cost_micros: number; currency: string; status: string; module_id: string }>('select * from platform.ai_operations where id = $1', [r.operationId])).rows[0]!
    assert.equal(op.status, 'ok')
    assert.equal(op.module_id, 'hello')
    assert.equal(op.input_tokens, 10)
    assert.equal(op.cost_micros, 10 * 100 + 5 * 400)
    assert.equal(op.currency, 'INR')
  })

  test('switching provider is a routing change only — same task, same call site, different adapter', async () => {
    const d2 = await deploy('fake-b', 'chat-2', CHAT)
    await gw.admin.setRoute(admin, { target: 'task:hello.chat', candidates: [{ deploymentId: d2.id }] })
    const r = await gw.run('hello.chat', { messages: [{ role: 'user', content: 'hi' }] }, { tenantId: A })
    assert.equal(r.route.adapter, 'fake-b')
    assert.match(r.text, /fake\(chat-2\)/)
  })

  test('tenant route overrides the platform route; category routes apply when no task route exists', async () => {
    const dt = await deploy('fake-a', 'tenant-pref', CHAT)
    await gw.admin.setRoute(admin, { tenantId: A, target: 'category:tutoring', candidates: [{ deploymentId: dt.id }] })
    assert.equal((await gw.run('hello.chat', { messages: [{ role: 'user', content: 'x' }] }, { tenantId: A })).route.modelId, 'tenant-pref')
    assert.equal((await gw.run('hello.chat', { messages: [{ role: 'user', content: 'x' }] }, { tenantId: B })).route.modelId, 'chat-2')
  })

  test('no route -> no_eligible_route; unknown task -> unknown_task (never an implicit default)', async () => {
    await assert.rejects(gw.run('hello.extract', { messages: [] }, { tenantId: B }), (e: GatewayError) => e.kind === 'no_eligible_route')
    await assert.rejects(gw.run('nope.task', { messages: [] }, { tenantId: B }), (e: GatewayError) => e.kind === 'unknown_task')
  })
})

describe('route validation (UG-4)', () => {
  test('rejects a capability gap with a specific reason', async () => {
    const plain = await deploy('fake-a', 'plain', PLAIN)
    await assert.rejects(gw.admin.setRoute(admin, { target: 'task:hello.extract', candidates: [{ deploymentId: plain.id }] }), /structured output none < json_mode/)
  })
  test('rejects a data-policy violation (student content to unverified provider terms)', async () => {
    const unv = await deploy('fake-a', 'unverified', CHAT, UNVERIFIED)
    await assert.rejects(gw.admin.setRoute(admin, { target: 'task:hello.extract', candidates: [{ deploymentId: unv.id }] }), /terms not verified/)
  })
  test('rejects embedding dimension mismatch and multi-candidate pinned/embedding routes', async () => {
    const e8 = await deploy('fake-a', 'emb-8', { operations: ['embed'], embeddingDimensions: [8] })
    await assert.rejects(gw.admin.setRoute(admin, { target: 'task:hello.embed', candidates: [{ deploymentId: e8.id }] }), /embedding dimensions 8 do not include 4/)
    const g1 = await deploy('fake-a', 'grader-1', CHAT)
    const g2 = await deploy('fake-b', 'grader-2', CHAT)
    await assert.rejects(gw.admin.setRoute(admin, { target: 'task:hello.grade', candidates: [{ deploymentId: g1.id }, { deploymentId: g2.id }] }), /exactly one candidate/)
  })
  test('production requires probe-verified capabilities and a passing eval', async () => {
    const tasks = new TaskRegistry()
    TASKS.forEach((x) => tasks.register(x))
    const prod = createGateway({ system: t.system, keyManager: KM, environment: 'production', adapters: { 'fake-a': fakeA }, tasks })
    const d = await deploy('fake-a', 'prod-chat', CHAT, VERIFIED, {}, prod)
    await assert.rejects(prod.admin.setRoute(admin, { target: 'task:hello.chat', candidates: [{ deploymentId: d.id }] }), /capabilities not verified/)
    await prod.admin.probeDeployment(admin, d.id)
    await assert.rejects(prod.admin.setRoute(admin, { target: 'task:hello.chat', candidates: [{ deploymentId: d.id }] }), /no passing eval/)
    await prod.admin.recordEvalStanding(admin, { taskId: 'hello.chat', deploymentId: d.id, evalRunId: 'run-1', passed: true })
    await prod.admin.setRoute(admin, { target: 'task:hello.chat', candidates: [{ deploymentId: d.id }] })
  })
})

describe('fallback (UG-5)', () => {
  test('retries then falls back to the next eligible candidate; both attempts are metered', async () => {
    const flaky = await deploy('fake-a', 'flaky', CHAT)
    const good = await deploy('fake-b', 'backup', CHAT)
    await gw.admin.setRoute(admin, { target: 'category:tutoring', candidates: [{ deploymentId: flaky.id }, { deploymentId: good.id }] })
    await t.system.query(`update platform.ai_routes set active = false where target = 'task:hello.chat'`)
    const r = await gw.run('hello.chat', { messages: [{ role: 'user', content: 'q' }] }, { tenantId: B })
    assert.equal(r.route.modelId, 'backup')
    assert.equal(r.route.fallback, true)
    const ops = (await t.system.query<{ model_id: string; status: string; fallback: boolean; error_kind: string }>(`select model_id, status, fallback, error_kind from platform.ai_operations where tenant_id = $1 and task_id = 'hello.chat' order by created_at desc limit 3`, [B])).rows
    assert.deepEqual(ops.map((o) => [o.model_id, o.status, o.error_kind]).sort(), [['backup', 'ok', null], ['flaky', 'error', 'rate_limited'], ['flaky', 'error', 'rate_limited']].sort())
  })

  test('never falls back to a candidate that became ineligible (disabled / weaker policy)', async () => {
    const flaky = await deploy('fake-a', 'flaky', CHAT)
    const weaker = await deploy('fake-b', 'weaker', CHAT)
    await gw.admin.setRoute(admin, { target: 'task:hello.chat', candidates: [{ deploymentId: flaky.id }, { deploymentId: weaker.id }] })
    // after approval, the backup's terms are downgraded: it must not be used
    await t.system.query(`update platform.ai_connections set data_policy = $2 where id = (select connection_id from platform.ai_deployments where id = $1)`, [weaker.id, JSON.stringify({ ...VERIFIED, zeroRetention: false })])
    await assert.rejects(gw.run('hello.chat', { messages: [{ role: 'user', content: 'q' }] }, { tenantId: B }), (e: GatewayError) => e.kind === 'rate_limited')
    assert.ok(!fakeB.calls.some((c) => c.model === 'weaker'))
  })

  test('pinned (grading) tasks never switch model', async () => {
    const broken = await deploy('fake-a', 'broken', CHAT)
    await gw.admin.setRoute(admin, { target: 'task:hello.grade', candidates: [{ deploymentId: broken.id }] })
    await assert.rejects(gw.run('hello.grade', { messages: [{ role: 'user', content: 'grade' }] }, { tenantId: B }), (e: GatewayError) => e.kind === 'provider_error')
  })

  test('property: 10,000 generated scenarios never yield an ineligible or less-strict candidate', async () => {
    const { resolveCandidates } = await import('../src/routing.ts')
    const { capabilityGaps } = await import('../src/capabilities.ts')
    const { policyViolations, notLessStrict } = await import('../src/policy.ts')
    let seed = 42
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!
    const task = TASKS[2]! // student_content + json_mode
    let checked = 0
    for (let s = 0; s < 10_000; s++) {
      const n = 1 + Math.floor(rnd() * 4)
      const deps = new Map<string, any>()
      const conns = new Map<string, any>()
      const candidates = []
      for (let i = 0; i < n; i++) {
        const id = `d${i}`
        const policy: DataPolicy = { processingLocation: pick(['IN', 'US']), selfHosted: rnd() < 0.2, retentionDays: 0, zeroRetention: rnd() < 0.5, trainsOnData: pick([true, false, null]), dpaInPlace: rnd() < 0.5, termsVerified: rnd() < 0.6 }
        conns.set(`c${i}`, { id: `c${i}`, tenant_id: null, scope: 'platform', adapter: 'fake-a', enabled: rnd() < 0.9, enabled_models: null, enabled_capabilities: null, data_policy: policy })
        deps.set(id, { id, tenant_id: null, connection_id: `c${i}`, model_id: id, enabled: rnd() < 0.9, verified: null, declared: { operations: ['generate'], structuredOutput: pick(['none', 'json_mode', 'json_schema']), tools: 'none', forcedToolChoice: false, vision: false, reasoningControl: false, contextWindow: 8000, maxOutputTokens: null, embeddingDimensions: [] } })
        candidates.push({ deploymentId: id })
      }
      const tenantPolicy = { allowedLocations: rnd() < 0.3 ? ['IN'] : undefined, requireZeroRetention: rnd() < 0.3 }
      const store = {
        deployment: async (id: string) => deps.get(id) ?? null,
        connection: async (id: string) => conns.get(id) ?? null,
        route: async (tenant: string | null, target: string) => (tenant === null && target === `task:${task.id}` ? { id: 'r', tenant_id: null, scope: 'platform', target, environment: 'test', candidates, version: 1 } : null),
        evalPassed: async () => true,
      }
      const { eligible } = await resolveCandidates({ store: store as never, environment: 'test', adapterTypes: new Set(['fake-a']) }, task, A, tenantPolicy)
      for (const e of eligible) {
        assert.equal(e.deployment.enabled && e.connection.enabled, true)
        assert.deepEqual(capabilityGaps(e.capabilities, task.requires), [])
        assert.deepEqual(policyViolations(e.connection.data_policy, task.dataClass, tenantPolicy), [])
        assert.ok(notLessStrict(e.connection.data_policy, eligible[0]!.connection.data_policy))
        checked++
      }
    }
    assert.ok(checked > 1000, `exercised ${checked} eligible selections`)
  })
})

describe('structured output and embeddings', () => {
  test('invalid JSON is repaired once, then validated against the task schema', async () => {
    let n = 0
    const repairing = createFakeAdapter('fake-r', { respond: () => ({ text: n++ === 0 ? 'not json' : '```json\n{"answer":"ok","n":2}\n```', toolCalls: [], finish: 'stop', usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null } }) })
    const never = createFakeAdapter('fake-n', { respond: () => ({ text: '{"answer": 5}', toolCalls: [], finish: 'stop', usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null } }) })
    const tasks = new TaskRegistry()
    TASKS.forEach((x) => tasks.register(x))
    const g = createGateway({ system: t.system, keyManager: KM, environment: 'test', adapters: { 'fake-r': repairing, 'fake-n': never }, tasks })
    const d1 = await deploy('fake-r', 'rep', CHAT, VERIFIED, {}, g)
    await g.admin.setRoute(admin, { tenantId: null, target: 'task:hello.extract', candidates: [{ deploymentId: d1.id }] })
    const r = await g.run('hello.extract', { messages: [{ role: 'user', content: 'extract' }] }, { tenantId: B })
    assert.deepEqual(r.json, { answer: 'ok', n: 2 })
    assert.equal(repairing.calls.length, 2)
    // json_mode deployments get the schema instruction injected
    assert.match(JSON.stringify(repairing.calls[0]!.req), /conforms to this JSON Schema/)
    const d2 = await deploy('fake-n', 'never', CHAT, VERIFIED, {}, g)
    await g.admin.setRoute(admin, { target: 'task:hello.extract', candidates: [{ deploymentId: d2.id }] })
    await assert.rejects(g.run('hello.extract', { messages: [{ role: 'user', content: 'x' }] }, { tenantId: B }), (e: GatewayError) => e.kind === 'invalid_output')
  })

  test('embeddings use exactly one deployment and enforce dimensions', async () => {
    const e4 = await deploy('fake-a', 'emb-4', { operations: ['embed'], embeddingDimensions: [4] })
    await gw.admin.setRoute(admin, { target: 'task:hello.embed', candidates: [{ deploymentId: e4.id }] })
    const r = await gw.embed('hello.embed', ['a', 'bb'], { tenantId: B })
    assert.equal(r.vectors.length, 2)
    assert.equal(r.dimensions, 4)
  })

  test('stream: route event first, fallback before any output', async () => {
    const flaky = await deploy('fake-a', 'flaky', CHAT)
    const good = await deploy('fake-b', 'streamer', CHAT)
    await gw.admin.setRoute(admin, { target: 'task:hello.stream', candidates: [{ deploymentId: flaky.id }, { deploymentId: good.id }] })
    const ev = []
    for await (const e of gw.stream('hello.stream', { messages: [{ role: 'user', content: 'stream me' }] }, { tenantId: B })) ev.push(e)
    assert.equal(ev[0]!.t, 'route')
    assert.equal((ev[0] as { route: { modelId: string; fallback: boolean } }).route.modelId, 'streamer')
    assert.match(ev.filter((e) => e.t === 'text').map((e) => (e as { delta: string }).delta).join(''), /stream me/)
    assert.equal(ev.at(-1)!.t, 'finish')
  })
})

describe('secrets, BYOK isolation and SSRF', () => {
  test('keys are envelope-encrypted, write-only, and never logged', async () => {
    const key = 'sk-live-SUPERSECRET-' + randomBytes(8).toString('hex')
    const mock = await startMock('openai')
    try {
      const conn = await gw.admin.createConnection(admin, { adapter: 'openai', name: 'oa', baseUrl: mock.baseUrl, apiKey: MOCK_KEY, allowPrivateNetwork: false, dataPolicy: VERIFIED }).catch((e) => e)
      assert.match(String(conn.message), /private|https/) // hosted adapter cannot point at a private host
      const c2 = await gw.admin.createConnection(admin, { adapter: 'openai-compatible', name: 'compat', baseUrl: mock.baseUrl, apiKey: key, allowPrivateNetwork: true, dataPolicy: VERIFIED })
      assert.deepEqual(c2.key, { fingerprint: c2.key!.fingerprint, last4: key.slice(-4) })
      assert.ok(!JSON.stringify(await gw.admin.listConnections(admin, null)).includes(key))
      const raw = await t.system.query<{ ciphertext: Buffer }>('select ciphertext from platform.ai_secrets')
      assert.ok(raw.rows.every((r) => !r.ciphertext.toString('latin1').includes(key)))
      const test1 = await gw.admin.testConnection(admin, c2.id) // wrong key against the mock -> auth failure
      assert.equal(test1.ok, false)
      assert.ok(!JSON.stringify(test1).includes(key))
      assert.ok(!logs.some((l) => l.includes(key)), 'key must never be logged')
      // app role cannot read secrets at all
      await assert.rejects(t.db.withTenant({ tenantId: A }, (tx) => tx.query('select * from platform.ai_secrets')), /permission denied/)
    } finally {
      await mock.close()
    }
  })

  test('BYOK: tenant connections are usable and visible only by their tenant', async () => {
    const adminA: Actor = { userId: null, tenantId: A, isPlatformAdmin: false, roles: ['tenant_admin'] }
    const adminB: Actor = { userId: null, tenantId: B, isPlatformAdmin: false, roles: ['tenant_admin'] }
    await assert.rejects(gw.admin.createConnection(adminB, { tenantId: B, adapter: 'openai', name: 'b', apiKey: 'sk-test-abcdefghijkl', dataPolicy: VERIFIED }), /BYOK is not enabled/)
    await assert.rejects(gw.admin.createConnection(adminA, { tenantId: A, adapter: 'openai-compatible', name: 'x', baseUrl: 'http://127.0.0.1:8000/v1', dataPolicy: VERIFIED }), /https is required|private/)
    const cA = await gw.admin.createConnection(adminA, { tenantId: A, adapter: 'openai', name: 'mine', apiKey: 'sk-tenant-A-0123456789', dataPolicy: VERIFIED })
    assert.equal(cA.scope, 'tenant')
    await assert.rejects(gw.admin.listConnections(adminB, A), /tenant admin of that tenant/)
    await assert.rejects(gw.admin.testConnection(adminB, cA.id), /tenant admin of that tenant/)
    const visibleToB = await t.db.withTenant({ tenantId: B }, (tx) => tx.query('select id from platform.ai_connections'))
    assert.equal(visibleToB.rowCount, 0)
    // a tenant-A deployment cannot be used in tenant B's or the platform's routes
    await gw.admin.approveModel(admin, { adapter: 'openai', modelId: 'byok-model', declared: CHAT })
    const dA = await gw.admin.createDeployment(adminA, { connectionId: cA.id, modelId: 'byok-model' })
    await assert.rejects(gw.admin.setRoute(adminB, { tenantId: B, target: 'task:hello.chat', candidates: [{ deploymentId: dA.id }] }), /another tenant/)
    await assert.rejects(gw.admin.setRoute(admin, { target: 'task:hello.chat', candidates: [{ deploymentId: dA.id }] }), /tenant \(BYOK\) connections/)
  })

  test('SSRF: private, loopback and metadata destinations are blocked, including DNS rebinding (UG-9)', async () => {
    const adminA: Actor = { userId: null, tenantId: A, isPlatformAdmin: false, roles: ['tenant_admin'] }
    for (const url of ['https://127.0.0.1/v1', 'https://169.254.169.254/v1', 'https://localhost/v1', 'https://10.0.0.5/v1', 'https://[::1]/v1', 'https://metadata.google.internal/v1']) {
      await assert.rejects(gw.admin.createConnection(adminA, { tenantId: A, adapter: 'openai', name: 's', baseUrl: url, apiKey: 'sk-test-0123456789ab', dataPolicy: VERIFIED }), /not allowed/, url)
    }
    // rebinding: hostname looks public at save time but resolves to loopback when connecting
    const tasks = new TaskRegistry()
    TASKS.forEach((x) => tasks.register(x))
    const g = createGateway({ system: t.system, keyManager: KM, environment: 'test', adapters: ADAPTERS, tasks, resolver: async () => [{ address: '127.0.0.1', family: 4 }] })
    const c = await g.admin.createConnection(adminA, { tenantId: A, adapter: 'openai', name: 'rebind', baseUrl: 'https://rebind.example.test/v1', apiKey: 'sk-test-0123456789ab', dataPolicy: VERIFIED })
    await g.admin.approveModel(admin, { adapter: 'openai', modelId: 'rebind-model', declared: CHAT })
    const d = await g.admin.createDeployment(adminA, { connectionId: c.id, modelId: 'rebind-model' })
    await g.admin.setRoute(adminA, { tenantId: A, target: 'task:hello.chat', candidates: [{ deploymentId: d.id }] })
    await assert.rejects(g.run('hello.chat', { messages: [{ role: 'user', content: 'x' }] }, { tenantId: A }), (e: GatewayError) => e.kind === 'blocked_destination')
    await t.system.query(`update platform.ai_routes set active = false where tenant_id = $1`, [A])
  })
})

describe('discovery, probes, budgets, task registry', () => {
  test('discovered models are recorded but not deployable until approved; probes verify capabilities', async () => {
    const mock = await startMock('ollama')
    try {
      const c = await gw.admin.createConnection(admin, { adapter: 'ollama', name: 'local', baseUrl: mock.baseUrl, allowPrivateNetwork: true, dataPolicy: { ...VERIFIED, selfHosted: true } })
      assert.equal((await gw.admin.testConnection(admin, c.id)).ok, true)
      const models = await gw.admin.discoverModels(admin, c.id)
      assert.deepEqual(models.map((m) => m.id).sort(), ['mock-chat', 'mock-embed'])
      await assert.rejects(gw.admin.createDeployment(admin, { connectionId: c.id, modelId: 'mock-chat' }), /not approved/)
      await gw.admin.approveModel(admin, { adapter: 'ollama', modelId: 'mock-chat', declared: { operations: ['generate', 'stream'], structuredOutput: 'json_schema', tools: 'single', contextWindow: 8192 } })
      const d = await gw.admin.createDeployment(admin, { connectionId: c.id, modelId: 'mock-chat' })
      const report = await gw.admin.probeDeployment(admin, d.id)
      assert.deepEqual(report.verified.operations, ['generate', 'stream'])
      assert.equal(report.verified.structuredOutput, 'json_schema')
      assert.equal(report.verified.tools, 'single')
    } finally {
      await mock.close()
    }
  })

  test('hard budget stops calls with budget_exceeded', async () => {
    const C = newId()
    await t.system.query(`insert into platform.tenants (id, slug, name, type) values ($1, 'gc', 'C', 'institution')`, [C])
    await gw.admin.setBudget(admin, { tenantId: C, currency: 'INR', monthlyHardLimitMicros: 1 })
    const d = await deploy('fake-a', 'budgeted', CHAT)
    await gw.admin.setRoute(admin, { tenantId: C, target: 'task:hello.chat', candidates: [{ deploymentId: d.id }] })
    await gw.run('hello.chat', { messages: [{ role: 'user', content: 'x' }] }, { tenantId: C })
    await assert.rejects(gw.run('hello.chat', { messages: [{ role: 'user', content: 'x' }] }, { tenantId: C }), (e: GatewayError) => e.kind === 'budget_exceeded')
  })

  test('tasks declare needs only: provider/model fields are rejected (rule M9)', () => {
    const r = new TaskRegistry()
    assert.throws(() => r.register({ ...TASKS[0]!, id: 'm.x', owner: 'm', model: 'gpt-x' } as unknown as TaskDefinition), { code: 'task_provider_field' })
    assert.throws(() => r.register({ ...TASKS[0]!, id: 'm.y', owner: 'm', provider: 'openai' } as unknown as TaskDefinition), { code: 'task_provider_field' })
    assert.throws(() => r.register({ ...TASKS[0]!, id: 'other.y', owner: 'm' }), { code: 'task_namespace' })
    assert.throws(() => r.register({ ...TASKS[4]!, id: 'm.e', owner: 'm', fallback: 'eligible_only' }), /cannot fall back/)
  })

  test('usage summary aggregates by module, task, adapter and model', async () => {
    const u = await gw.admin.usage(admin, A, new Date(Date.now() - 3_600_000), new Date(Date.now() + 60_000))
    assert.ok(u.length > 0)
    assert.ok(u.every((row) => typeof (row as { calls: number }).calls === 'number'))
  })
})
