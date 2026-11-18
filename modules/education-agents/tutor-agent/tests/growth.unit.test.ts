import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analysePatterns, compareSchoolBoard, practiceBlueprint, type PaperFact, type QuestionFact } from '../src/domain/exam.ts'
import { adapt, chooseStrategy, observe } from '../src/domain/strategy.ts'
import { computeGrowth, leaderboard, outcomes, streak, type LearningEvent } from '../src/domain/growth.ts'
import { assemblePackage } from '../src/domain/package.ts'
import { leaks } from '../src/growth/service.ts'
import { isoWeek } from '../src/agent/jobs.ts'
import type { ConceptProfile } from '../src/domain/insight.ts'

const topics = [
  { id: 'ph', name: 'pH scale', examWeight: 2, pMastery: 0.2 },
  { id: 'neu', name: 'Neutralisation', examWeight: 2, pMastery: 0.8 },
  { id: 'salt', name: 'Salts', examWeight: 1, pMastery: 0.1 },
]
const papers: PaperFact[] = [
  { id: 'b21', title: 'Board 2021', kind: 'board_past_paper', year: 2021, school: null },
  { id: 'b22', title: 'Board 2022', kind: 'board_past_paper', year: 2022, school: null },
  { id: 'b23', title: 'Board 2023', kind: 'board_past_paper', year: 2023, school: null },
  { id: 'b24', title: 'Board 2024', kind: 'board_past_paper', year: 2024, school: null },
  { id: 'tx', title: 'NCERT exercises', kind: 'textbook_exercise', year: null, school: null },
]
const q = (paperId: string, conceptId: string | null, marks = 2, qtype = 'short', features: string[] = []): QuestionFact => ({ paperId, conceptId, marks, qtype, features })
const questions = [q('b21', 'ph'), q('b22', 'ph', 3), q('b23', 'ph'), q('b24', 'ph', 5, 'long', ['reaction']), q('b23', 'salt', 1, 'mcq'), q('b24', 'salt', 2), q('b21', 'neu'), q('tx', 'neu'), q('tx', 'neu'), q('b22', null)]

test('exam patterns: verified counts kept apart from estimated priority; textbook exercises are not exam frequency', () => {
  const a = analysePatterns({ topics, papers, questions })
  const ph = a.topics.find((x) => x.conceptId === 'ph')!
  assert.equal(ph.papersWith, 4)
  assert.equal(ph.papersTotal, 4, 'the textbook exercise set is not counted as a paper')
  assert.match(ph.verified, /Appeared in 4 of 4 paper\(s\)/)
  assert.equal(ph.confidence, 'high')
  assert.equal(a.topics[0]!.conceptId, 'ph', 'frequent + not yet secure comes first')
  const salt = a.topics.find((x) => x.conceptId === 'salt')!
  assert.equal(salt.trend, 'new', 'only in the recent half')
  assert.ok(salt.reasons.some((r) => /not a guarantee/.test(r)))
  assert.equal(a.unmatchedQuestions, 1)
  assert.match(a.note, /no question is guaranteed/)
  const none = analysePatterns({ topics, papers: [], questions: [] })
  assert.ok(none.topics.every((x) => x.confidence === 'low' && x.verified === 'No verified past-paper evidence'))
  assert.match(none.note, /Upload papers/)
})

test('school vs board comparison and pattern-aligned blueprint', () => {
  const withSchool = [...papers, { id: 's1', title: 'Bal Vidya mid-term', kind: 'school_paper' as const, year: 2024, school: 'Bal Vidya School' }]
  const qs = [...questions, q('s1', 'salt'), q('s1', 'salt'), q('s1', 'salt')]
  const cmp = compareSchoolBoard({ topics, papers: withSchool, questions: qs })
  assert.ok(cmp.some((x) => x.conceptId === 'salt' && /your school asks this more/.test(x.note)))
  assert.deepEqual(compareSchoolBoard({ topics, papers, questions }), [], 'no comparison without school papers')
  const bp = practiceBlueprint(analysePatterns({ topics, papers, questions }).topics, 10)
  assert.equal(bp.reduce((n, x) => n + x.count, 0), 10)
  assert.equal(bp[0]!.conceptId, 'ph')
})

