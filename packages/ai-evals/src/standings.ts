import type { Actor } from '@platform/ai-gateway'
import type { Report } from './report.ts'

/** The part of the gateway admin API used to record eval standings (the real `Gateway['admin']` satisfies it). */
export interface StandingRecorder {
  recordEvalStanding(actor: Actor, input: { taskId: string; deploymentId: string; evalRunId: string; passed: boolean }): Promise<void>
}

export interface StandingDecision {
  taskId: string
  deploymentId: string
  recorded: boolean
  reason?: string
}

/**
 * Record passing `ai_eval_standings` rows (AI_GATEWAY.md § 8 step 4) — ONLY when the report passed
 * every gate, the baseline rule and was complete. A standing is per (task, deployment): it is written
 * only for a deployment that served every call of that task in the run without fallback, so a
 * standing always describes the deployment that was actually measured. Nothing is written for a
 * failing run (an existing standing is left as it is) or for fake/test adapters.
 */
export async function recordStandings(admin: StandingRecorder, actor: Actor, report: Report, o: { /** replaces the default "fake*" exclusion */ excludeAdapters?: string[] } = {}): Promise<StandingDecision[]> {
  // default: any adapter whose type starts with "fake" (test doubles) never earns a standing
  const isTestAdapter = (a: string) => (o.excludeAdapters ? o.excludeAdapters.includes(a) : a.startsWith('fake'))
  const decisions: StandingDecision[] = []
  const byTask = new Map<string, typeof report.reproducibility.routes>()
  for (const r of report.reproducibility.routes) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r])
  for (const [taskId, uses] of byTask) {
    for (const u of uses) {
      const d: StandingDecision = { taskId, deploymentId: u.deploymentId, recorded: false }
      if (!report.passed) d.reason = `run did not pass: ${report.gates.reasons.join('; ')}`
      else if (isTestAdapter(u.adapter)) d.reason = `adapter ${u.adapter} is a test adapter`
      else if (uses.length > 1 || u.fallbacks > 0) d.reason = 'task was served by more than one deployment (fallback) — re-run with a single-candidate route'
      if (!d.reason) {
        await admin.recordEvalStanding(actor, { taskId, deploymentId: u.deploymentId, evalRunId: report.runId, passed: true })
        d.recorded = true
      }
      decisions.push(d)
    }
  }
  return decisions
}
