import { fileURLToPath } from 'node:url'
import { AppError, badRequest, notFound } from '@platform/core'
import type { ModuleDeps, ModuleManifest, Principal, RouteDef } from '@platform/contracts'
import type { Sql } from '@platform/tenancy-db'
import { estimate } from './domain/learner-model.ts'
import { newCard, review, type Grade } from './domain/fsrs.ts'
import type { SessionState } from './domain/tutoring.ts'
import { isRubricSpec, score, scoreExpression, type AnswerSpec, type ScoreResult } from './domain/scoring.ts'
import { itemRoutes, mathUnavailable } from './items.ts'
import { progressRoutes } from './progress.ts'
import { TASKS } from './ai.ts'
import { courseGraph, evidenceFor, ID, obj, P, requireEnrolled, str, uuid } from './common.ts'
import { generatePlan } from './plans.ts'
import { turnRoutes } from './turns.ts'
import { SCHEDULES, tutorJobs } from './jobs.ts'
import { MATERIAL_TASKS, materialRoutes } from './materials.ts'
import { DIAGNOSIS_TASKS, diagnosisRoutes } from './diagnosis.ts'
import { coachRoutes } from './coach.ts'
import { VOICE_TASKS, voiceRoutes } from './voice.ts'
import { GENERATION_TASKS, generationRoutes } from './assessgen.ts'
import { ASSESSMENT_TASKS, assessmentRoutes } from './assessments.ts'
import { agentRoutes } from './agent/routes.ts'
import { studioRoutes } from './studio/routes.ts'
import { LIVE_TASKS, liveRoutes } from './studio/live.ts'
import { growthRoutes } from './growth/routes.ts'
import { GROWTH_TASKS } from './growth/prompts.ts'
import { STUDIO_TASKS } from './studio/prompts.ts'
import { PERSONAL_TASKS, personalRoutes } from './courses/personal.ts'
import { DOCUMENT_TASKS } from './courses/document.ts'
import { AGENT_TASKS } from './agent/prompts.ts'

