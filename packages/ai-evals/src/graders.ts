import { Ajv2020 } from 'ajv/dist/2020.js'
import { AppError } from '@platform/core'
import type { JudgeItem, JudgeVerdict } from './judges.ts'
import { deepEqual, resolvePath } from './paths.ts'
import type { DialogueTurn, EvalCase, GraderSpec, MetricSample, Observation } from './types.ts'

/**
 * Injected maths equivalence check (implemented over `@platform/math-client` by the integrator).
 * `unverified` means the checker could not decide — graders count it as a FAIL, never a pass.
 */
export interface MathChecker {
  equivalent(a: string, b: string): Promise<{ ok: boolean | 'unverified'; reason?: string }>
}

export interface GraderContext {
  case: EvalCase
  turn?: DialogueTurn
  turnIndex?: number
  math?: MathChecker
  /** call a validated judge by name (provided by the runner; refuses untrusted judges) */
  judge?: (name: string, item: JudgeItem) => Promise<JudgeVerdict>
}

export type Grader = (spec: GraderSpec, obs: Observation, ctx: GraderContext) => Promise<MetricSample[]>

/** The values a grader `target` / `when` path is resolved against. */
export function graderScope(obs: Observation, ctx: GraderContext): Record<string, unknown> {
  return {
    text: obs.text, json: obs.json, meta: obs.meta, error: obs.error ?? null, finish: obs.finish,
    latencyMs: obs.latencyMs, ttftMs: obs.ttftMs, costMicros: obs.costMicros, route: obs.route,
    case: { id: ctx.case.id, input: ctx.case.input, context: ctx.case.context, tags: ctx.case.tags },
    turn: ctx.turn ? { ...ctx.turn, index: ctx.turnIndex } : null,
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v))
const rate = (metric: string, ok: boolean, detail?: string): MetricSample => ({ metric, kind: 'rate', value: ok ? 1 : 0, detail: ok ? undefined : detail })
const metricOf = (spec: GraderSpec, fallback: string) => (typeof spec.metric === 'string' && spec.metric ? spec.metric : fallback)

function targetValues(spec: GraderSpec, obs: Observation, ctx: GraderContext, fallback = 'text'): unknown[] {
  return resolvePath(graderScope(obs, ctx), typeof spec.target === 'string' ? spec.target : fallback)
}
function param<T>(spec: GraderSpec, key: string, check: (v: unknown) => boolean, what: string): T {
  const v = spec[key]
  if (!check(v)) throw new AppError('grader_spec_invalid', `${spec.grader}: "${key}" must be ${what}`)
  return v as T
}

/** exact: every target value equals `equals`, is in `oneOf`, and/or is not in `notOneOf` (optionally case/space-insensitive). */
const exact: Grader = async (spec, obs, ctx) => {
  const norm = (v: unknown) => (typeof v === 'string' && spec.normalize !== false ? v.trim().replace(/\s+/g, ' ')[spec.caseInsensitive ? 'toLowerCase' : 'toString']() : v)
  const values = targetValues(spec, obs, ctx).map(norm)
  const has = (k: string) => Object.hasOwn(spec, k)
  if (!has('equals') && !has('oneOf') && !has('notOneOf')) throw new AppError('grader_spec_invalid', 'exact: give equals, oneOf or notOneOf')
  const oneOf = has('oneOf') ? param<unknown[]>(spec, 'oneOf', Array.isArray, 'an array').map(norm) : null
  const notOneOf = has('notOneOf') ? param<unknown[]>(spec, 'notOneOf', Array.isArray, 'an array').map(norm) : null
  // an absent target is a failure for positive assertions, vacuous for exclusions
  if (!values.length) return [rate(metricOf(spec, 'exact'), !has('equals') && !oneOf, `target ${str(spec.target)} missing`)]
  const bad = values.find((v) =>
    (has('equals') && !deepEqual(v, norm(spec.equals))) || (oneOf && !oneOf.some((o) => deepEqual(o, v))) || (notOneOf && notOneOf.some((o) => deepEqual(o, v))))
  return [rate(metricOf(spec, 'exact'), bad === undefined, `got ${str(bad)}`)]
}

