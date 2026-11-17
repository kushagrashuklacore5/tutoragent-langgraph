/**
 * Spaced-repetition scheduling with the FSRS-4.5 model (open algorithm by J. Ye / open-spaced-repetition).
 * Implemented from the published FSRS-4.5 formulas with its default parameters. Status: unit- and
 * property-tested here; not yet cross-checked against the reference implementation's outputs (TODO
 * before pilot: golden tests from the reference library, or adopt it as a dependency).
 */

export type Grade = 1 | 2 | 3 | 4 // again, hard, good, easy

export interface CardState {
  stability: number // days
  difficulty: number // 1..10
  reps: number
  lapses: number
  lastReview: Date | null
  due: Date
}

export const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755] as const
const DECAY = -0.5
const FACTOR = 19 / 81
const w = (i: number) => W[i]!
const clampD = (d: number) => Math.min(10, Math.max(1, d))

export function retrievability(elapsedDays: number, stability: number): number {
  return Math.pow(1 + (FACTOR * elapsedDays) / stability, DECAY)
}
export function intervalDays(stability: number, desiredRetention = 0.9): number {
  return (stability / FACTOR) * (Math.pow(desiredRetention, 1 / DECAY) - 1)
}
const initDifficulty = (g: Grade) => clampD(w(4) - (g - 3) * w(5))

export function newCard(now: Date): CardState {
  return { stability: 0, difficulty: 0, reps: 0, lapses: 0, lastReview: null, due: now }
}

/** Apply a review and return the next state. Intervals are rounded to whole days, minimum 1 day. */
export function review(card: CardState, grade: Grade, now: Date, desiredRetention = 0.9, maxIntervalDays = 365): CardState {
  let stability: number
  let difficulty: number
  if (card.reps === 0 || card.stability <= 0) {
    stability = w(grade - 1)
    difficulty = initDifficulty(grade)
  } else {
    const elapsed = card.lastReview ? Math.max(0, (now.getTime() - card.lastReview.getTime()) / 86_400_000) : 0
    const r = retrievability(elapsed, card.stability)
    const d1 = card.difficulty - w(6) * (grade - 3)
    difficulty = clampD(w(7) * initDifficulty(3) + (1 - w(7)) * d1) // mean reversion
    if (grade === 1) {
      stability = w(11) * Math.pow(card.difficulty, -w(12)) * (Math.pow(card.stability + 1, w(13)) - 1) * Math.exp(w(14) * (1 - r))
      stability = Math.min(stability, card.stability) // a lapse never increases stability
    } else {
      const hardPenalty = grade === 2 ? w(15) : 1
      const easyBonus = grade === 4 ? w(16) : 1
      stability = card.stability * (Math.exp(w(8)) * (11 - card.difficulty) * Math.pow(card.stability, -w(9)) * (Math.exp(w(10) * (1 - r)) - 1) * hardPenalty * easyBonus + 1)
    }
  }
  const days = grade === 1 ? 1 : Math.min(maxIntervalDays, Math.max(1, Math.round(intervalDays(stability, desiredRetention))))
  return {
    stability,
    difficulty,
    reps: card.reps + 1,
    lapses: card.lapses + (grade === 1 && card.reps > 0 ? 1 : 0),
    lastReview: now,
    due: new Date(now.getTime() + days * 86_400_000),
  }
}
