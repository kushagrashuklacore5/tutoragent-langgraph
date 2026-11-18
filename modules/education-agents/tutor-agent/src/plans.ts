import { badRequest } from '@platform/core'
import type { Sql } from '@platform/tenancy-db'
import { estimate } from './domain/learner-model.ts'
import { buildPlan, recoverPlan, type Plan, type PlanConcept } from './domain/planner.ts'
import { courseGraph, evidenceFor } from './common.ts'

export type PlanTrigger = 'request' | 'scheduled_refresh' | 'missed_recovery' | 'assessment_update'

/**
 * Build and store a new plan version for the CURRENT user (RLS owner-only) and course. Shared by the
 * student's "plan" route and the scheduled plan refresh job, so both use the same planner inputs.
 */
export async function generatePlan(t: Sql, userId: string, courseId: string, o: { missedMinutes?: number; trigger?: PlanTrigger; now?: Date } = {}): Promise<{ version: number } & Plan> {
  const goal = (await t.query<{ exam_at: Date | null; daily_minutes: number }>('select exam_at, daily_minutes from education_tutor.goals where course_id = $1', [courseId])).rows[0]
  if (!goal) throw badRequest('goal_required', 'Set your exam date and daily study time first')
  const now = o.now ?? new Date()
  const { concepts, edges } = await courseGraph(t, courseId)
  const ev = await evidenceFor(t, concepts.map((c) => c.id))
  const due = (await t.query<{ n: number }>(`select count(*)::int as n from education_tutor.cards where course_id = $1 and user_id = platform.current_user_id() and due_at < $2::timestamptz + interval '7 days'`, [courseId, now])).rows[0]!.n
  const planConcepts: PlanConcept[] = concepts.map((c) => {
    const m = estimate(ev.get(c.id)!, now)
    return { id: c.id, name: c.name, estMinutes: c.est_minutes, examWeight: Number(c.exam_weight), pMastery: m.pMastery, mastered: m.state === 'mastered', prerequisites: edges.filter((e) => e.to_concept === c.id).map((e) => e.from_concept) }
  })
  const input = { today: now, examAt: goal.exam_at, dailyMinutes: goal.daily_minutes, concepts: planConcepts, reviewMinutesPerDay: Math.ceil((due * 1.5) / 7) }
  const missed = o.missedMinutes ?? 0
  const plan = missed > 0 ? recoverPlan(input, missed) : buildPlan(input)
  const trigger = o.trigger ?? (missed > 0 ? 'missed_recovery' : 'request')
  if (trigger === 'scheduled_refresh') plan.rationale.unshift('Refreshed automatically: your previous plan was more than 7 days old.')
  if (trigger === 'assessment_update') plan.rationale.unshift('Updated automatically after your latest assessment result.')
  const v = (await t.query<{ v: number }>('select coalesce(max(version), 0)::int + 1 as v from education_tutor.plans where course_id = $1', [courseId])).rows[0]!.v
  await t.query(`insert into education_tutor.plans (tenant_id, user_id, course_id, version, plan, trigger) values (platform.current_tenant(), $1, $2, $3, $4, $5)`,
    [userId, courseId, v, JSON.stringify(plan), trigger])
  return { version: v, ...plan }
}

/**
 * Minutes of learn/practice work from the latest plan that are in the past and show no evidence since the
 * plan was made ("missed"). Review blocks are not counted (their backlog is visible in the due queue).
 */
export async function missedMinutes(t: Sql, plan: Plan, planCreatedAt: Date, now: Date): Promise<number> {
  const today = now.toISOString().slice(0, 10)
  const past = plan.tasks.filter((x) => x.kind !== 'review' && x.date < today)
  if (!past.length) return 0
  const active = new Set((await t.query<{ concept_id: string }>(
    `select distinct concept_id from education_tutor.evidence where user_id = platform.current_user_id() and observed_at >= $1 and kind <> 'self_report'`, [planCreatedAt])).rows.map((r) => r.concept_id))
  return past.filter((x) => !active.has(x.conceptId)).reduce((n, x) => n + x.minutes, 0)
}