/** regex: the joined target text must (mustMatch: true, default) or must not (false) match `pattern`. */
const regex: Grader = async (spec, obs, ctx) => {
  const pattern = param<string>(spec, 'pattern', (v) => typeof v === 'string' && v.length > 0, 'a non-empty string')
  const flags = typeof spec.flags === 'string' ? spec.flags.replace(/[gy]/g, '') : 'u'
  const re = new RegExp(pattern, flags.includes('u') ? flags : flags + 'u')
  const text = targetValues(spec, obs, ctx).map(str).join('\n')
  const mustMatch = spec.mustMatch !== false
  const m = re.exec(text)
  return [rate(metricOf(spec, 'regex'), mustMatch ? !!m : !m, mustMatch ? `no match for /${pattern}/` : `forbidden match "${m?.[0]}"`)]
}

const schemaAjv = new Ajv2020({ allErrors: true, strict: false })
const schemaCache = new Map<string, ReturnType<typeof schemaAjv.compile>>()

/** jsonSchema: the target (default `json`, else `text` parsed as JSON) validates against `schema`. */
const jsonSchema: Grader = async (spec, obs, ctx) => {
  const schema = param<object>(spec, 'schema', (v) => !!v && typeof v === 'object', 'an object')
  const key = JSON.stringify(schema)
  let validate = schemaCache.get(key)
  if (!validate) schemaCache.set(key, (validate = schemaAjv.compile(schema)))
  let value: unknown
  if (typeof spec.target === 'string') value = targetValues(spec, obs, ctx)[0]
  else if (obs.json !== undefined) value = obs.json
  else {
    try {
      value = JSON.parse(obs.text)
    } catch {
      return [rate(metricOf(spec, 'schema_valid'), false, 'output is not JSON')]
    }
  }
  const ok = validate(value) === true
  return [rate(metricOf(spec, 'schema_valid'), ok, schemaAjv.errorsText(validate.errors))]
}

/** Pull a number from a value: numbers as-is, numeric strings parsed, otherwise the last number in the text. */
export function extractNumber(v: unknown, which: 'first' | 'last' = 'last'): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const direct = Number(v.trim().replace(/,/g, ''))
  if (v.trim() && Number.isFinite(direct)) return direct
  const all = [...v.replace(/(\d),(\d{3})/g, '$1$2').matchAll(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)].map((m) => Number(m[0]))
  return all.length ? (which === 'first' ? all[0]! : all[all.length - 1]!) : null
}

/** numericTolerance: |got − expected| ≤ max(abs, rel·|expected|). Defaults abs 1e-9. */
const numericTolerance: Grader = async (spec, obs, ctx) => {
  const expected = param<number>(spec, 'expected', (v) => typeof v === 'number' && Number.isFinite(v), 'a finite number')
  const abs = typeof spec.abs === 'number' ? spec.abs : 1e-9
  const rel = typeof spec.rel === 'number' ? spec.rel : 0
  const got = extractNumber(targetValues(spec, obs, ctx)[0], spec.extract === 'first' ? 'first' : 'last')
  if (got === null) return [rate(metricOf(spec, 'numeric_correct'), false, 'no number in output')]
  const ok = Math.abs(got - expected) <= Math.max(abs, rel * Math.abs(expected))
  return [rate(metricOf(spec, 'numeric_correct'), ok, `got ${got}, expected ${expected}`)]
}

/** solverEquivalent: the target is mathematically equivalent to `expected` per the injected MathChecker. `unverified` fails. */
const solverEquivalent: Grader = async (spec, obs, ctx) => {
  const expected = param<string>(spec, 'expected', (v) => typeof v === 'string' && v.length > 0, 'a non-empty string')
  const metric = metricOf(spec, 'solver_equivalent')
  const got = str(targetValues(spec, obs, ctx)[0]).trim()
  if (!got) return [rate(metric, false, 'no answer in output')]
  if (!ctx.math) return [rate(metric, false, 'unverified: no MathChecker configured')]
  try {
    const r = await ctx.math.equivalent(got, expected)
    if (r.ok === 'unverified') return [rate(metric, false, `unverified${r.reason ? `: ${r.reason}` : ''}`)]
    return [rate(metric, r.ok === true, r.reason ?? `${got} is not equivalent to ${expected}`)]
  } catch (e) {
    return [rate(metric, false, `unverified: checker failed (${(e as Error).message})`)]
  }
}

/**
 * citationIds: cited ids (target, default `json.segments[*].citations`) vs gold ids (`gold`, or the
 * path in `goldFrom`, default `case.context.goldChunkIds`). With gold ids: precision and recall
 * (means). With EMPTY gold (question not answerable from the material): "not in material" honesty —
 * any citation is a failure.
 */
