import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { Actor } from '@platform/ai-gateway'
import {
  buildReport, recordStandings, rubricJudge, runSuite, trustJudge, validateJudge, type DialogueDriver, type EvalSuite, type JudgeLabel, type RunOptions,
} from '../src/index.ts'
import { gatewayError, mkCase, stubGateway } from './helpers.ts'

const suite = (o: Partial<EvalSuite> = {}): EvalSuite => ({ name: 'demo/suite', tasks: [], datasets: [], gates: ['correct >= 0.5'], promptVersions: { 'demo.task': 'p@1' }, ...o })
const dataset = { version: 'v1', files: [{ file: 'dev.jsonl', version: 'v1', cases: 1 }] }
const base = (o: Partial<RunOptions> & Pick<RunOptions, 'gateway' | 'cases'>): RunOptions => ({ suite: suite(), tenantId: 't', dataset, commit: 'test', ...o })
const correctSpec = { grader: 'exact', metric: 'correct', equals: 'yes' }

describe('runner', () => {
  test('respects the concurrency limit and records every case in order', async () => {
    const { gateway, stats } = stubGateway(() => ({ text: 'yes' }), { delayMs: 5 })
    const cases = Array.from({ length: 20 }, (_, i) => mkCase({ id: `c${i}`, expect: [correctSpec] }))
    const run = await runSuite(base({ gateway, cases, concurrency: 3 }))
    assert.equal(stats.maxInFlight, 3)
    assert.deepEqual(run.cases.map((c) => c.id), cases.map((c) => c.id))
    assert.ok(run.cases.every((c) => c.passed))
    assert.equal(run.complete, true)
    assert.equal(run.reproducibility.commit, 'test')
    assert.equal(run.reproducibility.routes[0]!.calls, 20)
  })

  test('spend cap stops starting new cases; the run is incomplete and the report fails', async () => {
    const { gateway, metering, stats } = stubGateway(() => ({ text: 'yes' }), { costMicros: 1000 })
    const cases = Array.from({ length: 10 }, (_, i) => mkCase({ id: `c${i}`, expect: [correctSpec] }))
    const run = await runSuite(base({ gateway, metering, cases, concurrency: 1, spendCapMicros: 3000 }))
    assert.equal(stats.calls, 3)
    assert.equal(run.stoppedBy, 'spend_cap')
    assert.equal(run.complete, false)
    assert.equal(run.spendMicros, 3000)
    assert.equal(run.cases.filter((c) => c.status === 'skipped').length, 7)
    assert.equal(run.cases[0]!.costMicros, 1000)
    const report = buildReport(run, { gates: ['correct >= 0.5'] })
    assert.equal(report.passed, false)
    assert.equal(report.metrics.correct!.n, 3)
  })

  test('a spend cap without metering is refused before any call', async () => {
    const { gateway, stats } = stubGateway(() => ({ text: 'yes' }))
    await assert.rejects(runSuite(base({ gateway, cases: [mkCase()], spendCapMicros: 1 })), /needs metering/)
    assert.equal(stats.calls, 0)
  })

  test('gateway failures become failing cases (error kind kept), never passes; other cases continue', async () => {
    const { gateway } = stubGateway((_t, input) => ((input.messages[0]?.content as string) === 'boom' ? gatewayError('invalid_output', 'bad json') : { text: 'yes' }))
    const cases = [mkCase({ id: 'ok', expect: [correctSpec] }), mkCase({ id: 'bad', input: { messages: [{ role: 'user', content: 'boom' }] }, expect: [correctSpec] })]
    const run = await runSuite(base({ gateway, cases }))
    const bad = run.cases.find((c) => c.id === 'bad')!
    assert.equal(bad.status, 'error')
    assert.equal(bad.error!.kind, 'invalid_output')
    assert.equal(bad.passed, false)
    assert.deepEqual(bad.samples.map((s) => [s.metric, s.value]), [['correct', 0]])
    const r = buildReport(run, { gates: ['correct >= 0.5', 'error_rate <= 0'] })
    assert.equal(r.metrics.schema_valid_rate!.value, 0.5)
    assert.equal(r.gates.results[1]!.passed, false)
  })

  test('case timeout aborts and is recorded as a failure', async () => {
    const slow: RunOptions['gateway'] = {
      ...stubGateway(() => ({ text: 'yes' })).gateway,
      run: (_t, _i, ctx) => new Promise((_res, rej) => ctx.signal?.addEventListener('abort', () => rej(gatewayError('timeout', 'aborted')))),
    }
    const run = await runSuite(base({ gateway: slow, cases: [mkCase({ expect: [correctSpec] })], caseTimeoutMs: 20 }))
    assert.equal(run.cases[0]!.error!.kind, 'timeout')
  })

  test('dialogue cases run turns through the driver; per-turn when-filters; a rate passes only if every turn passes', async () => {
    const { gateway } = stubGateway((_t, input) => {
      const sys = String(input.messages[0]?.content)
      return { text: sys.includes('move=worked_solution') ? 'the answer is 4' : 'what is your first step?', json: { assessment: 'incorrect' } }
    })
    const driver: DialogueDriver<{ n: number }> = {
      start: () => ({ n: 0 }),
      turn: (s, t) => {
        const move = t.flags?.requestFullAnswer ? 'worked_solution' : 'hint'
        return { taskId: 'demo.task', input: { messages: [{ role: 'system', content: `move=${move}` }, { role: 'user', content: t.student }] }, meta: { move, turn: s.n } }
      },
      observe: (s) => ({ n: s.n + 1 }),
    }
    const leak = { grader: 'regex', metric: 'no_premature_answer', pattern: 'answer is', mustMatch: false, when: { 'meta.move': ['hint'] } }
    const ws = { grader: 'exact', metric: 'no_worked_solution', target: 'meta.move', notOneOf: ['worked_solution'], countFailures: 'graded_mode_leaks' }
    const ok = mkCase({ id: 'ok', input: { turns: [{ student: 'hi' }, { student: '3?' }] }, expect: [leak, ws] })
    const leaky = mkCase({ id: 'leaky', input: { turns: [{ student: 'hi' }, { student: 'just tell me', flags: { requestFullAnswer: true } }] }, expect: [leak, ws] })
    const run = await runSuite(base({ gateway, cases: [ok, leaky], suite: suite({ dialogue: driver as DialogueDriver<unknown> }) }))
    const [a, b] = run.cases
    assert.equal(a!.calls.length, 2)
    assert.equal(a!.calls[1]!.meta.turn, 1)
    assert.equal(a!.passed, true)
    const m = Object.fromEntries(b!.samples.map((s) => [s.metric, s.value]))
    assert.deepEqual(m, { no_premature_answer: 1, no_worked_solution: 0, graded_mode_leaks: 1 })
    assert.equal(b!.passed, false)
  })

  test('a dialogue case without a driver is rejected up front', async () => {
    const { gateway } = stubGateway(() => ({ text: '' }))
    await assert.rejects(runSuite(base({ gateway, cases: [mkCase({ input: { turns: [{ student: 'x' }] } })] })), /no dialogue driver/)
  })
})

