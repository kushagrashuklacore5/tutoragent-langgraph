/**
 * Explicit learning intent through the REAL LangGraph companion (HTTP → graph → PostgreSQL checkpointer).
 * The model is deliberately unhelpful here ({intent: 'other'}), so these prove the rules alone keep the student's topic:
 * live failure: "explain me disection of human body" → "Which of your courses…?" four times, with unrelated courses listed.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { type GenerateRequest } from '@platform/ai-adapter-kit'
import { setupTutorWorld, type TutorWorld } from './tutor-setup.ts'

const usage = { inputTokens: 50, outputTokens: 20, cachedInputTokens: null, reasoningTokens: null }
const out = (json: unknown) => ({ text: JSON.stringify(json), toolCalls: [], finish: 'stop' as const, usage })
const A = '/api/m/education.tutor/agent'
const decideQueue: unknown[] = []
const OUTLINES: [RegExp, string, string[]][] = [
  [/dissection|human body/i, 'Human Body Dissection', ['Purpose and ethics of dissection', 'Body systems overview', 'Musculoskeletal system']],
  [/python/i, 'Python Programming', ['Variables and types', 'Control flow', 'Functions']],
  [/quadratic/i, 'Quadratic Equations', ['Standard form', 'Factorisation', 'Quadratic formula']],
  [/chemistry/i, 'Class 12 Chemistry', ['Solutions', 'Electrochemistry', 'Chemical kinetics']],
  [/photosynthesis/i, 'Photosynthesis', ['Light reactions', 'Calvin cycle', 'Factors affecting photosynthesis']],
]
function respond(req: GenerateRequest) {
  const sys = req.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n')
  const user = req.messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join(' ')
  if (/Ek Bharat study companion: ONE friendly/.test(sys)) return out(decideQueue.shift() ?? { intent: 'other', reply: 'Okay.' })
  if (/Write your reply as JSON/.test(sys)) return out({ reply: 'Here you go.' })
  if (/design a complete, structured self-study course/.test(sys)) {
    const subject = /Subject or skill: (.*)/.exec(user)?.[1] ?? user
    const hit = OUTLINES.find(([re]) => re.test(subject)) ?? OUTLINES[0]!
    return out({ title: hit[1], topics: hit[2].map((name) => ({ name })) })
  }
  return out({ segments: [{ text: 'ok', source: 'general' }], assessment: 'not_an_attempt' })
}

let w: TutorWorld
let n = 0
before(async () => { w = await setupTutorWorld({ respond }) })
after(async () => { await w?.close() })

/** a brand-new student with no course at all */
async function newStudent() {
  const email = `learner${++n}@x.test`
  assert.equal((await w.h.call('POST', '/api/members', w.admin, { email, roles: ['student'] })).status, 200)
  const token = await w.h.signIn('iit-x', email)
  const id = (await w.owner.query('select id from platform.users where email = $1', [email])).rows[0].id as string
  const conversationId = (await w.h.call('POST', `${A}/conversations`, token)).json.conversationId as string
  return { token, id, conversationId }
}
type Card = { type: string; choices?: string[]; intake?: Intake; links?: { label: string; href: string }[]; auto?: boolean }
interface Intake { id: string; questions: { slot: string; default: string | null; required: boolean; showIf?: { slot: string; in: string[] } }[] }
const say = async (s: { token: string; conversationId: string }, message: string, intake?: { id: string; answers: Record<string, string>; review?: boolean }) => {
  const r = await w.h.call('POST', `${A}/messages`, s.token, { conversationId: s.conversationId, message, language: 'en', ...(intake ? { intake } : {}) })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const m = (r.json.messages as { content: string; cards: Card[] }[]).at(-1)!
  return { reply: m.content, cards: m.cards, choices: m.cards.find((c) => c.type === 'choices')?.choices ?? [], intake: m.cards.find((c) => c.type === 'intake')?.intake ?? null, phase: (r.json.state as { phase: string }).phase, state: r.json.state as { phase: string; pendingProposalId: string | null } }
}
const state = async (conversationId: string) => (await w.owner.query('select state from education_tutor.agent_conversations where id = $1', [conversationId])).rows[0].state as { lastAsked: string | null; topic: { name: string } | null }
const courses = async (userId: string) => (await w.owner.query(`select c.title from education_tutor.courses c join education_tutor.enrolments e on e.course_id = c.id where e.user_id = $1 order by c.created_at`, [userId])).rows.map((r) => r.title as string)
const COURSE_QUESTION = /which of your courses/i

