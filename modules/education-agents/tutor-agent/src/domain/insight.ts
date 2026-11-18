/**
 * Learner intelligence (deterministic). The AI may *propose* an error type; these rules decide what is
 * recorded, and every profile figure and recommendation is computed from stored evidence — never typed
 * in by a model. Same inputs → same outputs.
 */
import { horizonDays, type Evidence, type MasteryEstimate } from './learner-model.ts'

export const ERROR_TYPES = ['conceptual', 'procedural', 'calculation', 'interpretation', 'prerequisite', 'careless', 'unknown'] as const
export type ErrorType = typeof ERROR_TYPES[number]

const DAY = 86_400_000
export const RECURRING_WINDOW_DAYS = 14

/**
 * Careless slip vs genuine misunderstanding. A calculation/procedural error by a student who has shown
 * the concept independently (≥ 2 unassisted correct answers, mastery ≥ 0.7) is a slip; the same error
 * type on the same concept twice within 14 days is recurring (and never a slip).
 */
/** Content-word overlap (Jaccard) of two short misconception statements, 0..1. */
export function misconceptionSimilarity(a: string, b: string): number {
  const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 4)))  // crude stem: dividing/division, multiply/multiplication
  const x = words(a), y = words(b)
  if (!x.size || !y.size) return 0
  let inter = 0
  for (const w of x) if (y.has(w)) inter++
  return inter / (x.size + y.size - inter)
}
const STOP = new Set(['the', 'and', 'for', 'student', 'thinks', 'that', 'instead', 'with', 'from', 'when', 'this', 'are', 'was', 'not', 'has', 'have', 'into', 'than'])
export const SAME_MISCONCEPTION = 0.25

export function classifyError(aiType: string, est: Pick<MasteryEstimate, 'pMastery' | 'unassistedCorrect'>, recentTypes: { type: ErrorType; at: Date; misconception?: string }[], now = new Date(), misconception = ''): { errorType: ErrorType; recurring: boolean } {
  const proposed: ErrorType = (ERROR_TYPES as readonly string[]).includes(aiType) && aiType !== 'careless' ? aiType as ErrorType : 'unknown'
  const recent = recentTypes.filter((r) => now.getTime() - r.at.getTime() <= RECURRING_WINDOW_DAYS * DAY)
  // recurring = the same kind of error again, or the same misconception again under a different label
  const recurring = (proposed !== 'unknown' && recent.some((r) => r.type === proposed))
    || (!!misconception && recent.some((r) => !!r.misconception && misconceptionSimilarity(r.misconception, misconception) >= SAME_MISCONCEPTION))
  const slipCandidate = proposed === 'calculation' || proposed === 'procedural'
  if (!recurring && slipCandidate && est.unassistedCorrect >= 2 && est.pMastery >= 0.7) return { errorType: 'careless', recurring: false }
  return { errorType: proposed, recurring }
}

export interface AttemptFact { conceptId: string; correct: boolean; confidence: string | null; hintsUsed: number; at: Date }
export interface ConceptProfile {
  conceptId: string; name: string
  mastery: Pick<MasteryEstimate, 'pMastery' | 'state' | 'evidenceCount' | 'unassistedCorrect'>
  /** share of correct answers that needed hints (null: no correct answers yet) */
  hintDependency: number | null
  /** 0..1: how much of the memory horizon has elapsed since the last evidence (1 = likely forgotten) */
  forgettingRisk: number | null
  /** sureWrong/unsureRight/rated: all time. unresolvedSureWrong: confident errors among the last 10 rated answers that
   *  are newer than the latest run of 3 consecutive confident-correct answers (i.e. not yet shown to be fixed). */
  calibration: { sureWrong: number; unsureRight: number; rated: number; unresolvedSureWrong: number }
  errorTypes: Partial<Record<ErrorType, number>>
  recurringMisconceptions: string[]
  transfer: { attempted: number; passed: number }
}

