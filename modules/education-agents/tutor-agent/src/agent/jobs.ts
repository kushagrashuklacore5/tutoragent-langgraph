/**
 * Companion background workflows (queue + scheduler; no model calls). Run as the student (owner-only RLS):
 *   agent.daily.student      milestone bookkeeping (done / missed), nudges (deterministic rules, throttled),
 *                            next-session preparation, conversation retention
 *   agent.after_assessment   after a graded assessment: re-plan with the new evidence and tell the student
 */
import { PermanentJobError, type JobContext, type ModuleDeps, type Principal } from '@platform/contracts'
import type { Sql } from '@platform/tenancy-db'
import { estimate } from '../domain/learner-model.ts'
import type { Plan } from '../domain/planner.ts'
import { coachFor } from '../coach.ts'
import { evidenceFor } from '../common.ts'
import { generatePlan } from '../plans.ts'
import { decideNudges, prepareSession, type NudgeKind } from './nudges.ts'
import { buildTopicSet } from '../courses/personal.ts'
import { addMessage, createConversation, initialState, latestConversation, loadProfile, RETENTION_DAYS, saveState, type ConvState } from './store.ts'

export const AGENT_DAILY_JOB = 'agent.daily.student'
export const AFTER_ASSESSMENT_JOB = 'agent.after_assessment'
export { QUESTION_SET_JOB } from './job-names.ts'
import { QUESTION_SET_JOB } from './job-names.ts'
const DAY = 86_400_000

const asUser = <T>(ctx: JobContext, fn: (t: Sql) => Promise<T>): Promise<T> => {
  const { userId } = (ctx.job.payload ?? {}) as { userId?: string }
  if (!userId || !ctx.job.tenant_id) throw new Error('payload.userId and a tenant are required')
  return ctx.inTenant(fn, { userId })
}
const principalOf = (ctx: JobContext) => ({ tenantId: ctx.job.tenant_id!, userId: String((ctx.job.payload as { userId: string }).userId) })

/** Mark milestones done (every concept practised since the plan and >= 50% mastery) or missed (past due). */
export async function updateMilestones(t: Sql, courseId: string, now: Date): Promise<{ done: number; missed: { title: string; due: string }[] }> {
  const open = (await t.query<{ id: string; title: string; concept_ids: string[]; due_on: Date; created_at: Date; kind: string }>(
    `select id, title, concept_ids, due_on, created_at, kind from education_tutor.agent_tasks where course_id = $1 and status = 'pending' order by due_on`, [courseId])).rows
  const ev = await evidenceFor(t, [...new Set(open.flatMap((o) => o.concept_ids))])
  const today = now.toISOString().slice(0, 10)
  let done = 0
  const missed: { title: string; due: string }[] = []
  for (const m of open) {
    const complete = m.concept_ids.length > 0 && m.concept_ids.every((c) => {
      const e = ev.get(c) ?? []
      return e.some((x) => x.kind !== 'self_report' && x.observedAt >= m.created_at) && estimate(e, now).pMastery >= 0.5
    })
    const due = m.due_on.toISOString().slice(0, 10)
    if (complete) { await t.query(`update education_tutor.agent_tasks set status = 'done', completed_at = now() where id = $1`, [m.id]); done++ }
    else if (due < today && m.kind === 'milestone') { await t.query(`update education_tutor.agent_tasks set status = 'missed' where id = $1`, [m.id]); missed.push({ title: m.title, due }) }
  }
  return { done, missed }
}

async function conversationFor(t: Sql): Promise<{ id: string; state: ConvState }> {
  const c = await latestConversation(t)
  if (c) return { id: c.id, state: { ...initialState(), ...c.state } }
  const id = await createConversation(t)
  return { id, state: initialState() }
}

