import { PermanentJobError, type JobContext, type JobHandler, type ModuleDeps, type ModuleSchedule, type Principal } from '@platform/contracts'
import { assessmentService, GRADE_JOB, GRADE_JOB_MAX_ATTEMPTS, MAX_RECOVERY_RUNS, STALE_GRADING } from './assessments.ts'
import type { Sql } from '@platform/tenancy-db'
import { estimate, type Evidence } from './domain/learner-model.ts'
import type { Plan } from './domain/planner.ts'
import { courseGraph, evidenceFor } from './common.ts'
import { generatePlan, missedMinutes } from './plans.ts'
import { encryptLegacyTurns } from './turns.ts'
import { AGENT_DAILY_JOB, agentJobs } from './agent/jobs.ts'
import { growthJobs } from './growth/routes.ts'

/**
 * Recurring background work of the Tutor. Each schedule fans out per tenant (only tenants that enabled
 * education.tutor), then per enrolled user; per-user jobs act as that user, so the owner-only RLS rules
 * on learner data apply unchanged. Every step is idempotent (safe to retry or run twice).
 */

export const DELAYED_CHECK_MIN_DAYS = 14
export const DELAYED_CHECK_MAX_DAYS = 28
export const PLAN_MAX_AGE_DAYS = 7
const DAY = 86_400_000

export const SCHEDULES: ModuleSchedule[] = [
  { name: 'delayed-checks', job: 'delayed_checks.fanout', spec: { dailyAtUtc: '01:30' }, perTenant: true },
  { name: 'plan-refresh', job: 'plan_refresh.fanout', spec: { dailyAtUtc: '02:00' }, perTenant: true },
  { name: 'encrypt-legacy-turns', job: 'turns.encrypt_legacy.fanout', spec: { dailyAtUtc: '02:30' }, perTenant: true },
  // safety net for marking: attempts stuck in 'grading' (crashed process, lost job) are re-enqueued
  { name: 'assessment-grading-recovery', job: 'assessment.recover', spec: { everyMs: 5 * 60_000 }, perTenant: true },
  // study companion: milestone bookkeeping, throttled nudges, next-session preparation (no model calls)
  { name: 'agent-daily', job: 'agent.daily.fanout', spec: { dailyAtUtc: '02:45' }, perTenant: true },
]

interface UserPayload { userId: string; scheduledFor: string }
const payloadOf = (ctx: JobContext) => ctx.job.payload as Partial<UserPayload>

/** Tenant job: enqueue `child` once per enrolled user (enrolments are tenant-readable course structure). */
const fanOut = (d: ModuleDeps, child: string, role: 'student' | null): JobHandler => async (ctx) =>
  ctx.inTenant(async (tx) => {
    const users = (await tx.query<{ user_id: string }>(
      `select distinct user_id from education_tutor.enrolments where ($1::text is null or role = $1) order by user_id`, [role])).rows
    const scheduledFor = String(payloadOf(ctx).scheduledFor ?? new Date().toISOString())
    let created = 0
    for (const u of users) if ((await d.enqueue(tx, child, { userId: u.user_id, scheduledFor }, { idempotencyKey: `${scheduledFor}:${u.user_id}` })).created) created++
    return { users: users.length, created }
  })

const asUser = <T>(ctx: JobContext, fn: (tx: Sql) => Promise<T>): Promise<T> => {
  const { userId } = payloadOf(ctx)
  if (!userId) throw new Error('payload.userId is required')
  return ctx.inTenant(fn, { userId })
}

/**
 * Is a delayed check due for a concept? Yes when the concept is mastered or stale now, or WAS mastered at
 * its latest evidence (evidence decays, so two weeks later the estimate itself is often back to
 * "insufficient evidence"), and there has been no delayed check for >= 14 days. Read-only: the evidence
 * rules (spacing, no single-session mastery) are those of the learner model.
 */
export function delayedCheckDue(evidence: Evidence[], now: Date): boolean {
  const objective = evidence.filter((e) => e.kind !== 'self_report')
  const lastAny = objective.reduce<number>((x, e) => Math.max(x, e.observedAt.getTime()), 0)
  if (!lastAny) return false
  const current = estimate(evidence, now).state
  if (current !== 'mastered' && current !== 'stale' && estimate(evidence, new Date(lastAny)).state !== 'mastered') return false
  const lastDelayed = objective.filter((e) => e.kind === 'delayed_check').reduce<number>((x, e) => Math.max(x, e.observedAt.getTime()), 0)
  // anchor: the last delayed check, or (never checked) the latest evidence that established the estimate
  const anchor = lastDelayed || lastAny
  return now.getTime() - anchor >= DELAYED_CHECK_MIN_DAYS * DAY
}

