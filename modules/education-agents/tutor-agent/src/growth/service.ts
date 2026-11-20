/**
 * Strategic learning services (Stage 3), all built on existing systems:
 *   self-tests      student-created assessments on the assessment engine (same assembly, marking, evidence rules)
 *   exam intel      past/sample/school papers from the existing document pipeline; questions extracted by the model,
 *                   counted deterministically (domain/exam.ts) with provenance and confidence
 *   hint ladder     6 graduated hints; levels 1-5 from the model with a leak check, level 6 from the stored explanation
 *   observation     strategy + findings + adjustments (domain/strategy.ts) from the student's own evidence
 *   growth          XP/levels/streaks/badges/personal bests + outcomes (domain/growth.ts); opt-in board via SQL function
 *   package         chapter package from the taught book + notebook + weaknesses + past questions (domain/package.ts)
 */
import { randomUUID } from 'node:crypto'
import { AppError, badRequest, notFound } from '@platform/core'
import type { ModuleDeps, Principal } from '@platform/contracts'
import type { Sql } from '@platform/tenancy-db'
import { courseGraph, evidenceFor, requireEnrolled } from '../common.ts'
import { coachFor } from '../coach.ts'
import { courseScope } from '../materials.ts'
import { answerText } from '../diagnosis.ts'
import { estimate } from '../domain/learner-model.ts'
import type { AnswerSpec } from '../domain/scoring.ts'
import { analysePatterns, compareSchoolBoard, practiceBlueprint, type PaperFact, type QuestionFact, type SourceKind } from '../domain/exam.ts'
import { adapt, chooseStrategy, observe, type ObservationInput } from '../domain/strategy.ts'
import { computeGrowth, leaderboard, LEVELS, levelOf, outcomes, type LearningEvent } from '../domain/growth.ts'
import { assemblePackage, type PkgBlock, type PkgTopic } from '../domain/package.ts'
import { loadProfile } from '../agent/store.ts'
import { buildExtractPrompt, buildHintPrompt, EXTRACT_TASK, FEATURES, GROWTH_PROMPT_VERSION, HINT_TASK, QTYPES } from './prompts.ts'

export const EXTRACT_JOB = 'exam.extract'
export type Purpose = 'diagnostic' | 'practice' | 'mock' | 'post' | 'pattern_practice'
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const DAY = 86_400_000

