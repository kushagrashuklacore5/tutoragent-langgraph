import { AppError, badRequest, notFound } from '@platform/core'
import type { ModuleDeps, RouteDef, SearchHit, TaskDefinition } from '@platform/contracts'
import { stemSimilarity, NEAR_DUPLICATE } from './domain/assessment.ts'
import { validateSpec, type AnswerSpec, type RubricCriterion } from './domain/scoring.ts'
import { groundingOverlap, materialBlock, courseScope } from './materials.ts'
import { P, uuid } from './common.ts'
import { requireCourseEducator, COGNITIVE } from './items.ts'

/**
 * Question generation from APPROVED course material (educator-verified documents only — never student
 * notes). The model proposes; this module validates every candidate before it is stored, and stores it
 * only as a DRAFT that an educator must approve before any student sees it:
 *   - cites ≥ 1 retrieved verified source and shares vocabulary with it (grounding)
 *   - well-formed answer key for its type (validateSpec + type-specific checks)
 *   - numeric answers recomputed by the maths service from the stem's own numbers
 *   - not a near-duplicate of an existing item for the concept or of another candidate
 */
export const GENERATE_TASK = 'education.tutor.generate_items'
export const GENERATE_PROMPT_VERSION = 'generate_items@1'
export const GEN_TYPES = ['mcq', 'numeric', 'expression', 'short', 'descriptive'] as const
type GenType = typeof GEN_TYPES[number]

const CRITERION = {
  type: 'object', required: ['id', 'criterion', 'points', 'keyPoints'],
  properties: { id: { type: 'string', maxLength: 20 }, criterion: { type: 'string', maxLength: 500 }, points: { type: 'number' }, keyPoints: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 8 } },
}
export const GENERATE_SCHEMA = {
  type: 'object', required: ['items'],
  properties: {
    items: {
      type: 'array', maxItems: 12,
      items: {
        type: 'object', required: ['type', 'stem', 'learningObjective', 'cognitive', 'difficulty', 'sourceIds', 'explanation'],
        properties: {
          type: { enum: [...GEN_TYPES] },
          stem: { type: 'string', minLength: 10, maxLength: 2000 },
          learningObjective: { type: 'string', maxLength: 300 },
          cognitive: { enum: [...COGNITIVE] },
          difficulty: { type: 'number' },
          sourceIds: { type: 'array', items: { type: 'string' }, maxItems: 4 },
          explanation: { type: 'string', maxLength: 2000 },
          options: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 6 },
          correct: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 6 },
          value: { type: 'number' }, tolerance: { type: 'number' }, unit: { type: 'string', maxLength: 30 },
          answerExpr: { type: 'string', maxLength: 300 },
          expression: { type: 'string', maxLength: 300 },
          modelAnswer: { type: 'string', maxLength: 4000 },
          acceptable: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 6 },
          rubric: { type: 'array', items: CRITERION, maxItems: 6 },
        },
      },
    },
  },
}

export const GENERATION_TASKS: TaskDefinition[] = [{
  id: GENERATE_TASK, owner: 'education.tutor', category: 'assessment',
  requires: { operation: 'generate', structuredOutput: 'json_mode', minContext: 16000 },
  dataClass: 'course_content', determinism: 'flexible', fallback: 'eligible_only',
  outputSchema: GENERATE_SCHEMA, evalSuite: 'tutor/generate_items',
  defaults: { maxOutputTokens: 6000, temperature: 0.4, reasoning: 'medium' },
}]

export interface Candidate {
  type: GenType; stem: string; learningObjective: string; cognitive: string; difficulty: number; sourceIds: string[]; explanation: string
  options?: string[]; correct?: string[]; value?: number; tolerance?: number; unit?: string; answerExpr?: string; expression?: string
  modelAnswer?: string; acceptable?: string[]; rubric?: RubricCriterion[]
}

