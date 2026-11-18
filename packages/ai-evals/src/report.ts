import { AppError } from '@platform/core'
import { evaluateGate, parseGate, regression, type GateResult, type RegressionResult } from './gates.ts'
import type { Reproducibility, RunRecord } from './runner.ts'
import { mean, meanInterval, percentile, wilson, type Interval } from './stats.ts'
import type { CaseResult, MetricKind } from './types.ts'

export const REPORT_SCHEMA = 'ai-evals/report@1'

export interface MetricSummary {
  kind: MetricKind | 'measure'
  value: number
  /** items the metric was measured on (cases for grader metrics, calls for latency) */
  n: number
  /** 95% interval: Wilson for rates, normal approximation for means */
  interval?: Interval
  successes?: number
  /** true when the metric lives on a 0..1 scale (regression points are percentage points) */
  unit: boolean
}

export interface Report {
  schema: typeof REPORT_SCHEMA
  runId: string
  suite: string
  startedAt: string
  finishedAt: string
  complete: boolean
  stoppedBy: RunRecord['stoppedBy']
  /** all gates pass, no regression beyond the rule, and the run is complete */
  passed: boolean
  summary: { selected: number; attempted: number; ok: number; errors: number; skipped: number; passedCases: number }
  metrics: Record<string, MetricSummary>
  byTag: Record<string, Record<string, MetricSummary>>
  byTask: Record<string, Record<string, MetricSummary>>
  cost: { currency: string | null; totalMicros: number | null; perCaseMicros: number | null; judgeMicros: number | null; inputTokens: number; outputTokens: number }
  gates: { results: GateResult[]; regressions: RegressionResult[]; passed: boolean; reasons: string[] }
  baseline: null | { runId: string; datasetVersion: string; sameDataset: boolean; diffs: Record<string, { baseline: number; current: number; delta: number }> }
  notes: string[]
  reproducibility: Reproducibility
  cases: CaseResult[]
}

function summarize(cases: CaseResult[]): Record<string, MetricSummary> {
  const by = new Map<string, { kind: MetricKind; values: number[] }>()
  for (const c of cases) {
    for (const s of c.samples) {
      const e = by.get(s.metric) ?? { kind: s.kind, values: [] }
      e.values.push(s.value)
      by.set(s.metric, e)
    }
  }
  const out: Record<string, MetricSummary> = {}
  for (const [name, { kind, values }] of by) {
    if (kind === 'rate') {
      const k = values.filter((v) => v === 1).length
      out[name] = { kind, value: k / values.length, n: values.length, successes: k, interval: wilson(k, values.length), unit: true }
    } else if (kind === 'mean') {
      out[name] = { kind, value: mean(values), n: values.length, interval: meanInterval(values), unit: values.every((v) => v >= 0 && v <= 1) }
    } else {
      out[name] = { kind, value: values.reduce((a, b) => a + b, 0), n: values.length, unit: false }
    }
  }
  // built-in run metrics
  const attempted = cases.filter((c) => c.status !== 'skipped')
  if (attempted.length) {
    const passed = attempted.filter((c) => c.passed).length
    const errors = attempted.filter((c) => c.status === 'error').length
    out.case_pass_rate = { kind: 'rate', value: passed / attempted.length, n: attempted.length, successes: passed, interval: wilson(passed, attempted.length), unit: true }
    out.error_rate = { kind: 'rate', value: errors / attempted.length, n: attempted.length, successes: errors, interval: wilson(errors, attempted.length), unit: true }
    const calls = attempted.flatMap((c) => c.calls)
    if (calls.length) {
      const valid = calls.filter((x) => x.error?.kind !== 'invalid_output').length
      out.schema_valid_rate = { kind: 'rate', value: valid / calls.length, n: calls.length, successes: valid, interval: wilson(valid, calls.length), unit: true }
      const lat = calls.filter((x) => !x.error).map((x) => x.latencyMs)
      if (lat.length) {
        out.p50_latency_ms = { kind: 'measure', value: percentile(lat, 50), n: lat.length, unit: false }
        out.p95_latency_ms = { kind: 'measure', value: percentile(lat, 95), n: lat.length, unit: false }
      }
      const ttft = calls.map((x) => x.ttftMs).filter((v): v is number => v !== null)
      if (ttft.length) {
        out.p50_first_token_ms = { kind: 'measure', value: percentile(ttft, 50), n: ttft.length, unit: false }
        out.p95_first_token_ms = { kind: 'measure', value: percentile(ttft, 95), n: ttft.length, unit: false }
      }
    }
    const costs = attempted.map((c) => c.costMicros).filter((v): v is number => v !== null)
    if (costs.length) {
      out.cost_micros_total = { kind: 'measure', value: costs.reduce((a, b) => a + b, 0), n: costs.length, unit: false }
      out.cost_micros_per_case = { kind: 'measure', value: mean(costs), n: costs.length, interval: meanInterval(costs), unit: false }
    }
  }
  return out
}

