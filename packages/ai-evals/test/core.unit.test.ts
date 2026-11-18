import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildReport, calibration, cohensKappa, delayedRetention, evaluateGate, normalizedGain, parseDataset, parseGate, percentile, regression,
  renderMarkdown, selectCases, transferPerformance, wilson, type CaseResult, type RunRecord,
} from '../src/index.ts'

const line = (o: Record<string, unknown> = {}) => JSON.stringify({ id: 'a', task: 'demo.task', input: { messages: [] }, context: {}, expect: [], tags: ['en'], split: 'dev', source: 'synthetic', ...o })

describe('dataset', () => {
  test('parses JSONL, skips blank and // comment lines, versions canonically', () => {
    const d1 = parseDataset([line(), '', '// note', line({ id: 'b' })].join('\n'), 'x.jsonl')
    assert.equal(d1.cases.length, 2)
    // key order / whitespace does not change the version; content does
    const reordered = JSON.stringify({ source: 'synthetic', split: 'dev', tags: ['en'], expect: [], context: {}, input: { messages: [] }, task: 'demo.task', id: 'a' })
    const d2 = parseDataset([reordered, '   ' + line({ id: 'b' })].join('\r\n'), 'y.jsonl')
    assert.equal(d1.version, d2.version)
    assert.notEqual(d1.version, parseDataset([line(), line({ id: 'b', tags: ['hi'] })].join('\n')).version)
  })
  test('rejects the whole file with line numbers on any problem', () => {
    const bad = [line(), 'not json', line({ id: 'a' }), line({ id: 'c', split: 'prod' }), line({ id: 'd', extra: 1 }), line({ id: 'e', input: { turns: [{ x: 1 }] } })].join('\n')
    assert.throws(() => parseDataset(bad), (e: Error) => /line 2: invalid JSON/.test(e.message) && /line 3: duplicate/.test(e.message) && /line 4/.test(e.message) && /line 5/.test(e.message) && /line 6: every dialogue turn/.test(e.message))
    assert.throws(() => parseDataset(''), /no cases/)
  })
  test('a test.jsonl file may only hold test cases', () => {
    assert.throws(() => parseDataset(line(), 'suite/test.jsonl'), /split dev but the file holds test/)
    assert.equal(parseDataset(line({ split: 'test' }), 'suite/test.jsonl').cases.length, 1)
  })
  test('selection by split, tags and a deterministic sample', () => {
    const cases = Array.from({ length: 50 }, (_, i) => JSON.parse(line({ id: `c${i}`, split: i % 2 ? 'test' : 'dev', tags: i % 3 ? ['en'] : ['hi'] })))
    assert.equal(selectCases(cases, { split: 'test' }).length, 25)
    assert.ok(selectCases(cases, { tags: ['hi'] }).every((c) => c.tags.includes('hi')))
    const s1 = selectCases(cases, { sample: 0.1, seed: 'pr' })
    assert.equal(s1.length, 5)
    assert.deepEqual(s1, selectCases(cases, { sample: 0.1, seed: 'pr' }))
  })
})

describe('statistics', () => {
  test('Wilson interval matches reference values and stays in [0,1]', () => {
    const w = wilson(81, 263)
    assert.ok(Math.abs(w.low - 0.2553) < 1e-3 && Math.abs(w.high - 0.3662) < 1e-3, JSON.stringify(w))
    assert.equal(wilson(0, 10).low, 0)
    assert.ok(wilson(10, 10).high <= 1 && wilson(10, 10).low > 0.69)
  })
  test('percentile interpolates; kappa', () => {
    assert.equal(percentile([1, 2, 3, 4], 50), 2.5)
    assert.equal(percentile([5], 95), 5)
    assert.ok(Math.abs(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95) - 95.05) < 1e-9)
    assert.equal(cohensKappa(['a', 'b', 'a'], ['a', 'b', 'a']), 1)
    assert.ok(cohensKappa(['a', 'a', 'b', 'b'], ['a', 'b', 'a', 'b']) === 0)
  })
})

