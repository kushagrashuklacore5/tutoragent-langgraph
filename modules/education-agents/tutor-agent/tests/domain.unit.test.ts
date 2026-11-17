import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { estimate, probeCandidates, type Evidence } from '../src/domain/learner-model.ts'
import { intervalDays, newCard, retrievability, review, type Grade } from '../src/domain/fsrs.ts'
import { buildPlan, recoverPlan, MAX_OVERLOAD, type PlanConcept } from '../src/domain/planner.ts'
import { advance, chooseMove, verifySegments, type SessionState } from '../src/domain/tutoring.ts'
import { score, validateSpec } from '../src/domain/scoring.ts'

const D = (s: string) => new Date(s + 'T10:00:00Z')
const now = D('2026-11-17')
const ev = (outcome: number, date: string, kind: Evidence['kind'] = 'practice', hintsUsed = 0): Evidence => ({ kind, outcome, hintsUsed, observedAt: D(date) })

describe('learner model', () => {
  test('one perfect quiz is never "mastered" (single session)', () => {
    const e = Array.from({ length: 10 }, () => ev(1, '2026-11-17'))
    assert.notEqual(estimate(e, now).state, 'mastered')
  })
  test('consistent unassisted success over days becomes mastered', () => {
    const e = ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-16', '2026-11-17'].map((d) => ev(1, d))
    const m = estimate(e, now)
    assert.equal(m.state, 'mastered', JSON.stringify(m))
    assert.match(m.explanation, /8 answers over 7 days/)
  })
  test('fewer than 3 answers = insufficient evidence; self-reports never count alone', () => {
    assert.equal(estimate([ev(1, '2026-11-16'), ev(1, '2026-11-17')], now).state, 'insufficient_evidence')
    assert.equal(estimate(Array.from({ length: 6 }, (_, i) => ev(1, `2026-11-1${i}`, 'self_report')), now).state, 'insufficient_evidence')
  })
  test('monotonic: an extra correct answer never lowers p; an extra wrong one never raises it', () => {
    for (let seed = 0; seed < 300; seed++) {
      const base = Array.from({ length: (seed % 7) + 1 }, (_, i) => ev(((seed * 7 + i) % 3) / 2, `2026-11-${String(10 + (i % 7)).padStart(2, '0')}`))
      const p = estimate(base, now).pMastery
      assert.ok(estimate([...base, ev(1, '2026-11-17')], now).pMastery >= p)
      assert.ok(estimate([...base, ev(0, '2026-11-17')], now).pMastery <= p)
    }
  })
  test('hints reduce the weight of evidence; old evidence decays towards uncertainty', () => {
    const assisted = estimate(Array.from({ length: 6 }, (_, i) => ev(1, `2026-11-1${i + 1}`, 'practice', 3)), now)
    const unassisted = estimate(Array.from({ length: 6 }, (_, i) => ev(1, `2026-11-1${i + 1}`)), now)
    assert.ok(unassisted.pMastery > assisted.pMastery)
    const old = estimate(Array.from({ length: 6 }, (_, i) => ev(1, `2026-0${i + 1}-10`)), now)
    assert.ok(old.high - old.low > unassisted.high - unassisted.low)
  })
  test('probe candidates prefer least-evidenced, weakest prerequisites', () => {
    const a = estimate([], now)
    const b = estimate([ev(0, '2026-11-15'), ev(0, '2026-11-16'), ev(1, '2026-11-17')], now)
    assert.deepEqual(probeCandidates([{ conceptId: 'b', estimate: b }, { conceptId: 'a', estimate: a }]), ['a', 'b'])
  })
})

describe('FSRS scheduling', () => {
  test('first review: easier grades give longer intervals', () => {
    const days = ([1, 2, 3, 4] as Grade[]).map((g) => (review(newCard(now), g, now).due.getTime() - now.getTime()) / 86_400_000)
    assert.ok(days[0]! <= days[1]! && days[1]! <= days[2]! && days[2]! <= days[3]!, String(days))
  })
  test('at 90% desired retention the interval equals stability; retrievability at that point is 0.9', () => {
    assert.ok(Math.abs(intervalDays(10) - 10) < 1e-9)
    assert.ok(Math.abs(retrievability(10, 10) - 0.9) < 1e-9)
  })
  test('successful reviews grow intervals; a lapse resets to 1 day and never increases stability', () => {
    let c = review(newCard(now), 3, now)
    let t = c.due
    const intervals: number[] = []
    for (let i = 0; i < 5; i++) {
      const next = review(c, 3, t)
      intervals.push((next.due.getTime() - t.getTime()) / 86_400_000)
      c = next
      t = next.due
    }
    assert.ok(intervals.every((x, i) => i === 0 || x >= intervals[i - 1]!), String(intervals))
    const lapse = review(c, 1, t)
    assert.equal((lapse.due.getTime() - t.getTime()) / 86_400_000, 1)
    assert.ok(lapse.stability <= c.stability)
    assert.equal(lapse.lapses, 1)
    assert.ok(lapse.difficulty >= 1 && lapse.difficulty <= 10)
  })
})

