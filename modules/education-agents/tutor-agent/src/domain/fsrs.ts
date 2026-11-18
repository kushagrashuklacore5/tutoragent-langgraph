/**
 * Spaced-repetition scheduling with the FSRS-4.5 model (open algorithm by J. Ye / open-spaced-repetition)
 * and its default parameters.
 *
 * Verified against the reference implementation py-fsrs 2.5.1 (the last py-fsrs release implementing
 * FSRS-4.5; 3.x is FSRS-5): golden sequences in tests/fixtures/fsrs-4.5 (see its README), compared by
 * tests/fsrs-golden.unit.test.ts. Matches the reference's long-term ("Review state") path exactly:
 * whole elapsed days, no stability clamp after a lapse, and the hard ≤ good < easy interval ordering.
 *
 * Product deviation (documented, not a model difference): there are no same-day learning/relearning
 * steps. A first review schedules `next_interval(S)` days and "again" schedules 1 day, where the
 * reference would use minute-level learning steps. Memory state (S, D) is identical.
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
const FACTOR = 19 / 81 // = 0.9^(1/DECAY) − 1
const DAY_MS = 86_400_000
const w = (i: number) => W[i]!
const clampD = (d: number) => Math.min(10, Math.max(1, d))
/** Python's round() (half to even), so intervals match the reference on exact .5 values too. */
const roundHalfEven = (x: number) => {
  const r = Math.round(x)
  return Math.abs(x - Math.trunc(x)) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

export function retrievability(elapsedDays: number, stability: number): number {
  return Math.pow(1 + (FACTOR * elapsedDays) / stability, DECAY)
}
/** Unrounded interval (days) at which retrievability falls to `desiredRetention`. */
export function intervalDays(stability: number, desiredRetention = 0.9): number {
  return (stability / FACTOR) * (Math.pow(desiredRetention, 1 / DECAY) - 1)
}
/** Scheduled interval in whole days, as the reference `next_interval`. */
export function nextInterval(stability: number, desiredRetention = 0.9, maxIntervalDays = 36500): number {
  return Math.min(Math.max(roundHalfEven(intervalDays(stability, desiredRetention)), 1), maxIntervalDays)
}
export const initStability = (g: Grade) => Math.max(w(g - 1), 0.1)
export const initDifficulty = (g: Grade) => clampD(w(4) - (g - 3) * w(5))
/** Difficulty update with mean reversion towards the initial "good" difficulty (w4). */
export const nextDifficulty = (d: number, g: Grade) => clampD(w(7) * w(4) + (1 - w(7)) * (d - w(6) * (g - 3)))
export function nextRecallStability(d: number, s: number, r: number, g: 2 | 3 | 4): number {
  const hardPenalty = g === 2 ? w(15) : 1
  const easyBonus = g === 4 ? w(16) : 1
  return s * (1 + Math.exp(w(8)) * (11 - d) * Math.pow(s, -w(9)) * (Math.exp((1 - r) * w(10)) - 1) * hardPenalty * easyBonus)
}
export function nextForgetStability(d: number, s: number, r: number): number {
  return w(11) * Math.pow(d, -w(12)) * (Math.pow(s + 1, w(13)) - 1) * Math.exp((1 - r) * w(14))
}

export function newCard(now: Date): CardState {
  return { stability: 0, difficulty: 0, reps: 0, lapses: 0, lastReview: null, due: now }
}

/** Whole days between reviews, as the reference (`timedelta.days`: floor). */
export const elapsedWholeDays = (from: Date, to: Date) => Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS))

/** Apply a review and return the next state. Intervals are whole days, minimum 1 day. */
export function review(card: CardState, grade: Grade, now: Date, desiredRetention = 0.9, maxIntervalDays = 365): CardState {
  let stability: number
  let difficulty: number
  let days: number
  if (card.reps === 0 || card.stability <= 0) {
    stability = initStability(grade)
    difficulty = initDifficulty(grade)
    days = grade === 1 ? 1 : nextInterval(stability, desiredRetention, maxIntervalDays)
  } else {
    const r = retrievability(card.lastReview ? elapsedWholeDays(card.lastReview, now) : 0, card.stability)
    difficulty = nextDifficulty(card.difficulty, grade)
    const s = { 2: nextRecallStability(card.difficulty, card.stability, r, 2), 3: nextRecallStability(card.difficulty, card.stability, r, 3), 4: nextRecallStability(card.difficulty, card.stability, r, 4) }
    let hard = nextInterval(s[2], desiredRetention, maxIntervalDays)
    let good = nextInterval(s[3], desiredRetention, maxIntervalDays)
    hard = Math.min(hard, good)
    good = Math.max(good, hard + 1)
    const easy = Math.max(nextInterval(s[4], desiredRetention, maxIntervalDays), good + 1)
    if (grade === 1) {
      stability = nextForgetStability(card.difficulty, card.stability, r)
      days = 1
    } else {
      stability = s[grade]
      days = grade === 2 ? hard : grade === 3 ? good : easy
    }
  }
  return {
    stability,
    difficulty,
    reps: card.reps + 1,
    lapses: card.lapses + (grade === 1 && card.reps > 0 ? 1 : 0),
    lastReview: now,
    due: new Date(now.getTime() + days * DAY_MS),
  }
}