export function agentJobs(d: ModuleDeps) {
  return {
    [AGENT_DAILY_JOB]: async (ctx: JobContext) => asUser(ctx, async (t) => {
      const p = principalOf(ctx)
      const now = new Date()
      // retention: conversations without activity for RETENTION_DAYS are deleted (profile and plan are kept)
      const purged = (await t.query(`delete from education_tutor.agent_conversations where user_id = platform.current_user_id() and updated_at < now() - make_interval(days => $1)`, [RETENTION_DAYS])).rowCount
      const profile = await loadProfile(d, p, t)
      if (!profile?.courseId) return { skipped: 'no companion profile', purged }
      const courseId = profile.courseId
      const enrolled = (await t.query(`select 1 from education_tutor.enrolments where course_id = $1 and user_id = platform.current_user_id() and role = 'student'`, [courseId])).rowCount
      if (!enrolled) return { skipped: 'not enrolled', purged }
      const nudgesOn = (await t.query<{ nudges_enabled: boolean }>('select nudges_enabled from education_tutor.agent_profiles where user_id = platform.current_user_id()')).rows[0]?.nudges_enabled !== false
      const ms = await updateMilestones(t, courseId, now)
      const coach = await coachFor(t, courseId, now)
      const today = now.toISOString().slice(0, 10)
      const plan = (await t.query<{ plan: Plan }>(`select plan from education_tutor.plans where course_id = $1 and user_id = platform.current_user_id() order by version desc limit 1`, [courseId])).rows[0]?.plan
      const checkpoints = (await t.query<{ title: string; due_on: Date; concept_ids: string[] }>(
        `select title, due_on, concept_ids from education_tutor.agent_tasks where course_id = $1 and kind = 'checkpoint' and status = 'pending' and due_on <= $2::date order by due_on`, [courseId, today])).rows
      // studied in a tutor session in the last 2 days without any practice on that concept since
      const lesson = (await t.query<{ concept_id: string; name: string }>(
        `select s.concept_id, c.name from education_tutor.sessions s join education_tutor.concepts c on c.id = s.concept_id
          where s.course_id = $1 and s.created_at > now() - interval '2 days' and s.concept_id is not null
            and not exists (select 1 from education_tutor.evidence e where e.user_id = s.user_id and e.concept_id = s.concept_id and e.kind <> 'self_report' and e.observed_at > s.created_at)
          order by s.created_at desc limit 1`, [courseId])).rows[0]
      const active = (await t.query(`select 1 from education_tutor.agent_messages where user_id = platform.current_user_id() and role = 'student' and created_at >= $1::date
         union all select 1 from education_tutor.evidence where user_id = platform.current_user_id() and observed_at >= $1::date limit 1`, [today])).rowCount > 0
      const recent = (await t.query<{ dedupe_key: string; created_at: Date }>(
        `select dedupe_key, created_at from education_tutor.agent_messages where user_id = platform.current_user_id() and kind = 'nudge' and created_at > now() - interval '3 days'`)).rows
      const conv = await conversationFor(t)
      const nudges = nudgesOn ? decideNudges({
        now, courseId, language: profile.language ?? 'en', activeToday: active,
        nudgesToday: recent.filter((r) => r.created_at.toISOString().slice(0, 10) === today).length,
        recent: recent.map((r) => ({ kind: r.dedupe_key.split(':')[0] as NudgeKind, at: r.created_at })),
        dueCards: coach.dueCards, overdueMilestones: ms.missed,
        checkpointsDue: checkpoints.map((c) => ({ title: c.title, conceptIds: c.concept_ids })),
        recurringMisconceptions: coach.profile.flatMap((x) => x.recurringMisconceptions.slice(0, 1).map((m) => ({ conceptId: x.conceptId, conceptName: x.name, misconception: m }))),
        weakPrerequisite: coach.next.action === 'review_prerequisite' && coach.next.conceptId ? { conceptId: coach.next.conceptId, name: coach.profile.find((x) => x.conceptId === coach.next.conceptId)?.name ?? '' } : null,
        practiceAfterLesson: lesson ? { conceptId: lesson.concept_id, name: lesson.name } : null,
        planUpdated: null,
        examInDays: coach.examAt ? Math.ceil((Date.parse(`${coach.examAt}T00:00:00Z`) - now.getTime()) / DAY) : null,
      }) : []
      let posted = 0
      for (const n of nudges) if ((await addMessage(d, p, t, conv.id, { role: 'agent', kind: 'nudge', content: n.text, cards: [{ type: 'links', links: n.links }], dedupeKey: n.dedupeKey })).created) posted++
      // weekly learning report (once per ISO week, only after a week of use; facts only, no model call)
      const firstSeen = (await t.query<{ at: Date | null }>(`select min(created_at) as at from education_tutor.agent_messages where user_id = platform.current_user_id()`)).rows[0]?.at
      if (nudgesOn && firstSeen && now.getTime() - firstSeen.getTime() >= 6 * DAY) {
        const w = (await t.query<{ answers: number; correct: number; sections: number; done: number; missed: number }>(
          `select (select count(*)::int from education_tutor.evidence where user_id = platform.current_user_id() and kind <> 'self_report' and observed_at > now() - interval '7 days') as answers,
                  (select count(*)::int from education_tutor.evidence where user_id = platform.current_user_id() and kind <> 'self_report' and outcome >= 1 and observed_at > now() - interval '7 days') as correct,
                  (select count(*)::int from education_tutor.studio_events where user_id = platform.current_user_id() and kind = 'section_generated' and created_at > now() - interval '7 days') as sections,
                  (select count(*)::int from education_tutor.agent_tasks where user_id = platform.current_user_id() and status = 'done' and completed_at > now() - interval '7 days') as done,
                  (select count(*)::int from education_tutor.agent_tasks where user_id = platform.current_user_id() and status = 'missed' and due_on > current_date - 7) as missed`)).rows[0]!
        const strong = coach.profile.filter((x) => x.mastery.state === 'mastered').map((x) => x.name).slice(0, 3)
        const focus = coach.profile.filter((x) => x.mastery.evidenceCount > 0 && x.mastery.state !== 'mastered').sort((a, b) => a.mastery.pMastery - b.mastery.pMastery).map((x) => x.name).slice(0, 2)
        const week = isoWeek(now)
        const text = [
          `Your week: ${w.answers} answers checked (${w.answers ? Math.round((w.correct / w.answers) * 100) : 0}% right), ${w.sections} lesson section(s), ${w.done} milestone(s) done${w.missed ? `, ${w.missed} moved forward` : ''}.`,
          strong.length ? `Secure now: ${strong.join(', ')}.` : '',
          focus.length ? `Next week's focus: ${focus.join(', ')}.` : '',
          w.answers === 0 ? 'A quiet week is fine — 15 minutes a day is enough to restart.' : '',
        ].filter(Boolean).join(' ')
        if ((await addMessage(d, p, t, conv.id, { role: 'agent', kind: 'nudge', content: text, cards: [{ type: 'links', links: [{ label: 'See your progress', href: '/growth' }] }], dedupeKey: `weekly_report:${courseId}:${week}` })).created) posted++
      }
      // prepare the next session (shown when the student opens the companion)
      if (plan) {
        const agenda = prepareSession({ today, courseId, dueCards: coach.dueCards, tasks: plan.tasks as never, checkpoints: checkpoints.map((c) => ({ title: c.title, due: today, conceptIds: c.concept_ids })), openDoubts: (profile.doubts ?? []).filter((x) => x.status === 'open') })
        conv.state.nextSession = { ...agenda, courseId }
        await saveState(t, conv.id, conv.state)
      }
      return { milestonesDone: ms.done, milestonesMissed: ms.missed.length, nudges: posted, purged }
    }),

    /** The plan's question set, built ONCE after approval: per topic, the student's document first, then checked
     *  AI questions to fill the gap. Topics already filled are skipped, so retries and re-runs are cheap no-ops. */
    [QUESTION_SET_JOB]: async (ctx: JobContext) => {
      const { userId, courseId, conceptIds, documentId } = (ctx.job.payload ?? {}) as { userId?: string; courseId?: string; conceptIds?: string[]; documentId?: string | null }
      if (!ctx.job.tenant_id || !userId || !courseId || !Array.isArray(conceptIds)) throw new PermanentJobError('agent.question_set needs a tenant, userId, courseId and conceptIds')
      const p: Principal = { userId, tenantId: ctx.job.tenant_id, email: '', roles: ['student'], isPlatformAdmin: false }
      // only the questionSet field is written (live: saving the whole state raced with the approval turn)
      const progress = (qs: NonNullable<ConvState['questionSet']>, say?: string) => asUser(ctx, async (t) => {
        const conv = await conversationFor(t)
        await t.query(`update education_tutor.agent_conversations set state = jsonb_set(state, '{questionSet}', $2::jsonb) where id = $1`, [conv.id, JSON.stringify(qs)])
        if (say) await addMessage(d, p, t, conv.id, { role: 'agent', content: say, cards: [], dedupeKey: `qs:${courseId}:${ctx.job.id}` })
      })
      const total = conceptIds.length
      let done = 0, added = 0, fromDocument = 0
      const notes: unknown[] = []
      await progress({ courseId, total, done, status: 'building', added, fromDocument })
      for (const conceptId of conceptIds) {
        try {
          const r = await buildTopicSet(d, p, courseId, conceptId, { documentId: documentId ?? null })
          added += r.added; fromDocument += r.fromDocument
          notes.push({ conceptId, added: r.added, fromDocument: r.fromDocument, candidates: r.candidates ?? 0, sourcePages: r.sourcePages ?? 0, rejected: r.reasons ?? [] })
        } catch (e) {
          // provider hiccups retry the whole job (finished topics are skipped); bad topics are skipped
          if ((e as { retryable?: boolean }).retryable) throw e
        }
        done++
        await progress({ courseId, total, done, status: 'building', added, fromDocument })
        // stay under the provider's per-minute token limit (live: back-to-back topics were rate limited)
        if (done < total) await new Promise((r) => setTimeout(r, 4000))
      }
      await progress({ courseId, total, done, status: 'ready', added, fromDocument },
        added ? `Your practice set is ready: ${added} questions${fromDocument ? `, ${fromDocument} of them taken from your own material (with page numbers)` : ''}. Every answer was checked before it was added. Say "practise" when you want to start.` : undefined)
      return { added, fromDocument, notes }
    },
    [AFTER_ASSESSMENT_JOB]: async (ctx: JobContext) => asUser(ctx, async (t) => {
      const p = principalOf(ctx)
      const { attemptId } = (ctx.job.payload ?? {}) as { attemptId?: string }
      const a = (await t.query<{ course_id: string; title: string; score: string | null; max_score: string | null; status: string }>(
        `select x.course_id, s.title, x.score, x.max_score, x.status from education_tutor.assessment_attempts x join education_tutor.assessments s on s.id = x.assessment_id where x.id = $1`, [attemptId])).rows[0]
      if (!a || a.status !== 'graded') return { skipped: 'attempt not graded' }
      const profile = await loadProfile(d, p, t)
      const conv = await latestConversation(t)
      const state: ConvState | null = conv ? { ...initialState(), ...conv.state } : null
      // only plans the student approved through the companion are adapted automatically
      if (!profile || !state?.appliedPlan || state.appliedPlan.courseId !== a.course_id) return { skipped: 'no companion plan for this course' }
      const plan = await generatePlan(t, p.userId, a.course_id, { trigger: 'assessment_update' })
      const pct = a.max_score && Number(a.max_score) > 0 ? Math.round((Number(a.score) / Number(a.max_score)) * 100) : null
      const first = plan.tasks.find((x) => x.kind !== 'review')
      const score = pct !== null ? ` (${pct}%)` : ''
      const lang = profile.language ?? 'en'
      const reason = lang === 'hinglish'
        ? `"${a.title}"${score} ke result ke baad ${first ? `ab pehle ${first.conceptName} aayega` : 'baaki topics ka order badla gaya hai'}.`
        : lang === 'hi'
          ? `"${a.title}"${score} के परिणाम के बाद ${first ? `अब पहले ${first.conceptName} आएगा` : 'बाकी टॉपिक का क्रम बदला गया है'}।`
          : `after "${a.title}"${score}, ${first ? `${first.conceptName} comes first now` : 'your remaining topics were re-ordered'}.`
      const [n] = decideNudges({ now: new Date(), courseId: a.course_id, language: profile.language ?? 'en', activeToday: true, nudgesToday: 0, recent: [], dueCards: 0, overdueMilestones: [], checkpointsDue: [], recurringMisconceptions: [], weakPrerequisite: null, practiceAfterLesson: null, planUpdated: { reason, version: plan.version }, examInDays: null })
      if (n) await addMessage(d, p, t, conv!.id, { role: 'agent', kind: 'nudge', content: n.text, cards: [{ type: 'links', links: n.links }], dedupeKey: `${n.dedupeKey}:${attemptId}` })
      return { planVersion: plan.version }
    }),
  }
}

/** ISO week label (e.g. 2026-W47) for once-a-week dedupe keys. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum)
  const y = t.getUTCFullYear()
  const week = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7)
  return `${y}-W${String(week).padStart(2, '0')}`
}