describe('planner', () => {
  const C = (id: string, prereq: string[] = [], o: Partial<PlanConcept> = {}): PlanConcept => ({ id, name: id, estMinutes: 60, examWeight: 1, pMastery: 0.2, mastered: false, prerequisites: prereq, ...o })
  test('prerequisites always come before dependants; deterministic', () => {
    const input = { today: now, examAt: D('2026-11-27'), dailyMinutes: 60, concepts: [C('limits', ['functions']), C('functions'), C('derivatives', ['limits'], { examWeight: 5 })] }
    const p1 = buildPlan(input)
    const p2 = buildPlan(input)
    assert.deepEqual(p1, p2)
    const first = (id: string) => p1.tasks.findIndex((t) => t.conceptId === id)
    assert.ok(first('functions') < first('limits') && first('limits') < first('derivatives'))
  })
  test('never exceeds daily capacity; what does not fit is reported, not crammed', () => {
    for (const daily of [20, 45, 90]) {
      const p = buildPlan({ today: now, examAt: D('2026-11-21'), dailyMinutes: daily, reviewMinutesPerDay: 10, concepts: Array.from({ length: 12 }, (_, i) => C(`c${i}`)) })
      const perDay = new Map<string, number>()
      for (const t of p.tasks) perDay.set(t.date, (perDay.get(t.date) ?? 0) + t.minutes)
      assert.ok([...perDay.values()].every((m) => m <= daily), `daily ${daily}: ${[...perDay.values()]}`)
      if (daily === 20) assert.ok(p.dropped.length > 0)
    }
  })
  test('recovery after missed days stays within 125% of usual daily time', () => {
    const p = recoverPlan({ today: now, examAt: D('2026-11-24'), dailyMinutes: 60, concepts: Array.from({ length: 6 }, (_, i) => C(`c${i}`)) }, 300)
    const perDay = new Map<string, number>()
    for (const t of p.tasks) perDay.set(t.date, (perDay.get(t.date) ?? 0) + t.minutes)
    assert.ok([...perDay.values()].every((m) => m <= 60 * MAX_OVERLOAD))
    assert.match(p.rationale[0]!, /max 125%/)
  })
  test('mastered concepts are left to revision', () => {
    const p = buildPlan({ today: now, examAt: D('2026-11-27'), dailyMinutes: 60, concepts: [C('a', [], { mastered: true }), C('b')] })
    assert.ok(!p.tasks.some((t) => t.conceptId === 'a'))
  })
})

describe('tutoring rules', () => {
  const S: SessionState = { mode: 'socratic', hintLevel: 0, attemptsAtStep: 0, rescueTarget: null, graded: false }
  test('new problem: ask first; full answer only after genuine attempts in guided mode', () => {
    assert.equal(chooseMove(S, { hasProblem: true }, 'guided', null).move, 'ask')
    assert.equal(chooseMove(S, { hasProblem: true, requestFullAnswer: true }, 'guided', null).move, 'hint')
    assert.equal(chooseMove({ ...S, attemptsAtStep: 2 }, { hasProblem: true, requestFullAnswer: true }, 'guided', null).move, 'worked_solution')
    assert.equal(chooseMove(S, { hasProblem: true, requestFullAnswer: true }, 'open', null).move, 'worked_solution')
  })
  test('graded / hint-only: never a worked solution, hints capped at level 3', () => {
    for (const st of [{ ...S, graded: true, attemptsAtStep: 5, hintLevel: 4 }, { ...S, attemptsAtStep: 5 }]) {
      for (const flags of [{ hasProblem: true, requestFullAnswer: true }, { hasProblem: true }]) {
        const d = chooseMove(st, flags, st.graded ? 'guided' : 'hint_only', null)
        assert.notEqual(d.move, 'worked_solution')
        if (d.move === 'hint') assert.ok(d.hintLevel <= 3)
      }
    }
  })
  test('stuck triggers prerequisite rescue; two failed attempts raise the hint level', () => {
    assert.equal(chooseMove(S, { hasProblem: true, stuck: true }, 'guided', 'limits').move, 'rescue_probe')
    let st = advance(S, { move: 'hint', hintLevel: 1 }, 'incorrect')
    st = advance(st, { move: 'hint', hintLevel: 1 }, 'incorrect')
    assert.equal(st.hintLevel, 2)
    assert.equal(advance(st, { move: 'hint', hintLevel: 2 }, 'correct').hintLevel, 0)
  })
  test('course labels require a citation from this turn; otherwise relabelled uncertain', () => {
    const { segments, relabelled } = verifySegments([
      { text: 'A', source: 'course', citations: ['c1'] },
      { text: 'B', source: 'course', citations: ['made-up'] },
      { text: 'C', source: 'general', citations: ['c1'] },
    ], new Set(['c1']))
    assert.deepEqual(segments.map((s) => s.source), ['course', 'uncertain', 'general'])
    assert.equal(relabelled, 1)
    assert.deepEqual(segments[2]!.citations, [])
  })
})

describe('scoring', () => {
  test('MCQ single and multi answer, numeric tolerance, invalid input', () => {
    assert.equal(score({ type: 'mcq', options: ['a', 'b', 'c'], correct: ['b'] }, 'b').outcome, 1)
    assert.equal(score({ type: 'mcq', options: ['a', 'b', 'c'], correct: ['b'] }, 'a').outcome, 0)
    assert.equal(score({ type: 'mcq', options: ['a', 'b', 'c'], correct: ['a', 'b'] }, ['a']).feedbackKey, 'partially_correct')
    assert.equal(score({ type: 'mcq', options: ['a', 'b'], correct: ['a'] }, 'z').feedbackKey, 'invalid_response')
    assert.equal(score({ type: 'numeric', value: 9.81, tolerance: 0.01, relative: true }, '9.8').correct, true)
    assert.equal(score({ type: 'numeric', value: 9.81, tolerance: 0.001, relative: true }, '9.7').correct, false)
    assert.deepEqual(validateSpec({ type: 'mcq', options: ['a'], correct: ['b'] }).length, 2)
  })
})