export function buildGeneratePrompt(o: { course: string; concept: string; description: string; count: number; types: GenType[]; difficulty: string; hits: SearchHit[]; avoid: string[] }) {
  return [
    {
      role: 'system' as const,
      content: [
        `You write assessment questions for the course "${o.course}", concept "${o.concept}"${o.description ? ` (${o.description})` : ''}.`,
        'Every question must be answerable from the COURSE MATERIAL below and must cite the SOURCE ids it is based on in "sourceIds". Do not test facts that are not in the material.',
        `Write ${o.count} questions. Allowed types: ${o.types.join(', ')}. Spread them across the allowed types and across cognitive levels (recall, understand, apply, transfer, explain): at least one should apply the idea to an unfamiliar real-world situation.`,
        `Target difficulty: ${o.difficulty} (difficulty is 0..1: 0.2 easy, 0.5 medium, 0.8 hard).`,
        'Type rules:',
        '- mcq: 4 options; "correct" lists the correct option(s) copied exactly from "options"; distractors must be plausible and reflect real misconceptions, never joke answers.',
        '- numeric: "value" is the exact answer; "answerExpr" is the calculation from the numbers in the stem that produces it (e.g. "12/3"); "tolerance" an absolute tolerance; "unit" optional.',
        '- expression: "expression" is the answer in plain maths (* ^ sqrt()).',
        '- short: one-line answer; "modelAnswer", "acceptable" (equivalent exact forms) and a 1-2 criterion "rubric".',
        '- descriptive: an explanation question; "modelAnswer" and a "rubric" of 2-5 criteria, each with id (c1, c2…), criterion, points (whole or half marks) and keyPoints a marker looks for.',
        'Each question needs a clear "learningObjective", a full worked "explanation" and must be unambiguous (one defensible answer). Do not reveal the answer in the stem.',
        o.avoid.length ? `Do NOT repeat or closely paraphrase these existing questions:\n${o.avoid.slice(0, 30).map((s) => `- ${s.slice(0, 160)}`).join('\n')}` : '',
        materialBlock(o.hits),
        'Return only JSON: {"items":[...]}.',
      ].filter(Boolean).join('\n'),
    },
    { role: 'user' as const, content: `Generate the ${o.count} questions now.` },
  ]
}

/** Numbers used in a calculation must come from the question itself (no hidden constants). */
/** Conversion factors a calculation may use without them appearing in the stem (powers, percent, time). */
const UNIT_CONSTANTS = new Set(['1', '2', '10', '100', '1000', '60', '3600'])
export function numbersFrom(s: string): Set<string> {
  return new Set((s.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n))))
}

export function toSpec(c: Candidate): AnswerSpec | null {
  switch (c.type) {
    case 'mcq': return c.options && c.correct ? { type: 'mcq', options: c.options.map((x) => x.trim()), correct: c.correct.map((x) => x.trim()) } : null
    case 'numeric': return typeof c.value === 'number' ? { type: 'numeric', value: c.value, tolerance: Math.max(0, c.tolerance ?? Math.abs(c.value) * 0.01), ...(c.unit ? { unit: c.unit } : {}) } : null
    case 'expression': return c.expression ? { type: 'expression', value: c.expression.trim() } : null
    case 'short': return c.modelAnswer && c.rubric ? { type: 'short', modelAnswer: c.modelAnswer, acceptable: (c.acceptable ?? []).map((a) => a.trim()).filter(Boolean), rubric: c.rubric } : null
    case 'descriptive': return c.modelAnswer && c.rubric ? { type: 'descriptive', modelAnswer: c.modelAnswer, rubric: c.rubric } : null
  }
}

