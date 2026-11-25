import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyDoubts, asksForExplanation, mergeProfile, relatedTo, requestedTopic, topicChange, missingRequired, nextSlot, parseSlotAnswer, readyToPlan, validDate } from '../src/agent/profile.ts'
import { buildRoadmap } from '../src/agent/roadmap.ts'
import { decideNudges, prepareSession, type NudgeFacts } from '../src/agent/nudges.ts'
import { validate } from '../src/agent/schema.ts'
import { executeTool, ToolRegistry, traceArgs } from '../src/agent/tools.ts'
import type { PlanConcept } from '../src/domain/planner.ts'

const now = new Date('2026-11-18T10:00:00Z')
const C = 'c0000000-0000-4000-8000-000000000001'

test('profile: model-proposed values are validated, clamped and limited to known courses', () => {
  const { profile, changed } = mergeProfile({}, { objective: 'exam_prep', examDate: '2026-12-20', dailyMinutes: 2000, confidence: 9, courseId: 'not-mine', level: 'wizard', hasMaterials: 'yes', grade: '  B.Tech   1st year ' }, now, [C])
  assert.deepEqual(profile, { objective: 'exam_prep', examDate: '2026-12-20', dailyMinutes: 600, confidence: 5, grade: 'B.Tech 1st year' })
  assert.ok(!changed.includes('courseId'))
  assert.equal(validDate('2026-11-18', now), undefined, 'today is not a future date')
  assert.equal(validDate('2026-02-30', now), undefined, 'impossible date')
  assert.equal(validDate('2029-01-01', now), undefined, 'more than two years ahead')
  assert.equal(validDate('none', now), 'none')
  assert.equal(mergeProfile({}, { courseId: C }, now, [C]).profile.courseId, C)
})

test('onboarding: one question at a time, required first, date only for date-bound goals, optional capped, never re-asked', () => {
  let p = mergeProfile({}, { courseId: C }, now, [C]).profile
  assert.equal(nextSlot(p, []), 'objective')
  p = { ...p, objective: 'conceptual_mastery' }
  assert.deepEqual(missingRequired(p), ['topic', 'dailyMinutes', 'material'], 'no exam date needed for conceptual mastery')
  p = { ...p, objective: 'exam_prep' }
  assert.equal(nextSlot(p, ['objective']), 'topic', 'the chapter/topic comes first')
  p = { ...p, topic: 'Limits', examDate: '2026-12-20', dailyMinutes: 60 }
  assert.equal(nextSlot(p, ['objective', 'topic', 'examDate', 'dailyMinutes']), 'material', 'the material source is required before teaching')
  const q = { ...p, material: 'ai' as const, materialFor: C }
  assert.equal(nextSlot(q, ['objective', 'examDate', 'dailyMinutes', 'material']), 'confidence')
  assert.equal(nextSlot({ ...q, confidence: 3 }, ['confidence', 'level']), null, 'at most two optional questions')
  assert.ok(readyToPlan(q, ['confidence', 'level']))
  assert.equal(nextSlot({ ...p, material: 'ai', materialFor: C, skipped: ['confidence', 'level', 'learningStyle', 'hasMaterials'] }, []), null, 'skipped slots are not asked')
})

test('direct answers are parsed without the model (minutes, dates, yes/no, skip)', () => {
  assert.deepEqual(parseSlotAnswer('dailyMinutes', '1.5 hours', now), { dailyMinutes: 90 })
  assert.deepEqual(parseSlotAnswer('dailyMinutes', '45 min', now), { dailyMinutes: 45 })
  assert.deepEqual(parseSlotAnswer('dailyMinutes', '2 ghante', now), { dailyMinutes: 120 })
  assert.deepEqual(parseSlotAnswer('examDate', '15 Dec', now), { examDate: '2026-12-15' })
  assert.deepEqual(parseSlotAnswer('examDate', 'Mar 3', now), { examDate: '2027-03-03' }, 'past month rolls into next year')
  assert.deepEqual(parseSlotAnswer('examDate', 'no exam', now), { examDate: 'none' })
  assert.deepEqual(parseSlotAnswer('hasMaterials', 'haan', now), { hasMaterials: true })
  assert.deepEqual(parseSlotAnswer('confidence', 'pata nahi', now), { skip: ['confidence'] })
  assert.deepEqual(parseSlotAnswer('objective', 'something', now), {})
})

