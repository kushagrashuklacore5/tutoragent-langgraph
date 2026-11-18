import { notFound } from '@platform/core'
import type { ModuleDeps, RouteDef } from '@platform/contracts'
import { estimate, type Evidence, type MasteryEstimate } from './domain/learner-model.ts'
import { courseGraph, P, requireEnrolled, uuid } from './common.ts'
import { misconceptionSimilarity, SAME_MISCONCEPTION } from './domain/insight.ts'

/**
 * Educator learner-progress dashboard (read-only). Data access is limited by RLS policy
 * `course_educator_read` (migration 0004) to courses the caller teaches; conversations are never
 * included. Mastery uses the same learner model the student sees, so both views agree.
 */

const MAX_STUDENTS = 500

export interface StudentProgress {
  userId: string; name: string; email: string
  mastered: number; learning: number; stale: number; insufficient: number; avgMastery: number | null
  /** per concept: state + point estimate (concepts with no evidence are omitted) */
  concepts: Record<string, { state: MasteryEstimate['state']; pMastery: number }>
  practice: { attempts: number; correctRate: number | null; last7Days: number; confidentWrong: number }
  revision: { cards: number; due: number; overdue: number }
  lastActiveAt: string | null
  /** short, explainable reasons this student may need attention */
  flags: string[]
}
export interface ConceptInsight {
  conceptId: string; name: string
  students: { mastered: number; learning: number; stale: number; insufficient: number }
  avgMastery: number | null
  practice: { attempts: number; correctRate: number | null; confidentWrong: number }
  /** diagnosed error types across students (from validated diagnoses of wrong practice answers) */
  errorTypes: Record<string, number>
  /** similar misconception statements grouped; `students` = distinct learners showing it */
  misconceptions: { text: string; students: number; occurrences: number }[]
}

const DAY = 86_400_000
const rate = (num: number, den: number) => (den ? Math.round((num / den) * 1000) / 1000 : null)
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null)

/** Pure aggregation (unit-tested): rows in, dashboard out. */
export function buildProgress(input: {
  concepts: { id: string; name: string }[]
  students: { userId: string; name: string; email: string }[]
  evidence: { userId: string; conceptId: string; e: Evidence }[]
  attempts: { userId: string; conceptId: string; outcome: number; confidence: string | null; at: Date }[]
  cards: { userId: string; dueAt: Date }[]
  diagnoses?: { userId: string; conceptId: string; errorType: string; misconception: string }[]
  now?: Date
}): { students: StudentProgress[]; concepts: ConceptInsight[] } {
  const now = input.now ?? new Date()
  const ev = new Map<string, Evidence[]>()
  for (const r of input.evidence) {
    const k = `${r.userId}|${r.conceptId}`
    const list = ev.get(k)
    if (list) list.push(r.e)
    else ev.set(k, [r.e])
  }
  const est = new Map<string, MasteryEstimate>()
  for (const [k, list] of ev) est.set(k, estimate(list, now))

  const students = input.students.map((s): StudentProgress => {
    const concepts: StudentProgress['concepts'] = {}
    const counts = { mastered: 0, learning: 0, stale: 0, insufficient: 0 }
    const ps: number[] = []
    for (const c of input.concepts) {
      const m = est.get(`${s.userId}|${c.id}`)
      if (!m) { counts.insufficient++; continue }
      concepts[c.id] = { state: m.state, pMastery: Math.round(m.pMastery * 1000) / 1000 }
      ps.push(m.pMastery)
      if (m.state === 'mastered') counts.mastered++
      else if (m.state === 'learning') counts.learning++
      else if (m.state === 'stale') counts.stale++
      else counts.insufficient++
    }
    const att = input.attempts.filter((a) => a.userId === s.userId)
    const correct = att.filter((a) => a.outcome >= 1).length
    const confidentWrong = att.filter((a) => a.confidence === 'sure' && a.outcome < 1).length
    const cards = input.cards.filter((c) => c.userId === s.userId)
    const due = cards.filter((c) => c.dueAt <= now).length
    const overdue = cards.filter((c) => c.dueAt.getTime() <= now.getTime() - 2 * DAY).length
    const times = [...att.map((a) => a.at.getTime()), ...input.evidence.filter((r) => r.userId === s.userId).map((r) => r.e.observedAt.getTime())]
    const last = times.length ? Math.max(...times) : null
    const flags: string[] = []
    if (last === null) flags.push('No learning activity yet')
    else if (now.getTime() - last > 7 * DAY) flags.push(`Inactive for ${Math.floor((now.getTime() - last) / DAY)} days`)
    if (att.length >= 4 && correct / att.length < 0.5) flags.push(`Practice accuracy ${Math.round((correct / att.length) * 100)}%`)
    if (confidentWrong >= 2) flags.push(`${confidentWrong} confident wrong answers (possible misconception)`)
    if (overdue >= 5) flags.push(`${overdue} revision cards overdue`)
    if (counts.stale) flags.push(`${counts.stale} concept${counts.stale === 1 ? '' : 's'} fading (not reviewed)`)
    return {
      ...s, ...counts, avgMastery: mean(ps), concepts,
      practice: { attempts: att.length, correctRate: rate(correct, att.length), last7Days: att.filter((a) => now.getTime() - a.at.getTime() <= 7 * DAY).length, confidentWrong },
      revision: { cards: cards.length, due, overdue },
      lastActiveAt: last === null ? null : new Date(last).toISOString(),
      flags,
    }
  })

  const concepts = input.concepts.map((c): ConceptInsight => {
    const st = { mastered: 0, learning: 0, stale: 0, insufficient: 0 }
    const ps: number[] = []
    for (const s of input.students) {
      const m = est.get(`${s.userId}|${c.id}`)
      if (!m) { st.insufficient++; continue }
      ps.push(m.pMastery)
      st[m.state === 'insufficient_evidence' ? 'insufficient' : m.state]++
    }
    const att = input.attempts.filter((a) => a.conceptId === c.id)
    const diag = (input.diagnoses ?? []).filter((d) => d.conceptId === c.id)
    const errorTypes: Record<string, number> = {}
    for (const d of diag) errorTypes[d.errorType] = (errorTypes[d.errorType] ?? 0) + 1
    // greedy grouping of similar statements (deterministic: input order)
    const groups: { text: string; users: Set<string>; n: number }[] = []
    for (const d of diag.filter((x) => x.misconception.trim())) {
      const g = groups.find((x) => misconceptionSimilarity(x.text, d.misconception) >= SAME_MISCONCEPTION)
      if (g) { g.users.add(d.userId); g.n++ } else groups.push({ text: d.misconception.trim(), users: new Set([d.userId]), n: 1 })
    }
    return {
      errorTypes,
      misconceptions: groups.sort((a, b) => b.users.size - a.users.size || b.n - a.n).slice(0, 5).map((g) => ({ text: g.text, students: g.users.size, occurrences: g.n })),
      conceptId: c.id, name: c.name, students: st, avgMastery: mean(ps),
      practice: { attempts: att.length, correctRate: rate(att.filter((a) => a.outcome >= 1).length, att.length), confidentWrong: att.filter((a) => a.confidence === 'sure' && a.outcome < 1).length },
    }
  })
  return { students, concepts }
}

