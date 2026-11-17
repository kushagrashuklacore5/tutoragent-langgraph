import { fileURLToPath } from 'node:url'
import { AppError, badRequest, notFound } from '@platform/core'
import type { ModuleDeps, ModuleManifest, Principal, RouteDef } from '@platform/contracts'
import type { Sql } from '@platform/tenancy-db'
import { estimate, probeCandidates, type Evidence, type MasteryEstimate } from './domain/learner-model.ts'
import { newCard, review, type Grade } from './domain/fsrs.ts'
import { buildPlan, recoverPlan, type PlanConcept } from './domain/planner.ts'
import { advance, chooseMove, evidenceOutcome, verifySegments, type IntegrityMode, type Segment, type SessionState } from './domain/tutoring.ts'
import { score, validateSpec, type AnswerSpec } from './domain/scoring.ts'
import { TASKS, PROMPT_VERSION, buildSocraticPrompt } from './ai.ts'

const ID = 'education.tutor'
const P = {
  read: `${ID}:course.read`,
  manage: `${ID}:course.manage`,
  study: `${ID}:study`,
} as const

const UUID = /^[0-9a-f-]{36}$/i
const uuid = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw badRequest('invalid_id', `${name} must be a UUID`)
  return v
}
const str = (v: unknown, name: string, max = 2000): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw badRequest('invalid_field', `${name} is required (max ${max} chars)`)
  return v.trim()
}
const obj = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {})

async function requireEnrolled(tx: Sql, p: Principal, courseId: string): Promise<{ title: string; integrity_mode: IntegrityMode; role: string }> {
  const r = await tx.query<{ title: string; integrity_mode: IntegrityMode; role: string }>(
    `select c.title, c.integrity_mode, e.role from education_tutor.courses c
     join education_tutor.enrolments e on e.course_id = c.id and e.user_id = $2 where c.id = $1`, [courseId, p.userId])
  if (!r.rows[0]) throw notFound('Course')
  return r.rows[0]
}

async function evidenceFor(tx: Sql, conceptIds: string[]): Promise<Map<string, Evidence[]>> {
  const m = new Map<string, Evidence[]>(conceptIds.map((c) => [c, []]))
  if (!conceptIds.length) return m
  const r = await tx.query<{ concept_id: string; kind: Evidence['kind']; outcome: string; hints_used: number; observed_at: Date }>(
    `select concept_id, kind, outcome, hints_used, observed_at from education_tutor.evidence where concept_id = any($1) and user_id = platform.current_user_id()`, [conceptIds])
  for (const e of r.rows) m.get(e.concept_id)?.push({ kind: e.kind, outcome: Number(e.outcome), hintsUsed: e.hints_used, observedAt: e.observed_at })
  return m
}

async function courseGraph(tx: Sql, courseId: string) {
  const concepts = (await tx.query<{ id: string; name: string; est_minutes: number; exam_weight: string }>(
    `select id, name, est_minutes, exam_weight from education_tutor.concepts where course_id = $1 and status = 'approved' order by name`, [courseId])).rows
  const edges = (await tx.query<{ from_concept: string; to_concept: string }>(
    `select e.from_concept, e.to_concept from education_tutor.concept_edges e join education_tutor.concepts c on c.id = e.to_concept where c.course_id = $1`, [courseId])).rows
  return { concepts, edges }
}

