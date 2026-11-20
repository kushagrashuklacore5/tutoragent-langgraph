/**
 * The companion's tools: thin, validated wrappers over existing domain services (course graph, learner model,
 * coach, planner, retrieval, FSRS cards, assessments). Every tool runs as the student inside the RLS transaction
 * and re-checks course enrolment; none reads another user's data or bypasses domain authorisation.
 */
import { randomUUID } from 'node:crypto'
import { badRequest, notFound } from '@platform/core'
import type { Sql } from '@platform/tenancy-db'
import { estimate } from '../domain/learner-model.ts'
import type { PlanConcept } from '../domain/planner.ts'
import { coachFor } from '../coach.ts'
import { courseGraph, evidenceFor, requireEnrolled } from '../common.ts'
import { courseScope } from '../materials.ts'
import { missedMinutes } from '../plans.ts'
import type { Plan } from '../domain/planner.ts'
import { buildRoadmap } from './roadmap.ts'
import { loadProfile, type Proposal } from './store.ts'
import { studioService } from '../studio/service.ts'
import { growthService } from '../growth/service.ts'
import { analysePatterns } from '../domain/exam.ts'
import { chooseStrategy } from '../domain/strategy.ts'
import { ToolRegistry, type ToolContext } from './tools.ts'
import { createPersonalCourse } from '../courses/personal.ts'
import { UUID_PATTERN, type Schema } from './schema.ts'

const courseArg: Schema = { type: 'string', pattern: UUID_PATTERN, description: 'course id' }
const conceptArg: Schema = { type: 'string', pattern: UUID_PATTERN, description: 'concept id' }
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false })
const anyObj: Schema = { type: 'object' }
/** outputs: required keys and their types; extra fields allowed */
const out = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required })
const base = (courseId: string) => `/app/education/tutor/courses/${courseId}`

export async function planConcepts(t: Sql, courseId: string, now: Date): Promise<PlanConcept[]> {
  const { concepts, edges } = await courseGraph(t, courseId)
  const ev = await evidenceFor(t, concepts.map((c) => c.id))
  return concepts.map((c) => {
    const m = estimate(ev.get(c.id)!, now)
    return { id: c.id, name: c.name, estMinutes: c.est_minutes, examWeight: Number(c.exam_weight), pMastery: m.pMastery, mastered: m.state === 'mastered', prerequisites: edges.filter((e) => e.to_concept === c.id).map((e) => e.from_concept) }
  })
}

async function conceptIn(t: Sql, courseId: string, conceptId: string | undefined): Promise<{ id: string; name: string } | null> {
  if (!conceptId) return null
  const r = (await t.query<{ id: string; name: string }>(`select id, name from education_tutor.concepts where id = $1 and course_id = $2 and status = 'approved'`, [conceptId, courseId])).rows[0]
  if (!r) throw notFound('Concept')
  return r
}

/** Build a plan proposal from the stored profile (deterministic; nothing is written). */
const words = (x: string) => x.toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').split(' ').filter((w) => w.length >= 4)
/** Course topics matching the student's chapter/topic (by shared words), plus their unmastered prerequisites. */
export function scopeToTopic(all: PlanConcept[], topic: string | undefined): { concepts: PlanConcept[]; note: string | null } {
  if (!topic || /^(the )?complete material$|^poora material$|^all$/i.test(topic.trim())) return { concepts: all, note: null }
  const want = new Set(words(topic))
  const hits = all.filter((c) => { const w = words(c.name); return w.some((x) => want.has(x) || [...want].some((y) => x.startsWith(y.slice(0, 5)))) })
  if (!hits.length) return { concepts: all, note: `I could not match "${topic}" to a topic of this course, so the plan covers the whole course.` }
  const byId = new Map(all.map((c) => [c.id, c]))
  const keep = new Set(hits.map((c) => c.id))
  // only DIRECT unmastered prerequisites, at most 2 per topic (live: an AI syllabus chained every chapter, so
  // "Trigonometry" pulled in the whole course)
  for (const h of hits) for (const pid of h.prerequisites.filter((x) => { const pc = byId.get(x); return pc && !pc.mastered && !keep.has(x) }).slice(0, 2)) keep.add(pid)
  const added = keep.size - hits.length
  return { concepts: all.filter((c) => keep.has(c.id)), note: `Focused on "${topic}": ${hits.length} topic(s)${added ? ` plus ${added} prerequisite(s) you will need` : ''}.` }
}