export function progressRoutes(d: ModuleDeps): RouteDef[] {
  return [{
    method: 'GET', path: '/courses/:courseId/progress', permission: P.manage,
    handler: async ({ principal, params }) => {
      const courseId = uuid(params.courseId, 'courseId')
      return d.inTenant(principal, async (t) => {
        const course = await requireEnrolled(t, principal, courseId)
        if (course.role !== 'educator') throw notFound('Course')
        const { concepts } = await courseGraph(t, courseId)
        const students = (await t.query<{ user_id: string; display_name: string; email: string }>(
          `select e.user_id, coalesce(u.display_name, '') as display_name, coalesce(u.email, '') as email
             from education_tutor.enrolments e left join platform.users u on u.id = e.user_id
            where e.course_id = $1 and e.role = 'student' order by lower(coalesce(nullif(u.display_name, ''), u.email)), e.user_id limit $2`, [courseId, MAX_STUDENTS])).rows
        const ids = students.map((s) => s.user_id)
        const conceptIds = concepts.map((c) => c.id)
        const evidence = (await t.query<{ user_id: string; concept_id: string; kind: Evidence['kind']; outcome: string; hints_used: number; observed_at: Date }>(
          `select user_id, concept_id, kind, outcome, hints_used, observed_at from education_tutor.evidence where concept_id = any($1) and user_id = any($2)`, [conceptIds, ids])).rows
        const attempts = (await t.query<{ user_id: string; concept_id: string; outcome: string; confidence: string | null; created_at: Date }>(
          `select a.user_id, i.concept_id, a.outcome, a.confidence, a.created_at from education_tutor.attempts a join education_tutor.items i on i.id = a.item_id
            where i.course_id = $1 and a.user_id = any($2)`, [courseId, ids])).rows
        const cards = (await t.query<{ user_id: string; due_at: Date }>(
          `select user_id, due_at from education_tutor.cards where course_id = $1 and user_id = any($2) and purpose = 'study'`, [courseId, ids])).rows
        const diagnoses = (await t.query<{ user_id: string; concept_id: string; error_type: string; misconception: string }>(
          `select user_id, concept_id, error_type, misconception from education_tutor.error_diagnoses where concept_id = any($1) and user_id = any($2) and created_at > now() - interval '90 days' order by created_at`, [conceptIds, ids])).rows
        const r = buildProgress({
          diagnoses: diagnoses.map((x) => ({ userId: x.user_id, conceptId: x.concept_id, errorType: x.error_type, misconception: x.misconception })),
          concepts: concepts.map((c) => ({ id: c.id, name: c.name })),
          students: students.map((s) => ({ userId: s.user_id, name: s.display_name, email: s.email })),
          evidence: evidence.map((e) => ({ userId: e.user_id, conceptId: e.concept_id, e: { kind: e.kind, outcome: Number(e.outcome), hintsUsed: e.hints_used, observedAt: e.observed_at } })),
          attempts: attempts.map((a) => ({ userId: a.user_id, conceptId: a.concept_id, outcome: Number(a.outcome), confidence: a.confidence, at: a.created_at })),
          cards: cards.map((c) => ({ userId: c.user_id, dueAt: c.due_at })),
        })
        return { courseId, title: course.title, generatedAt: new Date().toISOString(), truncated: students.length >= MAX_STUDENTS, ...r }
      })
    },
  }]
}
