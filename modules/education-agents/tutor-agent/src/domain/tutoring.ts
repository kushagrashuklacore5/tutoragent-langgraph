/**
 * Tutor orchestration rules (AI_TUTOR_DESIGN.md §§ 2–4). Deterministic: the model writes the words,
 * this code decides the teaching move, enforces the integrity policy and the source-labelling rules.
 */

export type IntegrityMode = 'open' | 'guided' | 'hint_only'
export type Move = 'ask' | 'hint' | 'explain' | 'worked_solution' | 'rescue_probe' | 'check'
export type SourceType = 'course' | 'general' | 'ai_example' | 'uncertain'
export type AttemptAssessment = 'correct' | 'partial' | 'incorrect' | 'not_an_attempt'

export interface SessionState {
  mode: 'socratic' | 'explain'
  hintLevel: number // 0..4
  attemptsAtStep: number
  rescueTarget: string | null
  graded: boolean
}

export interface TurnFlags {
  stuck?: boolean
  requestFullAnswer?: boolean
  hasProblem: boolean
}

export interface MoveDecision {
  move: Move
  hintLevel: number
  policyNote?: string
}

export const MAX_HINT = 4

/** Choose the next teaching move. Graded work (or hint-only courses) never gets a worked solution. */
export function chooseMove(s: SessionState, f: TurnFlags, integrity: IntegrityMode, rescueCandidate: string | null): MoveDecision {
  const hintOnly = integrity === 'hint_only' || s.graded
  if ((f.stuck || s.hintLevel >= 3) && rescueCandidate && !s.rescueTarget) return { move: 'rescue_probe', hintLevel: s.hintLevel }
  if (f.requestFullAnswer) {
    if (hintOnly) return { move: 'hint', hintLevel: Math.min(Math.max(s.hintLevel, 2), 3), policyNote: 'This is graded work, so I can give hints but not the full solution.' }
    if (integrity === 'open' || s.attemptsAtStep >= 2) return { move: 'worked_solution', hintLevel: MAX_HINT }
    return { move: 'hint', hintLevel: Math.min(s.hintLevel + 1, 3), policyNote: 'Have a go first — after two genuine attempts I can walk you through the full solution.' }
  }
  if (!f.hasProblem) return { move: 'explain', hintLevel: 0 }
  if (s.hintLevel === 0 && s.attemptsAtStep === 0) return { move: 'ask', hintLevel: 0 }
  return { move: 'hint', hintLevel: Math.min(s.hintLevel === 0 ? 1 : s.hintLevel, hintOnly ? 3 : MAX_HINT) }
}

/** Update state after the model assessed the student's attempt. Two failed attempts raise the hint level. */
export function advance(s: SessionState, decision: MoveDecision, assessment: AttemptAssessment): SessionState {
  const next = { ...s, hintLevel: decision.hintLevel }
  if (assessment === 'correct') return { ...next, attemptsAtStep: 0, hintLevel: 0, rescueTarget: null }
  if (assessment === 'incorrect' || assessment === 'partial') {
    next.attemptsAtStep = s.attemptsAtStep + 1
    if (next.attemptsAtStep >= 2 && next.hintLevel < MAX_HINT) next.hintLevel = next.hintLevel + 1
  }
  if (decision.move === 'rescue_probe') next.rescueTarget = s.rescueTarget
  return next
}

export interface Segment {
  text: string
  source: SourceType
  citations: string[]
}

/**
 * Enforce honest labelling: a `course` segment must cite at least one chunk from THIS turn's
 * retrieval set; otherwise it is relabelled `uncertain` (never silently kept as course material).
 */
export function verifySegments(segments: Segment[], allowedChunkIds: Set<string>): { segments: Segment[]; relabelled: number } {
  let relabelled = 0
  const out = segments.map((s) => {
    if (s.source !== 'course') return { ...s, citations: [] }
    const valid = s.citations.filter((c) => allowedChunkIds.has(c))
    if (!valid.length) {
      relabelled++
      return { text: s.text, source: 'uncertain' as const, citations: [] }
    }
    return { ...s, citations: valid }
  })
  return { segments: out, relabelled }
}

/** Outcome (0..1) recorded as evidence for an assessed attempt, or null when nothing was attempted. */
export function evidenceOutcome(a: AttemptAssessment): number | null {
  return a === 'correct' ? 1 : a === 'partial' ? 0.5 : a === 'incorrect' ? 0 : null
}