test('doubts: bounded, de-duplicated, resolved by id only', () => {
  let n = 0
  let p = applyDoubts({}, ['Why is a inversely proportional to m?', 'why is A inversely proportional to m?', 'x', 'y'], [], now, 'N2', () => `d${++n}`)
  assert.equal(p.doubts!.length, 2, 'duplicate (case-insensitive) dropped; max 3 per turn')
  p = applyDoubts(p, [], ['d1', 'nope'], now)
  assert.equal(p.doubts!.find((d) => d.id === 'd1')!.status, 'resolved')
  assert.equal(p.doubts!.filter((d) => d.status === 'open').length, 1)
})

const concepts: PlanConcept[] = [
  { id: 'f', name: 'Functions', estMinutes: 60, examWeight: 1, pMastery: 0.3, mastered: false, prerequisites: [] },
  { id: 'l', name: 'Limits', estMinutes: 120, examWeight: 3, pMastery: 0.1, mastered: false, prerequisites: ['f'] },
  { id: 'd', name: 'Derivatives', estMinutes: 120, examWeight: 3, pMastery: 0, mastered: false, prerequisites: ['l'] },
  { id: 'm', name: 'Sets', estMinutes: 30, examWeight: 1, pMastery: 0.95, mastered: true, prerequisites: [] },
]

test('roadmap: workload vs time, feasibility, weekly milestones with checkpoints, prerequisite gaps', () => {
  const ok = buildRoadmap({ today: now, examAt: new Date('2026-12-16T00:00:00Z'), dailyMinutes: 60, studyDaysPerWeek: 7, concepts })
  assert.equal(ok.feasibility, 'comfortable')
  assert.equal(ok.suggestedDailyMinutes, null)
  assert.ok(ok.milestones.length >= 1)
  assert.deepEqual(ok.milestones.flatMap((m) => m.conceptIds).sort(), ['d', 'f', 'l'], 'every unmastered concept lands in a milestone; mastered ones do not')
  const order = ok.milestones.flatMap((m) => m.conceptIds)
  assert.ok(order.indexOf('f') < order.indexOf('l') && order.indexOf('l') < order.indexOf('d'), 'prerequisites first')
  const spaced = ok.checkpoints.filter((c) => c.title.startsWith('Spaced review'))
  assert.ok(spaced.length >= 1, 'spare weeks get spaced retrieval practice')
  assert.ok(spaced.every((c) => c.due > ok.milestones.at(-1)!.due))
  assert.equal(ok.checkpoints.length, ok.milestones.length + spaced.length + 1, 'a checkpoint per milestone, spaced reviews, and a final check before the exam')
  assert.ok(ok.checkpoints.at(-1)!.title.startsWith('Full mock test'))
  assert.ok(ok.checkpoints.every((c) => c.due < '2026-12-16'))
  assert.deepEqual(ok.gaps, ['Functions', 'Limits'])
  assert.ok(ok.weeks.length >= 1 && ok.weeks[0]!.week === 1)

  const tight = buildRoadmap({ today: now, examAt: new Date('2026-11-23T00:00:00Z'), dailyMinutes: 60, studyDaysPerWeek: 5, concepts })
  assert.equal(tight.feasibility, 'over', '5 days at ~43 min/day cannot hold ~7 h of work')
  assert.ok(tight.suggestedDailyMinutes! > 60)
  assert.ok(tight.dropped.length > 0)
  assert.match(tight.rationale.join(' '), /5 day\(s\) a week/)

  const open = buildRoadmap({ today: now, examAt: null, dailyMinutes: 30, concepts })
  assert.equal(open.horizon.fixedDate, false)
  assert.equal(open.horizon.days, 28)
  assert.ok(!open.checkpoints.some((c) => c.title.startsWith('Full mock test')), 'no final exam check without a date')
})