export function growthService(d: ModuleDeps) {
  const tx = <T>(p: Principal, fn: (t: Sql) => Promise<T>) => d.inTenant(p, fn)
  const crypto = () => { if (!d.crypto) throw new AppError('crypto_unavailable', 'Encryption at rest is not configured on this server', { status: 503 }); return d.crypto }

  // ── exam intelligence ──
  async function papersAndQuestions(p: Principal, t: Sql, courseId: string): Promise<{ papers: (PaperFact & { status: string; questions: number; mine: boolean; documentId: string })[]; questions: (QuestionFact & { id: string; text_enc: string; number: string; page: number | null })[] }> {
    const papers = (await t.query<{ id: string; title: string; source_kind: SourceKind; year: number | null; school: string | null; status: string; questions: number; owner_user_id: string | null; document_id: string }>(
      'select id, title, source_kind, year, school, status, questions, owner_user_id, document_id from education_tutor.exam_papers where course_id = $1 order by year desc nulls last, created_at', [courseId])).rows
    const questions = (await t.query<{ id: string; paper_id: string; concept_id: string | null; marks: string | null; qtype: string; features: string[]; text_enc: string; number: string; page: number | null }>(
      'select id, paper_id, concept_id, marks, qtype, features, text_enc, number, page from education_tutor.exam_questions where course_id = $1', [courseId])).rows
    return {
      papers: papers.map((x) => ({ id: x.id, title: x.title, kind: x.source_kind, year: x.year, school: x.school, status: x.status, questions: x.questions, mine: x.owner_user_id === p.userId, documentId: x.document_id })),
      questions: questions.map((q) => ({ id: q.id, paperId: q.paper_id, conceptId: q.concept_id, marks: q.marks === null ? null : Number(q.marks), qtype: q.qtype, features: q.features, text_enc: q.text_enc, number: q.number, page: q.page })),
    }
  }

  async function topicFacts(t: Sql, courseId: string) {
    const { concepts, edges } = await courseGraph(t, courseId)
    const ev = await evidenceFor(t, concepts.map((c) => c.id))
    return concepts.map((c) => {
      const m = estimate(ev.get(c.id)!)
      return { id: c.id, name: c.name, examWeight: Number(c.exam_weight), pMastery: m.pMastery, state: m.state, evidenceCount: m.evidenceCount, prerequisites: edges.filter((e) => e.to_concept === c.id).map((e) => e.from_concept) }
    })
  }

  async function addPaper(p: Principal, courseId: string, b: { documentId: string; sourceKind: SourceKind; title: string; year: number | null; board: string | null; school: string | null }) {
    if (!d.documents) throw new AppError('documents_unavailable', 'Document storage is not configured', { status: 503 })
    const doc = await d.documents.get(p, b.documentId)
    if (doc.scope !== courseScope(courseId)) throw badRequest('document_not_in_course', 'That document belongs to another course')
    if (doc.status !== 'ready') throw new AppError('document_not_ready', 'The paper is still being processed', { status: 409 })
    return tx(p, async (t) => {
      const e = await requireEnrolled(t, p, courseId)
      const shared = e.role === 'educator'
      const id = (await t.query<{ id: string }>(`insert into education_tutor.exam_papers (tenant_id, course_id, owner_user_id, added_by, document_id, source_kind, board, school, year, title)
        values (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (course_id, document_id) do update set title = excluded.title returning id`,
      [courseId, shared ? null : p.userId, p.userId, b.documentId, b.sourceKind, b.board, b.school, b.year, b.title])).rows[0]!.id
      await d.enqueue(t, EXTRACT_JOB, { paperId: id, userId: p.userId }, { idempotencyKey: `extract:${id}:${doc.version}`, maxAttempts: 4 })
      await d.audit(t, p, { action: 'exam.paper_added', targetType: 'exam_paper', targetId: id, metadata: { kind: b.sourceKind, shared } })
      return { paperId: id, shared }
    })
  }

  /** Job: extract questions (as the user who added the paper). Idempotent: replaces the paper's questions. */
  async function extract(p: Principal, paperId: string) {
    const paper = await tx(p, async (t) => {
      const r = (await t.query<{ id: string; course_id: string; document_id: string; owner_user_id: string | null }>('select id, course_id, document_id, owner_user_id from education_tutor.exam_papers where id = $1', [paperId])).rows[0]
      if (!r) return null
      await t.query(`update education_tutor.exam_papers set status = 'extracting', error = null where id = $1`, [paperId])
      return { ...r, topics: (await courseGraph(t, r.course_id)).concepts }
    })
    if (!paper || !d.documents) return { skipped: true }
    const doc = await d.documents.get(p, paper.document_id)
    const pages: { page: number; text: string }[] = []
    for (let n = 1; n <= Math.min(doc.page_count ?? 1, 24); n++) {
      try { pages.push({ page: n, text: (await d.documents.page(p, paper.document_id, n)).text.slice(0, 4000) }) } catch { break }
    }
    const found: { number: string; text: string; marks: number | null; qtype: string; page: number | null; conceptId: string | null; features: string[] }[] = []
    for (let i = 0; i < pages.length; i += 3) {
      const chunk = pages.slice(i, i + 3)
      if (!chunk.some((x) => x.text.trim())) continue
      const r = await d.ai(p).run(EXTRACT_TASK, { messages: buildExtractPrompt({ pages: chunk, topics: paper.topics.map((c) => c.name) }) }, { promptVersion: GROWTH_PROMPT_VERSION })
      for (const q of (r.json as { questions: Record<string, unknown>[] }).questions) {
        const text = String(q.text ?? '').trim().slice(0, 1500)
        if (text.length < 3) continue
        const topic = norm(String(q.topic ?? ''))
        const concept = topic && topic !== 'other' ? paper.topics.find((c) => norm(c.name) === topic) ?? paper.topics.find((c) => topic.includes(norm(c.name)) || norm(c.name).includes(topic)) : undefined
        const marks = Number(q.marks)
        found.push({
          number: String(q.number ?? '').slice(0, 20) || String(found.length + 1), text, marks: Number.isFinite(marks) && marks >= 0 && marks <= 100 ? marks : null,
          qtype: (QTYPES as readonly string[]).includes(String(q.type)) ? String(q.type) : 'other', page: Number.isInteger(q.page) ? Number(q.page) : chunk[0]!.page,
          conceptId: concept?.id ?? null, features: Array.isArray(q.features) ? q.features.map(String).filter((f) => (FEATURES as readonly string[]).includes(f)).slice(0, 6) : [],
        })
      }
    }
    return tx(p, async (t) => {
      await t.query('delete from education_tutor.exam_questions where paper_id = $1', [paperId])
      for (const q of found) {
        const id = randomUUID()
        await t.query(`insert into education_tutor.exam_questions (id, tenant_id, paper_id, course_id, owner_user_id, concept_id, number, marks, qtype, features, page, text_enc)
          values ($1, platform.current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, paperId, paper.course_id, paper.owner_user_id, q.conceptId, q.number, q.marks, q.qtype, q.features, q.page, await crypto().encrypt(p, { table: 'exam_questions', column: 'text', recordId: id }, q.text)])
      }
      await t.query(`update education_tutor.exam_papers set status = 'ready', questions = $2 where id = $1`, [paperId, found.length])
      return { questions: found.length, matched: found.filter((q) => q.conceptId).length }
    })
  }
  const markExtractFailed = (p: Principal, paperId: string, error: string) => tx(p, (t) => t.query(`update education_tutor.exam_papers set status = 'failed', error = $2 where id = $1`, [paperId, error.slice(0, 300)]))

  async function insights(p: Principal, courseId: string, scope: 'board' | 'school' | 'all' = 'all') {
    return tx(p, async (t) => {
      await requireEnrolled(t, p, courseId)
      const topics = await topicFacts(t, courseId)
      const { papers, questions } = await papersAndQuestions(p, t, courseId)
      const ready = papers.filter((x) => x.status === 'ready')
      const a = analysePatterns({ topics, papers: ready, questions, scope })
      // a few verbatim past questions per top topic, with their source
      const byPaper = new Map(papers.map((x) => [x.id, x]))
      const examples: Record<string, { text: string; source: string; marks: number | null }[]> = {}
      for (const tp of a.topics.slice(0, 6)) {
        const qs = questions.filter((q) => q.conceptId === tp.conceptId && byPaper.get(q.paperId)?.status === 'ready').slice(0, 3)
        examples[tp.conceptId] = await Promise.all(qs.map(async (q) => {
          const pp = byPaper.get(q.paperId)!
          return { text: await crypto().decrypt(p, { table: 'exam_questions', column: 'text', recordId: q.id }, q.text_enc), source: `${pp.title}${pp.year ? ` (${pp.year})` : ''}, Q${q.number}${q.page ? `, p. ${q.page}` : ''}`, marks: q.marks }
        }))
      }
      return { papers, ...a, examples, schoolVsBoard: compareSchoolBoard({ topics, papers: ready, questions }) }
    })
  }

  // ── self-tests on the assessment engine ──
  async function selfTest(p: Principal, courseId: string, o: { purpose: Purpose; conceptIds?: string[]; count?: number }) {
    return tx(p, async (t) => {
      const e = await requireEnrolled(t, p, courseId)
      if (e.role !== 'student') throw new AppError('forbidden', 'Self-tests are for students of this course', { status: 403 })
      const topics = await topicFacts(t, courseId)
      const avail = new Map((await t.query<{ concept_id: string; n: number }>(`select concept_id, count(*)::int as n from education_tutor.items where course_id = $1 and status = 'approved' and retired_at is null group by concept_id`, [courseId])).rows.map((r) => [r.concept_id, r.n]))
      const usable = topics.filter((x) => (avail.get(x.id) ?? 0) > 0 && (!o.conceptIds?.length || o.conceptIds.includes(x.id)))
      if (!usable.length) throw new AppError('not_enough_questions', 'There are no approved questions for these topics yet. Ask your educator to add some, or practise in the Studio.', { status: 422 })
      let sections: { title: string; conceptIds: string[]; count: number; types: string[]; difficulty: string }[]
      const total = Math.max(3, Math.min(30, o.count ?? (o.purpose === 'mock' ? 15 : o.purpose === 'diagnostic' || o.purpose === 'post' ? 8 : 6)))
      if (o.purpose === 'pattern_practice' || o.purpose === 'mock') {
        const { papers, questions } = await papersAndQuestions(p, t, courseId)
        const pats = analysePatterns({ topics: usable, papers: papers.filter((x) => x.status === 'ready'), questions }).topics
        sections = practiceBlueprint(pats, total).map((b) => ({ title: b.name, conceptIds: [b.conceptId], count: Math.min(b.count, avail.get(b.conceptId)!), types: [], difficulty: o.purpose === 'mock' ? 'mixed' : 'adaptive' }))
      } else {
        // diagnostic / post: the same spread over every usable topic (so before/after compare like with like)
        const per = Math.max(1, Math.floor(total / usable.length))
        sections = usable.slice(0, 10).map((x) => ({ title: x.name, conceptIds: [x.id], count: Math.min(per, avail.get(x.id)!), types: [], difficulty: o.purpose === 'practice' ? 'adaptive' : 'mixed' }))
      }
      sections = sections.filter((s) => s.count > 0).slice(0, 10)
      const count = sections.reduce((n, s) => n + s.count, 0)
      const mode = o.purpose === 'mock' ? 'exam' : o.purpose === 'diagnostic' || o.purpose === 'post' ? 'diagnostic' : 'practice'
      const titles: Record<Purpose, string> = { diagnostic: 'Starting-point check', practice: 'Topic practice', mock: 'Full mock test', post: 'After-learning check', pattern_practice: 'Practice paper (past-paper patterns)' }
      const minutes = o.purpose === 'mock' ? Math.max(10, Math.round(count * 2)) : o.purpose === 'practice' || o.purpose === 'pattern_practice' ? null : Math.max(5, Math.round(count * 1.5))
      const id = (await t.query<{ id: string }>(`insert into education_tutor.assessments (tenant_id, course_id, title, description, mode, time_limit_minutes, settings, status, max_attempts, created_by, owner_user_id, purpose)
        values (platform.current_tenant(), $1, $2, $3, $4, $5, $6, 'published', $7, platform.current_user_id(), platform.current_user_id(), $8) returning id`,
      [courseId, `${titles[o.purpose]} · ${new Date().toISOString().slice(0, 10)}`, `${count} questions from your educator's approved question bank`, mode, minutes, JSON.stringify({ adaptive: o.purpose === 'practice' || o.purpose === 'pattern_practice', sections }), o.purpose === 'diagnostic' || o.purpose === 'post' ? 1 : null, o.purpose])).rows[0]!.id
      return { assessmentId: id, title: titles[o.purpose], questions: count, minutes, sections: sections.map((s) => ({ title: s.title, count: s.count })), href: `/app/education/tutor/courses/${courseId}/assessments` }
    })
  }

  // ── graduated hints ──
  /** `direct`: the student CHOSE the complete solution (recorded as level 6 = aided; never unaided credit) */
  async function hint(p: Principal, itemId: string, level: number, direct = false) {
    if (!Number.isInteger(level) || level < 1 || level > 6) throw badRequest('invalid_field', 'level must be 1-6')
    const ctx = await tx(p, async (t) => {
      const it = (await t.query<{ id: string; course_id: string; concept_id: string; stem: string; answer_spec: AnswerSpec; explanation: string; status: string }>('select id, course_id, concept_id, stem, answer_spec, explanation, status from education_tutor.items where id = $1', [itemId])).rows[0]
      if (!it || it.status !== 'approved') throw notFound('Item')
      await requireEnrolled(t, p, it.course_id)
      const seen = (await t.query<{ max_level: number }>('select max_level from education_tutor.hint_usage where item_id = $1', [itemId])).rows[0]?.max_level ?? 0
      const triedWrong = (await t.query('select 1 from education_tutor.attempts where item_id = $1 and outcome < 1 limit 1', [itemId])).rowCount
      return { it, seen, triedWrong: !!triedWrong }
    })
    // one rung at a time; the full solution only after the worked-example rung or a wrong attempt
    if (!(direct && level === 6) && level > ctx.seen + 1) throw new AppError('hint_order', `Try hint ${ctx.seen + 1} first`, { status: 409 })
    if (level === 6 && !direct && ctx.seen < 5 && !ctx.triedWrong) throw new AppError('hint_order', 'The full solution opens after the similar-example hint or after you have tried', { status: 409 })
    const key = answerText(ctx.it.answer_spec)
    let text: string
    let source: { filename: string; page: number; href: string } | null = null
    if (level === 6) {
      text = [`Answer: ${key}`, ctx.it.explanation].filter(Boolean).join('\n')
    } else {
      const profile = await tx(p, (t) => loadProfile(d, p, t)).catch(() => null)
      text = ''
      try {
        const r = await d.ai(p).run(HINT_TASK, { messages: buildHintPrompt({ level, stem: ctx.it.stem, options: ctx.it.answer_spec.type === 'mcq' ? ctx.it.answer_spec.options : undefined, answerKey: key, explanation: ctx.it.explanation, language: profile?.language ?? 'en' }) }, { promptVersion: GROWTH_PROMPT_VERSION })
        text = (r.json as { hint: string }).hint.trim()
      } catch { /* deterministic fallback below */ }
      if (!text || leaks(text, ctx.it.answer_spec, key)) text = FALLBACK[level]!
      if (level >= 3 && d.retrieval) {
        try {
          const h = (await d.retrieval.search(p, { scopes: [courseScope(ctx.it.course_id)], query: ctx.it.stem.slice(0, 500), topK: 1 })).hits[0]
          if (h) source = { filename: h.filename, page: h.pageStart, href: `/app/education/tutor/courses/${ctx.it.course_id}/materials/${h.documentId}/${h.pageStart}` }
        } catch { /* no source link */ }
      }
    }
    await tx(p, (t) => t.query(`insert into education_tutor.hint_usage (tenant_id, user_id, item_id, max_level) values (platform.current_tenant(), platform.current_user_id(), $1, $2)
      on conflict (tenant_id, user_id, item_id) do update set max_level = greatest(hint_usage.max_level, excluded.max_level), updated_at = now()`, [itemId, level]))
    return { level, hint: text, source, next: level < 6 ? level + 1 : null }
  }

  // ── observation & strategy ──
  async function observation(p: Principal, courseId: string) {
    return tx(p, async (t) => {
      await requireEnrolled(t, p, courseId)
      const coach = await coachFor(t, courseId)
      const topics = await topicFacts(t, courseId)
      const ids = topics.map((x) => x.id)
      const confidence: ObservationInput['confidence'] = new Map()
      const application: ObservationInput['application'] = new Map()
      const rows = (await t.query<{ concept_id: string; correct: boolean; confidence: string | null; cognitive: string; at: Date }>(
        `select i.concept_id, a.outcome >= 1 as correct, a.confidence, i.cognitive, a.created_at as at from education_tutor.attempts a join education_tutor.items i on i.id = a.item_id where a.user_id = platform.current_user_id() and i.concept_id = any($1)
         union all
         select r.concept_id, r.points >= r.max_points, r.confidence, i.cognitive, r.created_at from education_tutor.assessment_responses r join education_tutor.items i on i.id = r.item_id where r.user_id = platform.current_user_id() and r.concept_id = any($1) and not r.needs_review`, [ids])).rows
      for (const r of rows) {
        const c = confidence.get(r.concept_id) ?? { sure: 0, sureRight: 0, guess: 0, guessRight: 0, total: 0 }
        if (r.confidence) { c.total++; if (r.confidence === 'sure') { c.sure++; if (r.correct) c.sureRight++ } if (r.confidence === 'guess') { c.guess++; if (r.correct) c.guessRight++ } }
        confidence.set(r.concept_id, c)
        const a = application.get(r.concept_id) ?? { familiarRight: 0, familiar: 0, transferRight: 0, transfer: 0 }
        if (r.cognitive === 'apply' || r.cognitive === 'transfer') { a.transfer++; if (r.correct) a.transferRight++ } else { a.familiar++; if (r.correct) a.familiarRight++ }
        application.set(r.concept_id, a)
      }
      const sessions = (await t.query<{ concept_id: string; n: number; last: Date }>(`select concept_id, count(*)::int as n, max(created_at) as last from education_tutor.sessions where user_id = platform.current_user_id() and concept_id = any($1) group by concept_id`, [ids])).rows
      const afterLessons: ObservationInput['afterLessons'] = new Map(sessions.map((s) => {
        const after = rows.filter((r) => r.concept_id === s.concept_id && r.at > s.last)
        return [s.concept_id, { lessons: s.n, attemptsAfter: after.length, correctAfter: after.filter((r) => r.correct).length }]
      }))
      const findings = observe({ concepts: topics.map((x) => ({ id: x.id, name: x.name, examWeight: x.examWeight, prerequisites: x.prerequisites })), profiles: coach.profile, confidence, application, afterLessons })
      const profile = await loadProfile(d, p, t).catch(() => null)
      const exam = coach.examAt ?? (profile?.examDate && profile.examDate !== 'none' ? profile.examDate : null)
      const daysToExam = exam ? Math.ceil((Date.parse(`${exam}T00:00:00Z`) - Date.now()) / DAY) : null
      return { strategy: chooseStrategy({ objective: profile?.objective, daysToExam, findings }), findings, adjustments: adapt(findings), next: coach.next, note: 'Findings describe your answers so far; confidence depends on how many answers there are.' }
    })
  }

  // ── growth & outcomes ──
  async function learningEvents(t: Sql, courseId: string): Promise<{ events: LearningEvent[]; levels: { conceptId: string; name: string; pMastery: number; state: string }[]; mistakes: { at: Date }[]; tasks: { done: number; total: number } }> {
    const topics = await topicFacts(t, courseId)
    const ids = topics.map((x) => x.id)
    const answers = (await t.query<{ at: Date; concept_id: string; correct: boolean; hints: number; confidence: 'sure' | 'unsure' | 'guess' | null; cognitive: string }>(
      `select a.created_at as at, i.concept_id, a.outcome >= 1 as correct, a.hints_used as hints, a.confidence, i.cognitive from education_tutor.attempts a join education_tutor.items i on i.id = a.item_id where a.user_id = platform.current_user_id() and i.concept_id = any($1)
       union all select r.created_at, r.concept_id, r.points >= r.max_points, 0, r.confidence, i.cognitive from education_tutor.assessment_responses r join education_tutor.items i on i.id = r.item_id where r.user_id = platform.current_user_id() and r.concept_id = any($1) and not r.needs_review`, [ids])).rows
    const tests = (await t.query<{ at: Date; assessment_id: string; frac: string; purpose: string | null }>(
      `select x.submitted_at as at, x.assessment_id, x.score / nullif(x.max_score, 0) as frac, a.purpose from education_tutor.assessment_attempts x join education_tutor.assessments a on a.id = x.assessment_id
        where x.user_id = platform.current_user_id() and x.course_id = $1 and x.status = 'graded' and x.max_score > 0`, [courseId])).rows
    const delayed = (await t.query<{ at: Date; outcome: string; concept_id: string }>(`select observed_at as at, outcome, concept_id from education_tutor.evidence where user_id = platform.current_user_id() and kind = 'delayed_check' and concept_id = any($1)`, [ids])).rows
    const revisions = (await t.query<{ at: Date }>(`select last_review as at from education_tutor.cards where user_id = platform.current_user_id() and course_id = $1 and last_review is not null`, [courseId])).rows
    const tasks = (await t.query<{ status: string; completed_at: Date | null }>(`select status, completed_at from education_tutor.agent_tasks where user_id = platform.current_user_id() and course_id = $1 and status <> 'cancelled'`, [courseId])).rows
    const lessons = (await t.query<{ at: Date }>(`select e.created_at as at from education_tutor.studio_events e join education_tutor.studio_books b on b.id = e.book_id where b.course_id = $1 and e.kind = 'section_generated'
      union all select created_at from education_tutor.sessions where user_id = platform.current_user_id() and course_id = $1`, [courseId])).rows
    const mistakes = (await t.query<{ at: Date }>(`select created_at as at from education_tutor.error_diagnoses where user_id = platform.current_user_id() and recurring and concept_id = any($1)`, [ids])).rows
    const events: LearningEvent[] = [
      ...answers.map((a) => ({ at: a.at, kind: 'answer' as const, conceptId: a.concept_id, correct: a.correct, hints: a.hints, confidence: a.confidence, transfer: a.cognitive === 'apply' || a.cognitive === 'transfer' })),
      ...tests.map((x) => ({ at: x.at, kind: 'assessment' as const, assessmentId: x.assessment_id, frac: Number(x.frac), purpose: x.purpose })),
      ...delayed.map((x) => ({ at: x.at, kind: 'delayed_check' as const, conceptId: x.concept_id, correct: Number(x.outcome) >= 1 })),
      ...revisions.map((x) => ({ at: x.at, kind: 'revision' as const })),
      ...tasks.filter((x) => x.status === 'done' && x.completed_at).map((x) => ({ at: x.completed_at!, kind: 'task_done' as const })),
      ...lessons.map((x) => ({ at: x.at, kind: 'lesson' as const })),
    ]
    return { events, levels: topics.map((x) => ({ conceptId: x.id, name: x.name, pMastery: x.pMastery, state: x.state })), mistakes, tasks: { done: tasks.filter((x) => x.status === 'done').length, total: tasks.length } }
  }

  async function growth(p: Principal, courseId: string) {
    return tx(p, async (t) => {
      await requireEnrolled(t, p, courseId)
      const le = await learningEvents(t, courseId)
      const g = computeGrowth(le.events, le.levels, new Date())
      const prefs = (await t.query<{ leaderboard: boolean; pseudonym: string | null; outcomes_consent: boolean }>('select leaderboard, pseudonym, outcomes_consent from education_tutor.growth_prefs where user_id = platform.current_user_id()')).rows[0] ?? { leaderboard: false, pseudonym: null, outcomes_consent: false }
      const boardRows = prefs.leaderboard ? (await t.query<{ pseudonym: string; points: number; me: boolean }>('select pseudonym, points, me from education_tutor.improvement_board($1)', [courseId])).rows : []
      const titles = new Map((await t.query<{ id: string; title: string; purpose: string | null }>('select id, title, purpose from education_tutor.assessments where course_id = $1', [courseId])).rows.map((r) => [r.id, r]))
      return {
        ...g, personalBests: g.personalBests.map((b) => ({ ...b, title: titles.get(b.assessmentId)?.title ?? 'Test', purpose: titles.get(b.assessmentId)?.purpose ?? null })),
        levelNames: LEVELS, prefs: { leaderboard: prefs.leaderboard, pseudonym: prefs.pseudonym, outcomesConsent: prefs.outcomes_consent },
        leaderboard: prefs.leaderboard ? leaderboard(boardRows.map((r) => ({ pseudonym: r.pseudonym, improvementPoints: r.points, me: r.me }))) : { visible: false, rows: [] },
        outcomes: outcomes({ events: le.events, repeatedMistakes: le.mistakes, tasks: le.tasks }),
      }
    })
  }
  const setPrefs = (p: Principal, b: { leaderboard: boolean; pseudonym: string | null; outcomesConsent: boolean }) => tx(p, async (t) => {
    if (b.leaderboard && !b.pseudonym) throw badRequest('pseudonym_required', 'Choose a nickname to appear on the board (not your real name)')
    await t.query(`insert into education_tutor.growth_prefs (tenant_id, user_id, leaderboard, pseudonym, outcomes_consent) values (platform.current_tenant(), platform.current_user_id(), $1, $2, $3)
      on conflict (tenant_id, user_id) do update set leaderboard = excluded.leaderboard, pseudonym = excluded.pseudonym, outcomes_consent = excluded.outcomes_consent, updated_at = now()`, [b.leaderboard, b.pseudonym, b.outcomesConsent])
    return b
  })
  const cohort = (p: Principal, courseId: string) => tx(p, async (t) => {
    const e = await requireEnrolled(t, p, courseId)
    if (e.role !== 'educator') throw new AppError('forbidden', 'Educators only', { status: 403 })
    const r = (await t.query<{ students: number; diagnostic_avg: string | null; post_avg: string | null; delayed_avg: string | null }>('select * from education_tutor.cohort_outcomes($1, 5)', [courseId])).rows[0]!
    return { consentingStudents: r.students, minimumGroup: 5, shown: r.diagnostic_avg !== null || r.post_avg !== null, diagnosticAvg: r.diagnostic_avg === null ? null : Number(r.diagnostic_avg), postAvg: r.post_avg === null ? null : Number(r.post_avg), delayedRetentionAvg: r.delayed_avg === null ? null : Number(r.delayed_avg), note: 'Only students who consented are included; nothing is shown for fewer than 5. Averages are descriptive and do not show cause.' }
  })

  // ── chapter package ──
  async function buildPackage(p: Principal, bookId: string) {
    const dec = <T>(table: string, column: string, id: string, v: string) => crypto().decrypt(p, { table, column, recordId: id }, v).then((s) => JSON.parse(s) as T)
    const data = await tx(p, async (t) => {
      const b = (await t.query<{ id: string; course_id: string; title: string; outline: { id: string; status: string; conceptId?: string | null }[] }>('select id, course_id, title, outline from education_tutor.studio_books where id = $1', [bookId])).rows[0]
      if (!b) throw notFound('Book')
      const nbRow = (await t.query<{ version: number; doc_enc: string }>('select version, doc_enc from education_tutor.studio_notebooks where book_id = $1 order by version desc limit 1', [bookId])).rows[0]!
      const notebook = await dec<{ topics: PkgTopic[] }>('studio_notebooks', 'doc', `${bookId}:${nbRow.version}`, nbRow.doc_enc)
      const pages = await Promise.all((await t.query<{ page_no: number; blocks_enc: string }>('select page_no, blocks_enc from education_tutor.studio_pages where book_id = $1 order by page_no', [bookId])).rows.map((r) => dec<(PkgBlock & { activity?: { prompt: string; explanation?: string } })[]>('studio_pages', 'blocks', `${bookId}:${r.page_no}`, r.blocks_enc)))
      const blocks = pages.flat()
      const missedIds = new Set((await t.query<{ block: string }>(`select distinct detail->>'blockId' as block from education_tutor.studio_events where book_id = $1 and kind = 'activity' and detail->>'verdict' <> 'correct'`, [bookId])).rows.map((r) => r.block))
      const missedChecks = blocks.filter((x) => missedIds.has(x.id) && x.activity).map((x) => ({ prompt: x.activity!.prompt, explanation: x.activity!.explanation ?? '' }))
      const topics = await topicFacts(t, b.course_id)
      const bookConcepts = new Set(b.outline.map((s) => s.conceptId).filter((x): x is string => !!x))
      const relevant = topics.filter((x) => !bookConcepts.size || bookConcepts.has(x.id))
      const diagnoses = (await t.query<{ misconception: string; concept_id: string }>(`select distinct on (concept_id, misconception) misconception, concept_id from education_tutor.error_diagnoses where user_id = platform.current_user_id() and misconception <> '' and concept_id = any($1) order by concept_id, misconception, created_at desc limit 10`, [relevant.map((x) => x.id)])).rows
      const { papers, questions } = await papersAndQuestions(p, t, b.course_id)
      const byPaper = new Map(papers.map((x) => [x.id, x]))
      const pyqs = await Promise.all(questions.filter((q) => byPaper.get(q.paperId)?.status === 'ready' && (!bookConcepts.size || (q.conceptId && bookConcepts.has(q.conceptId)))).slice(0, 25).map(async (q) => {
        const pp = byPaper.get(q.paperId)!
        return { text: await crypto().decrypt(p, { table: 'exam_questions', column: 'text', recordId: q.id }, q.text_enc), marks: q.marks, source: `${pp.title}${pp.year ? ` (${pp.year})` : ''}, Q${q.number} · ${pp.kind.replace(/_/g, ' ')}`, topic: topics.find((x) => x.id === q.conceptId)?.name ?? null }
      }))
      const v = (await t.query<{ v: number }>('select coalesce(max(version), 0)::int + 1 as v from education_tutor.chapter_packages where book_id = $1', [bookId])).rows[0]!.v
      return { b, notebook, blocks, missedChecks, relevant, diagnoses, pyqs, topics, v }
    })
    let mockTestId: string | null = null
    try { mockTestId = (await selfTest(p, data.b.course_id, { purpose: 'mock', conceptIds: data.relevant.map((x) => x.id) })).assessmentId } catch { /* no approved questions: the package says so */ }
    const pkg = assemblePackage({
      title: data.b.title, now: new Date(), topics: data.notebook.topics, blocks: data.blocks, missedChecks: data.missedChecks,
      diagnoses: data.diagnoses.map((x) => ({ misconception: x.misconception, concept: data.topics.find((c) => c.id === x.concept_id)?.name ?? '' })),
      pastQuestions: data.pyqs, mastery: data.relevant.map((x) => ({ topic: x.name, level: LEVELS[levelOf(x.pMastery, x.state)]!, pMastery: Math.round(x.pMastery * 100) / 100 })), mockTestId,
    })
    return tx(p, async (t) => {
      // flashcards become FSRS cards (once per card: source_ref is unique per user)
      let cards = 0
      for (const [i, f] of pkg.flashcards.slice(0, 40).entries()) {
        const r = await t.query(`insert into education_tutor.cards (tenant_id, user_id, course_id, concept_id, front, back, due_at, source_ref) values (platform.current_tenant(), platform.current_user_id(), $1, null, $2, $3, now() + interval '1 day', $4)
          on conflict (user_id, source_ref) where source_ref is not null do nothing`, [data.b.course_id, f.front.slice(0, 2000), f.back.slice(0, 4000), `pkg:${bookId}:${norm(f.front).slice(0, 80) || i}`])
        cards += r.rowCount
      }
      await t.query(`insert into education_tutor.chapter_packages (tenant_id, user_id, book_id, version, doc_enc) values (platform.current_tenant(), platform.current_user_id(), $1, $2, $3)`,
        [bookId, data.v, await crypto().encrypt(p, { table: 'chapter_packages', column: 'doc', recordId: `${bookId}:${data.v}` }, JSON.stringify(pkg))])
      await t.query(`insert into education_tutor.studio_events (tenant_id, user_id, book_id, kind, detail) values (platform.current_tenant(), platform.current_user_id(), $1, 'package', $2)`, [bookId, JSON.stringify({ version: data.v, cards, mock: !!mockTestId })])
      return { version: data.v, newFlashcards: cards, package: pkg }
    })
  }
  const getPackage = (p: Principal, bookId: string) => tx(p, async (t) => {
    const r = (await t.query<{ version: number; doc_enc: string }>('select version, doc_enc from education_tutor.chapter_packages where book_id = $1 order by version desc limit 1', [bookId])).rows[0]
    if (!r) throw notFound('Package')
    return { version: r.version, package: JSON.parse(await crypto().decrypt(p, { table: 'chapter_packages', column: 'doc', recordId: `${bookId}:${r.version}` }, r.doc_enc)) }
  })

  return { addPaper, extract, markExtractFailed, insights, selfTest, hint, observation, growth, setPrefs, cohort, buildPackage, getPackage, papersAndQuestions }
}

const FALLBACK: Record<number, string> = {
  1: 'Start by writing down what the question gives you and what it asks for.',
  2: 'Think about which idea from this topic connects the given quantities to the one you need.',
  3: 'Recall the rule or formula from this topic that links these quantities, and check it applies here.',
  4: 'Plan it in steps: (1) list the knowns, (2) choose the rule, (3) substitute carefully with units, (4) check the result makes sense.',
  5: 'Try a similar, simpler example first using the same rule, then apply the same steps to your question.',
}

/** Does a hint give the answer away? (correct option text, the numeric value, or the whole key) */
export function leaks(hint: string, spec: AnswerSpec, key: string): boolean {
  const h = ` ${hint.toLowerCase().replace(/\s+/g, ' ')} `
  if (spec.type === 'numeric') {
    const v = String(spec.value)
    return new RegExp(`(^|[^0-9.])${v.replace('.', '\\.')}([^0-9]|$)`).test(h)
  }
  if (spec.type === 'mcq') return spec.correct.some((c) => { const o = c.toLowerCase(); return o.length >= 3 && h.includes(o) })
  const k = key.toLowerCase().trim()
  return k.length >= 4 && h.includes(k)
}
