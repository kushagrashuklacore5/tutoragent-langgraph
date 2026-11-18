import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { applySpec, extractNumber, resolvePath, type GraderContext, type MathChecker } from '../src/index.ts'
import { mkCase, obs } from './helpers.ts'

const ctx = (o: Partial<GraderContext> = {}): GraderContext => ({ case: mkCase(), ...o })
const one = async (spec: Parameters<typeof applySpec>[0], o = obs(), c = ctx()) => applySpec(spec, o, c)
const val = async (...a: Parameters<typeof one>) => (await one(...a)).map((s) => [s.metric, s.value])

describe('paths', () => {
  test('dotted keys, indexes and wildcards; terminal scalar arrays flatten', () => {
    const s = { json: { segments: [{ text: 'a', citations: ['c1', 'c2'] }, { text: 'b', citations: [] }, { text: 'c' }] } }
    assert.deepEqual(resolvePath(s, 'json.segments[*].citations'), ['c1', 'c2'])
    assert.deepEqual(resolvePath(s, 'json.segments[*].text'), ['a', 'b', 'c'])
    assert.deepEqual(resolvePath(s, 'json.segments[1].text'), ['b'])
    assert.deepEqual(resolvePath(s, 'json.missing.x'), [])
  })
})

describe('exact', () => {
  test('equals / oneOf / notOneOf, normalised whitespace and case', async () => {
    assert.deepEqual(await val({ grader: 'exact', equals: 'Delhi' }, obs({ text: '  delhi ' })), [['exact', 0]])
    assert.deepEqual(await val({ grader: 'exact', equals: 'Delhi', caseInsensitive: true }, obs({ text: '  delhi ' })), [['exact', 1]])
    assert.deepEqual(await val({ grader: 'exact', equals: 'delhi', caseInsensitive: true }, obs({ text: '  DELHI ' })), [['exact', 1]])
    assert.deepEqual(await val({ grader: 'exact', target: 'meta.move', oneOf: ['ask', 'hint'], metric: 'm' }, obs({ meta: { move: 'hint' } })), [['m', 1]])
    assert.deepEqual(await val({ grader: 'exact', target: 'meta.move', notOneOf: ['worked_solution'] }, obs({ meta: { move: 'worked_solution' } })), [['exact', 0]])
    // absent target: exclusion is vacuous, positive assertion fails
    assert.deepEqual(await val({ grader: 'exact', target: 'meta.none', notOneOf: ['x'] }), [['exact', 1]])
    assert.deepEqual(await val({ grader: 'exact', target: 'meta.none', equals: 'x' }), [['exact', 0]])
  })
  test('a spec without a condition is a grader error, recorded as failure', async () => {
    const r = await one({ grader: 'exact' })
    assert.equal(r[0]!.value, 0)
    assert.match(r[0]!.detail!, /grader error/)
  })
})

describe('regex', () => {
  test('mustMatch true / false over joined wildcard targets', async () => {
    const o = obs({ json: { segments: [{ text: 'Try isolating x.' }, { text: 'So x = 4.' }] } })
    assert.deepEqual(await val({ grader: 'regex', target: 'json.segments[*].text', pattern: 'x\\s*=\\s*4', mustMatch: false, metric: 'no_answer' }, o), [['no_answer', 0]])
    assert.deepEqual(await val({ grader: 'regex', pattern: 'isolat', flags: 'i', target: 'json.segments[*].text' }, o), [['regex', 1]])
  })
})

describe('jsonSchema', () => {
  const schema = { type: 'object', required: ['a'], properties: { a: { type: 'integer' } } }
  test('validates json, falls back to parsing text, fails on non-JSON', async () => {
    assert.deepEqual(await val({ grader: 'jsonSchema', schema }, obs({ json: { a: 1 } })), [['schema_valid', 1]])
    assert.deepEqual(await val({ grader: 'jsonSchema', schema }, obs({ text: '{"a":"x"}' })), [['schema_valid', 0]])
    assert.deepEqual(await val({ grader: 'jsonSchema', schema }, obs({ text: 'hello' })), [['schema_valid', 0]])
  })
})

describe('numericTolerance', () => {
  test('absolute and relative tolerance; last number in text', async () => {
    assert.deepEqual(await val({ grader: 'numericTolerance', expected: 9.81, abs: 0.01 }, obs({ text: 'g is about 9.809 m/s^2' })), [['numeric_correct', 0]]) // last number is 2
    assert.deepEqual(await val({ grader: 'numericTolerance', expected: 9.81, abs: 0.01, extract: 'first' }, obs({ text: 'g is about 9.809 m/s^2' })), [['numeric_correct', 1]])
    assert.deepEqual(await val({ grader: 'numericTolerance', expected: 1000, rel: 0.01 }, obs({ text: 'Answer: 1,008' })), [['numeric_correct', 1]])
    assert.deepEqual(await val({ grader: 'numericTolerance', expected: 1000, rel: 0.001 }, obs({ text: 'Answer: 1,008' })), [['numeric_correct', 0]])
    assert.deepEqual(await val({ grader: 'numericTolerance', expected: 1 }, obs({ text: 'no digits' })), [['numeric_correct', 0]])
    assert.equal(extractNumber('-3.5e2'), -350)
  })
})

