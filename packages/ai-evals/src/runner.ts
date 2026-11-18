import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { AppError } from '@platform/core'
import { withSpan } from '@platform/observability'
import type { RouteInfo } from '@platform/ai-gateway'
import { canonicalJson, sha256 } from './dataset.ts'
import { GRADERS, applySpec, type Grader, type MathChecker } from './graders.ts'
import type { JudgeItem, JudgeVerdict, TrustedJudge } from './judges.ts'
import type { CaseResult, DialogueTurn, EvalCall, EvalCase, EvalSuite, GatewayLike, GraderSpec, MeteringReader, MetricSample, Observation } from './types.ts'

export const FRAMEWORK_VERSION = '@platform/ai-evals@0.1.0'

export interface RunOptions {
  gateway: GatewayLike
  suite: EvalSuite
  cases: EvalCase[]
  /** tenant the eval traffic is metered to (a dedicated eval tenant; no student data) */
  tenantId: string
  /** parallel cases (default 4) */
  concurrency?: number
  /** stop starting new cases once metered spend (cases + judges) reaches this many currency micro-units */
  spendCapMicros?: number
  /** read access to `platform.ai_operations` for cost / tokens (required for a spend cap) */
  metering?: MeteringReader
  graders?: Record<string, Grader>
  math?: MathChecker
  judges?: TrustedJudge[]
  /** per-case wall-clock limit (aborts the gateway call) */
  caseTimeoutMs?: number
  signal?: AbortSignal
  /** reproducibility inputs */
  dataset: { version: string; files: { file: string; version: string; cases: number }[] }
  selection?: Record<string, unknown>
  routeConfig?: unknown
  commit?: string | null
  onCase?: (r: CaseResult) => void
}

export interface RouteUse {
  taskId: string
  deploymentId: string
  connectionId: string
  adapter: string
  modelId: string
  calls: number
  fallbacks: number
}

export interface Reproducibility {
  suite: string
  datasetVersion: string
  datasets: { file: string; version: string; cases: number }[]
  selection: Record<string, unknown>
  caseIdsHash: string
  promptVersions: Record<string, string>
  tasks: { id: string; hash: string }[]
  taskDefinitions: unknown[]
  routes: RouteUse[]
  routeConfigHash: string | null
  routeConfig: unknown
  judges: { name: string; version: string; taskId: string; agreement: number; n: number; kappa: number; validatedAt: string }[]
  commit: string | null
  node: string
  framework: string
}

export interface RunRecord {
  runId: string
  suite: string
  startedAt: string
  finishedAt: string
  /** every selected case was attempted (no spend-cap / abort stop) */
  complete: boolean
  stoppedBy: 'spend_cap' | 'aborted' | null
  spendMicros: number | null
  judgeSpendMicros: number | null
  currency: string | null
  cases: CaseResult[]
  reproducibility: Reproducibility
}

/** Current git commit (with `+dirty` when the tree has local changes); null outside a repository. */
export function gitCommit(cwd = process.cwd()): string | null {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0
    return dirty ? `${head}+dirty` : head
  } catch {
    return null
  }
}

/** Judge names referenced by the specs of these cases (default names per judge grader). */
export function referencedJudges(cases: EvalCase[], extra: GraderSpec[] = []): Set<string> {
  const names = new Set<string>()
  const visit = (s: GraderSpec) => {
    if (s.grader === 'entailmentJudge') names.add(typeof s.judge === 'string' ? s.judge : 'entailment')
    if (s.grader === 'rubricJudge') names.add(typeof s.judge === 'string' ? s.judge : 'rubric')
  }
  extra.forEach(visit)
  for (const c of cases) {
    c.expect.forEach(visit)
    if (Array.isArray(c.input.turns)) for (const t of c.input.turns as DialogueTurn[]) t.expect?.forEach(visit)
  }
  return names
}

interface Metered {
  costMicros: number | null
  currency: string | null
  inputTokens: number | null
  outputTokens: number | null
}

async function readMetering(m: MeteringReader | undefined, traceId: string): Promise<Metered | null> {
  if (!m) return null
  const r = await m.query<{ cost: string | number | null; currency: string | null; input_tokens: string | number | null; output_tokens: string | number | null }>(
    `select sum(cost_micros) as cost, max(currency) as currency, sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens
     from platform.ai_operations where trace_id = $1`, [traceId])
  const row = r.rows[0]
  const num = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Number(v))
  return { costMicros: num(row?.cost), currency: row?.currency ?? null, inputTokens: num(row?.input_tokens), outputTokens: num(row?.output_tokens) }
}

