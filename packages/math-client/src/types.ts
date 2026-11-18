/**
 * Result types for the maths solver sidecar (services/math-solver).
 *
 * `ok` is true ONLY when the check passed (or, for evaluate/convertUnits, a value was computed).
 * Every other outcome — a failed check, an inconclusive proof, invalid input, or a solver that could
 * not be reached in time (`verdict: 'unverified'`) — has `ok: false`. Callers must never show a number
 * or mark an answer correct unless `ok === true`.
 */

export type Verdict = 'pass' | 'fail' | 'inconclusive' | 'invalid' | 'unverified'

/** Client-side / transport reasons for `verdict: 'unverified'` (fail-closed). */
export type UnverifiedReason = 'unavailable' | 'timeout' | 'busy' | 'bad_response'

export interface MathResult {
  ok: boolean
  verdict: Verdict
  /** stable machine-readable code, e.g. 'equivalent', 'not_equivalent', 'outside_tolerance', 'dimension_mismatch', 'timeout' */
  reason: string
  detail?: string
}

export interface UnverifiedResult extends MathResult {
  ok: false
  verdict: 'unverified'
  reason: UnverifiedReason | string
}

export type Assumption = 'complex' | 'real' | 'positive'

export interface EquivalenceOptions {
  /** domain assumed for every variable (default 'complex', i.e. no assumption) */
  assume?: Assumption
  /** only accept a symbolic proof; numeric-sampling agreement becomes 'inconclusive' */
  requireSymbolic?: boolean
}

export interface Counterexample {
  at: Record<string, string>
  a: string
  b: string
}

export interface EquivalenceResult extends MathResult {
  /** how the verdict was reached; 'numeric' with ok=true means "deterministic samples agree, no symbolic proof" */
  method?: 'symbolic' | 'numeric' | 'solution_set'
  counterexample?: Counterexample
  samples?: number
}

export interface StepResult {
  step: number
  verdict: Verdict
  reason: string
  method?: string
}

export interface CheckStepsResult extends MathResult {
  /** 0-based index into `steps` of the first step that does not follow from the previous one */
  firstBadStep?: number
  firstInconclusiveStep?: number
  /** for an invalid (unparseable) step */
  step?: number
  steps?: StepResult[]
  counterexample?: Counterexample
}

export type UnitSpec = string | { expected: string; actual: string }

export interface NumericCheckInput {
  expected: number | string
  actual: number | string
  /** default 1e-9 */
  tolerance?: number
  /** tolerance relative to |expected| (falls back to absolute when expected is 0) */
  relative?: boolean
  /** unit of both values, or separate units (actual is converted to the expected unit) */
  units?: UnitSpec
}

export interface NumericCheckResult extends MathResult {
  expectedValue?: string
  actualValue?: string
  difference?: string
  tolerance?: string
  relative?: boolean
  unit?: string
  dimension?: string
  note?: string
}

export interface EvaluateOptions {
  substitutions?: Record<string, number | string>
  /** significant digits, 1..100 (default 15) */
  precision?: number
}

export interface EvaluateResult extends MathResult {
  value?: string
  exact?: string | null
  isReal?: boolean
  precision?: number
  symbols?: string[]
}

export interface ConvertUnitsResult extends MathResult {
  value?: string
  exact?: string | null
  factor?: string | null
  unit?: string
}

/** The interface other packages depend on (inject an implementation; fakes are fine in tests). */
export interface MathChecker {
  equivalent(a: string, b: string, opts?: EquivalenceOptions): Promise<EquivalenceResult>
  checkSteps(steps: string[], opts?: EquivalenceOptions): Promise<CheckStepsResult>
  numericCheck(input: NumericCheckInput): Promise<NumericCheckResult>
  evaluate(expr: string, opts?: EvaluateOptions): Promise<EvaluateResult>
  convertUnits(value: number | string, from: string, to: string, opts?: { precision?: number }): Promise<ConvertUnitsResult>
  /** true when the service answers /health with at least one idle worker */
  healthy(): Promise<boolean>
}