test('strategy: chosen from goal and time, switched by evidence', () => {
  assert.equal(chooseStrategy({ objective: 'exam_prep', daysToExam: 7 }).name, 'exam_sprint')
  assert.equal(chooseStrategy({ objective: 'exam_prep', daysToExam: 40 }).name, 'exam_prep')
  assert.equal(chooseStrategy({ objective: 'conceptual_mastery', daysToExam: null }).name, 'concept_mastery')
  assert.equal(chooseStrategy({ objective: 'interview_prep', daysToExam: 5 }).name, 'interview_prep')
  const s = chooseStrategy({ objective: 'conceptual_mastery', daysToExam: null, findings: [{ kind: 'memorising_without_understanding', conceptId: 'ph', title: 'x', evidence: '', n: 8, confidence: 'high' }] })
  assert.ok(s.mix.teachBack > chooseStrategy({ objective: 'conceptual_mastery', daysToExam: null }).mix.teachBack)
  assert.ok(Math.abs(Object.values(s.mix).reduce((a, b) => a + b, 0) - 1) < 0.02)
})

const prof = (id: string, name: string, p: number, n: number, o: Partial<ConceptProfile> = {}): ConceptProfile => ({ conceptId: id, name, mastery: { pMastery: p, state: p >= 0.9 ? 'mastered' : 'learning', evidenceCount: n, unassistedCorrect: 2 }, hintDependency: 0, forgettingRisk: 0.1, calibration: { sureWrong: 0, unsureRight: 0, rated: 0, unresolvedSureWrong: 0 }, errorTypes: {}, recurringMisconceptions: [], transfer: { attempted: 0, passed: 0 }, ...o })

test('observation: evidence-backed findings with confidence; low-confidence findings never change the plan', () => {
  const f = observe({
    concepts: [{ id: 'acid', name: 'Acids', examWeight: 1, prerequisites: [] }, { id: 'ph', name: 'pH scale', examWeight: 3, prerequisites: ['acid'] }, { id: 'neu', name: 'Neutralisation', examWeight: 2, prerequisites: [] }],
    profiles: [prof('acid', 'Acids', 0.3, 4), prof('ph', 'pH scale', 0.3, 6), prof('neu', 'Neutralisation', 0.95, 10)],
    confidence: new Map([['ph', { sure: 4, sureRight: 1, guess: 5, guessRight: 1, total: 9 }]]),
    application: new Map([['neu', { familiarRight: 6, familiar: 6, transferRight: 0, transfer: 3 }]]),
    afterLessons: new Map([['ph', { lessons: 2, attemptsAfter: 4, correctAfter: 1 }]]),
  })
  const kinds = f.map((x) => x.kind)
  for (const k of ['missing_prerequisite', 'strategy_ineffective', 'unclear_important_concept', 'repeated_guessing', 'overconfident', 'memorising_without_understanding']) assert.ok(kinds.includes(k as never), k)
  assert.equal(f[0]!.kind, 'missing_prerequisite')
  assert.ok(f.every((x) => x.evidence && x.n > 0))
  assert.ok(!f.some((x) => /anxi|adhd|depress|disorder/i.test(x.title + x.evidence)), 'never psychological labels')
  const adj = adapt(f)
  assert.ok(adj.some((a) => a.action === 'revise_prerequisite' && a.conceptId === 'acid'))
  assert.ok(adj.some((a) => a.action === 'application_practice'))
  assert.deepEqual(adapt([{ kind: 'repeated_guessing', conceptId: 'x', title: 't', evidence: 'e', n: 2, confidence: 'low' }]), [])
})

const at = (daysAgo: number) => new Date(Date.UTC(2026, 10, 18) - daysAgo * 86_400_000)
test('growth: rewards learning not speed; flexible streaks; personal bests; opt-in board hidden below 5', () => {
  const now = new Date(Date.UTC(2026, 10, 18, 12))
  const ev: LearningEvent[] = [
    { at: at(0), kind: 'answer', correct: true, hints: 0 }, { at: at(1), kind: 'answer', correct: true, hints: 2 },
    { at: at(3), kind: 'answer', correct: false, confidence: 'unsure' }, { at: at(4), kind: 'answer', correct: true, transfer: true, hints: 0 },
    { at: at(5), kind: 'assessment', assessmentId: 'a', frac: 0.5, purpose: 'diagnostic' }, { at: at(1), kind: 'assessment', assessmentId: 'a', frac: 0.8, purpose: 'diagnostic' },
    { at: at(0), kind: 'assessment', assessmentId: 'p', frac: 0.85, purpose: 'post' },
  ]
  const g = computeGrowth(ev, [{ conceptId: 'ph', name: 'pH', pMastery: 0.95, state: 'mastered' }], now)
  assert.ok(g.xpBreakdown.some((x) => x.reason === 'Correct on your own' && x.xp === 10))
  assert.ok(g.xpBreakdown.some((x) => x.reason === 'Beat your personal best' && x.xp === 30))
  assert.ok(!g.xpBreakdown.some((x) => /fast|speed|time/i.test(x.reason)))
  assert.equal(g.levels[0]!.label, 'Mastered')
  assert.ok(g.badges.some((b) => b.id === 'comeback') && g.badges.some((b) => b.id === 'first_mastery'))
  const st = streak(ev, now)
  assert.equal(st.days, 5, 'two rest days inside the week do not break the streak')
  assert.equal(st.restDaysUsed, 1)
  assert.deepEqual(leaderboard([{ pseudonym: 'a', improvementPoints: 5, me: true }]), { visible: false, rows: [] })
  const lb = leaderboard(['a', 'b', 'c', 'd', 'e'].map((x, i) => ({ pseudonym: x, improvementPoints: i * 10, me: x === 'c' })))
  assert.equal(lb.rows[0]!.pseudonym, 'e')
})

