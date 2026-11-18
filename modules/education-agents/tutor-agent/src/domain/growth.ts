/**
 * Growth (healthy gamification) and learning-outcome measurement (pure, unit-tested).
 * Rewards come ONLY from validated learning events: unaided correct answers, improvement over a personal best,
 * mastery level-ups, honest confidence, completed revision and plan tasks, consistency. Never speed or raw rank.
 * Streaks forgive rest days (up to 2 per rolling week), so a day off never "breaks" anything.
 */
export interface LearningEvent {
  at: Date
  kind: 'answer' | 'revision' | 'task_done' | 'assessment' | 'delayed_check' | 'lesson'
  conceptId?: string | null
  correct?: boolean
  hints?: number
  confidence?: 'sure' | 'unsure' | 'guess' | null
  transfer?: boolean
  /** assessments: score fraction and which assessment */
  frac?: number
  assessmentId?: string
  purpose?: string | null
}
export interface ConceptLevel { conceptId: string; name: string; pMastery: number; state: string }

export const LEVELS = ['New', 'Started', 'Developing', 'Solid', 'Mastered'] as const
export const levelOf = (pMastery: number, state: string) => (state === 'mastered' ? 4 : pMastery >= 0.65 ? 3 : pMastery >= 0.4 ? 2 : pMastery > 0.15 ? 1 : 0)

const day = (d: Date) => d.toISOString().slice(0, 10)
const DAY = 86_400_000

export function streak(events: LearningEvent[], now: Date): { days: number; restDaysUsed: number; studiedThisWeek: number } {
  const days = new Set(events.map((e) => day(e.at)))
  let d = new Date(now)
  if (!days.has(day(d))) d = new Date(d.getTime() - DAY) // today not studied yet: count from yesterday
  let count = 0, rest = 0, pending = 0
  const window: boolean[] = []
  for (let i = 0; i < 400; i++) {
    const studied = days.has(day(d))
    window.push(studied)
    if (window.length > 7) window.shift()
    if (studied) { count++; rest += pending; pending = 0 }
    else {
      const restInWeek = window.filter((x) => !x).length
      if (restInWeek > 2 || count === 0) break
      pending++ // a rest day only counts when study continues on the other side of it
    }
    d = new Date(d.getTime() - DAY)
  }
  const weekAgo = now.getTime() - 7 * DAY
  return { days: count, restDaysUsed: rest, studiedThisWeek: new Set(events.filter((e) => e.at.getTime() > weekAgo).map((e) => day(e.at))).size }
}

export interface Badge { id: string; title: string; why: string; earnedAt: string }
export interface Growth {
  xp: number
  xpBreakdown: { reason: string; xp: number }[]
  levels: (ConceptLevel & { level: number; label: string })[]
  streak: ReturnType<typeof streak>
  badges: Badge[]
  personalBests: { assessmentId: string; best: number; latest: number; attempts: number; improved: boolean }[]
  improvementPoints: number
}