test('1. "Explain human body dissection." starts learning that topic, with no course selection', async () => {
  const s = await newStudent()
  const r = await say(s, 'Explain human body dissection.')
  assert.doesNotMatch(r.reply, COURSE_QUESTION)
  assert.deepEqual(r.choices, [], 'no course list for an explicit topic')
  assert.deepEqual(await courses(s.id), ['Human Body Dissection'])
  const st = await state(s.conversationId)
  assert.notEqual(st.lastAsked, 'courseId')
  assert.equal(st.topic?.name, 'human body dissection')
})

test('2. "I have my own topic: human body dissection." is understood as the topic', async () => {
  const s = await newStudent()
  const r = await say(s, 'I have my own topic: human body dissection.')
  assert.doesNotMatch(r.reply, COURSE_QUESTION)
  assert.deepEqual(await courses(s.id), ['Human Body Dissection'])
})

test('3. "I want to learn Python." and 4. "Explain quadratic equations." each start their own subject', async () => {
  const a = await newStudent(), b = await newStudent()
  await say(a, 'I want to learn Python.')
  await say(b, 'Explain quadratic equations.')
  assert.deepEqual(await courses(a.id), ['Python Programming'])
  assert.deepEqual(await courses(b.id), ['Quadratic Equations'])
})

test('5. the live failure: "Another subject or skill", then the topic in the student\'s own (misspelt) words', async () => {
  const s = await newStudent()
  // a vague first message: here asking which course is reasonable
  const first = await say(s, 'hello')
  void first
  const another = await say(s, 'Another subject or skill')
  assert.match(another.reply, /which subject or skill/i)
  assert.equal((await state(s.conversationId)).lastAsked, 'subject', 'the pending question is recorded')
  const r = await say(s, 'disection of human body')
  assert.doesNotMatch(r.reply, COURSE_QUESTION)
  assert.deepEqual(await courses(s.id), ['Human Body Dissection'])
  const again = await say(s, "its the topic disection of human body")
  assert.doesNotMatch(again.reply, COURSE_QUESTION, 'never back to course selection')
  assert.deepEqual(await courses(s.id), ['Human Body Dissection'], 'repeating the topic does not create a second course')
})

test('6. typing instead of answering keeps the SAME intake open (no new questions, no loop); "ok go ahead" takes the defaults', async () => {
  const s = await newStudent()
  const first = await say(s, 'I want to learn Python.')
  const id = first.intake!.id
  const r = await say(s, 'something about it, not sure how to say')
  assert.equal(r.intake?.id, id, 'the same intake, not a second one')
  assert.equal((await state(s.conversationId)).lastAsked, null, 'no single follow-up question')
  const go = await say(s, 'ok go ahead and draft')
  assert.equal(go.phase, 'active', 'consent starts learning with the defaults')
})

test('7. an explicit topic change mid-way starts the new subject; 8. choosing an existing course by name selects it', async () => {
  const s = await newStudent()
  await say(s, 'Explain human body dissection.')
  await say(s, 'Switch topic to photosynthesis')
  assert.deepEqual(await courses(s.id), ['Human Body Dissection', 'Photosynthesis'])
  assert.equal((await state(s.conversationId)).topic?.name, 'photosynthesis')
  const r = await say(s, 'I want to learn Human Body Dissection again')
  assert.deepEqual(await courses(s.id), ['Human Body Dissection', 'Photosynthesis'], 'the existing course is chosen, not recreated')
  assert.doesNotMatch(r.reply, COURSE_QUESTION)
})