/** Deterministic checks for one candidate (maths verification is added by the caller). */
export function checkCandidate(c: Candidate, o: { types: GenType[]; hits: SearchHit[]; existing: string[]; accepted: string[] }): { spec: AnswerSpec | null; problems: string[]; refs: SearchHit[] } {
  const problems: string[] = []
  if (!o.types.includes(c.type)) problems.push(`type ${c.type} was not requested`)
  const byId = new Map(o.hits.map((h) => [h.chunkId, h]))
  const refs = (c.sourceIds ?? []).map((id) => byId.get(id)).filter((h): h is SearchHit => !!h)
  if (!refs.length) problems.push('does not cite any of the retrieved course material')
  else {
    // the REASONING must be grounded in the material; the stem of an apply/transfer question deliberately uses
    // new real-world context, so it is not part of the check (seen live: good transfer questions were rejected)
    const transfer = c.cognitive === 'apply' || c.cognitive === 'transfer'
    const basis = `${c.explanation} ${c.modelAnswer ?? ''} ${transfer ? '' : c.stem}`
    if (groundingOverlap(basis, refs.map((r) => r.text)) < (transfer ? 0.15 : 0.2)) problems.push('not supported by the cited material (low overlap)')
  }
  if (!Number.isFinite(c.difficulty) || c.difficulty < 0 || c.difficulty > 1) problems.push('difficulty must be between 0 and 1')
  if (!(COGNITIVE as readonly string[]).includes(c.cognitive)) problems.push('unknown cognitive level')
  if (!c.explanation?.trim()) problems.push('missing explanation')
  if (o.existing.some((s) => stemSimilarity(s, c.stem) >= NEAR_DUPLICATE)) problems.push('near-duplicate of an existing question')
  else if (o.accepted.some((s) => stemSimilarity(s, c.stem) >= NEAR_DUPLICATE)) problems.push('near-duplicate of another generated question')
  const spec = toSpec(c)
  if (!spec) problems.push(`incomplete answer key for a ${c.type} question`)
  else {
    problems.push(...validateSpec(spec))
    if (spec.type === 'mcq') {
      if (spec.options.length < 3) problems.push('MCQ needs at least 3 options')
      if (spec.options.some((x) => !x)) problems.push('empty option')
      if (spec.correct.length === spec.options.length) problems.push('every option is marked correct')
    }
    if (spec.type === 'numeric') {
      if (!c.answerExpr?.trim()) problems.push('numeric answer has no calculation to verify')
      else {
        const given = numbersFrom(c.stem)
        const hidden = [...numbersFrom(c.answerExpr)].filter((n) => !given.has(n) && !UNIT_CONSTANTS.has(n))
        if (hidden.length) problems.push(`calculation uses numbers that are not in the question (${hidden.join(', ')})`)
      }
    }
    if (spec.type === 'short' || spec.type === 'descriptive') {
      const total = spec.rubric.reduce((a, r) => a + r.points, 0)
      if (spec.type === 'descriptive' && (spec.rubric.length < 2 || total < 2)) problems.push('descriptive rubric needs at least 2 criteria')
      if (spec.rubric.some((r) => !r.keyPoints.length)) problems.push('every rubric criterion needs key points')
    }
  }
  if (/\b(all|none) of the above\b/i.test(JSON.stringify(c.options ?? []))) problems.push('"all/none of the above" options are not allowed')
  return { spec, problems: [...new Set(problems)], refs }
}