describe('solverEquivalent', () => {
  const checker = (ok: boolean | 'unverified'): MathChecker => ({ equivalent: async () => ({ ok, reason: 'r' }) })
  test('pass only on a verified equivalence; unverified, missing checker and checker errors fail', async () => {
    const spec = { grader: 'solverEquivalent', expected: '2*x+2' }
    const o = obs({ text: '2(x+1)' })
    assert.equal((await one(spec, o, ctx({ math: checker(true) })))[0]!.value, 1)
    assert.equal((await one(spec, o, ctx({ math: checker(false) })))[0]!.value, 0)
    const u = (await one(spec, o, ctx({ math: checker('unverified') })))[0]!
    assert.equal(u.value, 0)
    assert.match(u.detail!, /unverified/)
    assert.equal((await one(spec, o))[0]!.value, 0)
    assert.equal((await one(spec, o, ctx({ math: { equivalent: async () => { throw new Error('down') } } })))[0]!.value, 0)
  })
})

describe('citationIds', () => {
  const seg = (ids: string[][]) => obs({ json: { segments: ids.map((c) => ({ text: 't', source: 'course', citations: c })) } })
  test('precision and recall against gold ids', async () => {
    const r = await val({ grader: 'citationIds', gold: ['a', 'b'] }, seg([['a'], ['x']]))
    assert.deepEqual(r, [['citation_recall', 0.5], ['citation_precision', 0.5]])
  })
  test('gold from case context; no citations -> recall 0 and no precision sample', async () => {
    const c = ctx({ case: mkCase({ context: { goldChunkIds: ['a'] } }) })
    assert.deepEqual(await val({ grader: 'citationIds' }, seg([[]]), c), [['citation_recall', 0]])
  })
  test('"not in material": empty gold, any course citation fails honesty', async () => {
    assert.deepEqual(await val({ grader: 'citationIds', gold: [] }, seg([['a']])), [['not_in_material_honesty', 0]])
    assert.deepEqual(await val({ grader: 'citationIds', gold: [] }, seg([[]])), [['not_in_material_honesty', 1]])
  })
  test('a failed call fails the metric the spec would produce', async () => {
    assert.deepEqual(await val({ grader: 'citationIds', gold: [] }, obs({ error: { kind: 'timeout', message: 't' } })), [['not_in_material_honesty', 0]])
  })
})

describe('latency and cost budgets', () => {
  test('latency total / ttft; cost known / unknown', async () => {
    assert.deepEqual(await val({ grader: 'latencyBudget', maxMs: 100 }, obs({ latencyMs: 50 })), [['latency_within_budget', 1]])
    assert.deepEqual(await val({ grader: 'latencyBudget', maxMs: 100, measure: 'ttft' }, obs({ ttftMs: null })), [['ttft_within_budget', 0]])
    assert.deepEqual(await val({ grader: 'costBudget', maxMicros: 5000 }, obs({ costMicros: 4000 })), [['cost_within_budget', 1]])
    assert.deepEqual(await val({ grader: 'costBudget', maxMicros: 5000 }, obs({ costMicros: null })), [['cost_within_budget', 0]])
    assert.deepEqual(await val({ grader: 'costBudget', maxMicros: 5000, allowUnknown: true }, obs({ costMicros: null })), [['cost_within_budget', 1]])
  })
})

describe('judges as graders', () => {
  test('entailment: every claim must be entailed; rubric records pass and score', async () => {
    const judge: GraderContext['judge'] = async (_n, item) =>
      item.kind === 'entailment' ? { label: item.hypothesis.includes('Paris') ? 'entailed' : 'not_entailed' } : { label: item.response.includes('?') ? 'pass' : 'fail', score: 0.7 }
    const c = ctx({ judge, case: mkCase({ context: { sourceText: 'Paris is the capital of France.' } }) })
    assert.deepEqual(await val({ grader: 'entailmentJudge' }, obs({ json: { segments: [{ text: 'Paris is the capital.' }] } }), c), [['entailed', 1]])
    assert.deepEqual(await val({ grader: 'entailmentJudge' }, obs({ json: { segments: [{ text: 'Paris.' }, { text: 'Lyon is.' }] } }), c), [['entailed', 0]])
    assert.deepEqual(await val({ grader: 'rubricJudge', rubric: 'asks a question' }, obs({ text: 'What next?' }), c), [['rubric_pass', 1], ['rubric_pass_score', 0.7]])
  })
  test('without validated judges the grader fails (never passes)', async () => {
    assert.equal((await one({ grader: 'rubricJudge', rubric: 'x' }, obs({ text: 'y' })))[0]!.value, 0)
  })
})

describe('applySpec', () => {
  test('when filters observations; countFailures adds a count metric', async () => {
    const spec = { grader: 'exact', target: 'meta.move', notOneOf: ['worked_solution'], when: { 'case.context.graded': [true] }, metric: 'no_worked_solution', countFailures: 'graded_mode_leaks' }
    const graded = ctx({ case: mkCase({ context: { graded: true } }) })
    assert.deepEqual(await val(spec, obs({ meta: { move: 'hint' } }), ctx()), [])
    assert.deepEqual(await val(spec, obs({ meta: { move: 'worked_solution' } }), graded), [['no_worked_solution', 0], ['graded_mode_leaks', 1]])
    assert.deepEqual(await val(spec, obs({ meta: { move: 'hint' } }), graded), [['no_worked_solution', 1], ['graded_mode_leaks', 0]])
  })
  test('unknown grader fails', async () => {
    assert.deepEqual(await val({ grader: 'nope' }), [['nope', 0]])
  })
})