export function computeGrowth(events: LearningEvent[], concepts: ConceptLevel[], now: Date): Growth {
  const ev = [...events].sort((a, b) => a.at.getTime() - b.at.getTime())
  const b: Record<string, number> = {}
  const add = (reason: string, x: number) => { b[reason] = (b[reason] ?? 0) + x }
  for (const e of ev) {
    if (e.kind === 'answer' && e.correct) add(e.hints ? 'Correct with hints' : 'Correct on your own', e.hints ? 2 : 5)
    if (e.kind === 'answer' && e.correct && e.transfer) add('Applied it to a new situation', 5)
    if (e.kind === 'answer' && !e.correct && e.confidence && e.confidence !== 'sure') add('Honest "not sure" on a hard one', 1)
    if (e.kind === 'revision') add('Revision done', 2)
    if (e.kind === 'task_done') add('Plan milestone completed', 15)
    if (e.kind === 'delayed_check' && e.correct) add('Remembered after weeks', 10)
    if (e.kind === 'lesson') add('Lesson studied', 3)
  }
  // personal bests: improvement over your own previous best (never vs others)
  const byAssessment = new Map<string, number[]>()
  for (const e of ev) if (e.kind === 'assessment' && e.assessmentId && e.frac !== undefined) byAssessment.set(e.assessmentId, [...(byAssessment.get(e.assessmentId) ?? []), e.frac])
  let improvementPoints = 0
  const personalBests = [...byAssessment.entries()].map(([assessmentId, fr]) => {
    let best = fr[0]!
    for (const f of fr.slice(1)) { if (f > best) { improvementPoints += Math.round((f - best) * 100); best = f } }
    return { assessmentId, best: Math.round(best * 100) / 100, latest: Math.round(fr.at(-1)! * 100) / 100, attempts: fr.length, improved: fr.length > 1 && fr.at(-1)! > fr[0]! }
  })
  if (improvementPoints) add('Beat your personal best', improvementPoints)
  // pre → post improvement on purpose-tagged tests
  const diag = ev.find((e) => e.kind === 'assessment' && e.purpose === 'diagnostic')
  const post = [...ev].reverse().find((e) => e.kind === 'assessment' && (e.purpose === 'post' || e.purpose === 'mock'))
  if (diag?.frac !== undefined && post?.frac !== undefined && post.frac > diag.frac) { const p = Math.round((post.frac - diag.frac) * 100); improvementPoints += p; add('Improved since your diagnostic', p) }
  const levels = concepts.map((c) => { const level = levelOf(c.pMastery, c.state); return { ...c, level, label: LEVELS[level]! } })
  for (const l of levels) if (l.level >= 3) add(`${l.name}: ${l.label}`, l.level === 4 ? 40 : 15)
  const st = streak(ev, now)
  const badges: Badge[] = []
  const first = (pred: (e: LearningEvent) => boolean) => ev.find(pred)?.at.toISOString()
  const earn = (id: string, title: string, why: string, at: string | undefined) => { if (at) badges.push({ id, title, why, earnedAt: at }) }
  earn('first_mastery', 'First topic mastered', 'a topic reached "Mastered" from your own answers', levels.some((l) => l.level === 4) ? now.toISOString() : undefined)
  earn('independent', 'On your own', '5 correct answers without any hint', ev.filter((e) => e.kind === 'answer' && e.correct && !e.hints).length >= 5 ? first((e) => e.kind === 'answer' && !!e.correct && !e.hints) : undefined)
  earn('comeback', 'Comeback', 'beat a previous score on the same test', personalBests.some((p) => p.improved) ? now.toISOString() : undefined)
  earn('consistent_week', 'Steady week', 'studied on 4 or more days in a week', st.studiedThisWeek >= 4 ? now.toISOString() : undefined)
  const sure = ev.filter((e) => e.kind === 'answer' && e.confidence === 'sure')
  earn('calibrated', 'Knows what they know', '10+ "sure" answers, at least 85% of them right', sure.length >= 10 && sure.filter((e) => e.correct).length / sure.length >= 0.85 ? now.toISOString() : undefined)
  earn('remembered', 'It stuck', 'answered a delayed check correctly weeks later', first((e) => e.kind === 'delayed_check' && !!e.correct))
  const xpBreakdown = Object.entries(b).map(([reason, xp]) => ({ reason, xp })).sort((x, y) => y.xp - x.xp)
  return { xp: xpBreakdown.reduce((n, x) => n + x.xp, 0), xpBreakdown, levels, streak: st, badges, personalBests, improvementPoints }
}

/** Opt-in, pseudonymous, improvement-based board; hidden entirely below `minSize` participants. */
export function leaderboard(rows: { pseudonym: string; improvementPoints: number; me: boolean }[], minSize = 5): { visible: boolean; rows: { rank: number; pseudonym: string; improvementPoints: number; me: boolean }[] } {
  if (rows.length < minSize) return { visible: false, rows: [] }
  return { visible: true, rows: [...rows].sort((a, b) => b.improvementPoints - a.improvementPoints).slice(0, 20).map((r, i) => ({ rank: i + 1, ...r })) }
}