export function generationRoutes(d: ModuleDeps): RouteDef[] {
  return [{
    method: 'POST', path: '/courses/:courseId/items/generate', permission: P.manage,
    handler: async ({ principal, params, body }) => {
      const courseId = uuid(params.courseId, 'courseId')
      const b = (body ?? {}) as Record<string, unknown>
      const conceptId = uuid(b.conceptId, 'conceptId')
      const count = Number(b.count ?? 5)
      if (!Number.isInteger(count) || count < 1 || count > 10) throw badRequest('count_invalid', 'count must be 1-10')
      const types = (Array.isArray(b.types) && b.types.length ? b.types : ['mcq', 'numeric', 'short', 'descriptive']).map(String) as GenType[]
      if (types.some((t) => !(GEN_TYPES as readonly string[]).includes(t))) throw badRequest('types_invalid', `types must be among ${GEN_TYPES.join(', ')}`)
      const difficulty = typeof b.difficulty === 'string' && ['easy', 'medium', 'hard', 'mixed'].includes(b.difficulty) ? b.difficulty : 'mixed'
      const ctx = await d.inTenant(principal, async (t) => {
        const course = await requireCourseEducator(t, principal, courseId)
        const c = (await t.query<{ name: string; description: string }>(`select name, description from education_tutor.concepts where id = $1 and course_id = $2 and status = 'approved'`, [conceptId, courseId])).rows[0]
        if (!c) throw notFound('Concept')
        const existing = (await t.query<{ stem: string }>('select stem from education_tutor.items where concept_id = $1 and retired_at is null', [conceptId])).rows.map((r) => r.stem)
        return { course, c, existing }
      })
      // authorisation first (above); only then report server capability
      if (!d.retrieval) throw new AppError('materials_unavailable', 'Course material search is not available on this server', { status: 503 })
      // approved material only: educator-verified course documents (student notes are never used)
      const found = await d.retrieval.search(principal, { scopes: [courseScope(courseId)], query: `${ctx.c.name}. ${ctx.c.description}`.slice(0, 1500), topK: 8 })
      const hits = found.hits.filter((h) => h.trust === 'verified_course')
      if (!hits.length) throw new AppError('no_material', 'No approved course material covers this concept yet. Upload course material first, then generate questions.', { status: 422 })
      const out = await d.ai(principal).run(GENERATE_TASK, { messages: buildGeneratePrompt({ course: ctx.course.title, concept: ctx.c.name, description: ctx.c.description, count, types, difficulty, hits, avoid: ctx.existing }) }, { promptVersion: GENERATE_PROMPT_VERSION })
      const candidates = ((out.json as { items: Candidate[] }).items ?? []).slice(0, count + 2)
      const accepted: { stem: string; spec: AnswerSpec; c: Candidate; refs: SearchHit[]; checks: string[] }[] = []
      const rejected: { stem: string; type: string; reasons: string[] }[] = []
      for (const c of candidates) {
        if (accepted.length >= count) break
        const r = checkCandidate(c, { types, hits, existing: ctx.existing, accepted: accepted.map((a) => a.stem) })
        const checks = ['grounded in cited course material', 'answer key well-formed', 'not a near-duplicate']
        if (!r.problems.length && r.spec) {
          // maths verification of answer keys (fail closed: unverifiable numeric/expression keys are rejected)
          if (r.spec.type === 'numeric') {
            const v = d.math ? await d.math.equivalent(c.answerExpr!, String(r.spec.value)).catch(() => null) : null
            if (!v?.ok) r.problems.push(v ? 'answer does not match its own calculation (maths check)' : 'answer could not be verified (maths service unavailable)')
            else checks.push(`answer recomputed by the maths engine (${c.answerExpr} = ${r.spec.value})`)
          }
          if (r.spec.type === 'expression') {
            const v = d.math ? await d.math.equivalent(r.spec.value, r.spec.value).catch(() => null) : null
            if (!v?.ok) r.problems.push('answer expression could not be parsed by the maths engine')
            else checks.push('answer expression parsed by the maths engine')
          }
        }
        if (r.problems.length || !r.spec) rejected.push({ stem: c.stem?.slice(0, 300) ?? '', type: c.type, reasons: r.problems })
        else accepted.push({ stem: c.stem, spec: r.spec, c, refs: r.refs, checks })
      }
      const ids = await d.inTenant(principal, async (t) => {
        await requireCourseEducator(t, principal, courseId)
        const stored: { id: string; stem: string; type: string }[] = []
        for (const a of accepted) {
          const row = (await t.query<{ id: string }>(
            `insert into education_tutor.items (tenant_id, course_id, concept_id, type, stem, answer_spec, explanation, difficulty, origin, status, learning_objective, cognitive, source_refs, validation)
             values (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, 'ai_generated', 'draft', $8, $9, $10, $11) returning id`,
            [courseId, conceptId, a.spec.type, a.stem.trim(), JSON.stringify(a.spec), a.c.explanation.trim(), Math.round(a.c.difficulty * 100) / 100, a.c.learningObjective.trim().slice(0, 300), a.c.cognitive,
              JSON.stringify(a.refs.map((h) => ({ chunkId: h.chunkId, documentId: h.documentId, filename: h.filename, pageStart: h.pageStart, pageEnd: h.pageEnd }))),
              JSON.stringify({ checks: a.checks, model: out.route?.modelId ?? null, promptVersion: GENERATE_PROMPT_VERSION, generatedAt: new Date().toISOString() })])).rows[0]!
          stored.push({ id: row.id, stem: a.stem, type: a.spec.type })
        }
        await d.audit(t, principal, { action: 'items.generated', targetType: 'concept', targetId: conceptId, metadata: { accepted: stored.length, rejected: rejected.length, operationId: out.operationId } })
        return stored
      })
      return { accepted: ids, rejected, sourcesUsed: hits.length }
    },
  }]
}