function groupBy(cases: CaseResult[], keys: (c: CaseResult) => string[]): Record<string, Record<string, MetricSummary>> {
  const groups = new Map<string, CaseResult[]>()
  for (const c of cases) for (const k of keys(c)) groups.set(k, [...(groups.get(k) ?? []), c])
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, cs]) => [k, summarize(cs)]))
}

export interface ReportOptions {
  gates: string[]
  baseline?: Report | null
  /** regression threshold in points (default 2) */
  regressionPoints?: number
  notes?: string[]
}

/** Build the JSON report: metrics with 95% intervals, per-tag/per-task breakdowns, gates, baseline rule. */
export function buildReport(run: RunRecord, o: ReportOptions): Report {
  if (o.baseline && o.baseline.schema !== REPORT_SCHEMA) throw new AppError('eval_baseline_invalid', `baseline is not a ${REPORT_SCHEMA} report`)
  const metrics = summarize(run.cases)
  const gates = o.gates.map(parseGate)
  const results = gates.map((g) => evaluateGate(g, metrics[g.metric]))
  const regressions: RegressionResult[] = []
  const notes = [...(o.notes ?? [])]
  let baseline: Report['baseline'] = null
  if (o.baseline) {
    const b = o.baseline
    const diffs: Record<string, { baseline: number; current: number; delta: number }> = {}
    for (const [k, m] of Object.entries(metrics)) {
      const bm = b.metrics[k]
      if (bm && Number.isFinite(bm.value) && Number.isFinite(m.value)) diffs[k] = { baseline: bm.value, current: m.value, delta: m.value - bm.value }
    }
    const sameDataset = b.reproducibility.datasetVersion === run.reproducibility.datasetVersion && b.reproducibility.caseIdsHash === run.reproducibility.caseIdsHash
    if (!sameDataset) notes.push('Baseline was measured on a different dataset version or case selection; the regression comparison is not like-for-like.')
    baseline = { runId: b.runId, datasetVersion: b.reproducibility.datasetVersion, sameDataset, diffs }
    for (const g of gates) {
      const cur = metrics[g.metric]
      const base = b.metrics[g.metric]
      if (!cur || !base) continue
      const r = regression(g, cur.value, base.value, cur.unit && base.unit, o.regressionPoints ?? 2)
      if (r) regressions.push(r)
    }
  }
  const reasons: string[] = []
  if (!run.complete) reasons.push(`run incomplete (stopped by ${run.stoppedBy})`)
  for (const r of results) if (!r.passed) reasons.push(`gate failed: ${r.expr} (${r.reason})`)
  for (const r of regressions) if (r.failed) reasons.push(`regression: ${r.metric} ${r.baseline} → ${r.current} (${r.worsePoints.toFixed(2)} points worse > ${o.regressionPoints ?? 2})`)
  if (!gates.length) reasons.push('no gates declared')
  const attempted = run.cases.filter((c) => c.status !== 'skipped')
  const totalIn = attempted.flatMap((c) => c.calls).reduce((a, x) => a + (x.inputTokens ?? 0), 0)
  const totalOut = attempted.flatMap((c) => c.calls).reduce((a, x) => a + (x.outputTokens ?? 0), 0)
  const caseCosts = attempted.map((c) => c.costMicros).filter((v): v is number => v !== null)
  return {
    schema: REPORT_SCHEMA, runId: run.runId, suite: run.suite, startedAt: run.startedAt, finishedAt: run.finishedAt, complete: run.complete, stoppedBy: run.stoppedBy,
    passed: reasons.length === 0,
    summary: {
      selected: run.cases.length, attempted: attempted.length, ok: attempted.filter((c) => c.status === 'ok').length,
      errors: attempted.filter((c) => c.status === 'error').length, skipped: run.cases.length - attempted.length, passedCases: attempted.filter((c) => c.passed).length,
    },
    metrics,
    byTag: groupBy(run.cases, (c) => c.tags),
    byTask: groupBy(run.cases, (c) => [c.task]),
    cost: {
      currency: run.currency, totalMicros: caseCosts.length ? caseCosts.reduce((a, b) => a + b, 0) : null,
      perCaseMicros: caseCosts.length ? mean(caseCosts) : null, judgeMicros: run.judgeSpendMicros, inputTokens: totalIn, outputTokens: totalOut,
    },
    gates: { results, regressions, passed: reasons.length === 0, reasons },
    baseline, notes, reproducibility: run.reproducibility, cases: run.cases,
  }
}

