import type { ModuleDeps, RouteDef } from '@platform/contracts'
import type { Sql } from '@platform/tenancy-db'
import { estimate } from './domain/learner-model.ts'
import { conceptProfile, nextAction, type AttemptFact, type ConceptProfile, type ErrorType, type Recommendation } from './domain/insight.ts'
import { courseGraph, evidenceFor, P, requireEnrolled, uuid } from './common.ts'

/**
 * Personal learning coach: the student's living learner profile and the next-best learning action for a
 * course. Everything is computed deterministically from the student's own stored evidence (RLS:
 * owner-only queries, explicit user filters) — no model is involved in either.
 */
export async function coachFor(t: Sql, courseId: string, now = new Date()): Promise<{ next: Recommendation; profile: ConceptProfile[]; dueCards: number; examAt: string | null }> {
  const { concepts, edges } = await courseGraph(t, courseId)
  const ids = concepts.map((c) => c.id)
  const ev = await evidenceFor(t, ids)
  const attempts = (await t.query<{ concept_id: string; outcome: string; confidence: string | null; hints_used: number; created_at: Date }>(
    `select i.concept_id, a.outcome, a.confidence, a.hints_used, a.created_at from education_tutor.attempts a join education_tutor.items i on i.id = a.item_id
      where a.user_id = platform.current_user_id() and i.course_id = $1`, [courseId])).rows
  const diagnoses = (await t.query<{ concept_id: string; error_type: ErrorType; recurring: boolean; misconception: string; transfer: { correct: boolean } | null }>(
    `select concept_id, error_type, recurring, misconception, followup_results->'transfer' as transfer from education_tutor.error_diagnoses
      where user_id = platform.current_user_id() and concept_id = any($1) and created_at > now() - interval '60 days'`, [ids])).rows
  const dueCards = Number((await t.query<{ n: string }>(`select count(*) as n from education_tutor.cards where user_id = platform.current_user_id() and course_id = $1 and due_at <= now()`, [courseId])).rows[0]!.n)
  const goal = (await t.query<{ exam_at: Date | null }>('select exam_at from education_tutor.goals where user_id = platform.current_user_id() and course_id = $1', [courseId])).rows[0]
  const facts: AttemptFact[] = attempts.map((a) => ({ conceptId: a.concept_id, correct: Number(a.outcome) >= 1, confidence: a.confidence, hintsUsed: a.hints_used, at: a.created_at }))
  const profile = concepts.map((c) => conceptProfile({
    conceptId: c.id, name: c.name, est: estimate(ev.get(c.id)!, now), evidence: ev.get(c.id)!, attempts: facts.filter((f) => f.conceptId === c.id),
    diagnoses: diagnoses.filter((x) => x.concept_id === c.id).map((x) => ({ errorType: x.error_type, recurring: x.recurring, misconception: x.misconception })),
    transfer: diagnoses.filter((x) => x.concept_id === c.id && x.transfer).map((x) => ({ passed: x.transfer!.correct === true })), now,
  }))
  const examInDays = goal?.exam_at ? Math.ceil((new Date(goal.exam_at).getTime() - now.getTime()) / 86_400_000) : null
  const next = nextAction({
    concepts: concepts.map((c) => ({ id: c.id, name: c.name, examWeight: Number(c.exam_weight), prerequisites: edges.filter((e) => e.to_concept === c.id).map((e) => e.from_concept) })),
    profiles: new Map(profile.map((p) => [p.conceptId, p])), dueCards, examInDays,
  })
  return { next, profile, dueCards, examAt: goal?.exam_at ? new Date(goal.exam_at).toISOString().slice(0, 10) : null }
}

export function coachRoutes(d: ModuleDeps): RouteDef[] {
  return [{
    method: 'GET', path: '/courses/:courseId/coach', permission: P.study,
    handler: async ({ principal, params }) => d.inTenant(principal, async (t) => {
      const courseId = uuid(params.courseId, 'courseId')
      await requireEnrolled(t, principal, courseId)
      return coachFor(t, courseId)
    }),
  }]
}