const facts = (o: Partial<NudgeFacts> = {}): NudgeFacts => ({
  now, courseId: C, language: 'en', activeToday: false, nudgesToday: 0, recent: [], dueCards: 0, overdueMilestones: [], checkpointsDue: [],
  recurringMisconceptions: [], weakPrerequisite: null, practiceAfterLesson: null, planUpdated: null, examInDays: null, ...o,
})

test('nudges: priority, max 2 a day, cooldown, quiet when active, informative plan updates always', () => {
  const busy = facts({ dueCards: 9, overdueMilestones: [{ title: 'Week 1', due: '2026-11-16' }], recurringMisconceptions: [{ conceptId: 'x', conceptName: 'Limits', misconception: 'limit = f(a)' }], weakPrerequisite: { conceptId: 'f', name: 'Functions' } })
  assert.deepEqual(decideNudges(busy).map((n) => n.kind), ['milestone_overdue', 'repeated_mistake'])
  assert.deepEqual(decideNudges({ ...busy, nudgesToday: 1 }).map((n) => n.kind), ['milestone_overdue'])
  assert.deepEqual(decideNudges({ ...busy, recent: [{ kind: 'milestone_overdue', at: new Date(now.getTime() - 86_400_000) }] }).map((n) => n.kind), ['repeated_mistake', 'prerequisite'])
  assert.deepEqual(decideNudges({ ...busy, activeToday: true }), [], 'no routine nudges while the student is active')
  const upd = decideNudges({ ...busy, activeToday: true, planUpdated: { reason: 'after a test', version: 3 } })
  assert.deepEqual(upd.map((n) => n.kind), ['plan_updated'])
  assert.deepEqual(decideNudges(facts({ dueCards: 3 })), [], 'a few due cards are not worth a nudge')
  assert.deepEqual(decideNudges(facts({ dueCards: 3, examInDays: 5 })).map((n) => n.kind), ['exam_soon', 'revision_due'])
  assert.match(decideNudges(facts({ language: 'hinglish', dueCards: 6 }))[0]!.text, /revision cards due hain/)
  const keys = decideNudges(busy).map((n) => n.dedupeKey)
  assert.deepEqual(keys, decideNudges(busy).map((n) => n.dedupeKey), 'dedupe keys are stable (posting twice is a no-op)')
})

test('next session agenda: due cards, open doubt, today\'s plan tasks, due checkpoints', () => {
  const a = prepareSession({
    today: '2026-11-18', courseId: C, dueCards: 4,
    tasks: [{ date: '2026-11-18', kind: 'learn', conceptId: 'f', conceptName: 'Functions', minutes: 40 }, { date: '2026-11-19', kind: 'practice', conceptId: 'f', conceptName: 'Functions', minutes: 20 }],
    checkpoints: [{ title: 'Checkpoint 1', due: '2026-11-18', conceptIds: ['f'] }], openDoubts: [{ text: 'Why does the limit exist?' }],
  })
  assert.deepEqual(a.items.map((i) => i.kind), ['revise', 'doubt', 'learn', 'checkpoint'])
  assert.equal(a.totalMinutes, 6 + 10 + 40 + 10)
})

