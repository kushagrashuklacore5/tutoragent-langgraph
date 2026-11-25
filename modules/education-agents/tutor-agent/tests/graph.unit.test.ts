import { test } from 'node:test'
import assert from 'node:assert/strict'
import { END } from '@langchain/langgraph'
import { afterRespond, routeTurn } from '../src/agent/graph/graph.ts'
import { CompanionState, RESET, type CompanionStateT, type Decision } from '../src/agent/graph/state.ts'
import { documentScope, MATERIAL_WORDS } from '../src/agent/graph/rules.ts'
import { parseSlotAnswer, subjectSwitch } from '../src/agent/profile.ts'
import { initialState, type ConvState } from '../src/agent/store.ts'

const dec = (x: Partial<Decision> = {}): Decision => ({ intent: 'other', actions: [], switchTo: null, resumeBook: false, askSubject: false, planChanged: false, inSetup: false, ...x })
const st = (x: Omit<Partial<CompanionStateT>, 'conv'> & { conv?: Partial<ConvState> } = {}): CompanionStateT => ({
  turn: { messageId: 'm', source: 'text' }, decision: dec(), flags: {}, cards: [], outcomes: [], workflow: null, ...x,
  conv: { ...initialState(), ...(x.conv ?? {}) } as ConvState,
})
const proposal = { id: 'p1' } as ConvState['proposal']

test('document scope is a rule: clear requests change it, ordinary sentences and model paraphrases do not', () => {
  const topics = [{ name: 'What is photosynthesis' }, { name: 'The Calvin cycle' }]
  assert.equal(documentScope('The complete material', topics, true), 'the complete material')
  assert.equal(documentScope('The Calvin cycle', topics, true), 'The Calvin cycle')
  assert.equal(documentScope('Yes, build the full roadmap for all five sections.', topics, false), 'the complete material')
  assert.equal(documentScope('Only the Calvin cycle please', topics, false), 'The Calvin cycle')
  assert.equal(documentScope('What is photosynthesis?', topics, false), null, 'a question is not a scope change')
  assert.equal(documentScope('I completed my homework', topics, false), null)
})

test('material words are whole words: subject names are not material choices', () => {
  const now = new Date('2026-11-23T00:00:00Z')
  assert.deepEqual(parseSlotAnswer('material', 'Go back to photosynthesis', now), {})
  assert.deepEqual(parseSlotAnswer('material', 'explain momentum accurately', now), {})
  assert.deepEqual(parseSlotAnswer('material', 'a photo of my notebook', now), { material: 'own' })
  assert.deepEqual(parseSlotAnswer('material', 'you prepare them', now), { material: 'ai' })
  assert.ok(!MATERIAL_WORDS.test('photosynthesis'))
})

test('subject switch: returns to an enrolled course by title and never duplicates a graded course', () => {
  const courses = [{ id: 'bio', title: 'Photosynthesis: Sample Study Notes' }, { id: 'phy', title: 'Class 10 Physics Complete Course' }, { id: 'math', title: 'Maths' }]
  assert.deepEqual(subjectSwitch('Go back to photosynthesis.', courses, 'phy'), { kind: 'existing', courseId: 'bio' })
  assert.deepEqual(subjectSwitch('I want to learn physics class 10', courses, 'math'), { kind: 'existing', courseId: 'phy' })
  assert.deepEqual(subjectSwitch('I want to learn physics class 11', courses, 'math'), { kind: 'new', subject: 'Physics class 11' })
  assert.equal(subjectSwitch('What does photosynthesis produce?', courses, 'phy'), null, 'a question alone does not switch course')
  assert.equal(subjectSwitch('Go back to my notes', courses, 'phy'), null, 'generic title words name no course')
})

test('routing: approval only for a PENDING proposal; buttons, uploads, book doubts and continue go to their nodes', () => {
  assert.equal(routeTurn(st({ decision: dec({ intent: 'approve_plan' }), conv: { phase: 'awaiting_approval', proposal } })), 'apply_plan')
  assert.equal(routeTurn(st({ decision: dec({ intent: 'approve_plan' }), conv: { phase: 'awaiting_approval', proposal, appliedPlan: { courseId: 'c', version: 1, proposalId: 'p1', appliedAt: '' } as never } })), 'act', 'already applied: no second apply')
  assert.equal(routeTurn(st({ turn: { messageId: 'm', source: 'text', proposalDecision: { proposalId: 'p1', approve: false } } })), 'reject_plan')
  assert.equal(routeTurn(st({ turn: { messageId: 'm', source: 'text', documentId: 'd' }, decision: dec({ inSetup: true }) })), 'document')
  assert.equal(routeTurn(st({ turn: { messageId: 'm', source: 'text', context: { bookId: 'b', pageNo: 1 } }, decision: dec({ intent: 'question' }) })), 'book_doubt')
  assert.equal(routeTurn(st({ turn: { messageId: 'm', source: 'text', context: { bookId: 'b', pageNo: 1 } }, decision: dec({ intent: 'question', actions: [{ tool: 'practice.start', args: {} }] }) })), 'act', 'a request to practise leaves the book')
  assert.equal(routeTurn(st({ decision: dec({ intent: 'continue' }), conv: { activeBook: { id: 'b', title: 'x' } } })), 'resume_book')
  assert.equal(routeTurn(st()), 'act')
})

