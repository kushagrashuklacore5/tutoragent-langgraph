/**
 * Personal (self-study) courses: any subject or practical skill, when no educator course exists.
 * The model DRAFTS a syllabus and practice questions; deterministic code validates them and decides what is stored.
 * Practice items are stored only when automatic checks pass (MCQ key supported by its own explanation and not by
 * the other options; numeric keys recomputed by the maths engine; expression keys parsed). Fail closed.
 */
import { AppError, badRequest } from '@platform/core'
import type { ModuleDeps, Principal, RouteDef, SearchHit, TaskDefinition } from '@platform/contracts'
import { obj, P, requireEnrolled, str, uuid } from '../common.ts'
import { stemSimilarity, NEAR_DUPLICATE } from '../domain/assessment.ts'
import { validateSpec, type AnswerSpec } from '../domain/scoring.ts'
import { numbersFrom } from '../assessgen.ts'
import { loadProfile } from '../agent/store.ts'
import { courseScope, groundingOverlap } from '../materials.ts'
import { studioService } from '../studio/service.ts'

export const COURSE_TASK = 'education.tutor.course_outline'
export const PRACTICE_TASK = 'education.tutor.practice_items'
export const COURSE_PROMPT_VERSION = 'course_outline@1'

const COURSE_SCHEMA = {
  type: 'object', required: ['title', 'topics'],
  properties: {
    // generous at the gateway (live: a valid syllabus failed on a long description); validateOutline clips and checks
    title: { type: 'string', minLength: 2, maxLength: 300 },
    topics: { type: 'array', minItems: 3, maxItems: 40, items: { type: 'object', required: ['name'], properties: {
      name: { type: 'string', minLength: 2, maxLength: 300 }, description: { type: 'string', maxLength: 2000 },
      estMinutes: {}, prerequisites: { type: 'array', maxItems: 20 },
    } } },
  },
}
const PRACTICE_SCHEMA = {
  type: 'object', required: ['items'],
  properties: { items: { type: 'array', maxItems: 20, items: { type: 'object', required: ['type', 'stem', 'explanation'], properties: {
    type: { enum: ['mcq', 'numeric', 'expression', 'descriptive'] }, stem: { type: 'string', minLength: 5, maxLength: 2000 }, explanation: { type: 'string', minLength: 5, maxLength: 4000 },
    options: { type: 'array', maxItems: 6 }, correct: {}, value: {}, answerExpr: {}, unit: {}, difficulty: {}, expression: {}, modelAnswer: {}, rubric: { type: 'array', maxItems: 8 }, source: {}, page: {},
  } } } },
}
const base = { owner: 'education.tutor', determinism: 'flexible' as const, fallback: 'eligible_only' as const }
export const PERSONAL_TASKS: TaskDefinition[] = [
  { ...base, id: COURSE_TASK, category: 'tutoring', dataClass: 'student_content', requires: { operation: 'generate', structuredOutput: 'json_mode', minContext: 8000 }, outputSchema: COURSE_SCHEMA, evalSuite: 'tutor/course_outline', defaults: { maxOutputTokens: 1500, temperature: 0.2, reasoning: 'low' } },
  { ...base, id: PRACTICE_TASK, category: 'assessment', dataClass: 'course_content', requires: { operation: 'generate', structuredOutput: 'json_mode', minContext: 8000 }, outputSchema: PRACTICE_SCHEMA, evalSuite: 'tutor/practice_items', defaults: { maxOutputTokens: 5000, temperature: 0.3, reasoning: 'low' } },
]