function routes(d: ModuleDeps): RouteDef[] {
  const tx = <T>(p: Principal, fn: (t: Sql) => Promise<T>) => d.inTenant(p, fn)
  const inRange = (v: unknown, name: string, min: number, max: number, integer = false) => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw badRequest('invalid_field', `${name} must be ${integer ? 'a whole number ' : ''}between ${min} and ${max}`)
    return n
  }
  const mathOf = () => {
    if (!d.math) throw mathUnavailable()
    return d.math
  }
  return [
    // ── course structure (educators) ──
    { method: 'GET', path: '/courses', permission: P.read, handler: async ({ principal }) => tx(principal, async (t) =>
      (await t.query(`select c.id, c.code, c.title, c.term, c.integrity_mode, e.role from education_tutor.courses c
        join education_tutor.enrolments e on e.course_id = c.id and e.user_id = $1 order by c.code`, [principal.userId])).rows) },
    { method: 'POST', path: '/courses', permission: P.manage, handler: async ({ principal, body }) => {
      const b = obj(body)
      const mode = (b.integrityMode ?? 'guided') as string
      if (!['open', 'guided', 'hint_only'].includes(mode)) throw badRequest('integrity_mode_invalid', 'integrityMode must be open|guided|hint_only')
      return tx(principal, async (t) => {
        const r = await t.query<{ id: string }>(
          `insert into education_tutor.courses (tenant_id, code, title, term, integrity_mode, created_by) values (platform.current_tenant(), $1, $2, $3, $4, $5) returning id`,
          [str(b.code, 'code', 40), str(b.title, 'title', 200), typeof b.term === 'string' ? b.term : null, mode, principal.userId])
        const id = r.rows[0]!.id
        await t.query(`insert into education_tutor.enrolments (tenant_id, course_id, user_id, role) values (platform.current_tenant(), $1, $2, 'educator')`, [id, principal.userId])
        await d.audit(t, principal, { action: 'course.created', targetType: 'course', targetId: id })
        return { id }
      }).catch((e: { code?: string }) => { if (e.code === '23505') throw new AppError('course_exists', 'Course code already exists', { status: 409 }); throw e })
    } },
    { method: 'POST', path: '/courses/:courseId/enrolments', permission: P.manage, handler: async ({ principal, params, body }) => {
      const b = obj(body)
      const role = b.role === 'educator' ? 'educator' : 'student'
      return tx(principal, async (t) => {
        await requireEnrolled(t, principal, uuid(params.courseId, 'courseId'))
        // only members of this tenant can be enrolled (memberships are RLS-scoped to the tenant)
        const m = await t.query('select 1 from platform.memberships where user_id = $1 and status = $2', [uuid(b.userId, 'userId'), 'active'])
        if (!m.rowCount) throw badRequest('not_a_member', 'User is not an active member of this institution')
        await t.query(`insert into education_tutor.enrolments (tenant_id, course_id, user_id, role) values (platform.current_tenant(), $1, $2, $3)
          on conflict (course_id, user_id) do update set role = excluded.role`, [params.courseId, b.userId, role])
      })
    } },
    { method: 'GET', path: '/courses/:courseId/concepts', permission: P.read, handler: async ({ principal, params }) => tx(principal, async (t) => {
      const c = await requireEnrolled(t, principal, uuid(params.courseId, 'courseId'))
      const rows = (await t.query(`select id, name, description, est_minutes, exam_weight, status from education_tutor.concepts
        where course_id = $1 and (status = 'approved' or $2) order by name`, [params.courseId, c.role === 'educator'])).rows
      const edges = (await courseGraph(t, params.courseId!)).edges
      return { concepts: rows, prerequisites: edges.map((e) => ({ prerequisite: e.from_concept, concept: e.to_concept })) }
    }) },
    { method: 'POST', path: '/courses/:courseId/concepts', permission: P.manage, handler: async ({ principal, params, body }) => {
      const b = obj(body)
      const pre = Array.isArray(b.prerequisites) ? b.prerequisites.map((x) => uuid(x, 'prerequisite')) : []
      return tx(principal, async (t) => {
        await requireEnrolled(t, principal, uuid(params.courseId, 'courseId'))
        const r = await t.query<{ id: string }>(
          `insert into education_tutor.concepts (tenant_id, course_id, name, description, est_minutes, exam_weight) values (platform.current_tenant(), $1, $2, $3, $4, $5) returning id`,
          [params.courseId, str(b.name, 'name', 200), typeof b.description === 'string' ? b.description.slice(0, 4000) : '', inRange(b.estMinutes ?? 60, 'estMinutes', 5, 600, true), inRange(b.examWeight ?? 1, 'examWeight', 0.1, 10)])
        const id = r.rows[0]!.id
        for (const p of pre) {
          const ok = await t.query('select 1 from education_tutor.concepts where id = $1 and course_id = $2', [p, params.courseId])
          if (!ok.rowCount) throw badRequest('prerequisite_invalid', 'Prerequisites must belong to the same course')
          await t.query('insert into education_tutor.concept_edges (tenant_id, from_concept, to_concept) values (platform.current_tenant(), $1, $2)', [p, id])
        }
        return { id }
      })
    } },
    { method: 'POST', path: '/courses/:courseId/concepts/:conceptId/approve', permission: P.manage, handler: async ({ principal, params }) => tx(principal, async (t) => {
      await requireEnrolled(t, principal, uuid(params.courseId, 'courseId'))
      const r = await t.query(`update education_tutor.concepts set status = 'approved' where id = $1 and course_id = $2`, [uuid(params.conceptId, 'conceptId'), params.courseId])
      if (!r.rowCount) throw notFound('Concept')
      await d.audit(t, principal, { action: 'concept.approved', targetType: 'concept', targetId: params.conceptId })
    }) },
    ...itemRoutes(d),
    ...progressRoutes(d),

    // ── practice + learner profile (students) ──
    { method: 'GET', path: '/courses/:courseId/practice/next', permission: P.study, handler: async ({ principal, params, query }) => tx(principal, async (t) => {
      await requireEnrolled(t, principal, uuid(params.courseId, 'courseId'))
      const { concepts } = await courseGraph(t, params.courseId!)
      const ev = await evidenceFor(t, concepts.map((c) => c.id))
      const want = query.get('conceptId')
      const target = want ? concepts.find((c) => c.id === want) : [...concepts].sort((a, b) => estimate(ev.get(a.id)!).pMastery - estimate(ev.get(b.id)!).pMastery)[0]
      if (!target) throw notFound('Concept')
      const p = estimate(ev.get(target.id)!).pMastery
      // aim for a ~70-85% success zone: item difficulty close to current mastery
      const item = (await t.query<{ id: string; type: string; stem: string; answer_spec: AnswerSpec; source_refs: { kind?: string; filename?: string; pageStart?: number; bookId?: string }[] | null }>(
        `select i.id, i.type, i.stem, i.answer_spec, i.source_refs from education_tutor.items i
         where i.concept_id = $1 and i.retired_at is null and i.status = 'approved' and i.type in ('mcq', 'numeric', 'expression') and not exists (select 1 from education_tutor.attempts a where a.item_id = i.id and a.user_id = platform.current_user_id() and a.created_at > now() - interval '1 day')
         order by (coalesce(jsonb_array_length(i.source_refs), 0) = 0), abs(i.difficulty - $2), i.id limit 1`, [target.id, p])).rows[0]
      if (!item) return { conceptId: target.id, item: null, message: 'No unseen practice items for this concept right now.' }
      // never send the answer to the client
      const src = item.source_refs?.[0]
      return { conceptId: target.id, source: src?.filename ? { kind: src.kind === 'lesson' ? 'lesson' : 'material', filename: src.filename, page: src.pageStart ?? null, bookId: src.bookId ?? null } : null, item: { id: item.id, type: item.type, stem: item.stem, options: item.answer_spec.type === 'mcq' ? item.answer_spec.options : undefined, multiple: item.answer_spec.type === 'mcq' ? item.answer_spec.correct.length > 1 : undefined } }
    }) },
    { method: 'POST', path: '/attempts', permission: P.study, handler: async ({ principal, body }) => {
      const b = obj(body)
      const confidence = b.confidence === undefined ? null : String(b.confidence)
      if (confidence && !['sure', 'unsure', 'guess'].includes(confidence)) throw badRequest('confidence_invalid', 'confidence must be sure|unsure|guess')
      const clientHints = Math.max(0, Math.min(6, Number(b.hintsUsed ?? 0)))
      const itemId = uuid(b.itemId, 'itemId')
      const load = async (t: Sql) => {
        const item = (await t.query<{ id: string; course_id: string; concept_id: string; answer_spec: AnswerSpec; explanation: string; retired_at: Date | null }>(
          'select id, course_id, concept_id, answer_spec, explanation, retired_at from education_tutor.items where id = $1', [itemId])).rows[0]
        if (!item) throw notFound('Item')
        await requireEnrolled(t, principal, item.course_id)
        if (item.retired_at) throw new AppError('item_retired', 'This question has been withdrawn by your educator', { status: 409 })
        return item
      }
      // symbolic answers are checked by the maths service OUTSIDE the transaction (bounded by its timeout)
      let checked: ScoreResult | undefined
      const first = await tx(principal, load)
      if (first.answer_spec.type === 'expression') {
        const r = await scoreExpression(mathOf(), first.answer_spec, b.response)
        if (!r) throw mathUnavailable()
        checked = r
      }
      return tx(principal, async (t) => {
        const item = await load(t)
        if (item.answer_spec.type === 'expression' && (!checked || JSON.stringify(item.answer_spec) !== JSON.stringify(first.answer_spec))) {
          throw new AppError('item_changed', 'This question changed while your answer was being checked; please submit again', { status: 409 })
        }
        if (isRubricSpec(item.answer_spec)) throw badRequest('use_assessment', 'Written-answer questions are marked inside assessments')
        const s = item.answer_spec.type === 'expression' ? checked! : score(item.answer_spec, b.response)
        if (s.feedbackKey === 'invalid_response') throw badRequest('response_invalid', 'Response is not valid for this item')
        // a double click or network retry is one answer: same student, item and response within seconds records nothing new
        // (the lock makes concurrent submissions wait, so the second one sees the first)
        await t.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`attempt:${principal.userId}:${item.id}`])
        const duplicate = (await t.query<{ id: string }>(`select id from education_tutor.attempts where user_id = platform.current_user_id() and item_id = $1 and response = $2::jsonb and created_at > clock_timestamp() - interval '10 seconds' order by created_at desc limit 1`,
          [item.id, JSON.stringify(b.response)])).rows[0]
        let attemptId = duplicate?.id
        if (!attemptId) {
          // hints the server actually gave (hint ladder) count even if the client under-reports; the ladder resets per attempt
          const seen = (await t.query<{ max_level: number }>('delete from education_tutor.hint_usage where user_id = platform.current_user_id() and item_id = $1 returning max_level', [item.id])).rows[0]?.max_level ?? 0
          const hints = Math.max(clientHints, seen)
          attemptId = (await t.query<{ id: string }>(`insert into education_tutor.attempts (tenant_id, user_id, item_id, response, outcome, confidence, hints_used) values (platform.current_tenant(), $1, $2, $3, $4, $5, $6) returning id`,
            [principal.userId, item.id, JSON.stringify(b.response), s.outcome, confidence, hints])).rows[0]!.id
          await t.query(`insert into education_tutor.evidence (tenant_id, user_id, concept_id, kind, outcome, hints_used, source_ref) values (platform.current_tenant(), $1, $2, 'practice', $3, $4, $5)`,
            [principal.userId, item.concept_id, s.outcome, hints, `item:${item.id}`])
        }
        const m = estimate((await evidenceFor(t, [item.concept_id])).get(item.concept_id)!)
        return { attemptId, correct: s.correct, outcome: s.outcome, explanation: item.explanation, confidentAndWrong: confidence === 'sure' && !s.correct, mastery: m }
      })
    } },
    { method: 'GET', path: '/courses/:courseId/mastery', permission: P.study, handler: async ({ principal, params }) => tx(principal, async (t) => {
      await requireEnrolled(t, principal, uuid(params.courseId, 'courseId'))
      const { concepts } = await courseGraph(t, params.courseId!)
      const ev = await evidenceFor(t, concepts.map((c) => c.id))
      return concepts.map((c) => ({ conceptId: c.id, name: c.name, ...estimate(ev.get(c.id)!) }))
    }) },

    // ── spaced revision ──
    { method: 'POST', path: '/cards', permission: P.study, handler: async ({ principal, body }) => {
      const b = obj(body)
      return tx(principal, async (t) => {
        await requireEnrolled(t, principal, uuid(b.courseId, 'courseId'))
        const r = await t.query<{ id: string }>(`insert into education_tutor.cards (tenant_id, user_id, course_id, concept_id, front, back) values (platform.current_tenant(), $1, $2, $3, $4, $5) returning id`,
          [principal.userId, b.courseId, b.conceptId ? uuid(b.conceptId, 'conceptId') : null, str(b.front, 'front', 1000), str(b.back, 'back', 2000)])
        return { id: r.rows[0]!.id }
      })
    } },
    { method: 'GET', path: '/cards/due', permission: P.study, handler: async ({ principal }) => tx(principal, async (t) =>
      (await t.query(`select id, course_id, concept_id, front, back, due_at from education_tutor.cards where user_id = platform.current_user_id() and due_at <= now() order by due_at limit 50`)).rows) },
    { method: 'POST', path: '/cards/:cardId/review', permission: P.study, handler: async ({ principal, params, body }) => {
      const grade = Number(obj(body).grade)
      if (![1, 2, 3, 4].includes(grade)) throw badRequest('grade_invalid', 'grade must be 1 (again), 2 (hard), 3 (good) or 4 (easy)')
      return tx(principal, async (t) => {
        const c = (await t.query<{ stability: number; difficulty: number; reps: number; lapses: number; last_review: Date | null; due_at: Date; concept_id: string | null; purpose: string }>(
          'select stability, difficulty, reps, lapses, last_review, due_at, concept_id, purpose from education_tutor.cards where id = $1 and user_id = platform.current_user_id()', [uuid(params.cardId, 'cardId')])).rows[0]
        if (!c) throw notFound('Card')
        const now = new Date()
        const next = review(c.reps ? { stability: c.stability, difficulty: c.difficulty, reps: c.reps, lapses: c.lapses, lastReview: c.last_review, due: c.due_at } : newCard(now), grade as Grade, now)
        await t.query(`update education_tutor.cards set stability=$2, difficulty=$3, reps=$4, lapses=$5, last_review=$6, due_at=$7 where id=$1`,
          [params.cardId, next.stability, next.difficulty, next.reps, next.lapses, next.lastReview, next.due])
        if (c.concept_id) await t.query(`insert into education_tutor.evidence (tenant_id, user_id, concept_id, kind, outcome, source_ref) values (platform.current_tenant(), $1, $2, $3, $4, $5)`,
          [principal.userId, c.concept_id, c.reps > 0 || c.purpose === 'delayed_check' ? 'delayed_check' : 'check', grade >= 3 ? 1 : grade === 2 ? 0.5 : 0, `card:${params.cardId}`])
        return { dueAt: next.due, stability: next.stability }
      })
    } },

    // ── planner ──
    { method: 'PUT', path: '/courses/:courseId/goal', permission: P.study, handler: async ({ principal, params, body }) => {
      const b = obj(body)
      const daily = Number(b.dailyMinutes)
      if (!(daily >= 10 && daily <= 600)) throw badRequest('daily_minutes_invalid', 'dailyMinutes must be 10–600')
      const examAt = b.examAt ? new Date(String(b.examAt)) : null
      if (examAt && Number.isNaN(examAt.getTime())) throw badRequest('exam_at_invalid', 'examAt must be a date')
      return tx(principal, async (t) => {
        await requireEnrolled(t, principal, uuid(params.courseId, 'courseId'))
        await t.query(`insert into education_tutor.goals (tenant_id, user_id, course_id, exam_at, daily_minutes) values (platform.current_tenant(), $1, $2, $3, $4)
          on conflict (user_id, course_id) do update set exam_at = excluded.exam_at, daily_minutes = excluded.daily_minutes`, [principal.userId, params.courseId, examAt, daily])
      })
    } },
    { method: 'POST', path: '/courses/:courseId/plan', permission: P.study, handler: async ({ principal, params, body }) => tx(principal, async (t) => {
      await requireEnrolled(t, principal, uuid(params.courseId, 'courseId'))
      return generatePlan(t, principal.userId, params.courseId!, { missedMinutes: Number(obj(body).missedMinutes ?? 0) })
    }) },

    // ── tutor sessions ──
    { method: 'POST', path: '/sessions', permission: P.study, handler: async ({ principal, body }) => {
      const b = obj(body)
      const language = (b.language ?? 'en') as string
      if (!['en', 'hi', 'hinglish'].includes(language)) throw badRequest('language_invalid', 'language must be en|hi|hinglish')
      return tx(principal, async (t) => {
        await requireEnrolled(t, principal, uuid(b.courseId, 'courseId'))
        const state: SessionState = { mode: 'socratic', hintLevel: 0, attemptsAtStep: 0, rescueTarget: null, graded: b.graded === true }
        const r = await t.query<{ id: string }>(`insert into education_tutor.sessions (tenant_id, user_id, course_id, concept_id, problem, graded, language, state)
          values (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7) returning id`,
          [principal.userId, b.courseId, b.conceptId ? uuid(b.conceptId, 'conceptId') : null, typeof b.problem === 'string' ? b.problem.slice(0, 8000) : null, state.graded, language, JSON.stringify(state)])
        return { id: r.rows[0]!.id }
      })
    } },
    ...turnRoutes(d),
  ]
}