test('outcomes: before/after with sample sizes and honest caveats', () => {
  const o = outcomes({
    events: [
      { at: at(6), kind: 'assessment', frac: 0.4, purpose: 'diagnostic', assessmentId: 'd' }, { at: at(5), kind: 'answer', correct: false, hints: 2 },
      { at: at(4), kind: 'answer', correct: true, hints: 1, confidence: 'sure' }, { at: at(1), kind: 'assessment', frac: 0.75, purpose: 'post', assessmentId: 'p' },
      { at: at(0), kind: 'answer', correct: true, hints: 0, confidence: 'sure', transfer: true },
    ],
    repeatedMistakes: [{ at: at(5) }, { at: at(4) }], tasks: { done: 3, total: 4 },
  })
  assert.equal(o.change.value, 0.35)
  assert.deepEqual([o.independence.before.value, o.independence.after.value], [0, 1])
  assert.equal(o.repeatedMistakes.before.value, 2)
  assert.equal(o.repeatedMistakes.after.value, 0)
  assert.equal(o.planCompletion.value, 0.75)
  assert.ok(o.caveats.some((c) => /do not prove/.test(c)))
  assert.ok(o.caveats.some((c) => /delayed checks/.test(c)), 'retention not claimed without delayed checks')
})

test('chapter package reflects what was taught and what was missed; hint leak check; ISO weeks', () => {
  const pkg = assemblePackage({
    title: 'Acids, Bases and Salts', now: new Date(), mockTestId: 'm1',
    topics: [{ title: 'pH scale', definitions: [{ term: 'pH', text: 'a scale 0-14' }], formulae: ['pH < 7 acidic'], examples: ['lemon juice pH 2'], memoryTricks: ['Low pH, Lots of H+'], examPoints: ['Common mistake: pH 7 is not acidic'], doubts: [], practice: ['What is the pH of water?'], summary: 'pH measures acidity.', myNotes: '' }],
    blocks: [{ id: 'f', type: 'figure', text: '', label: 'ai', cites: [], figure: { caption: 'pH scale', thumb: 'https://upload.wikimedia.org/x.png', credit: 'X · CC0' } }],
    missedChecks: [{ prompt: 'Which is a base?', explanation: 'NaOH' }], diagnoses: [{ misconception: 'thinks pH 7 is acidic', concept: 'pH scale' }],
    pastQuestions: [{ text: 'Define pH.', marks: 1, source: 'Board 2023, Q4', topic: 'pH scale' }], mastery: [{ topic: 'pH scale', level: 'Developing', pMastery: 0.45 }],
  })
  assert.equal(pkg.diagrams.length, 1)
  assert.ok(pkg.flashcards.some((f) => f.front === 'Define: pH') && pkg.flashcards.some((f) => f.front === 'Which is a base?'))
  assert.ok(pkg.commonMistakes.some((m) => /pH 7 is acidic/.test(m.text)))
  assert.deepEqual(pkg.lastDaySheet.weakTopics, ['pH scale'])
  assert.equal(pkg.pastQuestions[0]!.source, 'Board 2023, Q4')
  assert.equal(leaks('Think about 20 divided by the mass', { type: 'numeric', value: 4, tolerance: 0 }, '4'), false)
  assert.equal(leaks('So the answer is 4 m/s^2', { type: 'numeric', value: 4, tolerance: 0 }, '4'), true)
  assert.equal(leaks('Recall that bases turn red litmus blue', { type: 'mcq', options: ['NaOH', 'HCl'], correct: ['NaOH'] }, 'NaOH'), false)
  assert.equal(leaks('It is NaOH', { type: 'mcq', options: ['NaOH', 'HCl'], correct: ['NaOH'] }, 'NaOH'), true)
  assert.equal(isoWeek(new Date('2026-11-18T10:00:00Z')), '2026-W47')
})