test('after the reply the thread waits only for a real decision (roadmap approval or document scope)', () => {
  assert.equal(afterRespond(st({ flags: { proposed: true } })), 'approval_gate')
  assert.equal(afterRespond(st({ flags: { askScope: ['The complete material', 'Part 1'] } })), 'scope_gate')
  assert.equal(afterRespond(st({ flags: { askScope: null } })), END)
  assert.equal(afterRespond(st()), END)
})

test('reducers: per-turn channels append within a turn and reset at the next; flags merge then replace', () => {
  const cards = CompanionState.spec.cards
  const flags = CompanionState.spec.flags
  const reduceCards = (cards as unknown as { operator: (a: unknown, b: unknown) => unknown }).operator
  const reduceFlags = (flags as unknown as { operator: (a: unknown, b: unknown) => unknown }).operator
  const a = reduceCards([], [{ type: 'upload' }]) as unknown[]
  const b = reduceCards(a, [{ type: 'choices', choices: ['x'] }]) as unknown[]
  assert.equal(b.length, 2, 'two nodes adding cards in one turn: nothing overwritten')
  assert.deepEqual(reduceCards(b, RESET), [], 'a new turn starts clean')
  const f1 = reduceFlags({ proposed: true }, { failedStep: 'x' })
  assert.deepEqual(f1, { proposed: true, failedStep: 'x' })
  assert.deepEqual(reduceFlags(f1, { replace: true }), { replace: undefined })
})

test('study time: a total and a daily figure reconcile into one consistent schedule', async () => {
  const { statedTotalMinutes, statedDailyMinutes, missingRequired } = await import('../src/agent/profile.ts')
  const { buildRoadmap } = await import('../src/agent/roadmap.ts')
  assert.equal(statedTotalMinutes('I want to learn AI and neural networks, I have six hours'), 360)
  assert.equal(statedTotalMinutes('sirf 6 ghante hain'), 360)
  assert.equal(statedTotalMinutes('I can study two hours per day'), null)
  assert.equal(statedTotalMinutes('a 2 hour lecture on CNNs'), null)
  assert.equal(statedDailyMinutes('I can study two hours per day'), 120)
  assert.ok(!missingRequired({ courseId: 'c', objective: 'general', totalMinutes: 360, material: 'ai', materialFor: 'c' }).includes('dailyMinutes'))
  const concepts = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, name: `Topic ${i}`, estMinutes: 60, pMastery: 0.1, mastered: false, prerequisites: [], examWeight: 1 }))
  const r = buildRoadmap({ today: new Date('2026-11-23T00:00:00Z'), examAt: null, dailyMinutes: 120, totalMinutes: 360, concepts: concepts as never })
  assert.equal(r.horizon.days, 3)
  assert.equal(r.horizon.end, '2026-11-25')
  assert.equal(r.availableMinutes, 360)
  assert.ok(r.plan.tasks.reduce((n, t) => n + t.minutes, 0) <= 360, 'scheduled work fits the total')
  assert.ok(r.dropped.length > 0 && r.feasibility === 'over', 'too much work is reported, never hidden')
  assert.match(r.rationale.join(' '), /covers \d+ of 12 topics/)
})

