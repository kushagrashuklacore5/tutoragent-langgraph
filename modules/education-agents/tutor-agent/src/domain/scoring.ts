/** Deterministic scoring for objective items (no AI). */

export type AnswerSpec =
  | { type: 'mcq'; correct: string[]; options: string[] }
  | { type: 'numeric'; value: number; tolerance: number; relative?: boolean; unit?: string }

export interface ScoreResult {
  outcome: number // 0..1
  correct: boolean
  feedbackKey: 'correct' | 'incorrect' | 'partially_correct' | 'invalid_response'
}

export function score(spec: AnswerSpec, response: unknown): ScoreResult {
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

/** Validate an educator-authored answer spec before an item can be served. */
export function validateSpec(spec: AnswerSpec): string[] {
  const p: string[] = []
  if (spec.type === 'mcq') {
    if (spec.options.length < 2) p.push('MCQ needs at least two options')
    if (new Set(spec.options).size !== spec.options.length) p.push('MCQ options must be distinct')
    if (!spec.correct.length || spec.correct.some((c) => !spec.options.includes(c))) p.push('correct answers must be among the options')
  } else {
    if (!Number.isFinite(spec.value)) p.push('numeric value must be finite')
    if (!(spec.tolerance >= 0)) p.push('tolerance must be >= 0')
  }
  return p
}