export async function proposePlan(ctx: ToolContext, courseId: string): Promise<Proposal> {
  const course = await requireEnrolled(ctx.t, ctx.p, courseId)
  if (course.role !== 'student') throw badRequest('not_a_student', 'Study plans are for students of this course')
  const profile = (await loadProfile(ctx.d, ctx.p, ctx.t)) ?? {}
  // a class preview needs no daily budget; everything else plans against the student's real time
  const dailyMinutes = profile.dailyMinutes ?? (profile.objective === 'class_prep' ? 45 : null)
  if (!dailyMinutes) throw badRequest('profile_incomplete', 'Daily study time is not known yet')
  const examDate = profile.examDate && profile.examDate !== 'none' ? profile.examDate : null
  const all = await planConcepts(ctx.t, courseId, ctx.now)
  if (!all.length) throw badRequest('no_concepts', 'This course has no approved topics yet')
  // scope to the chapter/topic the student asked for, plus the prerequisites it needs
  const scoped = scopeToTopic(all, profile.topic)
  const preview = profile.objective === 'class_prep' && profile.depth !== 'deep'
  const concepts = preview ? scoped.concepts.map((c) => ({ ...c, estMinutes: Math.max(10, Math.round(c.estMinutes * 0.35)) })) : scoped.concepts
  const due = (await ctx.t.query<{ n: number }>(`select count(*)::int as n from education_tutor.cards where course_id = $1 and user_id = platform.current_user_id() and due_at < now() + interval '7 days'`, [courseId])).rows[0]!.n
  const studyDaysPerWeek = profile.studyDaysPerWeek ?? 6
  // past-paper evidence (when there is any) raises the weight of frequently examined topics; priorities stay estimates
  const { papers, questions } = await growthService(ctx.d).papersAndQuestions(ctx.p, ctx.t, courseId)
  const ready = papers.filter((x) => x.status === 'ready')
  const patterns = analysePatterns({ topics: concepts.map((c) => ({ id: c.id, name: c.name, examWeight: c.examWeight, pMastery: c.pMastery })), papers: ready, questions })
  const weighted = ready.length ? concepts.map((c) => ({ ...c, examWeight: c.examWeight * (1 + (patterns.topics.find((x) => x.conceptId === c.id)?.priority ?? 0)) })) : concepts
  const daysToExam = examDate ? Math.ceil((Date.parse(`${examDate}T00:00:00Z`) - ctx.now.getTime()) / 86_400_000) : null
  const strategy = chooseStrategy({ objective: profile.objective, daysToExam })
  const roadmap = buildRoadmap({ today: ctx.now, examAt: examDate ? new Date(`${examDate}T00:00:00Z`) : null, dailyMinutes, studyDaysPerWeek, concepts: weighted, reviewMinutesPerDay: Math.ceil((due * 1.5) / 7), diagnosticFirst: strategy.name === 'exam_sprint' || strategy.name === 'exam_prep' })
  if (scoped.note) roadmap.rationale.unshift(scoped.note)
  roadmap.rationale.unshift(profile.material === 'own'
    ? 'Your uploaded material is the source: lessons follow it, and its own worked examples and exercises become your practice set (checked extra questions only fill gaps). The set is built once, right after you approve.'
    : profile.material === 'curriculum'
      ? 'Source: your course syllabus (NCERT/board). A practice set for every topic is built once, right after you approve; every answer is checked.'
      : 'Source: notes prepared for you, within your class and syllabus. A practice set for every topic is built once, right after you approve; every answer is checked.')
  if (preview) roadmap.rationale.unshift('Class preview: the key ideas, words and prerequisites only, so the next lesson is easy to follow.')
  roadmap.rationale.unshift(`Strategy: ${strategy.label} (${strategy.reasons.join('; ')}).`, ready.length ? `Topic priorities use ${ready.length} past/sample paper(s) you or your educator added (frequencies are counted, not guaranteed).` : 'No past papers added yet: priorities use the syllabus weights. Add papers in Exam insights to sharpen them.')
  return { id: randomUUID(), courseId, courseTitle: course.title, createdAt: ctx.now.toISOString(), inputs: { examDate, dailyMinutes, studyDaysPerWeek }, roadmap, strategy: { name: strategy.name, label: strategy.label, mix: strategy.mix }, examEvidence: { papers: ready.length, top: patterns.topics.slice(0, 5).map((x) => ({ name: x.name, priority: x.priority, verified: x.verified, confidence: x.confidence })) } }
}

