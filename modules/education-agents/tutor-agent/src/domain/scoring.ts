/** Deterministic scoring for objective items (no AI). */

export type AnswerSpec =
  | { type: 'mcq'; correct: string[]; options: string[] }
  | { type: 'numeric'; value: number; tolerance: number; relative?: boolean; unit?: string }
  /** symbolic answer, checked for mathematical equivalence by the maths service (never by string match) */
  | { type: 'expression'; value: string; assume?: 'complex' | 'real' | 'positive' }
  /** short answer: exact `acceptable` forms score full marks deterministically; otherwise rubric-marked */
  | { type: 'short'; modelAnswer: string; acceptable: string[]; rubric: RubricCriterion[] }
  /** descriptive / long-form: rubric-marked (validated AI marking, educator review when uncertain) */
  | { type: 'descriptive'; modelAnswer: string; rubric: RubricCriterion[] }

export interface RubricCriterion { id: string; criterion: string; points: number; keyPoints: string[] }
export type ObjectiveSpec = Extract<AnswerSpec, { type: 'mcq' | 'numeric' }>
export const isRubricSpec = (s: AnswerSpec): s is Extract<AnswerSpec, { type: 'short' | 'descriptive' }> => s.type === 'short' || s.type === 'descriptive'
/** Points an item is worth: rubric total for rubric items, 1 otherwise. */
export const itemPoints = (s: AnswerSpec) => (isRubricSpec(s) ? s.rubric.reduce((a, c) => a + c.points, 0) : 1)
/** Normalised exact match for short answers ("F = m a" ≡ "f=ma"). */
export const sameShortAnswer = (a: string, b: string) => a.toLowerCase().replace(/[\s.,;:!?'"`]+/g, '') === b.toLowerCase().replace(/[\s.,;:!?'"`]+/g, '')

export interface ScoreResult {
  outcome: number // 0..1
  correct: boolean
  feedbackKey: 'correct' | 'incorrect' | 'partially_correct' | 'invalid_response'
}

export function score(spec: ObjectiveSpec, response: unknown): ScoreResult {
  if (spec.type === 'mcq') {
    const chosen = Array.isArray(response) ? response.map(String) : typeof response === 'string' ? [response] : null
    if (!chosen || !chosen.every((c) => spec.options.includes(c))) return { outcome: 0, correct: false, feedbackKey: 'invalid_response' }
    const right = new Set(spec.correct)
    const hits = chosen.filter((c) => right.has(c)).length
    const wrong = chosen.length - hits
    if (hits === right.size && wrong === 0) return { outcome: 1, correct: true, feedbackKey: 'correct' }
    const partial = Math.max(0, (hits - wrong) / right.size)
    return { outcome: right.size > 1 ? partial : 0, correct: false, feedbackKey: partial > 0 && right.size > 1 ? 'partially_correct' : 'incorrect' }
  }
  const n = typeof response === 'number' ? response : typeof response === 'string' ? Number(response.replace(/,/g, '').trim()) : NaN
  if (!Number.isFinite(n)) return { outcome: 0, correct: false, feedbackKey: 'invalid_response' }
  const tol = spec.relative ? Math.abs(spec.value) * spec.tolerance : spec.tolerance
  const ok = Math.abs(n - spec.value) <= tol
  return { outcome: ok ? 1 : 0, correct: ok, feedbackKey: ok ? 'correct' : 'incorrect' }
}

/** The part of the maths checker that expression scoring needs (see @platform/math-client). */
export interface EquivalenceChecker {
  equivalent(a: string, b: string, opts?: { assume?: 'complex' | 'real' | 'positive' }): Promise<{ ok: boolean; verdict: string; reason: string }>
}

export const MAX_EXPRESSION = 500
const EXPR = /^[\p{L}\p{N}\s+\-*/^().,=_<>!|]+$/u

/**
 * Score a symbolic answer. Fail closed: only a definite verdict from the maths service grades the
 * attempt; `null` means it could not be checked (service down, timeout, inconclusive proof) and the
 * attempt must not be recorded or shown as right or wrong.
 */
export async function scoreExpression(math: EquivalenceChecker, spec: Extract<AnswerSpec, { type: 'expression' }>, response: unknown): Promise<ScoreResult | null> {
  const r = typeof response === 'string' ? response.trim() : ''
  if (!r || r.length > MAX_EXPRESSION || !EXPR.test(r)) return { outcome: 0, correct: false, feedbackKey: 'invalid_response' }
  const v = await math.equivalent(r, spec.value, spec.assume ? { assume: spec.assume } : undefined)
  if (v.ok) return { outcome: 1, correct: true, feedbackKey: 'correct' }
  if (v.verdict === 'fail') return { outcome: 0, correct: false, feedbackKey: 'incorrect' }
  if (v.verdict === 'invalid') return { outcome: 0, correct: false, feedbackKey: 'invalid_response' }
  return null
}

/** Validate an educator-authored answer spec before an item can be served. */
export function validateSpec(spec: AnswerSpec): string[] {
  const p: string[] = []
  if (spec.type === 'mcq') {
    if (spec.options.length < 2) p.push('MCQ needs at least two options')
    if (new Set(spec.options).size !== spec.options.length) p.push('MCQ options must be distinct')
    if (!spec.correct.length || spec.correct.some((c) => !spec.options.includes(c))) p.push('correct answers must be among the options')
  } else if (spec.type === 'short' || spec.type === 'descriptive') {
    if (typeof spec.modelAnswer !== 'string' || !spec.modelAnswer.trim() || spec.modelAnswer.length > 8000) p.push('a model answer is required (max 8000 chars)')
    if (!Array.isArray(spec.rubric) || !spec.rubric.length || spec.rubric.length > 10) p.push('rubric needs 1-10 criteria')
    else {
      const ids = new Set<string>()
      for (const c of spec.rubric) {
        if (!c || typeof c.id !== 'string' || !/^[a-z0-9_-]{1,20}$/i.test(c.id) || ids.has(c.id)) p.push('each criterion needs a unique short id')
        else ids.add(c.id)
        if (!c || typeof c.criterion !== 'string' || !c.criterion.trim() || c.criterion.length > 500) p.push('each criterion needs a description')
        if (!c || !Number.isFinite(c.points) || c.points <= 0 || c.points > 20 || (c.points * 2) % 1 !== 0) p.push('criterion points must be 0.5-20 in half marks')
        if (!c || !Array.isArray(c.keyPoints) || c.keyPoints.some((k) => typeof k !== 'string')) p.push('keyPoints must be a list of strings')
      }
    }
    if (spec.type === 'short' && (!Array.isArray(spec.acceptable) || spec.acceptable.some((a) => typeof a !== 'string' || a.length > 300))) p.push('acceptable answers must be short strings')
  } else if (spec.type === 'expression') {
    if (typeof spec.value !== 'string' || !spec.value.trim() || spec.value.length > MAX_EXPRESSION || !EXPR.test(spec.value)) p.push(`expression answer must be 1-${MAX_EXPRESSION} characters of maths notation`)
    if (spec.assume !== undefined && !['complex', 'real', 'positive'].includes(spec.assume)) p.push('assume must be complex|real|positive')
  } else {
    if (!Number.isFinite(spec.value)) p.push('numeric value must be finite')
    if (!(spec.tolerance >= 0)) p.push('tolerance must be >= 0')
  }
  return p
}
