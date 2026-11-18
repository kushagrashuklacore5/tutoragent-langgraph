import { AppError } from '@platform/core'
import { mean, meanInterval, wilson, type Interval } from './stats.ts'

/**
 * Learning-outcome metrics (offline analysis of consented study results — NOT CI gates).
 * AI_EVALUATION_FRAMEWORK.md § 1 and the Tutor's EVALUATION_AND_TESTING.md § 4. Scores are
 * fractions of the maximum (0..1) unless `max` is given.
 */

export interface PrePost {
  learnerId: string
  pre: number
  post: number
}

function checkScores(values: number[], max: number) {
  if (!(max > 0)) throw new AppError('outcome_invalid', 'max must be positive')
  for (const v of values) if (!Number.isFinite(v) || v < 0 || v > max) throw new AppError('outcome_invalid', `score ${v} outside [0, ${max}]`)
}

export interface GainResult {
  n: number
  meanPre: number
  meanPost: number
  /** Hake's class-average normalized gain: (mean post − mean pre) / (max − mean pre) */
  classGain: number
  /** mean of per-learner gains (learners already at max pre are excluded: gain undefined) */
  meanIndividualGain: number
  individualInterval: Interval
  excludedAtCeiling: number
}

/** Pre/post normalized gain (Hake). */
export function normalizedGain(rows: PrePost[], max = 1): GainResult {
  if (!rows.length) throw new AppError('outcome_invalid', 'no pre/post pairs')
  checkScores(rows.flatMap((r) => [r.pre, r.post]), max)
  const meanPre = mean(rows.map((r) => r.pre))
  const meanPost = mean(rows.map((r) => r.post))
  const usable = rows.filter((r) => r.pre < max)
  const gains = usable.map((r) => (r.post - r.pre) / (max - r.pre))
  return {
    n: rows.length, meanPre, meanPost,
    classGain: meanPre >= max ? NaN : (meanPost - meanPre) / (max - meanPre),
    meanIndividualGain: mean(gains), individualInterval: meanInterval(gains), excludedAtCeiling: rows.length - usable.length,
  }
}

export interface RetentionRow {
  learnerId: string
  post: number
  /** re-test 2–4 weeks after the unit */
  delayed: number
}

/** Delayed retention: share of the immediate post-test score kept at the delayed test (per learner, then averaged). */
export function delayedRetention(rows: RetentionRow[], max = 1): { n: number; meanRetention: number; interval: Interval; meanDrop: number; excludedZeroPost: number } {
  checkScores(rows.flatMap((r) => [r.post, r.delayed]), max)
  const usable = rows.filter((r) => r.post > 0)
  const ratios = usable.map((r) => Math.min(r.delayed / r.post, 1.5))
  return { n: usable.length, meanRetention: mean(ratios), interval: meanInterval(ratios), meanDrop: mean(rows.map((r) => (r.post - r.delayed) / max)), excludedZeroPost: rows.length - usable.length }
}

export interface ItemResponse {
  learnerId: string
  itemId: string
  correct: boolean
  /** near (practised format) or transfer (novel, tutor-off) item */
  kind: 'near' | 'transfer'
}

/** Transfer performance: success rate on tutor-off novel items, with the near-item rate for comparison. */
export function transferPerformance(responses: ItemResponse[]): { transfer: { rate: number; n: number; interval: Interval }; near: { rate: number; n: number; interval: Interval }; transferRatio: number } {
  const part = (k: ItemResponse['kind']) => {
    const rs = responses.filter((r) => r.kind === k)
    const c = rs.filter((r) => r.correct).length
    return { rate: rs.length ? c / rs.length : NaN, n: rs.length, interval: wilson(c, rs.length) }
  }
  const transfer = part('transfer')
  const near = part('near')
  return { transfer, near, transferRatio: near.rate > 0 ? transfer.rate / near.rate : NaN }
}

export interface ConfidenceRating {
  /** learner's stated probability of being right (0..1) */
  confidence: number
  correct: boolean
}

export interface CalibrationResult {
  n: number
  /** mean squared error of confidence vs outcome (0 = perfect; 0.25 = always saying 0.5) */
  brier: number
  /** expected calibration error over equal-width bins */
  ece: number
  /** mean confidence − accuracy (positive = overconfident) */
  overconfidence: number
  bins: { low: number; high: number; n: number; meanConfidence: number; accuracy: number }[]
}

/** Calibration of confidence taps: Brier score, ECE and a reliability table. */
export function calibration(ratings: ConfidenceRating[], binCount = 5): CalibrationResult {
  if (!ratings.length) throw new AppError('outcome_invalid', 'no ratings')
  for (const r of ratings) if (!(r.confidence >= 0 && r.confidence <= 1)) throw new AppError('outcome_invalid', `confidence ${r.confidence} outside [0, 1]`)
  const y = (r: ConfidenceRating) => (r.correct ? 1 : 0)
  const brier = mean(ratings.map((r) => (r.confidence - y(r)) ** 2))
  const bins = Array.from({ length: binCount }, (_, i) => {
    const low = i / binCount
    const high = (i + 1) / binCount
    const rs = ratings.filter((r) => r.confidence >= low && (i === binCount - 1 ? r.confidence <= high : r.confidence < high))
    return { low, high, n: rs.length, meanConfidence: rs.length ? mean(rs.map((r) => r.confidence)) : NaN, accuracy: rs.length ? mean(rs.map(y)) : NaN }
  })
  const ece = bins.filter((b) => b.n).reduce((a, b) => a + (b.n / ratings.length) * Math.abs(b.meanConfidence - b.accuracy), 0)
  return { n: ratings.length, brier, ece, overconfidence: mean(ratings.map((r) => r.confidence)) - mean(ratings.map(y)), bins }
}