const RESOLVED_STREAK = 3
const CALIBRATION_WINDOW = 10
function unresolvedSureWrong(rated: AttemptFact[]): number {
  let wrong = 0, streak = 0
  for (const a of [...rated].sort((x, y) => y.at.getTime() - x.at.getTime()).slice(0, CALIBRATION_WINDOW)) {
    if (a.confidence !== 'sure') continue
    if (a.correct) { if (++streak >= RESOLVED_STREAK) break } else { wrong++; streak = 0 }
  }
  return wrong
}

/** Per-concept profile from evidence, attempts and diagnoses. */
export function conceptProfile(input: {
  conceptId: string; name: string; est: MasteryEstimate; evidence: Evidence[]; attempts: AttemptFact[]
  diagnoses: { errorType: ErrorType; recurring: boolean; misconception: string }[]
  transfer: { passed: boolean }[]; now?: Date
}): ConceptProfile {
  const now = input.now ?? new Date()
  const correct = input.attempts.filter((a) => a.correct)
  const rated = input.attempts.filter((a) => a.confidence)
  const objective = input.evidence.filter((e) => e.kind !== 'self_report')
  const last = objective.reduce<number | null>((m, e) => Math.max(m ?? 0, e.observedAt.getTime()), null)
  const h = horizonDays(input.evidence)
  const errorTypes: ConceptProfile['errorTypes'] = {}
  for (const d of input.diagnoses) errorTypes[d.errorType] = (errorTypes[d.errorType] ?? 0) + 1
  return {
    conceptId: input.conceptId, name: input.name,
    mastery: { pMastery: input.est.pMastery, state: input.est.state, evidenceCount: input.est.evidenceCount, unassistedCorrect: input.est.unassistedCorrect },
    hintDependency: correct.length ? round(correct.filter((a) => a.hintsUsed > 0).length / correct.length) : null,
    forgettingRisk: last === null ? null : round(1 - Math.pow(0.5, (now.getTime() - last) / DAY / h)),
    calibration: { sureWrong: rated.filter((a) => a.confidence === 'sure' && !a.correct).length, unsureRight: rated.filter((a) => a.confidence !== 'sure' && a.correct).length, rated: rated.length, unresolvedSureWrong: unresolvedSureWrong(rated) },
    errorTypes,
    recurringMisconceptions: [...new Set(input.diagnoses.filter((d) => d.recurring && d.misconception).map((d) => d.misconception))].slice(0, 5),
    transfer: { attempted: input.transfer.length, passed: input.transfer.filter((t) => t.passed).length },
  }
}

export type NextAction = 'revise_due_cards' | 'repair_misconception' | 'review_prerequisite' | 'diagnostic_practice' | 'guided_practice'
  | 'independent_practice' | 'transfer_challenge' | 'learn_new' | 'refresh_fading' | 'advanced_challenge'
export interface Recommendation { action: NextAction; conceptId: string | null; conceptName: string | null; reason: string; minutes: number }

/**
 * Next-best learning action. Order of precedence (first match wins), each with a stated reason:
 * due reviews → recurring misconception → weak prerequisite of the target → fading concept →
 * too little evidence → hint-dependent → independent practice → transfer → new concept → challenge.
 * The target concept is the plan's first unmastered concept (prerequisites before dependants).
 */