test('schema validation and trace redaction', () => {
  const s = { type: 'object' as const, properties: { courseId: { type: 'string' as const, pattern: '^[a-f0-9-]{36}$' }, n: { type: 'integer' as const, minimum: 1 } }, required: ['courseId'], additionalProperties: false }
  assert.deepEqual(validate(s, { courseId: C }), [])
  assert.equal(validate(s, { courseId: 'x', n: 0, extra: 1 }).length, 3)
  assert.deepEqual(traceArgs({ courseId: C, n: 2, query: 'why is my exam so hard? I failed last time' }), { courseId: C, n: 2, query: traceArgs({ q: 'why is my exam so hard? I failed last time' }).q })
  assert.match(String(traceArgs({ query: 'my private worry about the exam' }).query), /^#[0-9a-f]{16}$/)
})

test('executor: unknown tools, model-forbidden tools, bad args and missing approval never run', async () => {
  let ran = 0
  const traces: unknown[][] = []
  const d = { inTenant: async (_p: unknown, fn: (t: unknown) => Promise<unknown>) => fn({ query: async (_q: string, v: unknown[]) => { traces.push(v); return { rows: [], rowCount: 0 } } }) }
  const reg = new ToolRegistry()
  const input = { type: 'object' as const, properties: { courseId: { type: 'string' as const } }, required: ['courseId'], additionalProperties: false }
  reg.register({ name: 'r.read', capability: 'progress', description: 'x', input, output: { type: 'object' }, effect: 'read', approval: 'none', modelCallable: true, run: async () => { ran++; return {} } })
  reg.register({ name: 'w.apply', capability: 'strategy', description: 'x', input, output: { type: 'object' }, effect: 'write', approval: 'required', modelCallable: false, idempotencyKey: () => 'k', run: async () => { ran++; return {} } })
  reg.register({ name: 'w.approve', capability: 'strategy', description: 'x', input, output: { type: 'object' }, effect: 'write', approval: 'required', modelCallable: true, idempotencyKey: () => 'k2', run: async () => { ran++; return {} } })
  const base = { d: d as never, p: { userId: 'u', tenantId: 't' } as never, conversationId: null, now }
  assert.equal((await executeTool(reg, base, 'nope', {}, { origin: 'model' })).error?.code, 'unknown_tool')
  assert.equal((await executeTool(reg, base, 'w.apply', { courseId: C }, { origin: 'model' })).error?.code, 'not_allowed')
  assert.equal((await executeTool(reg, base, 'r.read', { courseId: 5 }, { origin: 'model' })).error?.code, 'invalid_args')
  assert.equal((await executeTool(reg, base, 'r.read', { courseId: C, hack: true }, { origin: 'model' })).error?.code, 'invalid_args')
  assert.equal((await executeTool(reg, base, 'w.approve', { courseId: C }, { origin: 'model' })).status, 'needs_approval', 'a model cannot approve on the student\'s behalf')
  assert.equal(ran, 0)
  assert.equal(traces.length, 5, 'every refusal is traced')
  assert.equal((await executeTool(reg, base, 'r.read', { courseId: C }, { origin: 'model' })).status, 'ok')
  assert.equal(ran, 1)
  assert.throws(() => reg.register({ name: 'w.bad', capability: 'strategy', description: 'x', input, output: { type: 'object' }, effect: 'write', approval: 'none', modelCallable: true, run: async () => ({}) }), /idempotency/)
  assert.deepEqual(reg.catalog().map((c) => c.tool), ['r.read', 'w.approve'], 'non-model-callable tools are not offered to the model')
})

test('follow-up budget counts volunteered answers; replies carry one question', async () => {
  const { oneQuestion } = await import('../src/agent/graph/rules.ts')
  const p = { courseId: C, objective: 'exam_prep' as const, topic: 'Limits', material: 'curriculum' as const, materialFor: C, examDate: '2026-12-20', dailyMinutes: 60, confidence: 3, level: 'undergraduate' as const }
  assert.equal(nextSlot(p, ['confidence']), null, 'two optional facts known (one volunteered): no third follow-up')
  assert.ok(readyToPlan(p, ['confidence']))
  assert.equal(oneQuestion('Great. How confident are you, 1-5? And which year are you in?'), 'Great. How confident are you, 1-5?')
  assert.equal(oneQuestion('All set. Shall we start?'), 'All set. Shall we start?')
})

test('explicit topics are read by rule (live: "explain me disection of human body" looped on course selection)', () => {
  assert.equal(requestedTopic('explain me disection of human body', false), 'disection of human body')
  assert.equal(requestedTopic('I have my own topic: human body dissection.', false), 'human body dissection')
  assert.equal(requestedTopic("its the topic disection of human body", false), 'disection of human body')
  assert.equal(requestedTopic('I want to learn Python.', false), 'Python')
  assert.equal(requestedTopic('Explain quadratic equations step by step please', false), 'quadratic equations')
  // the answer to "which subject or skill?" is the topic itself
  assert.equal(requestedTopic('disection of human body', true), 'disection of human body')
  assert.equal(requestedTopic('disection of human body', false), null)
  // filler and vague phrases are never topics
  for (const m of ['explain this again please', 'Another subject or skill', 'I want to learn something new', 'explain more', 'tell me about it']) assert.equal(requestedTopic(m, true), null, m)
  assert.equal(asksForExplanation('Explain quadratic equations'), true)
  assert.equal(asksForExplanation('I want to learn Python'), false)
  assert.equal(topicChange('Switch topic to photosynthesis'), 'photosynthesis')
  assert.equal(topicChange('new topic: the French revolution'), 'the French revolution')
  assert.equal(topicChange('switch it off'), null)
  assert.equal(relatedTo('the musculoskeletal system', ['Human Body Dissection', 'Musculoskeletal systems']), true)
  assert.equal(relatedTo('disection of human body', ['Machine Learning', 'Photosynthesis']), false)
  assert.deepEqual(parseSlotAnswer('topic', 'its the topic disection of human body', new Date()), { topic: 'disection of human body' })
})

test('one-shot intake: only what is missing, validated as one payload, defaults for blanks', async () => {
  const { buildIntake, applyIntake, intakeRecord, statedLearner, parseLevelAnswer } = await import('../src/agent/intake.ts')
  const now = new Date('2026-11-25T10:00:00Z')
  assert.deepEqual(statedLearner('I am in class 12 and a complete beginner'), { level: 'school', grade: 'Class 12', confidence: 1 })
  assert.deepEqual(parseLevelAnswer('5'), { level: 'school', grade: 'Class 5' })
  assert.deepEqual(parseLevelAnswer('12th class'), { level: 'school', grade: 'Class 12' })
  const known = buildIntake({ courseId: 'c', level: 'school', grade: 'Class 12', confidence: 1, objective: 'conceptual_mastery', learningStyle: 'visual', material: 'ai', materialFor: 'c' }, { id: 'i', courseId: 'c', explain: true })
  assert.equal(known, null, 'nothing left to ask')
  const ik = buildIntake({ courseId: 'c' }, { id: 'i', courseId: 'c', explain: true })!
  const rec = intakeRecord(ik)
  const ok = applyIntake({ courseId: 'c' }, rec, { level: 'class_9_10', objective: 'visual' }, now)
  assert.deepEqual(ok.problems, [])
  assert.equal(ok.profile.learningStyle, 'visual', 'a blank style does not override the visual goal')
  assert.equal(ok.profile.examDate, 'none'); assert.equal(ok.profile.dailyMinutes, 30); assert.equal(ok.profile.material, 'ai')
  const bad = applyIntake({ courseId: 'c' }, rec, { confidence: 'genius', hack: 'x' }, now)
  assert.deepEqual(bad.problems.sort(), ['invalid answer: confidence', 'unexpected answer: hack'])
  const exam = applyIntake({ courseId: 'c' }, rec, { objective: 'exam', examDate: 'd14', dailyMinutes: 'm120' }, now)
  assert.equal(exam.profile.examDate, '2026-12-09'); assert.equal(exam.profile.dailyMinutes, 120)
})

test('several courses on one subject: the best-covered title, then the newest, is reused (no duplicate course)', async () => {
  const { courseNamed } = await import('../src/agent/profile.ts')
  const cs = [
    { id: 'a', title: 'Fundamentals of Human Dissection', createdAt: '2026-11-20' },
    { id: 'b', title: 'Comprehensive Course on Human Dissection', createdAt: '2026-11-25' },
    { id: 'c', title: 'Human Anatomy Dissection: Undergraduate Conceptual Mastery', createdAt: '2026-11-24' },
  ]
  assert.equal(courseNamed('explain human dissection', cs)?.id, 'b')
  assert.equal(courseNamed('undergraduate conceptual mastery of dissection', cs)?.id, 'c')
  assert.equal(courseNamed('quadratic equations', cs), null)
})