test('12. two conversations at the same time keep their own topics; 13. a repeated request does not duplicate work', async () => {
  const a = await newStudent(), b = await newStudent()
  await Promise.all([say(a, 'Explain human body dissection.'), say(b, 'Explain quadratic equations.')])
  assert.deepEqual(await courses(a.id), ['Human Body Dissection'])
  assert.deepEqual(await courses(b.id), ['Quadratic Equations'])
  await say(a, 'Explain human body dissection.')
  assert.deepEqual(await courses(a.id), ['Human Body Dissection'])
})

test('14. a question inside an active course stays in that course; filler is never taken as a topic', async () => {
  const s = await newStudent()
  await say(s, 'Explain human body dissection.')
  await say(s, 'explain this again please')
  await say(s, 'explain the musculoskeletal system')
  assert.deepEqual(await courses(s.id), ['Human Body Dissection'])
})

test('the live case: a student who already has an unrelated course asks to explain a new topic while setting up', async () => {
  const s = await newStudent()
  await say(s, 'I want to learn Python.')
  const fresh = (await w.h.call('POST', `${A}/conversations`, s.token)).json.conversationId as string
  const r = await say({ token: s.token, conversationId: fresh }, 'explain me disection of human body')
  assert.doesNotMatch(r.reply, COURSE_QUESTION)
  assert.deepEqual(r.choices.filter((x) => /python/i.test(x)), [], 'the unrelated course is not offered')
  assert.deepEqual(await courses(s.id), ['Python Programming', 'Human Body Dissection'])
  assert.notEqual((await state(fresh)).lastAsked, 'topic', 'the topic is not asked again')
})

// ---- one-shot intake → course → plan → Vidya (onboarding redesign) ----
const plans = async (userId: string) => (await w.owner.query('select count(*)::int as n from education_tutor.plans where user_id = $1', [userId])).rows[0].n as number
const profileOf = async (token: string) => (await w.h.call('GET', A, token)).json.profile as Record<string, unknown>

test('intake: "Explain human dissection." → ONE consolidated intake → one submission → course, plan and the first lesson open with Vidya', async () => {
  const s = await newStudent()
  const r1 = await say(s, 'Explain human dissection.')
  assert.ok(r1.intake, 'one intake card')
  assert.deepEqual(r1.intake.questions.map((q) => q.slot), ['level', 'confidence', 'objective', 'learningStyle', 'examDate', 'dailyMinutes', 'material'])
  assert.deepEqual(r1.intake.questions.filter((q) => q.showIf).map((q) => q.slot), ['examDate', 'dailyMinutes'], 'a timetable only for a scheduled goal')
  assert.doesNotMatch(r1.reply, /\?/, 'no separate question')
  assert.deepEqual(r1.choices, [])
  assert.equal((await state(s.conversationId)).lastAsked, null)
  const r2 = await say(s, 'Class 11–12 · Complete beginner', { id: r1.intake.id, answers: { level: 'class_11_12', confidence: 'beginner' } })
  assert.equal(r2.phase, 'active', 'no approval loop')
  assert.equal(r2.state.pendingProposalId, null)
  assert.equal(await plans(s.id), 1)
  const open = r2.cards.find((c) => c.type === 'links' && c.auto)
  assert.match(open?.links?.[0]?.href ?? '', /^\/studio\/[0-9a-f-]{36}\?teach=1$/, 'the first lesson opens and Vidya starts teaching')
  assert.match(r2.reply, /Vidya is opening your first lesson/)
  const prof = await profileOf(s.token)
  assert.equal(prof.grade, 'Class 11–12'); assert.equal(prof.confidence, 1); assert.equal(prof.objective, 'conceptual_mastery'); assert.equal(prof.examDate, 'none'); assert.equal(prof.material, 'ai')
  // duplicate submission: nothing is created twice
  const r3 = await say(s, 'Class 11–12 · Complete beginner', { id: r1.intake.id, answers: { level: 'class_11_12' } })
  assert.equal(await plans(s.id), 1)
  assert.equal(r3.phase, 'active')
  assert.deepEqual(await courses(s.id), ['Human Body Dissection'])
})

