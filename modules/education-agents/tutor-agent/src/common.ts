import { badRequest, notFound } from '@platform/core'
import type { Principal } from '@platform/contracts'
import type { Sql } from '@platform/tenancy-db'
import type { Evidence } from './domain/learner-model.ts'
import type { IntegrityMode } from './domain/tutoring.ts'

/** Helpers shared by the tutor's route files and jobs. */
export const ID = 'education.tutor'
export const P = {
  read: `${ID}:course.read`,
  manage: `${ID}:course.manage`,
  study: `${ID}:study`,
} as const

const UUID = /^[0-9a-f-]{36}$/i
export const uuid = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw badRequest('invalid_id', `${name} must be a UUID`)
  return v
}
export const str = (v: unknown, name: string, max = 2000): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw badRequest('invalid_field', `${name} is required (max ${max} chars)`)
  return v.trim()
}
export const obj = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {})

export async function requireEnrolled(tx: Sql, p: Pick<Principal, 'userId'>, courseId: string): Promise<{ title: string; integrity_mode: IntegrityMode; role: string }> {
  const r = await tx.query<{ title: string; integrity_mode: IntegrityMode; role: string }>(
    `select c.title, c.integrity_mode, e.role from education_tutor.courses c
     join education_tutor.enrolments e on e.course_id = c.id and e.user_id = $2 where c.id = $1`, [courseId, p.userId])
  if (!r.rows[0]) throw notFound('Course')
  return r.rows[0]
}

/** Evidence of the CURRENT user (RLS owner-only) per concept. */
export async function evidenceFor(tx: Sql, conceptIds: string[]): Promise<Map<string, Evidence[]>> {
  const m = new Map<string, Evidence[]>(conceptIds.map((c) => [c, []]))
  if (!conceptIds.length) return m
  const r = await tx.query<{ concept_id: string; kind: Evidence['kind']; outcome: string; hints_used: number; observed_at: Date }>(
    `select concept_id, kind, outcome, hints_used, observed_at from education_tutor.evidence where concept_id = any($1) and user_id = platform.current_user_id()`, [conceptIds])
  for (const e of r.rows) m.get(e.concept_id)?.push({ kind: e.kind, outcome: Number(e.outcome), hintsUsed: e.hints_used, observedAt: e.observed_at })
  return m
}

export async function courseGraph(tx: Sql, courseId: string) {
  const concepts = (await tx.query<{ id: string; name: string; est_minutes: number; exam_weight: string }>(
    `select id, name, est_minutes, exam_weight from education_tutor.concepts where course_id = $1 and status = 'approved' order by name`, [courseId])).rows
  const edges = (await tx.query<{ from_concept: string; to_concept: string }>(
    `select e.from_concept, e.to_concept from education_tutor.concept_edges e join education_tutor.concepts c on c.id = e.to_concept where c.course_id = $1`, [courseId])).rows
  return { concepts, edges }
}