// ── learning outcomes ──
export interface Metric { value: number | null; n: number; note?: string }
export interface Outcomes {
  diagnostic: Metric; postLearning: Metric; change: Metric
  delayedRetention: Metric; transfer: Metric
  repeatedMistakes: { before: Metric; after: Metric }
  independence: { before: Metric; after: Metric }
  calibration: Metric
  planCompletion: Metric
  caveats: string[]
}
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null)

/**
 * Before/after measures from the student's own evidence. Halves are split at the first post-learning test (or
 * at the midpoint in time when there is none). Every metric carries its sample size.
 */
export function outcomes(o: { events: LearningEvent[]; repeatedMistakes: { at: Date }[]; tasks: { done: number; total: number } }): Outcomes {
  const ev = [...o.events].sort((a, b) => a.at.getTime() - b.at.getTime())
  const tests = ev.filter((e) => e.kind === 'assessment' && e.frac !== undefined)
  const diag = tests.find((e) => e.purpose === 'diagnostic')
  const post = [...tests].reverse().find((e) => e.purpose === 'post') ?? [...tests].reverse().find((e) => e.purpose === 'mock')
  const split = post?.at.getTime() ?? (ev.length ? (ev[0]!.at.getTime() + ev.at(-1)!.at.getTime()) / 2 : 0)
  const answers = ev.filter((e) => e.kind === 'answer')
  const before = answers.filter((e) => e.at.getTime() < split)
  const after = answers.filter((e) => e.at.getTime() >= split)
  const hintRate = (xs: LearningEvent[]): Metric => ({ value: xs.length ? mean(xs.map((e) => (e.correct && !e.hints ? 1 : 0))) : null, n: xs.length, note: 'share solved correctly without hints' })
  const delayed = ev.filter((e) => e.kind === 'delayed_check')
  const transfer = answers.filter((e) => e.transfer)
  const sure = answers.filter((e) => e.confidence)
  const calib = sure.length ? mean(sure.map((e) => ((e.confidence === 'sure') === !!e.correct ? 1 : 0))) : null
  const mistakesBefore = o.repeatedMistakes.filter((m) => m.at.getTime() < split).length
  const mistakesAfter = o.repeatedMistakes.filter((m) => m.at.getTime() >= split).length
  const caveats = [
    'These compare you with yourself over time; they do not prove that any single activity caused the change.',
    'Different tests contain different questions, so score changes are indicative.',
  ]
  if (!diag) caveats.push('No diagnostic test yet: take one to have a starting point.')
  if (!delayed.length) caveats.push('Retention is measured by delayed checks 2-4 weeks after mastery; none yet.')
  return {
    diagnostic: { value: diag?.frac ?? null, n: diag ? 1 : 0 },
    postLearning: { value: post?.frac ?? null, n: post ? 1 : 0 },
    change: { value: diag && post && post.at > diag.at ? Math.round((post.frac! - diag.frac!) * 100) / 100 : null, n: diag && post ? 2 : 0, note: 'post minus diagnostic (score fraction)' },
    delayedRetention: { value: mean(delayed.map((e) => (e.correct ? 1 : 0))), n: delayed.length },
    transfer: { value: mean(transfer.map((e) => (e.correct ? 1 : 0))), n: transfer.length },
    repeatedMistakes: { before: { value: mistakesBefore, n: before.length }, after: { value: mistakesAfter, n: after.length } },
    independence: { before: hintRate(before), after: hintRate(after) },
    calibration: { value: calib, n: sure.length, note: 'share of answers where "sure" matched being right' },
    planCompletion: { value: o.tasks.total ? Math.round((o.tasks.done / o.tasks.total) * 100) / 100 : null, n: o.tasks.total },
    caveats,
  }
}