export interface DraftTopic { name: string; description?: string; estMinutes?: number; prerequisites?: number[] }
const clean = (s: string, n: number) => s.replace(/[*_#`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n)

/** Validate a drafted syllabus: 3-16 distinct topics, plain text, sane times, prerequisites only to EARLIER topics. */
export function validateOutline(o: { title?: string; topics?: DraftTopic[] }, subject: string): { title: string; topics: DraftTopic[] } {
  const seen = new Set<string>()
  const topics: DraftTopic[] = []
  for (const t of o.topics ?? []) {
    const name = clean(String(t.name ?? ''), 120)
    const k = name.toLowerCase()
    if (name.length < 2 || seen.has(k)) continue
    seen.add(k)
    topics.push({ name, description: clean(String(t.description ?? ''), 400), estMinutes: Math.max(10, Math.min(300, Math.round(Number(t.estMinutes) || 45))), prerequisites: (Array.isArray(t.prerequisites) ? t.prerequisites : []).map((x) => Number(x)).filter((x) => Number.isInteger(x)) })
  }
  // indices are 1-based positions in the ORIGINAL list; after dedupe keep only edges to earlier kept topics
  const fixed = topics.map((t, i) => ({ ...t, prerequisites: (t.prerequisites ?? []).filter((x) => x >= 1 && x <= i) }))
  if (fixed.length < 3) throw new AppError('course_unavailable', 'I could not build a reliable syllabus for this subject. Please try again or name the chapters you need.', { status: 422 })
  return { title: clean(o.title || subject, 120) || clean(subject, 120), topics: fixed.slice(0, 16) }
}

export function coursePrompt(o: { subject: string; goal?: string; level?: string; language: string; chapter?: string }) {
  return [
    { role: 'system' as const, content: [
      'You design a complete, structured self-study course for one learner. Return only JSON {"title": string, "topics": [{"name", "description", "estMinutes", "prerequisites"}]}.',
      'Topics: 5-14, in the order they should be learned, covering the subject end to end for the stated level and goal (for a practical skill: hands-on steps from setup to a small real project).',
      'name: a short chapter/topic title. description: one sentence of what the learner will be able to do. estMinutes: realistic study minutes (15-180). prerequisites: 1-based positions of EARLIER topics this one needs.',
      'If a board/class or exam is named (e.g. CBSE Class 9, ICSE, JEE, a university course), the topics MUST be exactly that syllabus: for CBSE/NCERT use the NCERT textbook chapter titles in textbook order (e.g. CBSE Class 9 Geography: India – Size and Location; Physical Features of India; Drainage; Climate; Natural Vegetation and Wildlife; Population). Never invent a generic syllabus when an official one exists.',
      'Plain text only, no markdown.',
    ].join('\n') },
    { role: 'user' as const, content: `Subject or skill: ${o.subject}\n${o.chapter ? `The learner named this chapter/topic; include it with EXACTLY this title: ${o.chapter}\n` : ''}Goal: ${o.goal ?? 'learn it well'}\nLevel: ${o.level ?? 'not stated'}\nLanguage of titles: ${o.language === 'en' ? 'English' : 'English (simple words)'}` },
  ]
}

/** Draft-and-check one practice candidate (deterministic part; numeric keys are then recomputed by the maths engine). */
export interface PracticeCandidate { type: 'mcq' | 'numeric' | 'expression' | 'descriptive'; stem: string; explanation: string; options?: string[]; correct?: string; value?: number; answerExpr?: string; unit?: string; difficulty?: number; expression?: string; modelAnswer?: string; rubric?: { criterion: string; points: number; keyPoints: string[] }[]; source?: 'document' | 'generated'; page?: number }
const STOP = new Set(['the', 'and', 'for', 'with', 'are', 'was', 'were', 'has', 'have', 'its', 'this', 'that', 'from', 'into', 'than', 'then', 'both', 'each', 'only', 'also', 'not', 'all', 'none', 'any', 'one', 'can', 'will', 'which', 'what'])
const words = (s: string) => new Set(s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s.]/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))
export function checkPractice(c: PracticeCandidate, existing: string[]): { spec: AnswerSpec | null; problems: string[] } {
  const problems: string[] = []
  if (existing.some((s) => stemSimilarity(s, c.stem) >= NEAR_DUPLICATE)) problems.push('near-duplicate')
  let spec: AnswerSpec | null = null
  if (c.type === 'mcq') {
    const opts = (c.options ?? []).map((x) => x.trim()).filter(Boolean)
    const key = (c.correct ?? '').trim()
    if (opts.length < 3 || new Set(opts.map((x) => x.toLowerCase())).size !== opts.length) problems.push('needs 3+ distinct options')
    if (!opts.includes(key)) problems.push('key is not one of the options')
    if (/\b(all|none) of the above\b/i.test(opts.join(' '))) problems.push('all/none of the above')
    // the key must be the option its own explanation supports best (live runs produced wrong keys)
    // and it is the option the explanation names FIRST (explanations state the answer, then why the others are wrong)
    const exText = c.explanation.toLowerCase()
    const exCompact = compact(c.explanation)
    const ex = words(c.explanation)
    // maths options ("4/5", "sin²θ + cos²θ = 1") are matched as written; word options by their words
    const score = (o: string) => { if (exCompact.includes(compact(o)) && compact(o).length >= 1) return 1; const w = [...words(o)]; return w.length ? w.filter((x) => ex.has(x)).length / w.length : 0 }
    const firstAt = (o: string) => { const j = exCompact.indexOf(compact(o)); if (j >= 0) return j / Math.max(1, exCompact.length) * exText.length; return Math.min(...[...words(o)].map((x) => { const i = exText.indexOf(x); return i < 0 ? Infinity : i }), Infinity) }
    const ks = score(key)
    const rivals = opts.filter((o) => o !== key && score(o) >= 0.5)
    if (!(ks >= 0.5 && rivals.every((o) => firstAt(key) < firstAt(o)))) problems.push('explanation does not clearly support the key')
    spec = { type: 'mcq', options: opts, correct: [key] }
  } else if (c.type === 'expression') {
    if (!c.expression?.trim()) problems.push('no answer expression')
    else spec = { type: 'expression', value: c.expression.trim() }
  } else if (c.type === 'descriptive') {
    const rub = (c.rubric ?? []).filter((x) => x && x.criterion && Array.isArray(x.keyPoints) && x.keyPoints.length).slice(0, 5)
    if (!c.modelAnswer?.trim() || rub.length < 2) problems.push('written question needs a model answer and 2+ rubric criteria with key points')
    else spec = { type: 'descriptive', modelAnswer: c.modelAnswer.trim(), rubric: rub.map((x, i) => ({ id: `c${i + 1}`, criterion: String(x.criterion).slice(0, 300), points: Math.max(0.5, Math.min(5, Math.round((Number(x.points) || 1) * 2) / 2)), keyPoints: x.keyPoints.map((k) => String(k).slice(0, 200)).slice(0, 6) })) }
  } else {
    // "4/5", "0.8" or only a calculation: take the value from it (the maths engine re-checks it below)
    if (typeof c.value !== 'number' || !Number.isFinite(c.value)) {
      const v = arith(String(c.value ?? '')) ?? arith(String(c.answerExpr ?? ''))
      if (v !== null) c.value = v
      if (!c.answerExpr && typeof c.value === 'number') c.answerExpr = String(c.value)
    }
    if (typeof c.value !== 'number' || !Number.isFinite(c.value)) problems.push('no numeric answer')
    if (!c.answerExpr?.trim()) problems.push('no calculation to verify')
    else {
      // numbers in the calculation must come from the question or its worked solution (derived values such as a
      // hypotenuse are fine; invented constants are not). The maths engine then recomputes the answer.
      const given = new Set([...numbersFrom(c.stem), ...numbersFrom(c.explanation)])
      const hidden = [...numbersFrom(c.answerExpr)].filter((n) => !given.has(n) && !['1', '2', '10', '100', '1000', '60', '3600'].includes(n))
      if (hidden.length) problems.push('calculation uses numbers not in the question')
    }
    if (typeof c.value === 'number') spec = { type: 'numeric', value: c.value, tolerance: Math.max(1e-9, Math.abs(c.value) * 0.01), ...(c.unit ? { unit: c.unit } : {}) }
  }
  if (spec) problems.push(...validateSpec(spec))
  return { spec: problems.length ? null : spec, problems }
}