/** Apply an approved proposal atomically: goal, plan version, milestone/checkpoint tasks (previous open ones cancelled). */
export async function applyProposal(ctx: ToolContext, pr: Proposal): Promise<{ version: number; milestones: number; checkpoints: number }> {
  await requireEnrolled(ctx.t, ctx.p, pr.courseId)
  const t = ctx.t
  await t.query(`insert into education_tutor.goals (tenant_id, user_id, course_id, exam_at, daily_minutes) values (platform.current_tenant(), platform.current_user_id(), $1, $2, $3)
    on conflict (user_id, course_id) do update set exam_at = excluded.exam_at, daily_minutes = excluded.daily_minutes`, [pr.courseId, pr.inputs.examDate, Math.min(600, Math.max(10, pr.roadmap.effectiveDailyMinutes))])
  const v = (await t.query<{ v: number }>('select coalesce(max(version), 0)::int + 1 as v from education_tutor.plans where course_id = $1 and user_id = platform.current_user_id()', [pr.courseId])).rows[0]!.v
  const plan: Plan = { ...pr.roadmap.plan, rationale: ['Approved by you in the study companion.', ...pr.roadmap.plan.rationale] }
  await t.query(`insert into education_tutor.plans (tenant_id, user_id, course_id, version, plan, trigger) values (platform.current_tenant(), platform.current_user_id(), $1, $2, $3, 'agent')`, [pr.courseId, v, JSON.stringify(plan)])
  await t.query(`update education_tutor.agent_tasks set status = 'cancelled' where course_id = $1 and status = 'pending'`, [pr.courseId])
  for (const [kind, list] of [['milestone', pr.roadmap.milestones], ['checkpoint', pr.roadmap.checkpoints]] as const) {
    for (const m of list) {
      await t.query(`insert into education_tutor.agent_tasks (tenant_id, user_id, course_id, plan_version, kind, seq, title, concept_ids, due_on)
        values (platform.current_tenant(), platform.current_user_id(), $1, $2, $3, $4, $5, $6, $7)`, [pr.courseId, v, kind, m.seq, m.title.slice(0, 300), m.conceptIds, m.due])
    }
  }
  return { version: v, milestones: pr.roadmap.milestones.length, checkpoints: pr.roadmap.checkpoints.length }
}

