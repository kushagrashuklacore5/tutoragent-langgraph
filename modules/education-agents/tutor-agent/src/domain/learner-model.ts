/**
 * Learner model (AI_TUTOR_DESIGN.md § 5). Pure and deterministic: the same evidence always yields the
 * same estimate. Estimates are derived from evidence and never edited by hand.
 *
 * Method: a Beta posterior over weighted evidence. Each observation adds `weight × outcome` to α and
 * `weight × (1 − outcome)` to β, with weights by evidence kind, hints used and age (exponential decay
 * whose horizon grows with successful spaced reviews). p = mean, interval = normal approximation.
 */

export type EvidenceKind = 'practice' | 'check' | 'teach_back' | 'diagnostic' | 'delayed_check' | 'self_report'

export interface Evidence {
  kind: EvidenceKind
  /** 0..1 (1 = fully correct) */
  outcome: number
  hintsUsed: number
  observedAt: Date
}

export interface MasteryEstimate {
  pMastery: number
  low: number
  high: number
  evidenceCount: number
  distinctDays: number
  unassistedCorrect: number
  state: 'insufficient_evidence' | 'learning' | 'mastered' | 'stale'
  explanation: string
  modelVersion: string
}

export const MODEL_VERSION = 'beta-weighted-v1'
const PRIOR = { a: 1, b: 1 }
const KIND_WEIGHT: Record<EvidenceKind, number> = { delayed_check: 1.5, practice: 1.0, diagnostic: 1.0, check: 1.0, teach_back: 0.8, self_report: 0.2 }
const BASE_HORIZON_DAYS = 14
/**
 * Max 95% interval width for "mastered". AI_TUTOR_DESIGN § 5 proposed 0.2, which needs ~35 answers per
 * concept under this model; 0.35 (about ±0.17) is used until pilot data calibrates it.
 */
export const MASTERY_MAX_INTERVAL = 0.35

const day = (d: Date) => d.toISOString().slice(0, 10)

export function evidenceWeight(e: Evidence, now: Date, horizonDays: number): number {
  const base = KIND_WEIGHT[e.kind] * (e.kind === 'practice' || e.kind === 'check' ? Math.max(0.2, 1 - 0.2 * e.hintsUsed) : 1)
  const ageDays = Math.max(0, (now.getTime() - e.observedAt.getTime()) / 86_400_000)
  return base * Math.pow(0.5, ageDays / horizonDays) // weight halves every horizon
}

/** Horizon grows with successful delayed checks (spaced retrieval strengthens memory). */
export function horizonDays(evidence: Evidence[]): number {
  const passedDelayed = evidence.filter((e) => e.kind === 'delayed_check' && e.outcome >= 0.8).length
  return BASE_HORIZON_DAYS * Math.pow(2, Math.min(passedDelayed, 4))
}

export function estimate(evidence: Evidence[], now = new Date()): MasteryEstimate {
  const h = horizonDays(evidence)
  let a = PRIOR.a
  let b = PRIOR.b
  for (const e of evidence) {
    const w = evidenceWeight(e, now, h)
    const o = Math.min(1, Math.max(0, e.outcome))
    a += w * o
    b += w * (1 - o)
  }
  const p = a / (a + b)
  const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)))
  const low = Math.max(0, p - 1.96 * sd)
  const high = Math.min(1, p + 1.96 * sd)
  const objective = evidence.filter((e) => e.kind !== 'self_report')
  const distinctDays = new Set(objective.map((e) => day(e.observedAt))).size
  const unassistedCorrect = objective.filter((e) => e.hintsUsed === 0 && e.outcome >= 0.8).length
  const latest = objective.reduce<Date | null>((m, e) => (!m || e.observedAt > m ? e.observedAt : m), null)
  const ageOfLatest = latest ? (now.getTime() - latest.getTime()) / 86_400_000 : Infinity

  let state: MasteryEstimate['state']
  if (objective.length < 3 || high - low > 0.4) state = 'insufficient_evidence'
  // "Mastered" needs strong, consistent, recent, spaced and unassisted evidence — never one quiz
  else if (p >= 0.85 && high - low <= MASTERY_MAX_INTERVAL && objective.length >= 4 && distinctDays >= 2 && unassistedCorrect >= 1) state = ageOfLatest > h ? 'stale' : 'mastered'
  else state = ageOfLatest > h ? 'stale' : 'learning'

  const correct = objective.filter((e) => e.outcome >= 0.8).length
  const explanation = objective.length === 0
    ? 'No answers yet for this concept.'
    : `Based on ${objective.length} answer${objective.length === 1 ? '' : 's'} over ${distinctDays} day${distinctDays === 1 ? '' : 's'} (${correct} correct, ${unassistedCorrect} without hints). ` +
      (state === 'insufficient_evidence' ? 'Not enough evidence yet to say.' : state === 'stale' ? 'It has been a while — a quick check will refresh this.' : state === 'mastered' ? 'Consistently strong.' : 'Still building.')
  return { pMastery: round(p), low: round(low), high: round(high), evidenceCount: objective.length, distinctDays, unassistedCorrect, state, explanation, modelVersion: MODEL_VERSION }
}

const round = (x: number) => Math.round(x * 1000) / 1000

/**
 * Prerequisite propagation: failing a concept does not lower the *mastery* of untested prerequisites
 * but marks them as probe candidates, ordered by how little evidence we have and how low it is.
 */
export function probeCandidates(prereqs: { conceptId: string; estimate: MasteryEstimate }[]): string[] {
  return prereqs
    .filter((p) => p.estimate.state !== 'mastered')
    .sort((x, y) => (x.estimate.evidenceCount - y.estimate.evidenceCount) || (x.estimate.pMastery - y.estimate.pMastery))
    .map((p) => p.conceptId)
}