function routes(d: ModuleDeps): RouteDef[] {
  const tx = <T>(p: Principal, fn: (t: Sql) => Promise<T>) => d.inTenant(p, fn)
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
          [params.courseId, str(b.name, 'name', 200), typeof b.description === 'string' ? b.description : '', Number(b.estMinutes ?? 60), Number(b.examWeight ?? 1)])
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
    { method: 'POST', path: '/courses/:courseId/items', permission: P.manage, handler: async ({ principal, params, body }) => {
      const b = obj(body)
      const spec = b.answerSpec as AnswerSpec
      if (!spec || !['mcq', 'numeric'].includes(spec.type)) throw badRequest('answer_spec_invalid', 'answerSpec.type must be mcq or numeric')
      const problems = validateSpec(spec)
      if (problems.length) throw badRequest('answer_spec_invalid', problems.join('; '))
      return tx(principal, async (t) => {
        await requireEnrolled(t, principal, uuid(params.courseId, 'courseId'))
        const r = await t.query<{ id: string }>(
          `insert into education_tutor.items (tenant_id, course_id, concept_id, type, stem, answer_spec, explanation, difficulty)
           select platform.current_tenant(), $1, c.id, $3, $4, $5, $6, $7 from education_tutor.concepts c where c.id = $2 and c.course_id = $1 returning id`,
          [params.courseId, uuid(b.conceptId, 'conceptId'), spec.type, str(b.stem, 'stem', 4000), JSON.stringify(spec), typeof b.explanation === 'string' ? b.explanation : '', Number(b.difficulty ?? 0.5)])
        if (!r.rows[0]) throw notFound('Concept')
        return { id: r.rows[0].id }
      })
    } },

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
      const item = (await t.query<{ id: string; type: string; stem: string; answer_spec: AnswerSpec }>(
        `select i.id, i.type, i.stem, i.answer_spec from education_tutor.items i
         where i.concept_id = $1 and not exists (select 1 from education_tutor.attempts a where a.item_id = i.id and a.created_at > now() - interval '1 day')
         order by abs(i.difficulty - $2), i.id limit 1`, [target.id, p])).rows[0]
      if (!item) return { conceptId: target.id, item: null, message: 'No unseen practice items for this concept right now.' }
      // never send the answer to the client
      return { conceptId: target.id, item: { id: item.id, type: item.type, stem: item.stem, options: item.answer_spec.type === 'mcq' ? item.answer_spec.options : undefined, multiple: item.answer_spec.type === 'mcq' ? item.answer_spec.correct.length > 1 : undefined } }
    }) },
    { method: 'POST', path: '/attempts', permission: P.study, handler: async ({ principal, body }) => {
      const b = obj(body)
      const confidence = b.confidence === undefined ? null : String(b.confidence)
      if (confidence && !['sure', 'unsure', 'guess'].includes(confidence)) throw badRequest('confidence_invalid', 'confidence must be sure|unsure|guess')
      const hints = Math.max(0, Math.min(4, Number(b.hintsUsed ?? 0)))
      return tx(principal, async (t) => {
        const item = (await t.query<{ id: string; course_id: string; concept_id: string; answer_spec: AnswerSpec; explanation: string }>(
          'select id, course_id, concept_id, answer_spec, explanation from education_tutor.items where id = $1', [uuid(b.itemId, 'itemId')])).rows[0]
        if (!item) throw notFound('Item')
        await requireEnrolled(t, principal, item.course_id)
        const s = score(item.answer_spec, b.response)
        if (s.feedbackKey === 'invalid_response') throw badRequest('response_invalid', 'Response is not valid for this item')
        await t.query(`insert into education_tutor.attempts (tenant_id, user_id, item_id, response, outcome, confidence, hints_used) values (platform.current_tenant(), $1, $2, $3, $4, $5, $6)`,
          [principal.userId, item.id, JSON.stringify(b.response), s.outcome, confidence, hints])
        await t.query(`insert into education_tutor.evidence (tenant_id, user_id, concept_id, kind, outcome, hints_used, source_ref) values (platform.current_tenant(), $1, $2, 'practice', $3, $4, $5)`,
          [principal.userId, item.concept_id, s.outcome, hints, `item:${item.id}`])
        const m = estimate((await evidenceFor(t, [item.concept_id])).get(item.concept_id)!)
        return { correct: s.correct, outcome: s.outcome, explanation: item.explanation, confidentAndWrong: confidence === 'sure' && !s.correct, mastery: m }
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
      (await t.query(`select id, course_id, concept_id, front, back, due_at from education_tutor.cards where due_at <= now() order by due_at limit 50`)).rows) },
    { method: 'POST', path: '/cards/:cardId/review', permission: P.study, handler: async ({ principal, params, body }) => {
      const grade = Number(obj(body).grade)
      if (![1, 2, 3, 4].includes(grade)) throw badRequest('grade_invalid', 'grade must be 1 (again), 2 (hard), 3 (good) or 4 (easy)')
      return tx(principal, async (t) => {
        const c = (await t.query<{ stability: number; difficulty: number; reps: number; lapses: number; last_review: Date | null; due_at: Date; concept_id: string | null }>(
          'select stability, difficulty, reps, lapses, last_review, due_at, concept_id from education_tutor.cards where id = $1', [uuid(params.cardId, 'cardId')])).rows[0]
        if (!c) throw notFound('Card')
        const now = new Date()
        const next = review(c.reps ? { stability: c.stability, difficulty: c.difficulty, reps: c.reps, lapses: c.lapses, lastReview: c.last_review, due: c.due_at } : newCard(now), grade as Grade, now)
        await t.query(`update education_tutor.cards set stability=$2, difficulty=$3, reps=$4, lapses=$5, last_review=$6, due_at=$7 where id=$1`,
          [params.cardId, next.stability, next.difficulty, next.reps, next.lapses, next.lastReview, next.due])
        if (c.concept_id) await t.query(`insert into education_tutor.evidence (tenant_id, user_id, concept_id, kind, outcome, source_ref) values (platform.current_tenant(), $1, $2, $3, $4, $5)`,
          [principal.userId, c.concept_id, c.reps > 0 ? 'delayed_check' : 'check', grade >= 3 ? 1 : grade === 2 ? 0.5 : 0, `card:${params.cardId}`])
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
      const goal = (await t.query<{ exam_at: Date | null; daily_minutes: number }>('select exam_at, daily_minutes from education_tutor.goals where course_id = $1', [params.courseId])).rows[0]
      if (!goal) throw badRequest('goal_required', 'Set your exam date and daily study time first')
      const { concepts, edges } = await courseGraph(t, params.courseId!)
      const ev = await evidenceFor(t, concepts.map((c) => c.id))
      const due = (await t.query<{ n: number }>(`select count(*)::int as n from education_tutor.cards where course_id = $1 and due_at < now() + interval '7 days'`, [params.courseId])).rows[0]!.n
      const planConcepts: PlanConcept[] = concepts.map((c) => {
        const m = estimate(ev.get(c.id)!)
        return { id: c.id, name: c.name, estMinutes: c.est_minutes, examWeight: Number(c.exam_weight), pMastery: m.pMastery, mastered: m.state === 'mastered', prerequisites: edges.filter((e) => e.to_concept === c.id).map((e) => e.from_concept) }
      })
      const input = { today: new Date(), examAt: goal.exam_at, dailyMinutes: goal.daily_minutes, concepts: planConcepts, reviewMinutesPerDay: Math.ceil((due * 1.5) / 7) }
      const missed = Number(obj(body).missedMinutes ?? 0)
      const plan = missed > 0 ? recoverPlan(input, missed) : buildPlan(input)
      const v = (await t.query<{ v: number }>('select coalesce(max(version), 0)::int + 1 as v from education_tutor.plans where course_id = $1', [params.courseId])).rows[0]!.v
      await t.query(`insert into education_tutor.plans (tenant_id, user_id, course_id, version, plan) values (platform.current_tenant(), $1, $2, $3, $4)`, [principal.userId, params.courseId, v, JSON.stringify(plan)])
      return { version: v, ...plan }
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
    { method: 'POST', path: '/sessions/:sessionId/turns', permission: P.study, handler: async ({ principal, params, body }) => {
      const b = obj(body)
      const message = str(b.message, 'message', 8000)
      // 1. load session context (RLS: only the owner can see it)
      const ctx = await tx(principal, async (t) => {
        const s = (await t.query<{ course_id: string; concept_id: string | null; problem: string | null; language: string; state: SessionState }>(
          'select course_id, concept_id, problem, language, state from education_tutor.sessions where id = $1', [uuid(params.sessionId, 'sessionId')])).rows[0]
        if (!s) throw notFound('Session')
        const course = await requireEnrolled(t, principal, s.course_id)
        let rescue: { id: string; name: string } | null = null
        let conceptName: string | null = null
        if (s.concept_id) {
          conceptName = (await t.query<{ name: string }>('select name from education_tutor.concepts where id = $1', [s.concept_id])).rows[0]?.name ?? null
          const pre = (await t.query<{ id: string; name: string }>(`select c.id, c.name from education_tutor.concept_edges e join education_tutor.concepts c on c.id = e.from_concept where e.to_concept = $1`, [s.concept_id])).rows
          const ev = await evidenceFor(t, pre.map((x) => x.id))
          const order = probeCandidates(pre.map((x) => ({ conceptId: x.id, estimate: estimate(ev.get(x.id)!) as MasteryEstimate })))
          const first = pre.find((x) => x.id === order[0])
          if (first) rescue = first
        }
        const history = (await t.query<{ role: 'student' | 'tutor'; content: string }>('select role, content from education_tutor.turns where session_id = $1 order by created_at desc limit 12', [params.sessionId])).rows.reverse()
        return { s, course, rescue, conceptName, history }
      })
      // 2. deterministic teaching move + integrity policy
      const decision = chooseMove(ctx.s.state, { stuck: b.stuck === true, requestFullAnswer: b.requestFullAnswer === true, hasProblem: !!ctx.s.problem }, ctx.course.integrity_mode, ctx.rescue?.id ?? null)
      // 3. AI via the gateway (provider chosen by routing configuration)
      const out = await d.ai(principal).run('education.tutor.socratic_turn', {
        messages: buildSocraticPrompt({ move: decision.move, hintLevel: decision.hintLevel, language: ctx.s.language, courseTitle: ctx.course.title, conceptName: ctx.conceptName,
          problem: ctx.s.problem, rescueConceptName: decision.move === 'rescue_probe' ? ctx.rescue?.name : null, policyNote: decision.policyNote, history: ctx.history, message }),
      }, { promptVersion: PROMPT_VERSION })
      const json = out.json as { segments: Segment[]; assessment: 'correct' | 'partial' | 'incorrect' | 'not_an_attempt'; checkQuestion?: string }
      // 4. honest labelling: no retrieval in this session yet, so no segment may claim course material
      const { segments, relabelled } = verifySegments(json.segments.map((s) => ({ ...s, citations: s.citations ?? [] })), new Set())
      const nextState = { ...advance(ctx.s.state, decision, json.assessment), rescueTarget: decision.move === 'rescue_probe' ? ctx.rescue?.id ?? null : ctx.s.state.rescueTarget }
      const outcome = evidenceOutcome(json.assessment)
      // 5. persist turn, state and evidence atomically
      await tx(principal, async (t) => {
        await t.query(`insert into education_tutor.turns (tenant_id, user_id, session_id, role, content) values (platform.current_tenant(), $1, $2, 'student', $3)`, [principal.userId, params.sessionId, message])
        await t.query(`insert into education_tutor.turns (tenant_id, user_id, session_id, role, content, segments, move, hint_level, operation_id) values (platform.current_tenant(), $1, $2, 'tutor', $3, $4, $5, $6, $7)`,
          [principal.userId, params.sessionId, segments.map((s) => s.text).join('\n\n'), JSON.stringify(segments), decision.move, decision.hintLevel, out.operationId])
        await t.query('update education_tutor.sessions set state = $2 where id = $1', [params.sessionId, JSON.stringify(nextState)])
        if (outcome !== null && ctx.s.concept_id) {
          await t.query(`insert into education_tutor.evidence (tenant_id, user_id, concept_id, kind, outcome, hints_used, source_ref) values (platform.current_tenant(), $1, $2, 'check', $3, $4, $5)`,
            [principal.userId, ctx.s.concept_id, outcome, decision.hintLevel, `session:${params.sessionId}`])
        }
      })
      return { move: decision.move, hintLevel: decision.hintLevel, policyNote: decision.policyNote ?? null, segments, relabelled, checkQuestion: json.checkQuestion ?? null, assessment: json.assessment }
    } },
  ]
}

export const manifest: ModuleManifest = {
  id: ID,
  vertical: 'education',
  version: '0.1.0',
  owner: 'education-product-team',
  description: 'AI Personal Tutor: courses, Socratic tutoring, learner profile, practice, spaced revision, planner',
  db: { schema: 'education_tutor', migrationsDir: fileURLToPath(new URL('../db/migrations', import.meta.url)) },
  permissions: [
    { key: P.read, description: 'See enrolled courses and their concepts', roles: ['student', 'educator', 'tenant_admin'] },
    { key: P.manage, description: 'Create courses, concepts, items; enrol students', roles: ['educator', 'tenant_admin'] },
    { key: P.study, description: 'Use the tutor, practice, revision and planner (own data only)', roles: ['student', 'educator'] },
  ],
  routes,
  ui: {
    routes: [
      { path: '/app/education/tutor', title: 'Tutor', permission: P.read },
      { path: '/app/education/tutor/courses/:courseId', title: 'Course', permission: P.read },
    ],
    nav: [{ label: 'Tutor', path: '/app/education/tutor', permission: P.read }],
  },
  ai: { tasks: TASKS },
  data: {
    stores: [
      { kind: 'schema', name: 'education_tutor', onRemove: 'export_then_drop', description: 'courses, concepts, items, attempts, evidence, cards, goals, plans, sessions, turns' },
      { kind: 'audit_events', name: 'education.tutor.*', onRemove: 'retain_platform_policy', description: 'audit trail (ids only)' },
      { kind: 'ai_operations', name: 'education.tutor', onRemove: 'retain_platform_policy', description: 'AI metering' },
    ],
  },
  evals: { suites: ['tutor/socratic'] },
}