export async function createPersonalCourse(d: ModuleDeps, p: Principal, o: { subject: string; goal?: string; level?: string; language?: string; chapter?: string }): Promise<{ courseId: string; title: string; topics: string[] }> {
  const language = o.language === 'hi' || o.language === 'hinglish' ? o.language : 'en'
  const r = await d.ai(p).run(COURSE_TASK, { messages: coursePrompt({ ...o, language }) }, { promptVersion: COURSE_PROMPT_VERSION })
  const v = validateOutline(r.json as { title?: string; topics?: DraftTopic[] }, o.subject)
  return d.inTenant(p, async (t) => {
    // the same subject asked twice reuses the existing personal course
    const existing = (await t.query<{ id: string; title: string }>(`select id, title from education_tutor.courses where owner_user_id = platform.current_user_id() and lower(title) = lower($1)`, [v.title])).rows[0]
    if (existing) {
      const names = (await t.query<{ name: string }>('select name from education_tutor.concepts where course_id = $1 order by created_at', [existing.id])).rows.map((x) => x.name)
      return { courseId: existing.id, title: existing.title, topics: names }
    }
    const id = (await t.query<{ id: string }>('select education_tutor.create_personal_course($1, $2::jsonb, $3) as id', [v.title, JSON.stringify(v.topics), language])).rows[0]!.id
    await d.audit(t, p, { action: 'course.personal_created', targetType: 'course', targetId: id, metadata: { topics: v.topics.length, operationId: r.operationId } })
    return { courseId: id, title: v.title, topics: v.topics.map((x) => x.name) }
  })
}