export const manifest: ModuleManifest = {
  id: ID,
  vertical: 'education',
  version: '0.1.0',
  owner: 'education-product-team',
  description: 'AI Personal Tutor: courses, Socratic tutoring, learner profile, practice, spaced revision, planner, agentic study companion',
  db: { schema: 'education_tutor', migrationsDir: fileURLToPath(new URL('../db/migrations', import.meta.url)) },
  permissions: [
    { key: P.read, description: 'See enrolled courses and their concepts', roles: ['student', 'educator', 'tenant_admin'] },
    { key: P.manage, description: 'Create courses, concepts, items; enrol students', roles: ['educator', 'tenant_admin'] },
    { key: P.study, description: 'Use the tutor, practice, revision and planner (own data only)', roles: ['student', 'educator'] },
    { key: P.insights, description: 'See aggregate, privacy-safe product insights (no individual student data)', roles: ['tenant_admin'] },
  ],
  routes: (d) => [...routes(d), ...materialRoutes(d), ...diagnosisRoutes(d), ...coachRoutes(d), ...voiceRoutes(d), ...liveRoutes(d), ...generationRoutes(d), ...assessmentRoutes(d), ...agentRoutes(d), ...studioRoutes(d), ...growthRoutes(d), ...personalRoutes(d)],
  jobs: tutorJobs,
  schedules: SCHEDULES,
  ui: {
    routes: [
      { path: '/app/education/tutor', title: 'Tutor', permission: P.read },
      { path: '/app/education/tutor/courses/:courseId', title: 'Course', permission: P.read },
    ],
    nav: [{ label: 'Tutor', path: '/app/education/tutor', permission: P.read }],
  },
  ai: { tasks: [...TASKS, ...MATERIAL_TASKS, ...DIAGNOSIS_TASKS, ...VOICE_TASKS, ...LIVE_TASKS, ...GENERATION_TASKS, ...ASSESSMENT_TASKS, ...AGENT_TASKS, ...STUDIO_TASKS, ...GROWTH_TASKS, ...PERSONAL_TASKS, ...DOCUMENT_TASKS] },
  data: {
    stores: [
      { kind: 'schema', name: 'education_tutor', onRemove: 'export_then_drop', description: 'courses, concepts, items, attempts, evidence, cards, goals, plans, sessions, turns, companion profiles/conversations/tasks, studio books/pages/notebooks/annotations, exam papers/questions, hint usage, growth prefs, chapter packages' },
      { kind: 'audit_events', name: 'education.tutor.*', onRemove: 'retain_platform_policy', description: 'audit trail (ids only)' },
      { kind: 'ai_operations', name: 'education.tutor', onRemove: 'retain_platform_policy', description: 'AI metering' },
    ],
  },
  evals: { suites: ['tutor/socratic'] },
}