const fmt = (v: number | null | undefined, unit = false) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : unit ? v.toFixed(3) : Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-IN') : String(Number(v.toFixed(2)))
const ci = (m: MetricSummary) => (m.interval ? `[${fmt(m.interval.low, m.unit)}, ${fmt(m.interval.high, m.unit)}]` : '')
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** Human-readable Markdown summary of a report. */
export function renderMarkdown(r: Report): string {
  const L: string[] = []
  L.push(`# Eval report — ${r.suite}`, '')
  L.push(`**${r.passed ? 'PASS' : 'FAIL'}** · run \`${r.runId}\` · ${r.startedAt} → ${r.finishedAt}`, '')
  for (const n of r.notes) L.push(`> ${n}`, '')
  L.push(`Cases: ${r.summary.attempted}/${r.summary.selected} attempted · ${r.summary.passedCases} passed · ${r.summary.errors} errors · ${r.summary.skipped} skipped${r.complete ? '' : ` · **stopped by ${r.stoppedBy}**`}`, '')
  L.push('## Gates', '', '| Gate | Value | Result |', '|---|---|---|')
  for (const g of r.gates.results) L.push(`| \`${g.expr}\` | ${fmt(g.value, r.metrics[g.metric]?.unit)} | ${g.passed ? 'pass' : `**fail** — ${esc(g.reason ?? '')}`} |`)
  if (!r.gates.results.length) L.push('| (none) | | **fail** |')
  if (r.baseline) {
    L.push('', `## Baseline (\`${r.baseline.runId}\`${r.baseline.sameDataset ? '' : ', different dataset'})`, '', '| Gated metric | Baseline | Current | Points worse | Result |', '|---|---|---|---|---|')
    for (const x of r.gates.regressions) {
      const u = r.metrics[x.metric]?.unit
      L.push(`| ${x.metric} | ${fmt(x.baseline, u)} | ${fmt(x.current, u)} | ${fmt(x.worsePoints)} | ${x.failed ? '**regression**' : 'ok'} |`)
    }
  }
  if (r.gates.reasons.length) L.push('', '**Why it failed:**', '', ...r.gates.reasons.map((x) => `- ${x}`))
  L.push('', '## Metrics', '', '| Metric | Value | 95% CI | n |', '|---|---|---|---|')
  for (const [k, m] of Object.entries(r.metrics).sort(([a], [b]) => a.localeCompare(b))) L.push(`| ${k} | ${fmt(m.value, m.unit)} | ${ci(m)} | ${m.n} |`)
  const tags = Object.keys(r.byTag)
  if (tags.length) {
    const names = [...new Set(Object.values(r.byTag).flatMap((t) => Object.entries(t).filter(([, m]) => m.kind === 'rate').map(([k]) => k)))].sort()
    L.push('', '## By tag (rates)', '', `| Tag | ${names.join(' | ')} |`, `|---|${names.map(() => '---').join('|')}|`)
    for (const t of tags) L.push(`| ${t} | ${names.map((k) => { const m = r.byTag[t]![k]; return m ? `${fmt(m.value, true)} (n=${m.n})` : '—' }).join(' | ')} |`)
  }
  L.push('', '## Cost and tokens', '', `- Total: ${fmt(r.cost.totalMicros)} ${r.cost.currency ?? ''} micros · per case: ${fmt(r.cost.perCaseMicros)} · judges: ${fmt(r.cost.judgeMicros)}`, `- Tokens: ${r.cost.inputTokens} in / ${r.cost.outputTokens} out`)
  const rp = r.reproducibility
  L.push('', '## Reproducibility', '', `- Dataset version: \`${rp.datasetVersion}\` (${rp.datasets.map((d) => `${d.file.split(/[\\/]/).pop()}: ${d.cases} cases`).join(', ')}) · selection ${JSON.stringify(rp.selection)}`,
    `- Prompt versions: ${Object.entries(rp.promptVersions).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}`,
    `- Tasks: ${rp.tasks.map((t) => `${t.id} (${t.hash.slice(0, 12)})`).join(', ')}`,
    `- Routes: ${rp.routes.map((x) => `${x.taskId} → ${x.adapter}/${x.modelId} (${x.calls} calls, ${x.fallbacks} fallbacks)`).join('; ') || '—'}`,
    `- Route config: ${rp.routeConfigHash?.slice(0, 12) ?? '—'} · judges: ${rp.judges.map((j) => `${j.name}@${j.version} (agreement ${j.agreement.toFixed(3)}, n=${j.n})`).join(', ') || 'none'}`,
    `- Commit: ${rp.commit ?? 'unknown'} · ${rp.framework} · node ${rp.node}`)
  const failing = r.cases.filter((c) => c.status !== 'skipped' && !c.passed)
  if (failing.length) {
    L.push('', `## Failing cases (${failing.length})`, '', '| Case | Tags | Why |', '|---|---|---|')
    for (const c of failing.slice(0, 50)) {
      const why = c.error ? `${c.error.kind}: ${c.error.message}` : c.samples.filter((s) => (s.kind === 'rate' && s.value === 0) || (s.kind === 'count' && s.value > 0)).map((s) => `${s.metric}${s.detail ? ` (${s.detail})` : ''}`).join('; ')
      L.push(`| ${c.id} | ${c.tags.join(', ')} | ${esc(why).slice(0, 300)} |`)
    }
    if (failing.length > 50) L.push(`| … | | ${failing.length - 50} more in report.json |`)
  }
  return L.join('\n') + '\n'
}