/** Make sure a topic has verified practice questions (any enrolled course; generated on demand, automatic checks). */
export const SET_TARGET = 8

/** One topic's question set, built ONCE: the student's own document first (its worked examples and exercise
 *  questions, copied with page references and solved), then checked AI questions only to fill the gap. */
export async function buildTopicSet(d: ModuleDeps, p: Principal, courseId: string, conceptId: string | null, opts: { documentId?: string | null; target?: number } = {}): Promise<{ added: number; fromDocument: number; available: number; rejected: number; fromLesson?: number; reasons?: string[]; candidates?: number; sourcePages?: number; debug?: unknown }> {
  const target = opts.target ?? SET_TARGET
  const ctx = await d.inTenant(p, async (t) => {
    const course = await requireEnrolled(t, p, courseId)
    const concept = (await t.query<{ id: string; name: string; description: string }>(
      `select c.id, c.name, c.description from education_tutor.concepts c where c.course_id = $1 and ($2::uuid is null or c.id = $2) and c.status = 'approved'
        order by (select count(*) from education_tutor.items i where i.concept_id = c.id and i.status = 'approved'), c.created_at limit 1`, [courseId, conceptId])).rows[0]
    if (!concept) throw badRequest('no_concepts', 'This course has no topics yet')
    const rows = (await t.query<{ stem: string; grounded: boolean }>(`select stem, (origin = 'educator' or validation->>'source' in ('document', 'lesson')) as grounded from education_tutor.items where concept_id = $1 and status = 'approved' and retired_at is null`, [concept.id])).rows
    const stems = rows.map((x) => x.stem)
    const groundedCount = rows.filter((x) => x.grounded).length
    const prof = await loadProfile(d, p, t).catch(() => null)
    const level = [prof?.grade ? `Class ${prof.grade}` : prof?.level, prof?.curriculum].filter(Boolean).join(' ')
    return { concept, stems, groundedCount, course, level }
  })
  // what the tutor taught on this topic (the book) comes first; the student's material second
  const lesson = await studioService(d).taught(p, courseId, ctx.concept.id, ctx.concept.name).catch(() => ({ text: '', refs: [] as { bookId: string; bookTitle: string; pageNo: number; text: string }[] }))
  // generic questions do not count once there is a lesson or material to ground them in
  const have = lesson.refs.length || opts.documentId ? ctx.groundedCount : ctx.stems.length
  if (have >= target) return { added: 0, fromDocument: 0, available: ctx.stems.length, rejected: 0 }
  // the student's material for this topic (their uploaded document ranked first)
  let hits: SearchHit[] = []
  if (d.retrieval) {
    try {
      const all = (await d.retrieval.search(p, { scopes: [courseScope(courseId)], query: `${ctx.concept.name} example exercise question ${ctx.concept.description}`.slice(0, 800), topK: 10 })).hits
      hits = [...all.filter((h) => h.documentId === opts.documentId), ...all.filter((h) => h.documentId !== opts.documentId)].slice(0, 6)
    } catch { hits = [] }
  }
  const need = target - have
  const source = hits.map((h) => `[page ${h.pageStart}] ${h.text.slice(0, 1800)}`).join('\n---\n')
  const r = await d.ai(p).run(PRACTICE_TASK, { messages: [
    { role: 'system', content: [
      `Build a practice question set for "${ctx.course.title}", topic "${ctx.concept.name}"${ctx.concept.description ? ` (${ctx.concept.description})` : ''}. Return only JSON {"items":[...]}.`,
      ctx.level ? `The learner is ${ctx.level}: stay within that level and syllabus.` : '',
      'Every question must test what the student was actually TAUGHT (LESSON) or what is in their MATERIAL: the same ideas, notation, formulas and kind of examples; at most a small step beyond (near transfer). Never a new subtopic.',
      hits.length ? 'STEP 1: from MATERIAL, copy the worked EXAMPLES and EXERCISE questions that belong to this topic, word for word, with "source":"document" and "page". Solve each one.' : '',
      lesson.text ? 'STEP 2: from LESSON, write questions on exactly what was explained there: rework its worked examples with changed numbers, its definitions, its common mistakes; "source":"lesson" and "page" = the lesson page number.' : '',
      `Make ${need} questions in total.${lesson.text || hits.length ? '' : ' Use "source":"generated".'}`,
      'Prefer "mcq" and "numeric" for objective practice; use "expression" only for an algebraic answer in x (e.g. 2*x+3); for identities, proofs and "find all ratios" use "descriptive". Item types: "mcq" (4 options, "correct" copied exactly from options; distractors from real mistakes), "numeric" ("value" exact, "answerExpr" = the calculation using ONLY numbers in the stem), "expression" ("expression" = answer in plain maths with * ^ sqrt()), "descriptive" (for prove/explain questions: "modelAnswer" and "rubric" of 2-5 criteria, each {"criterion","points","keyPoints":[..]}).',
      '"explanation": starts by stating the correct answer, then the full worked solution step by step. Plain text, no markdown.',
      lesson.text ? `LESSON (what the tutor taught this student):\n${lesson.text}` : '',
      hits.length ? `MATERIAL (the student\'s own book/notes):\n${source}` : '',
    ].filter(Boolean).join('\n') },
    { role: 'user', content: ctx.stems.length ? `Already in the set (do not repeat):\n${ctx.stems.slice(0, 20).map((x) => `- ${x.slice(0, 140)}`).join('\n')}` : 'Build the set now.' },
  ] }, { promptVersion: 'question_set@1' })
  const cands = ((r.json as { items?: PracticeCandidate[] }).items ?? []).slice(0, 16)
  const accepted: { c: PracticeCandidate; spec: AnswerSpec; checks: string[]; refs: { kind: 'material' | 'lesson'; documentId?: string; bookId?: string; filename: string; pageStart: number }[] }[] = []
  let rejected = 0
  const reasons = new Set<string>()
  for (const c of cands) {
    // a value written as maths ("3*sqrt(7)/7") is evaluated by the maths engine
    if (c.type === 'numeric' && typeof c.value !== 'number' && c.value !== undefined && d.math) {
      const ev = await d.math.evaluate(String(c.value)).catch(() => null)
      if (ev?.ok && ev.value !== undefined && Number.isFinite(Number(ev.value))) { if (!c.answerExpr) c.answerExpr = String(c.value); c.value = Number(ev.value) }
    }
    const k = checkPractice(c, [...ctx.stems, ...accepted.map((x) => x.c.stem)])
    if (!k.spec) { rejected++; k.problems.forEach((x) => reasons.add(`${c.type}: ${x}`)); continue }
    const checks = ['well-formed key', 'not a duplicate']
    if (k.spec.type === 'numeric') {
      // the calculation is evaluated by the maths engine; a rounded stated value (e.g. 0.661 for sqrt(7)/4) is fine
      const v = d.math ? await d.math.evaluate(c.answerExpr!).catch(() => null) : null
      const got = v?.ok && v.value !== undefined ? Number(v.value) : NaN
      if (!Number.isFinite(got) || Math.abs(got - k.spec.value) > Math.max(1e-6, Math.abs(k.spec.value) * 0.005)) { rejected++; reasons.add(v?.ok ? 'numeric: answer does not match its calculation' : 'numeric: calculation not understood'); continue }
      checks.push(`answer recomputed by the maths engine (${c.answerExpr})`)
    } else if (k.spec.type === 'expression') {
      const v = d.math ? await d.math.equivalent(k.spec.value, k.spec.value).catch(() => null) : null
      if (!v?.ok) { rejected++; reasons.add('expression: not parseable'); continue }
      checks.push('answer expression parsed by the maths engine')
    } else if (k.spec.type === 'mcq') checks.push('key supported by its explanation, distractors not')
    else checks.push('rubric with key points (marked by the two-pass marker in tests)')
    // "from your book" only when the question really is in the retrieved pages
    const hit = c.source === 'document' ? hits.find((h) => h.pageStart === Number(c.page) || groundingOverlap(c.stem, [h.text]) >= 0.6) : undefined
    const fromDoc = !!hit && groundingOverlap(c.stem, [hit.text]) >= 0.6
    // which lesson page it is about (the one it overlaps most)
    const basis = `${c.stem} ${c.explanation}`
    const best = lesson.refs.map((r) => ({ r, o: groundingOverlap(basis, [r.text]) })).sort((a, b) => b.o - a.o)[0]
    const fromLesson = !fromDoc && !!best && best.o >= 0.18
    // grounded: when there IS a lesson or material, a question unrelated to both is rejected (stays "around" what was taught)
    if ((lesson.refs.length || hits.length) && !fromDoc && !fromLesson && groundingOverlap(basis, [lesson.text, ...hits.map((h) => h.text)]) < 0.12) { rejected++; reasons.add('not about what was taught'); continue }
    if (fromDoc) checks.push(`taken from your material, page ${hit!.pageStart}`)
    if (fromLesson) checks.push(`based on your lesson, page ${best!.r.pageNo}`)
    accepted.push({ c, spec: k.spec, checks, refs: fromDoc ? [{ kind: 'material', documentId: hit!.documentId, filename: hit!.filename, pageStart: hit!.pageStart }] : fromLesson ? [{ kind: 'lesson', bookId: best!.r.bookId, filename: best!.r.bookTitle, pageStart: best!.r.pageNo }] : [] })
  }
  const added = accepted.length ? await d.inTenant(p, async (t) => Number((await t.query<{ n: number }>('select education_tutor.add_verified_practice($1, $2, $3::jsonb) as n', [courseId, ctx.concept.id, JSON.stringify(accepted.map((x) => ({
    type: x.spec.type, stem: x.c.stem.trim(), answerSpec: x.spec, explanation: x.c.explanation.trim(), difficulty: Number(x.c.difficulty) || 0.5, sourceRefs: x.refs,
    validation: { checks: x.checks, auto: true, source: x.refs[0]?.kind === 'material' ? 'document' : x.refs[0]?.kind === 'lesson' ? 'lesson' : 'generated', model: r.route?.modelId ?? null, generatedAt: new Date().toISOString() },
  })))])).rows[0]!.n)) : 0
  return { added, fromDocument: accepted.filter((x) => x.refs[0]?.kind === 'material').length, fromLesson: accepted.filter((x) => x.refs[0]?.kind === 'lesson').length, available: ctx.stems.length + added, rejected, reasons: [...reasons].slice(0, 6), candidates: cands.length, sourcePages: hits.length, debug: process.env.QSET_DEBUG ? cands.slice(0, 4).map((c) => ({ t: c.type, v: c.value, e: c.answerExpr, x: c.expression, s: c.stem.slice(0, 80) })) : undefined }
}