test('intake: what the student already said is never asked again; a custom answer is understood; a known learner is asked less', async () => {
  const s = await newStudent()
  const r1 = await say(s, 'I am in class 12 and a complete beginner, teach me quadratic equations')
  assert.deepEqual(r1.intake!.questions.map((q) => q.slot).filter((x) => x === 'level' || x === 'confidence'), [], 'class and confidence were stated')
  const p1 = await profileOf(s.token)
  assert.equal(p1.grade, 'Class 12'); assert.equal(p1.confidence, 1)
  const b = await newStudent()
  const r2 = await say(b, 'I want to learn Python from scratch.')
  const r3 = await say(b, 'my own words', { id: r2.intake!.id, answers: { level: 'final year engineering student', objective: 'I want to build small automation scripts for my job', learningStyle: 'examples' } })
  assert.equal(r3.phase, 'active')
  const p2 = await profileOf(b.token)
  assert.equal(p2.level, 'undergraduate'); assert.equal(p2.objective, 'practical_skills')
  // the same learner starting another subject: level and teaching style carry over; only subject-specific questions remain
  const r4 = await say(b, 'Explain quadratic equations.')
  const slots = r4.intake!.questions.map((q) => q.slot)
  assert.ok(!slots.includes('level') && !slots.includes('learningStyle') && slots.includes('confidence') && slots.includes('objective'), slots.join(','))
})

test('intake: an exam goal asks for the date and daily time; skipping the optional questions uses the defaults', async () => {
  const s = await newStudent()
  const r1 = await say(s, 'Prepare me for my Class 12 chemistry examination.')
  assert.deepEqual(await courses(s.id), ['Class 12 Chemistry'])
  const slots = r1.intake!.questions.map((q) => q.slot)
  assert.ok(slots.includes('examDate') && slots.includes('dailyMinutes') && !slots.includes('level') && !slots.includes('objective'), slots.join(','))
  assert.ok(r1.intake!.questions.every((q) => !q.showIf))
  const r2 = await say(s, 'Start learning', { id: r1.intake!.id, answers: {} })
  assert.equal(r2.phase, 'active')
  const p = await profileOf(s.token)
  assert.equal(p.objective, 'exam_prep'); assert.equal(p.dailyMinutes, 60); assert.match(String(p.examDate), /^\d{4}-\d{2}-\d{2}$/)
})

test('intake: asking to review the plan first keeps ONE approval; "approved" applies it even when the model is unhelpful', async () => {
  const s = await newStudent()
  const r1 = await say(s, 'Explain human dissection.')
  const r2 = await say(s, 'Show me the plan first', { id: r1.intake!.id, answers: {}, review: true })
  assert.equal(r2.phase, 'awaiting_approval')
  assert.equal(await plans(s.id), 0)
  const r3 = await say(s, 'approved')
  assert.equal(r3.phase, 'active')
  assert.equal(await plans(s.id), 1)
})

test('intake: own material asks for the upload instead of planning; a stale intake id changes nothing', async () => {
  const s = await newStudent()
  const r1 = await say(s, 'Explain human dissection.')
  const r2 = await say(s, 'My own notes', { id: r1.intake!.id, answers: { material: 'own' } })
  assert.equal(r2.phase, 'onboarding')
  assert.ok(r2.cards.some((c) => c.type === 'upload'))
  assert.equal(await plans(s.id), 0)
  const b = await newStudent()
  const r3 = await say(b, 'Explain human dissection.')
  const r4 = await say(b, 'old form', { id: '00000000-0000-4000-8000-000000000000', answers: { material: 'ai' } })
  assert.equal(r4.phase, 'onboarding')
  assert.equal(await plans(b.id), 0)
  void r3
})