describe('gates', () => {
  test('parse and evaluate; unmeasured metrics fail', () => {
    const g = parseGate('citation_precision >= 0.95')
    assert.deepEqual([g.metric, g.op, g.threshold], ['citation_precision', '>=', 0.95])
    assert.equal(evaluateGate(g, { value: 0.96, n: 10 }).passed, true)
    assert.equal(evaluateGate(g, { value: 0.94, n: 10 }).passed, false)
    assert.equal(evaluateGate(g, undefined).passed, false)
    assert.equal(evaluateGate(g, { value: 1, n: 0 }).passed, false)
    assert.equal(evaluateGate(parseGate('graded_mode_leaks == 0'), { value: 0, n: 3 }).passed, true)
    assert.equal(evaluateGate(parseGate('p95_latency_ms <= 6000'), { value: 6001, n: 3 }).passed, false)
    assert.throws(() => parseGate('precision is high'), /must look like/)
  })
  test('regression rule: > 2 points worse fails even above the gate', () => {
    const g = parseGate('no_premature_answer >= 0.9')
    assert.equal(regression(g, 0.97, 1.0, true)!.failed, true) // 3 points worse, still above 0.9
    assert.equal(regression(g, 0.98, 1.0, true)!.failed, false) // exactly 2 points
    assert.ok(regression(g, 1.0, 0.95, true)!.worsePoints < 0)
    const lat = parseGate('p95_latency_ms <= 6000')
    assert.equal(regression(lat, 1030, 1000, false)!.failed, true) // +3%
    assert.equal(regression(lat, 1010, 1000, false)!.failed, false)
    assert.equal(regression(parseGate('x != 1'), 0, 1, true), null)
  })
})

const caseResult = (id: string, pass: boolean, o: Partial<CaseResult> = {}): CaseResult => ({
  id, task: 'demo.task', tags: [id.startsWith('h') ? 'hi' : 'en'], split: 'test', status: 'ok', passed: pass,
  samples: [{ metric: 'correct', kind: 'rate', value: pass ? 1 : 0 }, { metric: 'citation_precision', kind: 'mean', value: pass ? 1 : 0.5 }, { metric: 'leaks', kind: 'count', value: 0 }],
  calls: [{ latencyMs: 100, ttftMs: 40, inputTokens: 10, outputTokens: 5, costMicros: 3000, currency: 'INR', meta: {}, textChars: 10 }],
  latencyMs: 100, costMicros: 3000, judgeCostMicros: null, ...o,
})
const runRecord = (cases: CaseResult[], o: Partial<RunRecord> = {}): RunRecord => ({
  runId: 'r1', suite: 'demo/suite', startedAt: 't0', finishedAt: 't1', complete: true, stoppedBy: null, spendMicros: 0, judgeSpendMicros: null, currency: 'INR', cases,
  reproducibility: { suite: 'demo/suite', datasetVersion: 'v1', datasets: [{ file: 'test.jsonl', version: 'v1', cases: cases.length }], selection: {}, caseIdsHash: 'h', promptVersions: { 'demo.task': 'p@1' }, tasks: [], taskDefinitions: [], routes: [], routeConfigHash: null, routeConfig: null, judges: [], commit: 'abc', node: 'v24', framework: 'x' },
  ...o,
})

