import { AppError } from '@platform/core'

/**
 * Gate expressions as declared by modules (`evals.gates`): `metric op threshold`, e.g.
 * `citation_precision >= 0.95`, `graded_mode_leaks == 0`, `p95_latency_ms <= 6000`.
 */
export type GateOp = '>=' | '<=' | '>' | '<' | '==' | '!='

export interface Gate {
  expr: string
  metric: string
  op: GateOp
  threshold: number
}

export interface GateResult extends Gate {
  value: number | null
  passed: boolean
  reason?: string
}

export interface RegressionResult {
  metric: string
  baseline: number
  current: number
  /** how much worse, in points (percentage points for 0..1 metrics, % change otherwise); negative = better */
  worsePoints: number
  failed: boolean
}

const GATE = /^\s*([a-z][a-z0-9_.]*)\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*$/i

export function parseGate(expr: string): Gate {
  const m = GATE.exec(expr)
  if (!m) throw new AppError('eval_gate_invalid', `gate "${expr}" must look like "metric >= 0.95"`)
  return { expr: expr.trim(), metric: m[1]!, op: m[2] as GateOp, threshold: Number(m[3]) }
}

export function compare(value: number, op: GateOp, threshold: number): boolean {
  switch (op) {
    case '>=': return value >= threshold
    case '<=': return value <= threshold
    case '>': return value > threshold
    case '<': return value < threshold
    case '==': return value === threshold
    case '!=': return value !== threshold
  }
}

/** Evaluate a gate. An unmeasured metric (missing, NaN, or measured on 0 items) FAILS. */
export function evaluateGate(g: Gate, metric: { value: number; n: number } | undefined): GateResult {
  if (!metric || !Number.isFinite(metric.value) || metric.n === 0) return { ...g, value: null, passed: false, reason: 'metric not measured in this run' }
  const passed = compare(metric.value, g.op, g.threshold)
  return { ...g, value: metric.value, passed, reason: passed ? undefined : `${metric.value} does not satisfy ${g.op} ${g.threshold}` }
}

/**
 * Baseline regression rule (AI_EVALUATION_FRAMEWORK.md § 4): a gated metric that gets worse than the
 * baseline by more than `points` fails, even when still above the gate. "Points" are percentage
 * points for metrics on a 0..1 scale (rates, precision/recall) and percent change otherwise
 * (latency, cost). Direction comes from the gate: `>=`/`>` higher is better, `<=`/`<` lower is
 * better, `==` closer to the threshold is better; `!=` gates have no direction and are not compared.
 */
export function regression(g: Gate, current: number, baseline: number, unitScale: boolean, points = 2): RegressionResult | null {
  if (g.op === '!=' || !Number.isFinite(current) || !Number.isFinite(baseline)) return null
  const scale = (x: number) => (unitScale ? x * 100 : baseline === 0 ? (x === 0 ? 0 : Infinity * Math.sign(x)) : (x / Math.abs(baseline)) * 100)
  let worse: number
  if (g.op === '>=' || g.op === '>') worse = scale(baseline - current)
  else if (g.op === '<=' || g.op === '<') worse = scale(current - baseline)
  else worse = scale(Math.abs(current - g.threshold) - Math.abs(baseline - g.threshold))
  // a count gated `== 0` rising from 0 is already a gate failure; any rise in it is also a regression
  return { metric: g.metric, baseline, current, worsePoints: worse, failed: worse > points + 1e-9 }
}
