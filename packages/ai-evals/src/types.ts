import type { GatewayStreamEvent, RouteInfo, RunInput, RunResult, TaskDefinition } from '@platform/ai-gateway'

/** One evaluation case (one line of a versioned JSONL dataset). AI_EVALUATION_FRAMEWORK.md § 2. */
export interface EvalCase {
  id: string
  /** gateway task id under evaluation, e.g. `education.tutor.socratic_turn` */
  task: string
  /** task input: `{ messages }` for single-turn cases, `{ turns }` for scripted dialogues, `{ inputs }` for embeddings */
  input: Record<string, unknown>
  /** fixtures the case needs (document fixture ids, learner snapshot, integrity mode, gold answer, ...) */
  context: Record<string, unknown>
  /** assertions (grader specs) applied to the case's output */
  expect: GraderSpec[]
  /** language, difficulty, topic, ... — reports break metrics down per tag */
  tags: string[]
  split: 'dev' | 'test'
  /** provenance: educator, synthetic, consented (real student data only with consent, anonymised) */
  source: 'educator' | 'synthetic' | 'consented'
}

/** A scripted student turn in a dialogue case (`input.turns`). */
export interface DialogueTurn {
  student: string
  /** orchestrator flags for this turn (e.g. stuck, requestFullAnswer, hasProblem) */
  flags?: Record<string, unknown>
  /** assertions applied to this turn only */
  expect?: GraderSpec[]
}

/**
 * A grader assertion. `grader` picks the implementation; `metric` names the metric the result feeds
 * (defaults to the grader name). `when` restricts a spec to observations whose scope paths have one
 * of the listed values (e.g. `{ "meta.move": ["hint", "ask"] }`). `countFailures` additionally counts
 * failures into a count metric (e.g. `graded_mode_leaks`, gated `== 0`).
 */
export interface GraderSpec {
  grader: string
  metric?: string
  target?: string
  when?: Record<string, unknown[]>
  countFailures?: string
  [param: string]: unknown
}

/** What a grader sees: the output of one gateway call (one case, or one dialogue turn). */
export interface Observation {
  text: string
  json?: unknown
  vectors?: number[][]
  finish?: string
  /** set when the call failed (typed gateway error kind or `exception`) */
  error?: { kind: string; message: string }
  latencyMs: number
  ttftMs: number | null
  inputTokens: number | null
  outputTokens: number | null
  /** cost from gateway metering (`ai_operations.cost_micros`); null when unknown */
  costMicros: number | null
  currency: string | null
  route?: RouteInfo
  /** orchestrator-visible behaviour (teaching move, hint level, integrity mode, ...) */
  meta: Record<string, unknown>
}

export type MetricKind = 'rate' | 'mean' | 'count'

/** One measured value for one metric. Rates are 0/1, means any number, counts are summed. */
export interface MetricSample {
  metric: string
  kind: MetricKind
  value: number
  detail?: string
}

/** Something that can call a gateway: the real `Gateway` satisfies it structurally. */
export interface GatewayLike {
  run(taskId: string, input: RunInput, ctx: { tenantId: string; promptVersion?: string; signal?: AbortSignal }): Promise<RunResult>
  stream(taskId: string, input: RunInput, ctx: { tenantId: string; promptVersion?: string; signal?: AbortSignal }): AsyncIterable<GatewayStreamEvent>
  embed(taskId: string, inputs: string[], ctx: { tenantId: string; promptVersion?: string }, purpose?: 'document' | 'query'): Promise<{ vectors: number[][]; dimensions: number; usage: { inputTokens: number | null; outputTokens: number | null }; route: RouteInfo }>
}

/** Minimal read access to gateway metering (a `SystemDatabase` satisfies it). */
export interface MeteringReader {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}

/** A single gateway call made for a case or a dialogue turn. */
export interface EvalCall {
  taskId: string
  operation?: 'run' | 'stream' | 'embed'
  input?: RunInput
  /** embeddings */
  inputs?: string[]
  purpose?: 'document' | 'query'
  promptVersion?: string
  /** orchestrator-visible decisions taken before the call (exposed to graders as `meta.*`) */
  meta?: Record<string, unknown>
}

/** Drives a scripted multi-turn dialogue through module orchestration code. */
export interface DialogueDriver<S = unknown> {
  start(c: EvalCase): S
  /** decide the next call from the state and the scripted student turn (orchestrator logic lives here) */
  turn(state: S, turn: DialogueTurn, c: EvalCase): EvalCall
  /** fold the observed output into the state (e.g. advance the session from the model's assessment) */
  observe(state: S, turn: DialogueTurn, obs: Observation, c: EvalCase): S
}

/** A suite as declared by a module (`modules/<v>/<agent>/evals/<suite>/suite.ts`). */
export interface EvalSuite {
  /** e.g. `tutor/socratic` (matches the task's `evalSuite`) */
  name: string
  description?: string
  /** task definitions under evaluation (registered into the gateway by the CLI) */
  tasks: TaskDefinition[]
  /** prompt version per task id, recorded for reproducibility */
  promptVersions?: Record<string, string>
  /** absolute paths of JSONL dataset files */
  datasets: string[]
  /** gate expressions, `metric op threshold` */
  gates: string[]
  /** grader specs applied to every case (and every dialogue turn) in addition to the case's own */
  defaultExpect?: GraderSpec[]
  /** build the gateway call for a single-turn case; default: `run(case.task, case.input)` */
  buildCall?(c: EvalCase): EvalCall
  /** drives cases whose input has `turns` */
  dialogue?: DialogueDriver<unknown>
}

/** Result for one case. */
export interface CaseResult {
  id: string
  task: string
  tags: string[]
  split: 'dev' | 'test'
  status: 'ok' | 'error' | 'skipped'
  skippedReason?: string
  error?: { kind: string; message: string }
  /** all specs passed and no call failed */
  passed: boolean
  samples: MetricSample[]
  /** one per gateway call (several for dialogues) */
  calls: Array<Omit<Observation, 'json' | 'vectors' | 'text'> & { textChars: number }>
  latencyMs: number
  costMicros: number | null
  judgeCostMicros: number | null
}