describe('report', () => {
  const cases = [...Array.from({ length: 18 }, (_, i) => caseResult(`e${i}`, true)), caseResult('h1', false), caseResult('h2', true)]
  test('metrics with Wilson / mean intervals, per-tag breakdown, built-ins, cost', () => {
    const r = buildReport(runRecord(cases), { gates: ['correct >= 0.9', 'leaks == 0', 'p95_latency_ms <= 6000'] })
    assert.equal(r.metrics.correct!.value, 0.95)
    assert.deepEqual(r.metrics.correct!.interval, wilson(19, 20))
    assert.equal(r.metrics.citation_precision!.value, 0.975)
    assert.ok(r.metrics.citation_precision!.interval!.low < 0.975)
    assert.equal(r.metrics.leaks!.value, 0)
    assert.equal(r.byTag.hi!.correct!.value, 0.5)
    assert.equal(r.byTag.en!.correct!.n, 18)
    assert.equal(r.metrics.p95_latency_ms!.value, 100)
    assert.equal(r.metrics.p50_first_token_ms!.value, 40)
    assert.equal(r.cost.totalMicros, 60000)
    assert.equal(r.cost.perCaseMicros, 3000)
    assert.equal(r.passed, true)
    const md = renderMarkdown(r)
    assert.match(md, /\*\*PASS\*\*/)
    assert.match(md, /\| correct \| 0\.950 \| \[0\.\d+, 0\.\d+\] \| 20 \|/)
    assert.match(md, /## By tag/)
  })
  test('failing gate, incomplete run and baseline regression each fail the report', () => {
    const base = buildReport(runRecord(cases.map((c) => ({ ...c, passed: true, samples: c.samples.map((s) => (s.metric === 'correct' ? { ...s, value: 1 } : s)) }))), { gates: ['correct >= 0.9'] })
    assert.equal(base.metrics.correct!.value, 1)
    const cur = buildReport(runRecord(cases), { gates: ['correct >= 0.9'], baseline: base })
    assert.equal(cur.gates.results[0]!.passed, true)
    assert.equal(cur.passed, false) // 5 points worse than baseline
    assert.match(cur.gates.reasons.join(), /regression: correct/)
    assert.ok(Math.abs(cur.baseline!.diffs.correct!.delta + 0.05) < 1e-9)
    assert.match(renderMarkdown(cur), /\*\*regression\*\*/)
    assert.equal(buildReport(runRecord(cases), { gates: ['correct >= 0.99'] }).passed, false)
    assert.equal(buildReport(runRecord(cases, { complete: false, stoppedBy: 'spend_cap' }), { gates: ['correct >= 0.9'] }).passed, false)
    assert.equal(buildReport(runRecord(cases), { gates: [] }).passed, false)
  })
})

describe('learning outcomes (synthetic data)', () => {
  test('normalized gain', () => {
    const g = normalizedGain([{ learnerId: 'a', pre: 0.2, post: 0.6 }, { learnerId: 'b', pre: 0.4, post: 0.7 }, { learnerId: 'c', pre: 1, post: 1 }])
    assert.ok(Math.abs(g.classGain - (0.7667 - 0.5333) / (1 - 0.5333)) < 1e-3)
    assert.ok(Math.abs(g.meanIndividualGain - 0.5) < 1e-9) // (0.5 + 0.5) / 2, ceiling learner excluded
    assert.equal(g.excludedAtCeiling, 1)
    assert.throws(() => normalizedGain([{ learnerId: 'a', pre: 2, post: 1 }]), /outside/)
  })
  test('delayed retention and transfer', () => {
    const r = delayedRetention([{ learnerId: 'a', post: 0.8, delayed: 0.6 }, { learnerId: 'b', post: 0.5, delayed: 0.5 }, { learnerId: 'c', post: 0, delayed: 0.1 }])
    assert.ok(Math.abs(r.meanRetention - 0.875) < 1e-9)
    assert.equal(r.excludedZeroPost, 1)
    const t = transferPerformance([
      ...Array.from({ length: 10 }, (_, i) => ({ learnerId: `l${i}`, itemId: 'n', correct: i < 8, kind: 'near' as const })),
      ...Array.from({ length: 10 }, (_, i) => ({ learnerId: `l${i}`, itemId: 't', correct: i < 4, kind: 'transfer' as const })),
    ])
    assert.equal(t.near.rate, 0.8)
    assert.equal(t.transfer.rate, 0.4)
    assert.equal(t.transferRatio, 0.5)
  })
  test('calibration: perfect, overconfident, and coin-flip learners', () => {
    const perfect = calibration([{ confidence: 1, correct: true }, { confidence: 0, correct: false }])
    assert.equal(perfect.brier, 0)
    assert.equal(perfect.ece, 0)
    const coin = calibration(Array.from({ length: 100 }, (_, i) => ({ confidence: 0.5, correct: i % 2 === 0 })))
    assert.ok(Math.abs(coin.brier - 0.25) < 1e-12)
    assert.ok(coin.ece < 1e-12)
    // synthetic overconfident learner: says 0.9, right 60% of the time
    const over = calibration(Array.from({ length: 100 }, (_, i) => ({ confidence: 0.9, correct: i < 60 })))
    assert.ok(Math.abs(over.overconfidence - 0.3) < 1e-9)
    assert.ok(Math.abs(over.ece - 0.3) < 1e-9)
    assert.ok(Math.abs(over.brier - (0.6 * 0.01 + 0.4 * 0.81)) < 1e-9)
  })
})

test('marking-eval fixtures conform to the shared case schema and are labelled synthetic', async () => {
  const { readFileSync } = await import('node:fs')
  const ds = parseDataset(readFileSync(new URL('../../../modules/education-agents/tutor-agent/evals/marking/fixtures.synthetic.jsonl', import.meta.url), 'utf8'), 'fixtures.synthetic.jsonl')
  assert.equal(ds.cases.length, 12)
  assert.ok(ds.cases.every((c) => c.source === 'synthetic' && c.task === 'education.tutor.mark_answer'))
})