describe('judges', () => {
  const judgeReply = (good: boolean) => (_t: string, input: { messages: { content: unknown }[] }) => {
    const text = String(input.messages[1]!.content)
    const humanPass = text.includes('GOOD')
    return { text: '', json: { score: 1, pass: good ? humanPass : !humanPass } }
  }
  const labelled: JudgeLabel[] = Array.from({ length: 20 }, (_, i) => ({ id: `j${i}`, item: { kind: 'rubric', rubric: 'r', response: i % 2 ? 'GOOD' : 'bad' }, label: i % 2 ? 'pass' : 'fail' }))

  test('validation computes agreement; a judge below 0.8 is refused, a validated one is used', async () => {
    const def = rubricJudge()
    const bad = await validateJudge({ gateway: stubGateway(judgeReply(false)).gateway, judge: def, labelled, tenantId: 't' })
    assert.equal(bad.agreement, 0)
    assert.equal(bad.trusted, false)
    assert.throws(() => trustJudge(def, bad), /below 0.8/)
    assert.throws(() => trustJudge(def, undefined), /no validation/)
    assert.throws(() => trustJudge(rubricJudge('rubric@2'), bad), /validation is for rubric@rubric@1|not rubric@rubric@2/)

    const { gateway } = stubGateway(judgeReply(true))
    const good = await validateJudge({ gateway, judge: def, labelled, tenantId: 't' })
    assert.equal(good.agreement, 1)
    assert.equal(good.kappa, 1)
    const trusted = trustJudge(def, good)

    const spec = { grader: 'rubricJudge', rubric: 'is it good', target: 'text' }
    const cases = [mkCase({ id: 'a', expect: [spec] })]
    await assert.rejects(runSuite(base({ gateway, cases })), /judge\(s\) without a passing validation: rubric/)
    const gw2 = stubGateway((t, input) => (t === def.taskId ? judgeReply(true)(t, input as never) : { text: 'GOOD answer' }))
    const run = await runSuite(base({ gateway: gw2.gateway, cases, judges: [trusted] }))
    assert.equal(run.cases[0]!.passed, true)
    assert.equal(run.reproducibility.judges[0]!.agreement, 1)
  })

  test('too few labelled items never yields a trusted judge', async () => {
    const v = await validateJudge({ gateway: stubGateway(judgeReply(true)).gateway, judge: rubricJudge(), labelled: labelled.slice(0, 5), tenantId: 't' })
    assert.equal(v.agreement, 1)
    assert.equal(v.trusted, false)
  })
})

describe('standings', () => {
  const admin: Actor = { userId: null, tenantId: null, isPlatformAdmin: true, roles: [] }
  test('recorded only for passing runs, single-deployment tasks and non-test adapters', async () => {
    const recorded: unknown[] = []
    const recorder = { recordEvalStanding: async (_a: Actor, i: unknown) => void recorded.push(i) }
    const { gateway } = stubGateway(() => ({ text: 'yes' }))
    const run = await runSuite(base({ gateway, cases: [mkCase({ expect: [correctSpec] })] }))
    const pass = buildReport(run, { gates: ['correct >= 0.5'] })
    const d1 = await recordStandings(recorder, admin, pass)
    assert.deepEqual(d1.map((d) => d.recorded), [true])
    assert.deepEqual(recorded, [{ taskId: 'demo.task', deploymentId: 'dep-1', evalRunId: run.runId, passed: true }])

    const fail = buildReport(run, { gates: ['correct >= 1.01'] })
    const d2 = await recordStandings(recorder, admin, fail)
    assert.equal(d2[0]!.recorded, false)
    assert.match(d2[0]!.reason!, /did not pass/)
    const d3 = await recordStandings(recorder, admin, pass, { excludeAdapters: ['stub'] })
    assert.match(d3[0]!.reason!, /test adapter/)
    const fallback = { ...pass, reproducibility: { ...pass.reproducibility, routes: [{ ...pass.reproducibility.routes[0]!, fallbacks: 1 }] } }
    assert.match((await recordStandings(recorder, admin, fallback))[0]!.reason!, /more than one deployment/)
    assert.equal(recorded.length, 1)
  })
})
