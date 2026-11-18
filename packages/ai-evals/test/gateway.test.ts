import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { newId } from '@platform/core'
import { setupTestDb, type PlatformTestDb } from '@platform/testing'
import { TaskRegistry, aiGatewayMigrations, createGateway, localKeyManager, type Actor, type DataPolicy, type Gateway, type TaskDefinition } from '@platform/ai-gateway'
import { createFakeAdapter } from '@platform/ai-gateway/testing'
import {
  JUDGE_TASKS, buildReport, entailmentJudge, recordStandings, runSuite, trustJudge, validateJudge, type EvalCase, type EvalSuite, type JudgeLabel,
} from '../src/index.ts'
import { mkCase, stubGateway } from './helpers.ts'

/** Runner against the REAL gateway (routing, schema validation, metering in Postgres) with the fake adapter. */

const POLICY: DataPolicy = { processingLocation: 'IN', selfHosted: false, retentionDays: 0, zeroRetention: true, trainsOnData: false, dpaInPlace: true, termsVerified: true }
const TASKS: TaskDefinition[] = [
  { id: 'demo.answer', owner: 'demo', category: 'qa', requires: { operation: 'generate', structuredOutput: 'json_mode' }, dataClass: 'course_content', determinism: 'flexible', fallback: 'eligible_only',
    outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' }, citations: { type: 'array', items: { type: 'string' } } } } },
  { id: 'demo.chat', owner: 'demo', category: 'chat', requires: { operation: 'stream' }, dataClass: 'course_content', determinism: 'flexible', fallback: 'eligible_only' },
  { id: 'demo.embed', owner: 'demo', category: 'embeddings', requires: { operation: 'embed', embeddingDimensions: 4 }, dataClass: 'course_content', determinism: 'flexible', fallback: 'none' },
]
const admin: Actor = { userId: null, tenantId: null, isPlatformAdmin: true, roles: [] }
let t: PlatformTestDb
let gw: Gateway
let tenant: string
let depA: string

const lastUser = (req: { messages: { role: string; content: unknown }[] }) => String([...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '')
const fake = createFakeAdapter('fake-eval', {
  respond(req) {
    const q = lastUser(req)
    const first = String(req.messages.find((m) => m.role === 'user')?.content ?? '')
    const usage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: null, reasoningTokens: null }
    if (q.startsWith('CLAIM') || q.startsWith('SOURCE')) return { text: JSON.stringify({ label: /SOURCE:[\s\S]*Paris[\s\S]*CLAIM:[\s\S]*Paris/.test(q) ? 'entailed' : 'not_entailed' }), toolCalls: [], finish: 'stop', usage }
    if (first === 'broken') return { text: 'not json at all', toolCalls: [], finish: 'stop', usage }
    if (req.responseFormat) return { text: JSON.stringify({ answer: q.includes('capital') ? 'Paris is the capital of France.' : 'unknown', citations: q.includes('capital') ? ['chunk-1'] : [] }), toolCalls: [], finish: 'stop', usage }
    return { text: `echo: ${q}`, toolCalls: [], finish: 'stop', usage }
  },
})

before(async () => {
  t = await setupTestDb([aiGatewayMigrations])
  tenant = newId()
  await t.system.query(`insert into platform.tenants (id, slug, name, type) values ($1, 'evals', 'Evals', 'institution')`, [tenant])
  const tasks = new TaskRegistry()
  ;[...TASKS, ...JUDGE_TASKS].forEach((x) => tasks.register(x))
  gw = createGateway({ system: t.system, keyManager: localKeyManager(randomBytes(32)), environment: 'eval', adapters: { 'fake-eval': fake }, tasks, retryDelayMs: 1 })
  const conn = await gw.admin.createConnection(admin, { adapter: 'fake-eval', name: 'fake', baseUrl: 'http://127.0.0.1:9', allowPrivateNetwork: true, dataPolicy: POLICY })
  await gw.admin.approveModel(admin, { adapter: 'fake-eval', modelId: 'm1', declared: { operations: ['generate', 'stream', 'embed'], structuredOutput: 'json_mode', tools: 'single', contextWindow: 32000, embeddingDimensions: [4] } })
  depA = (await gw.admin.createDeployment(admin, { connectionId: conn.id, modelId: 'm1', pricing: { currency: 'INR', inputPerMTok: 100, outputPerMTok: 400 } })).id
  for (const task of [...TASKS, ...JUDGE_TASKS]) await gw.admin.setRoute(admin, { target: `task:${task.id}`, candidates: [{ deploymentId: depA }] })
})
after(() => t.close())

const suite: EvalSuite = {
  name: 'demo/qa', tasks: [...TASKS], datasets: [], gates: ['correct >= 0.5', 'citation_precision >= 0.9'],
  buildCall: (c) => ({ taskId: c.task, operation: c.task === 'demo.chat' ? 'stream' : c.task === 'demo.embed' ? 'embed' : 'run', input: c.input as never, inputs: c.input.inputs as string[] | undefined }),
}
const dataset = { version: 'v', files: [] }
const ask = (id: string, q: string, expect: EvalCase['expect'], o: Partial<EvalCase> = {}) => mkCase({ id, task: 'demo.answer', input: { messages: [{ role: 'user', content: q }] }, expect, ...o })

describe('runner on the real gateway', () => {
  test('run / stream / embed cases; cost and tokens from metering; schema failures are typed', async () => {
    const cases = [
      ask('cap', 'What is the capital of France?', [{ grader: 'regex', metric: 'correct', target: 'json.answer', pattern: 'Paris' }, { grader: 'citationIds', target: 'json.citations', gold: ['chunk-1'] }]),
      ask('oos', 'Who won the 1998 cricket final?', [{ grader: 'citationIds', target: 'json.citations', gold: [] }]),
      ask('bad', 'broken', [{ grader: 'regex', metric: 'correct', target: 'json.answer', pattern: '.' }]),
      mkCase({ id: 'chat', task: 'demo.chat', input: { messages: [{ role: 'user', content: 'hello there' }] }, expect: [{ grader: 'regex', metric: 'echo', pattern: 'hello there' }, { grader: 'costBudget', maxMicros: 50_000 }] }),
      mkCase({ id: 'emb', task: 'demo.embed', input: { inputs: ['a', 'b'] }, expect: [{ grader: 'exact', metric: 'dims', target: 'vectors[0]', equals: [1 / 7, 2 / 7, 3 / 7, 4 / 7] }] }),
    ]
    const run = await runSuite({ gateway: gw, suite, cases, tenantId: tenant, metering: t.system, dataset, commit: null })
    const by = Object.fromEntries(run.cases.map((c) => [c.id, c]))
    assert.equal(by.cap!.passed, true, JSON.stringify(by.cap))
    assert.equal(by.cap!.costMicros, 100 * 100 + 20 * 400)
    assert.equal(by.oos!.passed, true)
    assert.equal(by.bad!.error!.kind, 'invalid_output')
    assert.equal(by.chat!.passed, true, JSON.stringify(by.chat))
    assert.ok(by.chat!.calls[0]!.ttftMs !== null)
    assert.equal(by.chat!.costMicros, 18000)
    assert.equal(by.emb!.status, 'ok', JSON.stringify(by.emb))
    const report = buildReport(run, { gates: suite.gates })
    assert.equal(report.metrics.citation_precision!.value, 1)
    assert.equal(report.metrics.not_in_material_honesty!.value, 1)
    assert.ok(report.metrics.schema_valid_rate!.value < 1)
    assert.equal(report.cost.currency, 'INR')
    assert.equal(run.reproducibility.routes.find((r) => r.taskId === 'demo.answer')!.deploymentId, depA)
    assert.equal(run.reproducibility.routes.find((r) => r.taskId === 'demo.answer')!.adapter, 'fake-eval')
  })

  test('validated entailment judge runs as a pinned gateway task; judge spend is tracked separately', async () => {
    const def = entailmentJudge()
    const labelled: JudgeLabel[] = Array.from({ length: 20 }, (_, i) => ({
      id: `l${i}`, item: { kind: 'entailment', premise: 'Paris is the capital of France.', hypothesis: i % 2 ? 'Paris is the capital.' : 'Lyon is the capital.' }, label: i % 2 ? 'entailed' : 'not_entailed',
    }))
    const v = await validateJudge({ gateway: gw, judge: def, labelled, tenantId: tenant })
    assert.equal(v.agreement, 1)
    const cases = [ask('ent', 'What is the capital of France?', [{ grader: 'entailmentJudge', target: 'json.answer', premise: 'Paris is the capital of France.' }])]
    const run = await runSuite({ gateway: gw, suite, cases, tenantId: tenant, metering: t.system, judges: [trustJudge(def, v)], dataset, commit: null })
    assert.equal(run.cases[0]!.passed, true, JSON.stringify(run.cases[0]))
    assert.equal(run.cases[0]!.judgeCostMicros, 18000)
    assert.equal(run.judgeSpendMicros, 18000)
    assert.ok(run.reproducibility.routes.some((r) => r.taskId === def.taskId))
  })

  test('passing run records an eval standing in the gateway; failing run records nothing', async () => {
    const cases = [ask('cap', 'What is the capital of France?', [{ grader: 'regex', metric: 'correct', target: 'json.answer', pattern: 'Paris' }])]
    const run = await runSuite({ gateway: gw, suite, cases, tenantId: tenant, metering: t.system, dataset, commit: null })
    const failing = buildReport(run, { gates: ['correct >= 1.1'] })
    assert.equal((await recordStandings(gw.admin, admin, failing, { excludeAdapters: [] }))[0]!.recorded, false)
    assert.equal((await t.system.query('select 1 from platform.ai_eval_standings')).rows.length, 0)
    const passing = buildReport(run, { gates: ['correct >= 1'] })
    // 'fake-eval' is a test adapter by name prefix: standings refused by default
    assert.equal((await recordStandings(gw.admin, admin, passing))[0]!.recorded, false)
    const d = await recordStandings(gw.admin, admin, passing, { excludeAdapters: [] })
    assert.deepEqual(d.map((x) => x.recorded), [true])
    const rows = (await t.system.query<{ task_id: string; deployment_id: string; eval_run_id: string; passed: boolean }>('select * from platform.ai_eval_standings')).rows
    assert.deepEqual(rows.map((r) => [r.task_id, r.deployment_id, r.eval_run_id, r.passed]), [['demo.answer', depA, run.runId, true]])
  })
})

describe('benchmark', () => {
  test('cases/second with the fake adapter (real gateway + metering, and in-memory)', async () => {
    const n = 200
    const cases = Array.from({ length: n }, (_, i) => ask(`b${i}`, 'What is the capital of France?', [{ grader: 'regex', metric: 'correct', target: 'json.answer', pattern: 'Paris' }, { grader: 'citationIds', target: 'json.citations', gold: ['chunk-1'] }]))
    const t0 = performance.now()
    const run = await runSuite({ gateway: gw, suite, cases, tenantId: tenant, metering: t.system, concurrency: 8, dataset, commit: null })
    const real = n / ((performance.now() - t0) / 1000)
    assert.ok(run.cases.every((c) => c.passed))
    const m = 5000
    const stub = stubGateway(() => ({ text: '', json: { answer: 'Paris', citations: ['chunk-1'] } }))
    const memCases = Array.from({ length: m }, (_, i) => ({ ...cases[0]!, id: `m${i}` }))
    const t1 = performance.now()
    const memRun = await runSuite({ gateway: stub.gateway, suite, cases: memCases, tenantId: tenant, concurrency: 16, dataset, commit: null })
    const mem = m / ((performance.now() - t1) / 1000)
    assert.equal(memRun.cases.filter((c) => c.passed).length, m)
    const report = buildReport(memRun, { gates: ['correct >= 1'] })
    assert.equal(report.passed, true)
    console.log(`ai-evals benchmark: ${real.toFixed(0)} cases/s through the real gateway + Postgres metering (n=${n}, concurrency 8); ${mem.toFixed(0)} cases/s runner+graders in memory (n=${m})`)
    assert.ok(real > 5 && mem > 200, `too slow: ${real} / ${mem}`)
  })
})