export function nextAction(input: {
  concepts: { id: string; name: string; prerequisites: string[]; examWeight: number }[]
  profiles: Map<string, ConceptProfile>
  dueCards: number
  examInDays: number | null
}): Recommendation {
  const p = (id: string) => input.profiles.get(id)
  const name = (id: string) => input.concepts.find((c) => c.id === id)?.name ?? null
  const rec = (action: NextAction, conceptId: string | null, reason: string, minutes: number): Recommendation => ({ action, conceptId, conceptName: conceptId ? name(conceptId) : null, reason, minutes })

  if (input.dueCards >= 5 || (input.dueCards > 0 && input.examInDays !== null && input.examInDays <= 7)) {
    return rec('revise_due_cards', null, `${input.dueCards} revision card${input.dueCards === 1 ? ' is' : 's are'} due — reviewing now keeps them from being forgotten.`, Math.min(20, 2 * input.dueCards + 3))
  }
  const recurring = input.concepts.map((c) => p(c.id)).find((x) => x && x.recurringMisconceptions.length)
  if (recurring) return rec('repair_misconception', recurring.conceptId, `The same kind of mistake has come up more than once in ${recurring.name}: "${recurring.recurringMisconceptions[0]}". Let's fix the idea behind it.`, 15)

  // target: highest-weight concept not yet mastered whose prerequisites are being handled first
  const unmastered = input.concepts.filter((c) => p(c.id)?.mastery.state !== 'mastered')
    .sort((a, b) => b.examWeight * (1 - (p(b.id)?.mastery.pMastery ?? 0.5)) - a.examWeight * (1 - (p(a.id)?.mastery.pMastery ?? 0.5)))
  for (const c of unmastered) {
    const weakPre = c.prerequisites.map((id) => p(id)).find((x) => x && x.mastery.state !== 'mastered' && x.mastery.pMastery < 0.6 && x.mastery.evidenceCount > 0)
    if (weakPre) return rec('review_prerequisite', weakPre.conceptId, `${c.name} builds on ${weakPre.name}, which isn't secure yet (${pct(weakPre.mastery.pMastery)}).`, 15)
  }
  const fading = input.concepts.map((c) => p(c.id)).filter((x): x is ConceptProfile => !!x && (x.mastery.state === 'stale' || (x.forgettingRisk ?? 0) >= 0.6) && x.mastery.evidenceCount > 0)
    .sort((a, b) => (b.forgettingRisk ?? 0) - (a.forgettingRisk ?? 0))[0]
  if (fading && (input.examInDays === null || input.examInDays <= 21 || fading.mastery.state === 'stale')) return rec('refresh_fading', fading.conceptId, `${fading.name} hasn't been practised for a while and is likely fading — a quick check will refresh it.`, 10)

  const target = unmastered[0]
  if (target) {
    const t = p(target.id)
    if (!t || t.mastery.evidenceCount === 0) return rec('learn_new', target.id, `${target.name} is next: it carries weight in your course and you haven't started it.`, 25)
    // confident mistakes and hint dependence say more than "not enough evidence" once there is some evidence
    if (t.calibration.unresolvedSureWrong >= 2) return rec('guided_practice', target.id, `You were sure on answers in ${target.name} that turned out wrong — let's check the reasoning step by step.`, 15)
    if ((t.hintDependency ?? 0) >= 0.5) return rec('guided_practice', target.id, `You get ${target.name} right mostly with hints — guided practice will build independence.`, 15)
    if (t.mastery.state === 'insufficient_evidence') {
      return rec('diagnostic_practice', target.id, t.mastery.evidenceCount >= 5
        ? `Your results on ${target.name} are mixed so far — a few more questions will pin down where you are.`
        : `A few questions on ${target.name} will show what you already know.`, 10)
    }
    if (t.transfer.attempted === 0 && t.mastery.pMastery >= 0.7) return rec('transfer_challenge', target.id, `You're doing well on ${target.name}; try it in an unfamiliar situation to make sure it transfers.`, 10)
    return rec('independent_practice', target.id, `Practise ${target.name} without hints to strengthen it (${pct(t.mastery.pMastery)} now).`, 15)
  }
  const strongest = input.concepts.map((c) => p(c.id)).filter((x): x is ConceptProfile => !!x).sort((a, b) => b.mastery.pMastery - a.mastery.pMastery)[0]
  return rec('advanced_challenge', strongest?.conceptId ?? null, 'Everything here is mastered — take on a harder, applied problem.', 20)
}

const pct = (x: number) => `${Math.round(x * 100)}%`
const round = (x: number) => Math.round(x * 1000) / 1000