export function companionTools(): ToolRegistry {
  const r = new ToolRegistry()
  r.register({
    name: 'curriculum.syllabus', capability: 'curriculum', effect: 'read', approval: 'none', modelCallable: true,
    description: 'Topics of a course with prerequisites, estimated hours, exam weight, the student\'s current mastery, and the course materials available',
    input: obj({ courseId: courseArg }, ['courseId']), output: out({ course: anyObj, topics: { type: 'array' }, materials: { type: 'array' } }, ['course', 'topics', 'materials']),
    async run(ctx, a: { courseId: string }) {
      const c = await requireEnrolled(ctx.t, ctx.p, a.courseId)
      const pc = await planConcepts(ctx.t, a.courseId, ctx.now)
      const name = new Map(pc.map((x) => [x.id, x.name]))
      const docs = ctx.d.documents ? (await ctx.d.documents.list(ctx.p, courseScope(a.courseId))).filter((x) => x.status === 'ready').slice(0, 20) : []
      return {
        course: { id: a.courseId, title: c.title },
        topics: pc.map((x) => ({ id: x.id, name: x.name, hours: Math.round(x.estMinutes / 6) / 10, examWeight: x.examWeight, mastery: Math.round(x.pMastery * 100) / 100, mastered: x.mastered, prerequisites: x.prerequisites.map((p) => name.get(p) ?? p) })),
        materials: docs.map((d) => d.filename),
      }
    },
  })
  r.register({
    name: 'materials.search', capability: 'resources', effect: 'read', approval: 'none', modelCallable: true, timeoutMs: 12000,
    description: 'Find where a topic is covered in the course\'s approved materials and the student\'s notes (returns document and page pointers)',
    input: obj({ courseId: courseArg, query: { type: 'string', minLength: 2, maxLength: 300 } }, ['courseId', 'query']), output: out({ sources: { type: 'array' }, available: { type: 'boolean' } }, ['sources', 'available']),
    async run(ctx, a: { courseId: string; query: string }) {
      await requireEnrolled(ctx.t, ctx.p, a.courseId)
      if (!ctx.d.retrieval) return { sources: [], available: false }
      const res = await ctx.d.retrieval.search(ctx.p, { scopes: [courseScope(a.courseId)], query: a.query, topK: 5 })
      return {
        available: true,
        sources: res.hits.map((h) => ({ filename: h.filename, pages: h.pageStart === h.pageEnd ? `p. ${h.pageStart}` : `pp. ${h.pageStart}-${h.pageEnd}`, trust: h.trust, href: `${base(a.courseId)}/materials/${h.documentId}/${h.pageStart}`, excerpt: h.text.slice(0, 280) })),
      }
    },
  })
  r.register({
    name: 'mastery.analyse', capability: 'progress', effect: 'read', approval: 'none', modelCallable: true,
    description: 'The student\'s mastery per topic, weak topics, recurring misconceptions, confident mistakes and the recommended next step',
    input: obj({ courseId: courseArg }, ['courseId']), output: out({ next: anyObj, weak: { type: 'array' }, misconceptions: { type: 'array' }, dueCards: { type: 'integer' } }, ['next', 'weak', 'misconceptions', 'dueCards']),
    async run(ctx, a: { courseId: string }) {
      await requireEnrolled(ctx.t, ctx.p, a.courseId)
      const c = await coachFor(ctx.t, a.courseId, ctx.now)
      return {
        next: c.next, dueCards: c.dueCards, examAt: c.examAt,
        weak: c.profile.filter((x) => x.mastery.state !== 'mastered' && x.mastery.evidenceCount > 0).sort((x, y) => x.mastery.pMastery - y.mastery.pMastery).slice(0, 5).map((x) => ({ conceptId: x.conceptId, name: x.name, mastery: x.mastery.pMastery, state: x.mastery.state })),
        misconceptions: c.profile.flatMap((x) => x.recurringMisconceptions.map((m) => ({ concept: x.name, misconception: m }))).slice(0, 5),
      }
    },
  })
  r.register({
    name: 'plan.propose', capability: 'strategy', effect: 'read', approval: 'none', modelCallable: true,
    description: 'Draft a study roadmap (milestones, checkpoints, weekly load, feasibility) from the student\'s goal, deadline and available time; the student must approve it before anything changes',
    input: obj({ courseId: courseArg }, ['courseId']), output: out({ id: { type: 'string' }, roadmap: anyObj }, ['id', 'roadmap']),
    run: (ctx, a: { courseId: string }) => proposePlan(ctx, a.courseId),
  })
  r.register({
    name: 'plan.apply', capability: 'strategy', effect: 'write', approval: 'required', modelCallable: false,
    description: 'Save an approved roadmap as the active study plan and schedule its milestones and checkpoints',
    input: obj({ proposal: anyObj }, ['proposal']), output: out({ version: { type: 'integer' } }, ['version']),
    idempotencyKey: (a: { proposal: Proposal }) => `plan.apply:${a.proposal.id}`,
    run: (ctx, a: { proposal: Proposal }) => applyProposal(ctx, a.proposal),
  })
  r.register({
    name: 'lesson.start', capability: 'teaching', effect: 'read', approval: 'none', modelCallable: true,
    description: 'Open a guided (Socratic, source-grounded) tutoring session on a topic; use this for explanations instead of teaching in the chat',
    input: obj({ courseId: courseArg, conceptId: conceptArg }, ['courseId']), output: out({ href: { type: 'string' }, label: { type: 'string' } }, ['href', 'label']),
    async run(ctx, a: { courseId: string; conceptId?: string }) {
      await requireEnrolled(ctx.t, ctx.p, a.courseId)
      const c = await conceptIn(ctx.t, a.courseId, a.conceptId)
      return { href: `${base(a.courseId)}/tutor${c ? `?conceptId=${c.id}` : ''}`, label: c ? `Guided lesson: ${c.name}` : 'Open the tutor', conceptName: c?.name ?? null }
    },
  })
  r.register({
    name: 'practice.start', capability: 'assessment', effect: 'read', approval: 'none', modelCallable: true,
    description: 'Adaptive practice questions on a topic (or the weakest topic), marked automatically',
    input: obj({ courseId: courseArg, conceptId: conceptArg }, ['courseId']), output: out({ href: { type: 'string' }, label: { type: 'string' }, available: { type: 'integer' } }, ['href', 'label', 'available']),
    async run(ctx, a: { courseId: string; conceptId?: string }) {
      await requireEnrolled(ctx.t, ctx.p, a.courseId)
      const c = await conceptIn(ctx.t, a.courseId, a.conceptId)
      const n = (await ctx.t.query<{ n: number }>(`select count(*)::int as n from education_tutor.items where course_id = $1 and ($2::uuid is null or concept_id = $2) and status = 'approved' and retired_at is null and type in ('mcq', 'numeric', 'expression')`, [a.courseId, c?.id ?? null])).rows[0]!.n
      return { href: `/practice/${a.courseId}${c ? `?conceptId=${c.id}` : ''}`, label: c ? `Practise: ${c.name}` : 'Practise your weakest topic', available: n }
    },
  })
  r.register({
    name: 'assessments.list', capability: 'assessment', effect: 'read', approval: 'none', modelCallable: true,
    description: 'Published tests and checkpoints the student can take in a course, with attempts used',
    input: obj({ courseId: courseArg }, ['courseId']), output: out({ assessments: { type: 'array' } }, ['assessments']),
    async run(ctx, a: { courseId: string }) {
      await requireEnrolled(ctx.t, ctx.p, a.courseId)
      const rows = (await ctx.t.query<{ id: string; title: string; mode: string; time_limit_minutes: number | null; max_attempts: number | null; used: number }>(
        `select a.id, a.title, a.mode, a.time_limit_minutes, a.max_attempts, (select count(*)::int from education_tutor.assessment_attempts x where x.assessment_id = a.id and x.user_id = platform.current_user_id()) as used
           from education_tutor.assessments a where a.course_id = $1 and a.status = 'published' order by a.created_at desc limit 10`, [a.courseId])).rows
      return { assessments: rows.map((x) => ({ title: x.title, mode: x.mode, minutes: x.time_limit_minutes, attemptsLeft: x.max_attempts === null ? null : Math.max(0, x.max_attempts - x.used), href: `${base(a.courseId)}/assessments` })) }
    },
  })
  r.register({
    name: 'revision.status', capability: 'revision', effect: 'read', approval: 'none', modelCallable: true,
    description: 'Spaced-revision (FSRS) cards due now and in the next 7 days',
    input: obj({ courseId: courseArg }, ['courseId']), output: out({ dueNow: { type: 'integer' }, dueWeek: { type: 'integer' }, href: { type: 'string' } }, ['dueNow', 'dueWeek', 'href']),
    async run(ctx, a: { courseId: string }) {
      await requireEnrolled(ctx.t, ctx.p, a.courseId)
      const r2 = (await ctx.t.query<{ now: number; week: number }>(`select count(*) filter (where due_at <= now())::int as now, count(*) filter (where due_at <= now() + interval '7 days')::int as week from education_tutor.cards where course_id = $1 and user_id = platform.current_user_id()`, [a.courseId])).rows[0]!
      return { dueNow: r2.now, dueWeek: r2.week, href: `${base(a.courseId)}/revision`, label: r2.now ? `Revise ${r2.now} due card(s)` : 'Open revision' }
    },
  })
  r.register({
    name: 'progress.summary', capability: 'progress', effect: 'read', approval: 'none', modelCallable: true,
    description: 'Plan progress: milestones done/open/missed, missed planned minutes and the next milestone',
    input: obj({ courseId: courseArg }, ['courseId']), output: out({ hasPlan: { type: 'boolean' }, milestones: anyObj }, ['hasPlan', 'milestones']),
    async run(ctx, a: { courseId: string }) {
      await requireEnrolled(ctx.t, ctx.p, a.courseId)
      const latest = (await ctx.t.query<{ plan: Plan; created_at: Date; version: number }>(`select plan, created_at, version from education_tutor.plans where course_id = $1 and user_id = platform.current_user_id() order by version desc limit 1`, [a.courseId])).rows[0]
      const tasks = (await ctx.t.query<{ title: string; status: string; due_on: Date; kind: string }>(`select title, status, due_on, kind from education_tutor.agent_tasks where course_id = $1 and status <> 'cancelled' order by due_on, seq`, [a.courseId])).rows
      const ms = tasks.filter((x) => x.kind === 'milestone')
      const next = ms.find((x) => x.status === 'pending')
      return {
        hasPlan: !!latest, planVersion: latest?.version ?? null,
        missedMinutes: latest ? await missedMinutes(ctx.t, latest.plan, latest.created_at, ctx.now) : 0,
        milestones: { done: ms.filter((x) => x.status === 'done').length, open: ms.filter((x) => x.status === 'pending').length, missed: ms.filter((x) => x.status === 'missed').length, next: next ? { title: next.title, due: next.due_on.toISOString().slice(0, 10) } : null },
      }
    },
  })
  r.register({
    name: 'studio.open', capability: 'teaching', effect: 'write', approval: 'none', modelCallable: true, timeoutMs: 30000,
    description: 'Create an interactive study book for a chapter (from the student\'s uploaded document if given, otherwise generated from the course topics) and open it',
    input: obj({ courseId: courseArg, title: { type: 'string', minLength: 2, maxLength: 160, description: 'chapter or topic' }, documentId: { type: 'string', pattern: UUID_PATTERN } }, ['courseId', 'title']),
    output: out({ bookId: { type: 'string' }, href: { type: 'string' }, label: { type: 'string' } }, ['bookId', 'href', 'label']),
    idempotencyKey: (a: { courseId: string; title: string }, ctx) => `studio.open:${ctx.conversationId}:${a.courseId}:${a.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    async run(ctx, a: { courseId: string; title: string; documentId?: string }) {
      await requireEnrolled(ctx.t, ctx.p, a.courseId)
      const profile = await loadProfile(ctx.d, ctx.p, ctx.t)
      const b = await studioService(ctx.d).create(ctx.p, { courseId: a.courseId, title: a.title, documentId: a.documentId, language: profile?.language ?? 'en' })
      return { bookId: b.id, href: `/studio/${b.id}`, label: `Open the book: ${a.title}`, sections: b.sections }
    },
  })
  r.register({
    name: 'exam.insights', capability: 'curriculum', effect: 'read', approval: 'none', modelCallable: true, timeoutMs: 12000,
    description: 'Exam intelligence from past/sample/school papers added to the course: topic frequency (verified counts), trends, priorities (estimates) and example past questions with sources; says when no papers exist',
    input: obj({ courseId: courseArg, scope: { type: 'string', enum: ['all', 'board', 'school'] } }, ['courseId']), output: out({ topics: { type: 'array' }, note: { type: 'string' } }, ['topics', 'note']),
    async run(ctx, a: { courseId: string; scope?: 'all' | 'board' | 'school' }) {
      const r2 = await growthService(ctx.d).insights(ctx.p, a.courseId, a.scope ?? 'all')
      return { papers: r2.papers.map((x) => ({ title: x.title, kind: x.kind, year: x.year, status: x.status })), topics: r2.topics.slice(0, 8).map((x) => ({ name: x.name, verified: x.verified, priority: x.priority, confidence: x.confidence, trend: x.trend, reasons: x.reasons })), note: r2.note, href: `${base(a.courseId)}/exam` }
    },
  })
  r.register({
    name: 'assessment.self_test', capability: 'assessment', effect: 'write', approval: 'none', modelCallable: true, timeoutMs: 15000,
    description: 'Create a test for the student from the approved question bank: diagnostic (starting point), practice, pattern_practice (past-paper patterns), mock (full timed), post (after-learning check)',
    input: obj({ courseId: courseArg, purpose: { type: 'string', enum: ['diagnostic', 'practice', 'pattern_practice', 'mock', 'post'] } }, ['courseId', 'purpose']),
    output: out({ assessmentId: { type: 'string' }, href: { type: 'string' }, label: { type: 'string' } }, ['assessmentId', 'href', 'label']),
    idempotencyKey: (a: { courseId: string; purpose: string }, ctx) => `self_test:${ctx.conversationId}:${a.courseId}:${a.purpose}:${ctx.now.toISOString().slice(0, 10)}`,
    async run(ctx, a: { courseId: string; purpose: 'diagnostic' | 'practice' | 'pattern_practice' | 'mock' | 'post' }) {
      const t = await growthService(ctx.d).selfTest(ctx.p, a.courseId, { purpose: a.purpose })
      return { assessmentId: t.assessmentId, href: t.href, label: `${t.title}: ${t.questions} questions${t.minutes ? `, ${t.minutes} min` : ''}`, sections: t.sections }
    },
  })
  r.register({
    name: 'learning.observe', capability: 'progress', effect: 'read', approval: 'none', modelCallable: true,
    description: 'Current teaching strategy, evidence-based findings (missing prerequisite, guessing, memorising without understanding, ready to progress, explanations not landing) with confidence, and recommended adjustments',
    input: obj({ courseId: courseArg }, ['courseId']), output: out({ strategy: anyObj, findings: { type: 'array' } }, ['strategy', 'findings']),
    async run(ctx, a: { courseId: string }) {
      const o = await growthService(ctx.d).observation(ctx.p, a.courseId)
      return { strategy: { label: o.strategy.label, mix: o.strategy.mix, reasons: o.strategy.reasons }, findings: o.findings.slice(0, 6), adjustments: o.adjustments, note: o.note }
    },
  })
  r.register({
    name: 'growth.summary', capability: 'progress', effect: 'read', approval: 'none', modelCallable: true,
    description: 'Progress and improvement: topic levels, XP, streak (rest days allowed), badges, personal bests, and before/after outcome measures with sample sizes',
    input: obj({ courseId: courseArg }, ['courseId']), output: out({ xp: { type: 'integer' }, levels: { type: 'array' } }, ['xp', 'levels']),
    async run(ctx, a: { courseId: string }) {
      const g = await growthService(ctx.d).growth(ctx.p, a.courseId)
      return { xp: g.xp, levels: g.levels.map((l) => ({ topic: l.name, level: l.label })), streak: g.streak, badges: g.badges.map((b) => b.title), personalBests: g.personalBests.slice(0, 5).map((b) => ({ title: b.title, best: b.best, latest: b.latest })), outcomes: g.outcomes, href: '/growth', label: 'Your progress' }
    },
  })
  r.register({
    name: 'package.build', capability: 'revision', effect: 'write', approval: 'none', modelCallable: true, timeoutMs: 30000,
    description: 'Assemble the chapter learning package for a Studio book: notes, formula sheet, diagrams, memory tricks, solved examples, common mistakes, past questions with sources, flashcards (added to revision), last-day sheet, mock test, mastery report',
    input: obj({ bookId: { type: 'string', pattern: UUID_PATTERN } }, ['bookId']), output: out({ version: { type: 'integer' }, href: { type: 'string' }, label: { type: 'string' } }, ['version', 'href', 'label']),
    idempotencyKey: (a: { bookId: string }, ctx) => `package:${a.bookId}:${ctx.now.toISOString().slice(0, 13)}`,
    async run(ctx, a: { bookId: string }) {
      const p = await growthService(ctx.d).buildPackage(ctx.p, a.bookId)
      return { version: p.version, href: `/studio/${a.bookId}/package`, label: 'Open your chapter package', newFlashcards: p.newFlashcards, mockTest: !!p.package.mockTestId }
    },
  })
  r.register({
    name: 'plan.show', capability: 'strategy', effect: 'read', approval: 'none', modelCallable: true,
    description: 'Open the current study plan of the student (what is next, milestones, what was missed)',
    input: obj({ courseId: courseArg }, ['courseId']), output: out({ href: { type: 'string' }, label: { type: 'string' } }, ['href', 'label']),
    async run(ctx, a: { courseId: string }) {
      await requireEnrolled(ctx.t, ctx.p, a.courseId)
      const has = (await ctx.t.query('select 1 from education_tutor.plans where course_id = $1 and user_id = platform.current_user_id() limit 1', [a.courseId])).rowCount
      return { href: `${base(a.courseId)}/plan`, label: has ? 'Your study plan' : 'Study plan (not made yet)', hasPlan: !!has }
    },
  })
  r.register({
    name: 'materials.open', capability: 'resources', effect: 'read', approval: 'none', modelCallable: true,
    description: 'Open the material workspace where the student uploads their own NCERT chapter, notes, PDF or photos (then it is used for teaching)',
    input: obj({ courseId: courseArg }, ['courseId']), output: out({ href: { type: 'string' }, label: { type: 'string' } }, ['href', 'label']),
    async run(ctx, a: { courseId: string }) {
      await requireEnrolled(ctx.t, ctx.p, a.courseId)
      return { href: `${base(a.courseId)}/materials`, label: 'Upload your material' }
    },
  })
  r.register({
    name: 'course.create', capability: 'curriculum', effect: 'write', approval: 'none', modelCallable: true,
    description: 'Create a complete self-study course (structured syllabus of topics) for ANY subject or skill the student wants that is not one of their courses (e.g. Geography class 9, Excel, guitar basics). Use it instead of saying the subject is unavailable.',
    input: obj({ subject: { type: 'string', minLength: 2, maxLength: 160 }, level: { type: 'string', maxLength: 60 } }, ['subject']),
    output: out({ courseId: { type: 'string' }, title: { type: 'string' }, topics: { type: 'array' }, href: { type: 'string' }, label: { type: 'string' } }, ['courseId', 'title']),
    idempotencyKey: (a: { subject: string }, ctx) => `course.create:${ctx.conversationId}:${a.subject.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    timeoutMs: 45000,
    async run(ctx, a: { subject: string; level?: string }) {
      const profile = (await loadProfile(ctx.d, ctx.p, ctx.t)) ?? {}
      const c = await createPersonalCourse(ctx.d, ctx.p, { subject: a.subject, level: a.level ?? profile.level, goal: profile.objective, language: profile.language, chapter: profile.topic })
      return { ...c, topics: c.topics.slice(0, 16), href: base(c.courseId), label: `Your course: ${c.title}` }
    },
  })
  return r
}