/** kept for the manual "prepare questions" button: same builder */
export const preparePractice = (d: ModuleDeps, p: Principal, courseId: string, conceptId: string | null) => buildTopicSet(d, p, courseId, conceptId)

export function personalRoutes(d: ModuleDeps): RouteDef[] {
  return [
    { method: 'POST', path: '/personal-courses', permission: P.study, handler: async ({ principal, body }) => {
      const b = obj(body)
      return createPersonalCourse(d, principal, { subject: str(b.subject, 'subject', 160), goal: typeof b.goal === 'string' ? b.goal.slice(0, 200) : undefined, level: typeof b.level === 'string' ? b.level.slice(0, 60) : undefined, language: typeof b.language === 'string' ? b.language : undefined })
    } },
    { method: 'POST', path: '/courses/:courseId/practice/prepare', permission: P.study, handler: async ({ principal, params, body }) => {
      const b = obj(body ?? {})
      return preparePractice(d, principal, uuid(params.courseId, 'courseId'), b.conceptId ? uuid(b.conceptId, 'conceptId') : null)
    } },
  ]
}

/** the same text with spacing/case/sign variants removed (for matching maths written in options) */
function compact(x: string): string { return x.toLowerCase().normalize('NFKC').replace(/[\s.,;:'"`]+/g, '').replace(/[−–]/g, '-').replace(/×/g, '*').replace(/÷/g, '/') }
/** evaluate plain arithmetic like "4/5", "(24^2+7^2)", "3*0.5"; null for anything else */
export function arith(x: string): number | null {
  const e = x.replace(/\s+/g, '').replace(/\^/g, '**')
  if (!e || !/^[\d.+\-*/()]+$/.test(e) || /\*\*\*|[+\-*/]{3,}/.test(e)) return null
  try { const v = Function(`"use strict"; return (${e})`)() as unknown; return typeof v === 'number' && Number.isFinite(v) ? v : null } catch { return null }
}
