/**
 * Runs the PRODUCTION marking pipeline (`markWritten`: two AI passes through the gateway, quote checks,
 * rubric clamps and agreement rules in `validateMarking`) over educator-marked answers, and scores the result
 * against the educator's marks with `markingReport`.
 *
 * Dataset: JSONL in the shared eval-case format (packages/ai-evals CASE_SCHEMA), task `education.tutor.mark_answer`:
 *   input   { stem, type: 'short'|'descriptive', modelAnswer, rubric: [{id, criterion, points, keyPoints}], acceptable?, answer }
 *   context { difficulty: 0..1, itemRef? }
 *   expect  [{ grader: 'reference_marks', total, criteria: { <criterionId>: marks }, alternativeApproachValid?, educatorFeedback? }]
 *   source  'educator' | 'consented' (real, educator-marked)  or  'synthetic' (fixtures — pipeline checks only, NEVER evidence)
 */
import type { ModuleDeps, Principal } from '@platform/contracts'
type RunInput = Parameters<ReturnType<ModuleDeps['ai']>['run']>[1]
import { markWritten } from '../../src/assessments.ts'
import type { RubricCriterion } from '../../src/domain/scoring.ts'
import { markingReport, type MarkingOutcome } from './metrics.ts'

export interface MarkingCase {
  id: string; task: string; source: string; split: string; tags: string[]
  input: { stem: string; type: 'short' | 'descriptive'; modelAnswer: string; rubric: RubricCriterion[]; acceptable?: string[]; answer: string }
  context: { difficulty?: number; itemRef?: string }
  expect: { grader: string; total?: number; criteria?: Record<string, number>; alternativeApproachValid?: boolean; educatorFeedback?: string }[]
}

/** Validate a case beyond the shared schema: reference marks must match the rubric exactly. */
export function checkMarkingCase(c: MarkingCase): string[] {
  const p: string[] = []
  if (c.task !== 'education.tutor.mark_answer') p.push('task must be education.tutor.mark_answer')
  const ref = c.expect.find((e) => e.grader === 'reference_marks')
  if (!ref || !ref.criteria) return [...p, 'needs one expect entry { grader: "reference_marks", total, criteria }']
  const rubric = c.input?.rubric ?? []
  if (!rubric.length) p.push('rubric is empty')
  for (const r of rubric) {
    const v = ref.criteria[r.id]
    if (v === undefined) p.push(`no reference mark for criterion ${r.id}`)
    else if (v < 0 || v > r.points || (v * 2) % 1 !== 0) p.push(`reference mark for ${r.id} must be 0-${r.points} in half marks`)
  }
  if (Object.keys(ref.criteria).some((k) => !rubric.some((r) => r.id === k))) p.push('reference marks a criterion that is not in the rubric')
  const sum = Object.values(ref.criteria).reduce((a, b) => a + b, 0)
  if (ref.total !== undefined && ref.total !== sum) p.push(`reference total ${ref.total} != sum of criteria ${sum}`)
  if (typeof c.input?.answer !== 'string') p.push('answer must be a string')
  return p
}

export interface MarkingRunResult {
  outcomes: MarkingOutcome[]
  failures: { id: string; error: string }[]
  models: string[]
  /** marking runs retried because the provider was temporarily unavailable (rate limits etc.) */
  transientRetries: number
  report: ReturnType<typeof markingReport>
}

/**
 * @param run  gateway call for one task (the CLI passes `gateway.run` bound to the eval tenant)
 */
export async function runMarkingEval(run: (taskId: string, input: RunInput, ctx: { promptVersion?: string }) => Promise<{ json?: unknown; route: { modelId: string } }>, cases: MarkingCase[], opts: { concurrency?: number; transientRetries?: number; retryDelayMs?: number } = {}): Promise<MarkingRunResult> {
  let transientRetries = 0
  const d = { ai: () => ({ run: (task: string, input: RunInput, ctx?: { promptVersion?: string }) => run(task, input, ctx ?? {}) }) } as unknown as ModuleDeps
  const p = { userId: '00000000-0000-0000-0000-000000000000', tenantId: '00000000-0000-0000-0000-000000000000', email: '', roles: [], isPlatformAdmin: false } as Principal
  const outcomes: MarkingOutcome[] = []
  const failures: { id: string; error: string }[] = []
  const models = new Set<string>()
  let next = 0
  const worker = async () => {
    while (next < cases.length) {
      const c = cases[next++]!
      const problems = checkMarkingCase(c)
      if (problems.length) { failures.push({ id: c.id, error: problems.join('; ') }); continue }
      const ref = c.expect.find((e) => e.grader === 'reference_marks')!
      const spec = c.input.type === 'short'
        ? { type: 'short' as const, modelAnswer: c.input.modelAnswer, acceptable: c.input.acceptable ?? [], rubric: c.input.rubric }
        : { type: 'descriptive' as const, modelAnswer: c.input.modelAnswer, rubric: c.input.rubric }
      try {
        // like the production grading job: a transient provider failure is retried with backoff, not scored
        let m: Awaited<ReturnType<typeof markWritten>> | undefined
        for (let attempt = 1; ; attempt++) {
          try { m = await markWritten(d, p, c.input.stem, spec, c.input.answer); break } catch (e) {
            if ((e as { code?: string }).code !== 'marking_unavailable' || attempt >= (opts.transientRetries ?? 4)) throw e
            transientRetries++
            await new Promise((r) => setTimeout(r, (opts.retryDelayMs ?? 15_000) * attempt))
          }
        }
        if (!m) throw new Error('no marking result')
        if (m.route && m.route !== 'exact-match') models.add(m.route) // exact-match is deterministic, not a model
        outcomes.push({
          id: c.id, type: c.input.type, difficulty: c.context.difficulty ?? 0.5, source: c.source,
          maxPoints: m.maxPoints, refTotal: Object.values(ref.criteria!).reduce((a, b) => a + b, 0), aiTotal: m.points, needsReview: m.needsReview, reviewReasons: m.reasons,
          criteria: c.input.rubric.map((r) => ({ id: r.id, ref: ref.criteria![r.id]!, ai: m.criteria.find((x) => x.id === r.id)?.awarded ?? 0 })),
        })
      } catch (e) {
        failures.push({ id: c.id, error: (e as Error).message.slice(0, 200) })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 1) }, worker))
  outcomes.sort((a, b) => a.id.localeCompare(b.id))
  return { outcomes, failures, models: [...models], transientRetries, report: markingReport(outcomes) }
}