const citationIds: Grader = async (spec, obs, ctx) => {
  const cited = [...new Set(targetValues(spec, obs, ctx, 'json.segments[*].citations').map(str).filter(Boolean))]
  const goldRaw = Array.isArray(spec.gold) ? spec.gold : resolvePath(graderScope(obs, ctx), typeof spec.goldFrom === 'string' ? spec.goldFrom : 'case.context.goldChunkIds')
  const gold = new Set(goldRaw.map(str).filter(Boolean))
  const prefix = typeof spec.metric === 'string' && spec.metric ? spec.metric : 'citation'
  if (!gold.size) {
    const honesty = typeof spec.honestyMetric === 'string' ? spec.honestyMetric : 'not_in_material_honesty'
    return [rate(honesty, cited.length === 0, `cited ${cited.join(', ')} for an out-of-material question`)]
  }
  const hits = cited.filter((c) => gold.has(c)).length
  const out: MetricSample[] = [{ metric: `${prefix}_recall`, kind: 'mean', value: hits / gold.size }]
  // precision is undefined without citations; recall (0) records the miss
  if (cited.length) out.push({ metric: `${prefix}_precision`, kind: 'mean', value: hits / cited.length, detail: hits < cited.length ? `uncited-in-gold: ${cited.filter((c) => !gold.has(c)).join(', ')}` : undefined })
  return out
}

/** latencyBudget: total latency (or `measure: "ttft"`) ≤ maxMs. A missing first-token time fails. */
const latencyBudget: Grader = async (spec, obs) => {
  const maxMs = param<number>(spec, 'maxMs', (v) => typeof v === 'number' && v > 0, 'a positive number')
  const v = spec.measure === 'ttft' ? obs.ttftMs : obs.latencyMs
  return [rate(metricOf(spec, spec.measure === 'ttft' ? 'ttft_within_budget' : 'latency_within_budget'), v !== null && v <= maxMs, `${v ?? 'unknown'} ms > ${maxMs} ms`)]
}

/** costBudget: metered cost ≤ maxMicros. Unknown cost fails unless `allowUnknown: true`. */
const costBudget: Grader = async (spec, obs) => {
  const maxMicros = param<number>(spec, 'maxMicros', (v) => typeof v === 'number' && v >= 0, 'a non-negative number')
  const metric = metricOf(spec, 'cost_within_budget')
  if (obs.costMicros === null) return [rate(metric, spec.allowUnknown === true, 'cost unknown (no pricing / metering)')]
  return [rate(metric, obs.costMicros <= maxMicros, `${obs.costMicros} micros > ${maxMicros}`)]
}

function requireJudge(ctx: GraderContext) {
  if (!ctx.judge) throw new AppError('judge_unavailable', 'no validated judges configured for this run')
  return ctx.judge
}

/** entailmentJudge: each claim (target, default segment texts) must be entailed by the premise (`premise` or `premiseFrom`). */
const entailmentJudgeGrader: Grader = async (spec, obs, ctx) => {
  const judge = requireJudge(ctx)
  const name = typeof spec.judge === 'string' ? spec.judge : 'entailment'
  const premise = typeof spec.premise === 'string' ? spec.premise : resolvePath(graderScope(obs, ctx), typeof spec.premiseFrom === 'string' ? spec.premiseFrom : 'case.context.sourceText').map(str).join('\n')
  if (!premise) throw new AppError('grader_spec_invalid', 'entailmentJudge: no premise (premise / premiseFrom)')
  const claims = targetValues(spec, obs, ctx, 'json.segments[*].text').map(str).filter(Boolean)
  if (!claims.length) return [rate(metricOf(spec, 'entailed'), false, 'no claims to check')]
  const verdicts = await Promise.all(claims.map((h) => judge(name, { kind: 'entailment', premise, hypothesis: h })))
  const bad = verdicts.findIndex((v) => v.label !== 'entailed')
  return [rate(metricOf(spec, 'entailed'), bad < 0, bad >= 0 ? `not entailed: ${claims[bad]!.slice(0, 120)}` : undefined)]
}