export function tutorJobs(d: ModuleDeps): Record<string, JobHandler> {
  return {
    'delayed_checks.fanout': fanOut(d, 'delayed_checks.student', 'student'),
    'plan_refresh.fanout': fanOut(d, 'plan_refresh.student', 'student'),
    'turns.encrypt_legacy.fanout': fanOut(d, 'turns.encrypt_legacy.student', null),
    'agent.daily.fanout': fanOut(d, AGENT_DAILY_JOB, 'student'),
    ...agentJobs(d),
    ...growthJobs(d),

    /**
     * Marking job (enqueued with every submission; retried with backoff by the job system). Runs as the
     * student, whose attempt it is. Idempotent: a run on an attempt that is no longer 'grading' does nothing.
     */
    [GRADE_JOB]: async (ctx) => {
      const { attemptId, userId } = (ctx.job.payload ?? {}) as { attemptId?: string; userId?: string }
      if (!ctx.job.tenant_id || !attemptId || !userId) throw new PermanentJobError('assessment.grade needs a tenant, attemptId and userId')
      const p: Principal = { userId, tenantId: ctx.job.tenant_id, email: '', roles: ['student'], isPlatformAdmin: false }
      return { result: await assessmentService(d).runGrading(p, attemptId, 'job') }
    },
    /** Recovery sweep (every 5 min per tenant): re-enqueue attempts stuck in 'grading', up to MAX_RECOVERY_RUNS runs. */
    'assessment.recover': async (ctx) => ctx.inTenant(async (tx) => {
      const rows = (await tx.query<{ attempt_id: string; user_id: string; grading_attempts: number }>(
        'select attempt_id, user_id, grading_attempts from education_tutor.stale_grading_attempts($1::interval)', [STALE_GRADING])).rows
      let requeued = 0
      let exhausted = 0
      for (const r of rows) {
        if (r.grading_attempts >= MAX_RECOVERY_RUNS) { exhausted++; continue }
        const e = await d.enqueue(tx, GRADE_JOB, { attemptId: r.attempt_id, userId: r.user_id }, { idempotencyKey: `grade:${r.attempt_id}:recover:${r.grading_attempts}`, maxAttempts: GRADE_JOB_MAX_ATTEMPTS })
        if (e.created) requeued++
      }
      return { stale: rows.length, requeued, exhausted }
    }),

    /**
     * (a) Concepts that look mastered (or have gone stale) get one pending "delayed check" card once their
     * last spaced evidence is >= 14 days old, so it falls due within the 14–28 day window when the job runs
     * daily. It appears in the normal due queue; answering it records `delayed_check` evidence through the
     * regular review route. Nothing here writes evidence or changes estimates.
     */
    'delayed_checks.student': async (ctx) => asUser(ctx, async (tx) => {
      const { userId } = payloadOf(ctx)
      const now = new Date()
      const courses = (await tx.query<{ course_id: string }>(`select course_id from education_tutor.enrolments where user_id = $1 and role = 'student'`, [userId])).rows
      let created = 0
      for (const { course_id } of courses) {
        const { concepts } = await courseGraph(tx, course_id)
        const ev = await evidenceFor(tx, concepts.map((c) => c.id))
        for (const c of concepts) {
          if (!delayedCheckDue(ev.get(c.id)!, now)) continue
          const item = (await tx.query<{ stem: string; explanation: string }>(
            `select stem, explanation from education_tutor.items where concept_id = $1 and retired_at is null and status = 'approved' order by difficulty desc, id limit 1`, [c.id])).rows[0]
          const r = await tx.query(`insert into education_tutor.cards (tenant_id, user_id, course_id, concept_id, front, back, purpose, due_at)
            values (platform.current_tenant(), $1, $2, $3, $4, $5, 'delayed_check', $6)
            on conflict (user_id, concept_id) where purpose = 'delayed_check' and reps = 0 do nothing`,
          [userId, course_id, c.id,
            item ? `Delayed check (${c.name}): ${item.stem}` : `Delayed check: without notes, explain the key idea of "${c.name}" and work one example.`,
            item?.explanation || 'Compare your answer with your course notes, then grade yourself honestly.', now])
          created += r.rowCount
        }
      }
      return { created }
    }),

    /** (b) Re-plan when the latest plan is > 7 days old, or recover missed past work. One new version per run at most. */
    'plan_refresh.student': async (ctx) => asUser(ctx, async (tx) => {
      const { userId, scheduledFor } = payloadOf(ctx)
      const now = new Date()
      const courses = (await tx.query<{ course_id: string }>(
        `select g.course_id from education_tutor.goals g join education_tutor.enrolments e on e.course_id = g.course_id and e.user_id = g.user_id where g.user_id = $1`, [userId])).rows
      const out: { courseId: string; version: number; trigger: string }[] = []
      for (const { course_id } of courses) {
        const latest = (await tx.query<{ plan: Plan; created_at: Date; trigger: string }>(
          `select plan, created_at, trigger from education_tutor.plans where course_id = $1 order by version desc limit 1`, [course_id])).rows[0]
        if (!latest) continue // the student never asked for a plan
        if (latest.trigger !== 'request' && scheduledFor && latest.created_at >= new Date(scheduledFor)) continue // already refreshed this period
        const missed = await missedMinutes(tx, latest.plan, latest.created_at, now)
        const stale = now.getTime() - latest.created_at.getTime() > PLAN_MAX_AGE_DAYS * DAY
        if (!missed && !stale) continue
        const p = await generatePlan(tx, userId!, course_id, missed > 0 ? { missedMinutes: missed, trigger: 'missed_recovery', now } : { trigger: 'scheduled_refresh', now })
        out.push({ courseId: course_id, version: p.version, trigger: missed > 0 ? 'missed_recovery' : 'scheduled_refresh' })
      }
      return { refreshed: out }
    }),

    /** Transition after migration 0002: encrypt this user's plaintext turns written before encryption at rest. */
    'turns.encrypt_legacy.student': async (ctx) => {
      let total = 0
      for (;;) {
        const n = await asUser(ctx, (tx) => encryptLegacyTurns(d, tx, { tenantId: ctx.job.tenant_id! }))
        total += n
        if (n < 500) return { encrypted: total }
      }
    },
  }
}