const addNullable = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0))

/** Fold samples of one case: a rate passes only if every sample passed; means average; counts sum. */
export function foldSamples(samples: MetricSample[]): MetricSample[] {
  const by = new Map<string, MetricSample[]>()
  for (const s of samples) by.set(s.metric, [...(by.get(s.metric) ?? []), s])
  return [...by.entries()].map(([metric, ss]) => {
    const kind = ss[0]!.kind
    if (ss.some((s) => s.kind !== kind)) throw new AppError('eval_metric_kind_conflict', `metric ${metric} is produced with different kinds (${[...new Set(ss.map((s) => s.kind))].join(', ')})`)
    const failed = ss.find((s) => (kind === 'rate' && s.value === 0) || (kind === 'count' && s.value > 0))
    const value = kind === 'rate' ? Math.min(...ss.map((s) => s.value)) : kind === 'count' ? ss.reduce((a, s) => a + s.value, 0) : ss.reduce((a, s) => a + s.value, 0) / ss.length
    return { metric, kind, value, detail: failed?.detail }
  })
}

/**
 * Execute a suite's cases through a gateway. Each gateway call runs in its own trace so its metered
 * attempts (including retries and fallbacks) can be read back for cost and tokens.
 */
export async function runSuite(o: RunOptions): Promise<RunRecord> {
  const startedAt = new Date().toISOString()
  const runId = `eval_${startedAt.slice(0, 10).replace(/-/g, '')}_${randomUUID().slice(0, 8)}`
  const graders = o.graders ?? GRADERS
  const concurrency = Math.max(1, Math.floor(o.concurrency ?? 4))
  if (o.spendCapMicros !== undefined && !o.metering) throw new AppError('eval_spend_cap_unenforceable', 'a spend cap needs metering access (ai_operations)')
  const judges = new Map((o.judges ?? []).map((j) => [j.definition.name, j]))
  // refuse up-front (before any spend) if a case needs a judge that is not validated
  const missing = [...referencedJudges(o.cases, o.suite.defaultExpect)].filter((n) => !judges.has(n))
  if (missing.length) throw new AppError('judge_not_trusted', `suite ${o.suite.name} uses judge(s) without a passing validation: ${missing.join(', ')}`)
  for (const c of o.cases) {
    if (Array.isArray(c.input.turns) && !o.suite.dialogue) throw new AppError('eval_suite_invalid', `case ${c.id} is a dialogue but suite ${o.suite.name} has no dialogue driver`)
  }

  const routes = new Map<string, RouteUse>()
  let spent = 0
  let judgeSpent: number | null = null
  let currency: string | null = null
  let stoppedBy: RunRecord['stoppedBy'] = null
  const noteRoute = (taskId: string, r: RouteInfo | undefined) => {
    if (!r) return
    const k = `${taskId}|${r.deploymentId}`
    const u = routes.get(k) ?? { taskId, deploymentId: r.deploymentId, connectionId: r.connectionId, adapter: r.adapter, modelId: r.modelId, calls: 0, fallbacks: 0 }
    u.calls++
    if (r.fallback) u.fallbacks++
    routes.set(k, u)
  }

  async function execute(call: EvalCall, signal: AbortSignal | undefined): Promise<Observation> {
    const traceId = randomBytes(16).toString('hex')
    const obs: Observation = { text: '', latencyMs: 0, ttftMs: null, inputTokens: null, outputTokens: null, costMicros: null, currency: null, meta: { ...(call.meta ?? {}) } }
    const ctx = { tenantId: o.tenantId, promptVersion: call.promptVersion ?? o.suite.promptVersions?.[call.taskId], signal }
    const start = performance.now()
    await withSpan(`eval.call ${call.taskId}`, async () => {
      try {
        const op = call.operation ?? 'run'
        if (op === 'embed') {
          const r = await o.gateway.embed(call.taskId, call.inputs ?? [], ctx, call.purpose)
          Object.assign(obs, { vectors: r.vectors, route: r.route, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens })
        } else if (op === 'stream') {
          for await (const ev of o.gateway.stream(call.taskId, call.input ?? { messages: [] }, ctx)) {
            if (ev.t === 'route') obs.route = ev.route
            else if (ev.t === 'text') {
              if (obs.ttftMs === null) obs.ttftMs = Math.round(performance.now() - start)
              obs.text += ev.delta
            } else if (ev.t === 'output') obs.json = ev.json
            else if (ev.t === 'usage') Object.assign(obs, { inputTokens: ev.usage.inputTokens, outputTokens: ev.usage.outputTokens })
            else if (ev.t === 'finish') obs.finish = ev.finish
            else if ((ev as { t: string }).t === 'error') throw (ev as unknown as { error: unknown }).error
          }
        } else {
          const r = await o.gateway.run(call.taskId, call.input ?? { messages: [] }, ctx)
          Object.assign(obs, { text: r.text, json: r.json, finish: r.finish, route: r.route, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens })
          if (r.json === undefined && /^\s*[[{]/.test(r.text)) {
            try {
              obs.json = JSON.parse(r.text)
            } catch { /* not JSON: graders that need JSON fail */ }
          }
        }
      } catch (e) {
        const err = e as { kind?: string; message?: string }
        obs.error = { kind: typeof err.kind === 'string' ? err.kind : signal?.aborted ? 'timeout' : 'exception', message: String(err.message ?? e) }
      }
    }, traceId)
    obs.latencyMs = Math.round(performance.now() - start)
    const m = await readMetering(o.metering, traceId)
    if (m) {
      obs.costMicros = m.costMicros
      obs.currency = m.currency
      obs.inputTokens ??= m.inputTokens
      obs.outputTokens ??= m.outputTokens
    }
    noteRoute(call.taskId, obs.route)
    return obs
  }

  async function runCase(c: EvalCase): Promise<CaseResult> {
    const signal = o.caseTimeoutMs ? AbortSignal.any([AbortSignal.timeout(o.caseTimeoutMs), ...(o.signal ? [o.signal] : [])]) : o.signal
    let judgeCost: number | null = null
    const judge = async (name: string, item: JudgeItem): Promise<JudgeVerdict> => {
      const j = judges.get(name)
      if (!j) throw new AppError('judge_not_trusted', `judge ${name} is not validated`)
      const traceId = randomBytes(16).toString('hex')
      try {
        return await withSpan(`eval.judge ${name}`, async () => {
          const r = await o.gateway.run(j.definition.taskId, j.definition.buildInput(item), { tenantId: o.tenantId, promptVersion: j.definition.version })
          noteRoute(j.definition.taskId, r.route)
          return j.definition.parse(r)
        }, traceId)
      } finally {
        const m = await readMetering(o.metering, traceId)
        if (m) judgeCost = addNullable(judgeCost, m.costMicros)
      }
    }
    const base = { math: o.math, judge: judges.size ? judge : undefined }
    const samples: MetricSample[] = []
    const calls: Observation[] = []
    const shared = [...(o.suite.defaultExpect ?? []), ...c.expect]
    let error: CaseResult['error']

    if (Array.isArray(c.input.turns)) {
      const driver = o.suite.dialogue!
      let state = driver.start(c)
      for (const [i, turn] of (c.input.turns as DialogueTurn[]).entries()) {
        let obs: Observation
        try {
          obs = await execute(driver.turn(state, turn, c), signal)
        } catch (e) {
          // orchestrator (driver) failure: a logic error, recorded as such
          error = { kind: 'driver_error', message: (e as Error).message }
          break
        }
        calls.push(obs)
        // observe first: the driver folds the output into its state and may annotate obs.meta
        // with post-processing results (e.g. relabelled segments) that graders assert on
        if (!obs.error) {
          try {
            state = driver.observe(state, turn, obs, c)
          } catch (e) {
            error = { kind: 'driver_error', message: (e as Error).message }
          }
        }
        const ctx = { ...base, case: c, turn, turnIndex: i }
        for (const spec of [...shared, ...(turn.expect ?? [])]) samples.push(...(await applySpec(spec, obs, ctx, graders)))
        if (obs.error) error = obs.error
        if (error) break
      }
    } else {
      const call = o.suite.buildCall ? o.suite.buildCall(c) : { taskId: c.task, input: c.input as unknown as EvalCall['input'] }
      const obs = await execute(call, signal)
      calls.push(obs)
      for (const spec of shared) samples.push(...(await applySpec(spec, obs, { ...base, case: c }, graders)))
      if (obs.error) error = obs.error
    }

    const folded = foldSamples(samples)
    const costMicros = calls.reduce<number | null>((a, x) => addNullable(a, x.costMicros), null)
    currency ??= calls.find((x) => x.currency)?.currency ?? null
    return {
      id: c.id, task: c.task, tags: c.tags, split: c.split, status: error ? 'error' : 'ok', error,
      passed: !error && folded.every((s) => (s.kind === 'rate' ? s.value === 1 : s.kind === 'count' ? s.value === 0 : true)),
      samples: folded,
      calls: calls.map(({ text, json: _json, vectors: _vectors, ...rest }) => ({ ...rest, textChars: text.length })),
      latencyMs: calls.reduce((a, x) => a + x.latencyMs, 0),
      costMicros, judgeCostMicros: judgeCost,
    }
  }

  const results: CaseResult[] = new Array(o.cases.length)
  let next = 0
  const skip = (c: EvalCase, reason: string): CaseResult => ({
    id: c.id, task: c.task, tags: c.tags, split: c.split, status: 'skipped', skippedReason: reason, passed: false, samples: [], calls: [], latencyMs: 0, costMicros: null, judgeCostMicros: null,
  })
  await Promise.all(Array.from({ length: Math.min(concurrency, o.cases.length) }, async () => {
    while (next < o.cases.length) {
      const i = next++
      const c = o.cases[i]!
      if (o.signal?.aborted) {
        stoppedBy ??= 'aborted'
        results[i] = skip(c, 'aborted')
        continue
      }
      if (o.spendCapMicros !== undefined && spent >= o.spendCapMicros) {
        stoppedBy ??= 'spend_cap'
        results[i] = skip(c, 'spend_cap')
        continue
      }
      let r: CaseResult
      try {
        r = await runCase(c)
      } catch (e) {
        r = { ...skip(c, ''), status: 'error', skippedReason: undefined, error: { kind: 'runner_error', message: (e as Error).message } }
      }
      spent += (r.costMicros ?? 0) + (r.judgeCostMicros ?? 0)
      if (r.judgeCostMicros !== null) judgeSpent = (judgeSpent ?? 0) + r.judgeCostMicros
      results[i] = r
      o.onCase?.(r)
    }
  }))

  const taskIds = [...new Set(o.cases.map((c) => c.task))]
  const tasks = o.suite.tasks.filter((t) => taskIds.includes(t.id) || [...routes.values()].some((u) => u.taskId === t.id))
  const anyMetered = results.some((r) => r.costMicros !== null)
  return {
    runId, suite: o.suite.name, startedAt, finishedAt: new Date().toISOString(),
    complete: stoppedBy === null, stoppedBy,
    spendMicros: o.metering && anyMetered ? spent : null, judgeSpendMicros: judgeSpent, currency,
    cases: results,
    reproducibility: {
      suite: o.suite.name,
      datasetVersion: o.dataset.version,
      datasets: o.dataset.files,
      selection: o.selection ?? {},
      caseIdsHash: sha256(o.cases.map((c) => c.id).sort().join('\n')),
      promptVersions: { ...(o.suite.promptVersions ?? {}), ...Object.fromEntries((o.judges ?? []).map((j) => [j.definition.taskId, j.definition.version])) },
      tasks: tasks.map((t) => ({ id: t.id, hash: sha256(canonicalJson(t)) })),
      taskDefinitions: tasks,
      routes: [...routes.values()].filter((u) => u.deploymentId),
      routeConfigHash: o.routeConfig === undefined ? null : sha256(canonicalJson(o.routeConfig)),
      routeConfig: o.routeConfig ?? null,
      judges: (o.judges ?? []).map((j) => ({ name: j.definition.name, version: j.definition.version, taskId: j.definition.taskId, agreement: j.validation.agreement, n: j.validation.n, kappa: j.validation.kappa, validatedAt: j.validation.validatedAt })),
      commit: o.commit === undefined ? gitCommit() : o.commit,
      node: process.version,
      framework: FRAMEWORK_VERSION,
    },
  }
}