test('document coverage: a syllabus and index are not teaching material (MACHINE LEARNING.pdf shape)', async () => {
  const { coverageOf, splitByTeaching, describe } = await import('../src/courses/document.ts')
  const teaching = 'Machine learning is the field of study that gives computers the ability to learn without being explicitly programmed. '.repeat(5)
  const pages = [
    'DIGITAL NOTES ON MACHINE LEARNING\nPREPARED BY: staff',
    'COURSE OBJECTIVES:\nUNIT - I\nIntroduction, Feature Selection\nUNIT - II\nGradient Descent, Decision Trees',
    'UNIT - IV\nCross Validation\nTEXT BOOKS:\n1. Machine Learning, Pearson\nREFERENCE BOOKS:\n1. Bishop',
    'INDEX\nS.NO Title Page No\n1 Introduction to Machine learning 2\n2 Feature Selection 9\n3 Gradient Descent 28\n4 Decision Trees 31\n5 Q-learning 127',
    `UNIT-I\nIntroduction: Introduction to Machine learning, Supervised learning. Feature Selection: Filter, Wrapper\nEmbedded methods and Gradient Descent are outlined for this unit in this long line\nIntroduction\n${teaching}`,
  ]
  const c = coverageOf(pages)
  assert.deepEqual(c.kinds, ['front', 'syllabus', 'syllabus', 'index', 'teaching'])
  assert.deepEqual(c.teachingPages, [5])
  assert.equal(c.indexLastPage, 127)
  assert.equal(c.partial, true)
  const s = (name: string) => ({ name, description: '', pageStart: 1, pageEnd: 1, keyTerms: [] as string[] })
  const r = splitByTeaching([s('Machine learning'), s('Feature Selection'), s('Decision Trees')], pages, c)
  assert.deepEqual(r.taught.map((x) => x.name), ['Machine learning'])
  assert.deepEqual(r.listedOnly.map((x) => x.name), ['Feature Selection', 'Decision Trees'])
  const text = describe({ ok: true, documentId: 'd', filename: 'ml.pdf', pages: 5, subject: 'Machine learning', title: 'ML', summary: '', sections: r.taught, listedOnly: r.listedOnly.map((x) => x.name), coverage: c })
  assert.match(text, /index runs to page 127/)
  assert.match(text, /Listed but not taught in this file: Feature Selection/)
})

test('a reply about a plan can only state what the plan says', async () => {
  const { planClaimsOk } = await import('../src/agent/graph/rules.ts')
  const r = { requiredMinutes: 300, availableMinutes: 360, dailyMinutes: 120, effectiveDailyMinutes: 120, horizon: { days: 3, totalMinutes: 360 } }
  assert.equal(planClaimsOk('Your plan is 5 hours of work over 3 days, 2 hours a day.', r), true)
  assert.equal(planClaimsOk('We will spend 28 days on this.', r), false)
  assert.equal(planClaimsOk('Spend 30 minutes on concepts.', r), false)
  assert.equal(planClaimsOk('Your mastery is 40%.', r), false)
  assert.equal(planClaimsOk('I checked your past knowledge and built this.', r), false)
})

test('limited time goes to what the student asked for, with its direct prerequisites', async () => {
  const { focusForBudget } = await import('../src/agent/toolset.ts')
  const c = (id: string, name: string, prerequisites: string[] = []) => ({ id, name, prerequisites, mastered: false })
  const all = [c('a', 'Introduction to Artificial Intelligence'), c('b', 'Search Strategies', ['a']), c('m', 'Machine Learning Foundations', ['a']), c('s', 'Supervised Learning Algorithms', ['m']), c('n', 'Neural Networks and Deep Learning', ['s']), c('e', 'Ethics and Bias', ['a'])]
  const r = focusForBudget(all, 'I want to learn AI and neural networks. I have six hours.')
  assert.deepEqual(r.concepts.map((x) => x.id), ['s', 'n'])
  assert.deepEqual(r.named, ['Neural Networks and Deep Learning'])
  assert.equal(focusForBudget(all, 'teach me this subject').concepts.length, all.length, 'nothing named: nothing is removed')
})

test('setup questions offer one-tap answers that the rules understand', async () => {
  const { choicesFor } = await import('../src/agent/graph/rules.ts')
  const { parseSlotAnswer } = await import('../src/agent/profile.ts')
  const now = new Date('2026-11-23T00:00:00Z')
  for (const lang of ['en', 'hinglish'] as const) {
    assert.deepEqual(choicesFor('objective', lang, []).map((c) => parseSlotAnswer('objective', c, now).objective), ['conceptual_mastery', 'exam_prep', 'practical_skills', 'general'])
    assert.deepEqual(choicesFor('dailyMinutes', lang, []).map((c) => parseSlotAnswer('dailyMinutes', c, now).dailyMinutes), [30, 45, 60, 120])
  }
})

test('a Hinglish lesson never accepts an all-English spoken line', async () => {
  const { liveSegments, speaksLanguage } = await import('../src/studio/live.ts')
  assert.equal(speaksLanguage('hinglish', 'Plants make food.'), false)
  assert.equal(speaksLanguage('hinglish', 'Plants अपना food बनाते हैं।'), true)
  assert.equal(speaksLanguage('en', 'Plants make food.'), true)
  const block = { id: 'b1', type: 'text', text: 'Plants make food.', label: 'ai', cites: [] }
  const page = [{ pageNo: 1, blocks: [block] }] as never
  assert.equal(liveSegments(page, { segments: [{ blockId: 'b1', speech: 'Plants create food.' }] }, 'hinglish')[0]!.origin, 'lesson')
  assert.equal(liveSegments(page, { segments: [{ blockId: 'b1', speech: 'Plants अपना food बनाते हैं।' }] }, 'hinglish')[0]!.origin, 'script')
})