/** rubricJudge: the target (default text) passes `rubric` per a validated rubric judge; also records the score. */
const rubricJudgeGrader: Grader = async (spec, obs, ctx) => {
  const judge = requireJudge(ctx)
  const rubric = param<string>(spec, 'rubric', (v) => typeof v === 'string' && v.length > 0, 'a non-empty string')
  const name = typeof spec.judge === 'string' ? spec.judge : 'rubric'
  const response = targetValues(spec, obs, ctx).map(str).join('\n')
  const reference = typeof spec.reference === 'string' ? spec.reference : undefined
  const v = await judge(name, { kind: 'rubric', rubric, response, reference })
  const metric = metricOf(spec, 'rubric_pass')
  const out = [rate(metric, v.label === 'pass', v.rationale ?? 'rubric failed')]
  if (typeof v.score === 'number') out.push({ metric: `${metric}_score`, kind: 'mean', value: v.score })
  return out
}

/** Built-in graders by name. Extend with `{ ...GRADERS, custom }` and pass to the runner. */
export const GRADERS: Record<string, Grader> = {
  exact, regex, jsonSchema, numericTolerance, solverEquivalent, citationIds, latencyBudget, costBudget,
  entailmentJudge: entailmentJudgeGrader, rubricJudge: rubricJudgeGrader,
}

const DEFAULT_METRIC: Record<string, string> = {
  jsonSchema: 'schema_valid', numericTolerance: 'numeric_correct', solverEquivalent: 'solver_equivalent', costBudget: 'cost_within_budget',
  entailmentJudge: 'entailed', rubricJudge: 'rubric_pass',
}

/** Failing samples for the metrics a spec WOULD have produced (so failures land in the gated metric). */
function failSamples(spec: GraderSpec, obs: Observation, ctx: GraderContext, detail: string): MetricSample[] {
  if (spec.grader === 'citationIds') {
    const goldRaw = Array.isArray(spec.gold) ? spec.gold : resolvePath(graderScope(obs, ctx), typeof spec.goldFrom === 'string' ? spec.goldFrom : 'case.context.goldChunkIds')
    const prefix = typeof spec.metric === 'string' && spec.metric ? spec.metric : 'citation'
    if (!goldRaw.length) return [rate(typeof spec.honestyMetric === 'string' ? spec.honestyMetric : 'not_in_material_honesty', false, detail)]
    return [{ metric: `${prefix}_recall`, kind: 'mean', value: 0, detail }, { metric: `${prefix}_precision`, kind: 'mean', value: 0, detail }]
  }
  if (spec.grader === 'latencyBudget') return [rate(metricOf(spec, spec.measure === 'ttft' ? 'ttft_within_budget' : 'latency_within_budget'), false, detail)]
  return [rate(metricOf(spec, DEFAULT_METRIC[spec.grader] ?? spec.grader), false, detail)]
}

/** Does `spec.when` select this observation? (any resolved value equal to any listed value, for every key) */
export function specApplies(spec: GraderSpec, obs: Observation, ctx: GraderContext): boolean {
  if (!spec.when) return true
  const scope = graderScope(obs, ctx)
  return Object.entries(spec.when).every(([path, allowed]) => {
    const vals = resolvePath(scope, path)
    return Array.isArray(allowed) && vals.some((v) => allowed.some((a) => deepEqual(a, v)))
  })
}

/**
 * Apply one spec. Grader exceptions (bad spec, judge failure) become failing samples with the reason,
 * so a broken grader can never make a case pass. Failed calls fail every applicable spec.
 */
export async function applySpec(spec: GraderSpec, obs: Observation, ctx: GraderContext, graders: Record<string, Grader> = GRADERS): Promise<MetricSample[]> {
  if (!specApplies(spec, obs, ctx)) return []
  const g = graders[spec.grader]
  let samples: MetricSample[]
  if (!g) samples = failSamples(spec, obs, ctx, `unknown grader ${spec.grader}`)
  else if (obs.error && !['latencyBudget', 'costBudget'].includes(spec.grader)) samples = failSamples(spec, obs, ctx, `call failed: ${obs.error.kind}`)
  else {
    try {
      samples = await g(spec, obs, ctx)
    } catch (e) {
      samples = failSamples(spec, obs, ctx, `grader error: ${(e as Error).message}`)
    }
  }
  if (typeof spec.countFailures === 'string') {
    const failures = samples.filter((s) => s.kind === 'rate' && s.value === 0).length
    samples.push({ metric: spec.countFailures, kind: 'count', value: failures, detail: failures ? samples.find((s) => s.value === 0)?.detail : undefined })
  }
  return samples
}
