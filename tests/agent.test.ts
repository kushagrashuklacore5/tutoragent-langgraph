/**
 * Study companion end to end through the HTTP API, the real database (RLS, encryption at rest) and the job system,
 * with a scripted model: conversational onboarding → researched plan proposal → approval → managed workflow;
 * approval rules, tool authorisation, interruption/AI-failure fallbacks, isolation, and background workflows.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase, type Database } from '@platform/tenancy-db'
import { createSystemDatabase, type SystemDatabase } from '@platform/tenancy-db/system'
import { createWorker, enqueueSystem } from '@platform/jobs'
import { GatewayError, type GenerateRequest } from '@platform/ai-adapter-kit'
import { setupTutorWorld, type TutorWorld } from './tutor-setup.ts'

const usage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: null, reasoningTokens: null }
const out = (json: unknown) => ({ text: JSON.stringify(json), toolCalls: [], finish: 'stop' as const, usage })
const decideQueue: unknown[] = []
const composeSeen: string[] = []
let aiDown = false
function respond(req: GenerateRequest) {
  const sys = req.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n')
  if (aiDown) throw new GatewayError('overloaded', 'provider overloaded (503)')
  if (/interrupts with a question/.test(sys)) return out({ intent: 'simplify', blocks: [{ type: 'text', text: 'A limit is the value a function gets close to as x gets close to a point.', label: 'ai', cites: [] }], followUp: 'Want an example?' })
  if (/design a complete, structured self-study course/.test(sys)) return out({ title: 'Geography Class 9', topics: [{ name: 'India: size and location', estMinutes: 40 }, { name: 'Physical features of India', prerequisites: [1] }, { name: 'Drainage', prerequisites: [2] }, { name: 'Climate', prerequisites: [1] }] })
  if (/Build a practice question set for/.test(sys)) return out({ items: [
    { type: 'mcq', stem: 'Which is the southernmost point of mainland India?', options: ['Kanyakumari', 'Indira Point', 'Rameswaram', 'Chennai'], correct: 'Kanyakumari', explanation: 'Kanyakumari is the southernmost point of the mainland; Indira Point is in the islands.' },
    { type: 'mcq', stem: 'Which line divides India into almost two equal halves?', options: ['Tropic of Cancer', 'Equator', 'Prime meridian'], correct: 'Equator', explanation: 'The Tropic of Cancer passes through the middle of India.' },
  ] })
  if (/Ek Bharat study companion: ONE friendly/.test(sys)) return out(decideQueue.shift() ?? { intent: 'other', reply: 'Okay.' })
  if (/Write your reply as JSON/.test(sys)) {
    const results = /RESULTS \(JSON\): (.*)$/s.exec(sys)?.[1] ?? ''
    composeSeen.push(results)
    return out({ reply: `COMPOSED ${Object.keys(JSON.parse(results)).join(',')}` })
  }
  return out({ segments: [{ text: 'ok', source: 'general' }], assessment: 'not_an_attempt' })
}

let w: TutorWorld
let db: Database
let system: SystemDatabase
let tenantX: string, stuId: string
const A = '/api/m/education.tutor/agent'
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

before(async () => {
  w = await setupTutorWorld({ respond })
  db = createDatabase(w.h.test.appUrl, { max: 4 })
  system = createSystemDatabase(w.h.test.systemUrl, { max: 4 })
  tenantX = (await w.owner.query(`select id from platform.tenants where slug = 'iit-x'`)).rows[0].id
  stuId = (await w.owner.query(`select id from platform.users where email = 'stu@x.test'`)).rows[0].id
})
after(async () => { await db.close(); await system.close(); await w.close() })

const say = async (token: string, message: string, conversationId?: string) => {
  const r = await w.h.call('POST', `${A}/messages`, token, { message, conversationId, language: 'en' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  return r.json as { conversationId: string; messages: { role: string; content: string; cards: { type: string; proposal?: { id: string; roadmap: { milestones: unknown[]; feasibility: string } }; workflow?: { status: string; steps: { status: string }[] } }[] }[]; state: { phase: string; pendingProposalId: string | null; appliedPlan: { version: number } | null; nextSession: { items: { kind: string }[] } | null } }
}
const runJobs = async () => createWorker({ system, db, handlers: w.h.app.platform.jobs, batch: 5 }).drain()

let conv = ''
let proposalId = ''

test('journey: goal in one message, a couple of follow-ups, never re-asking what is known', async () => {
  const v = await w.h.call('GET', A, w.stu)
  assert.equal(v.status, 200)
  assert.equal(v.json.messages[0].role, 'agent', 'welcome message')
  assert.equal(v.json.state.phase, 'onboarding')
  conv = v.json.conversationId

  decideQueue.push({ intent: 'set_goal', profile: { objective: 'exam_prep', topic: 'Limits and derivatives', examDate: inDays(30), dailyMinutes: 60 }, reply: 'Great goal! Will you use your own notes, or shall I prepare the material?' })
  const r1 = await say(w.stu, `I have my Calculus exam in a month and can study about an hour a day`, conv)
  assert.equal(r1.state.phase, 'onboarding', 'one optional follow-up before planning')
  assert.match(r1.messages[1]!.content, /own notes|material/i)

  // a direct answer is understood without the model (the scripted decide returns nothing useful)
  decideQueue.push({ intent: 'onboarding_answer', reply: 'Thanks! How confident do you feel, 1 to 5?' })
  const r2 = await say(w.stu, 'you prepare it', conv)
  assert.equal(r2.state.phase, 'onboarding')

  // the student declines the last optional question → the planning workflow runs (syllabus → mastery → roadmap)
  decideQueue.push({ intent: 'onboarding_answer', profile: { skip: ['confidence', 'level'] }, reply: 'No problem.' })
  const r3 = await say(w.stu, 'skip', conv)
  assert.equal(r3.state.phase, 'awaiting_approval')
  const cards = r3.messages[1]!.cards
  const wf = cards.find((c) => c.type === 'workflow')!.workflow!
  assert.equal(wf.status, 'done')
  assert.ok(wf.steps.every((s) => s.status === 'done'))
  const pc = cards.find((c) => c.type === 'plan_proposal')!.proposal!
  proposalId = pc.id
  assert.equal(r3.state.pendingProposalId, proposalId)
  assert.ok(pc.roadmap.milestones.length >= 1)
  assert.match(r3.messages[1]!.content, /^COMPOSED .*planProposal/, 'the reply is composed from the tool results')
  const res = JSON.parse(composeSeen.at(-1)!)
  assert.ok(res['curriculum.syllabus'].topics.length === 2 && res['mastery.analyse'], 'researched: syllabus and current mastery were read')

  const prof = (await w.h.call('GET', A, w.stu)).json.profile
  assert.equal(prof.dailyMinutes, 60)
  assert.equal(prof.material, 'ai')
  assert.equal(prof.topic, 'Limits and derivatives')
  // nothing was written to the student's plan before approval
  assert.equal((await w.owner.query(`select count(*)::int as n from education_tutor.plans where user_id = $1`, [stuId])).rows[0].n, 0)
})

test('the model cannot apply a plan or reach another course; requests are validated and traced', async () => {
  const other = (await w.h.call('POST', '/api/m/education.tutor/courses', w.prof, { code: 'PH999', title: 'Not enrolled' })).json.id
  decideQueue.push({ intent: 'progress', actions: [{ tool: 'plan.apply', args: { proposal: { id: proposalId } } }, { tool: 'mastery.analyse', args: { courseId: other } }, { tool: 'no.such', args: {} }], reply: 'Applied your plan!' })
  const r0 = await say(w.stu, 'how am I doing? also just save the plan', conv)
  assert.equal(r0.state.phase, 'awaiting_approval', 'nothing applied without the student approving')
  assert.equal((await w.owner.query(`select count(*)::int as n from education_tutor.plans where user_id = $1`, [stuId])).rows[0].n, 0)
  const t0 = (await w.owner.query(`select tool, status, error_code from education_tutor.agent_tool_calls where user_id = $1 and tool in ('plan.apply', 'mastery.analyse', 'no.such') and status <> 'ok' order by created_at`, [stuId])).rows
  // while a plan awaits approval only research tools may run: plan.apply and unknown tools are never executed
  assert.deepEqual(t0, [
    { tool: 'mastery.analyse', status: 'error', error_code: 'not_found' },
  ])
  // the student's own explicit approval of the pending proposal applies the STORED proposal (model args ignored)
  decideQueue.push({ intent: 'approve_plan', actions: [{ tool: 'plan.apply', args: { proposal: { id: 'forged' } } }], reply: 'Done!' })
  const r = await say(w.stu, 'yes looks good, go ahead', conv)
  assert.equal(r.state.phase, 'active')
  const applied = (await w.owner.query(`select status from education_tutor.agent_tool_calls where user_id = $1 and tool = 'plan.apply' and status = 'ok'`, [stuId])).rows
  assert.equal(applied.length, 1)
})

test('approval created the plan, milestones and checkpoints once; repeated approval is a no-op', async () => {
  const plans = (await w.owner.query(`select version, trigger from education_tutor.plans where user_id = $1`, [stuId])).rows
  assert.deepEqual(plans, [{ version: 1, trigger: 'agent' }])
  const tasks = (await w.owner.query(`select kind, status from education_tutor.agent_tasks where user_id = $1`, [stuId])).rows
  assert.ok(tasks.some((t) => t.kind === 'milestone') && tasks.some((t) => t.kind === 'checkpoint'))
  assert.ok(tasks.every((t) => t.status === 'pending'))
  const goal = (await w.owner.query(`select exam_at, daily_minutes from education_tutor.goals where user_id = $1`, [stuId])).rows[0]
  assert.ok(goal.daily_minutes > 0 && goal.exam_at)
  const again = await w.h.call('POST', `${A}/proposals/${proposalId}/approve`, w.stu, { conversationId: conv })
  assert.equal(again.status, 200)
  assert.equal((await w.owner.query(`select count(*)::int as n from education_tutor.plans where user_id = $1`, [stuId])).rows[0].n, 1)
  assert.equal((await w.owner.query(`select count(*)::int as n from education_tutor.agent_tasks where user_id = $1`, [stuId])).rows[0].n, tasks.length)
})

test('approval starts learning by itself: the book opens; "continue" later returns to that same book', async () => {
  const msgs = (await w.h.call('GET', A, w.stu)).json.messages as { cards: { type: string; auto?: boolean; links?: { href: string }[] }[] }[]
  const opened = msgs.flatMap((m) => m.cards).filter((c) => c.type === 'links' && c.auto && /\/studio\//.test(c.links![0]!.href))
  assert.equal(opened.length, 1, 'the approved plan opened the book automatically')
  const href = opened[0]!.links![0]!.href
  // no model call: "continue" with an active book is handled deterministically
  const before = decideQueue.length
  const r = await say(w.stu, 'continue', conv)
  const back = r.messages[1]!.cards.find((c) => c.type === 'links') as unknown as { auto?: boolean; links: { href: string }[] }
  assert.equal(back.auto, true)
  assert.equal(back.links[0]!.href, href, 'resumes the active book (the book keeps the exact lecture position)')
  assert.equal(decideQueue.length, before)
})

test('changing availability re-proposes; approval by button replaces the schedule', async () => {
  decideQueue.push({ intent: 'modify_plan', profile: { dailyMinutes: 30 }, reply: 'Updating.' })
  const r = await say(w.stu, 'actually I only have 30 minutes a day now', conv)
  assert.equal(r.state.phase, 'awaiting_approval')
  const id = r.state.pendingProposalId!
  assert.notEqual(id, proposalId)
  const stale = await w.h.call('POST', `${A}/proposals/${proposalId}/reject`, w.stu, { conversationId: conv })
  assert.equal(stale.status, 409, 'an old proposal cannot be acted on')
  const ok = await w.h.call('POST', `${A}/proposals/${id}/approve`, w.stu, { conversationId: conv })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.state.appliedPlan.version, 2)
  assert.ok(ok.json.state.nextSession.items.length >= 1, 'next session prepared')
  const st = (await w.owner.query(`select plan_version, status from education_tutor.agent_tasks where user_id = $1`, [stuId])).rows
  assert.ok(st.filter((x) => x.plan_version === 1).every((x) => x.status === 'cancelled'))
  assert.ok(st.filter((x) => x.plan_version === 2).every((x) => x.status === 'pending'))
})

test('teaching and resources are delegated to existing tools (links), not invented in chat', async () => {
  decideQueue.push({ intent: 'learn_topic', topic: 'Limits', actions: [{ tool: 'lesson.start', args: { conceptId: 'limits' } }, { tool: 'revision.status', args: {} }], doubts: { open: ['Why can a limit exist where f is undefined?'] }, reply: 'Opening a lesson.' })
  const r = await say(w.stu, 'samjhao limits kya hote hain, mujhe doubt hai undefined points pe', conv)
  const links = r.messages[1]!.cards.filter((c) => c.type === 'links') as unknown as { auto?: boolean; links: { href: string }[] }[]
  assert.equal(links.length, 2, 'lesson + revision links')
  assert.equal(links.filter((l) => l.auto).length, 1, 'only the first workspace opens by itself')
  assert.match(links.find((l) => l.auto)!.links[0]!.href, /tutor\?conceptId=/)
  assert.match(JSON.stringify(links), new RegExp(`tutor\\?conceptId=${w.cLimits}`))
  const prof = (await w.h.call('GET', A, w.stu)).json.profile
  assert.equal(prof.openDoubts.length, 1, 'the doubt is remembered')
})

test('model outage: the turn still completes with a deterministic reply and nothing is lost', async () => {
  const fresh = (await w.h.call('POST', `${A}/conversations`, w.stu2)).json.conversationId
  aiDown = true
  try {
    const r = await say(w.stu2, 'hi, I want to get better at calculus', fresh)
    assert.equal(r.messages[0]!.content, 'hi, I want to get better at calculus')
    assert.match(r.messages[1]!.content, /main goal/, 'falls back to the next onboarding question')
  } finally { aiDown = false }
})

test('isolation: other students and institutions cannot read or act on the companion data; content is encrypted', async () => {
  const s2 = await w.h.call('GET', A, w.stu2)
  assert.notEqual(s2.json.conversationId, conv)
  assert.ok(!JSON.stringify(s2.json).includes('Calculus exam in a month'))
  assert.equal((await w.h.call('POST', `${A}/messages`, w.stu2, { message: 'hi', conversationId: conv })).status, 404)
  assert.equal((await w.h.call('POST', `${A}/proposals/${proposalId}/approve`, w.stu2, { conversationId: conv })).status, 404, 'another student conversation does not exist for them (RLS)')
  assert.equal((await w.h.call('GET', A, w.prof)).json.profile.dailyMinutes, undefined, 'an educator gets their own (empty) companion, never a student\'s')
  const adminY = await w.h.signIn('nit-y', 'admin@y.test')
  assert.ok([403, 404].includes((await w.h.call('GET', A, adminY)).status), 'institution without the tutor')
  // RLS: as stu2, raw SQL sees none of stu's rows
  const seen = await db.withTenant({ tenantId: tenantX, userId: (await w.owner.query(`select id from platform.users where email = 'stu2@x.test'`)).rows[0].id, roles: ['student'] }, async (t) =>
    (await t.query(`select (select count(*) from education_tutor.agent_messages where user_id = $1)::int as m, (select count(*) from education_tutor.agent_profiles where user_id = $1)::int as p, (select count(*) from education_tutor.agent_tasks where user_id = $1)::int as k`, [stuId])).rows[0])
  assert.deepEqual(seen, { m: 0, p: 0, k: 0 })
  const raw = (await w.owner.query(`select content_enc from education_tutor.agent_messages where user_id = $1`, [stuId])).rows.map((r) => r.content_enc).join(' ')
  assert.ok(!raw.includes('Calculus exam') && !raw.includes('30 minutes'), 'messages are encrypted at rest')
  const prof = (await w.owner.query(`select profile_enc from education_tutor.agent_profiles where user_id = $1`, [stuId])).rows[0].profile_enc
  assert.ok(!prof.includes('exam_prep'))
  const args = (await w.owner.query(`select args from education_tutor.agent_tool_calls where user_id = $1`, [stuId])).rows.map((r) => JSON.stringify(r.args)).join(' ')
  assert.ok(!args.includes('undefined points'), 'traces hold ids, not student text')
})

test('background: daily workflow marks missed milestones and nudges once; assessment results re-plan the approved plan', async () => {
  await w.owner.query(`update education_tutor.agent_tasks set due_on = current_date - 2, created_at = now() - interval '5 days' where user_id = $1 and plan_version = 2 and kind = 'milestone' and seq = 1`, [stuId])
  let k = 0
  const job = () => system.tx((t) => enqueueSystem(t, 'education.tutor/agent.daily.student', { userId: stuId }, { tenantId: tenantX, idempotencyKey: `daily:${++k}` }))
  await job(); await runJobs()
  const missed = (await w.owner.query(`select status from education_tutor.agent_tasks where user_id = $1 and plan_version = 2 and kind = 'milestone' and seq = 1`, [stuId])).rows[0].status
  assert.equal(missed, 'missed')
  // the student was active today (messages), so no routine nudges
  assert.equal((await w.owner.query(`select count(*)::int as n from education_tutor.agent_messages where user_id = $1 and kind = 'nudge'`, [stuId])).rows[0].n, 0)
  await w.owner.query(`update education_tutor.agent_messages set created_at = now() - interval '1 day' where user_id = $1`, [stuId])
  await w.owner.query(`update education_tutor.agent_tasks set status = 'pending' where user_id = $1 and plan_version = 2 and kind = 'milestone' and seq = 1`, [stuId])
  await job(); await runJobs()
  await job(); await runJobs()
  const nudges = (await w.owner.query(`select dedupe_key from education_tutor.agent_messages where user_id = $1 and kind = 'nudge'`, [stuId])).rows
  assert.equal(nudges.filter((n) => n.dedupe_key.startsWith('milestone_overdue')).length, 1, 'posted once despite two runs')
  assert.equal((await w.h.call('GET', `${A}/unread`, w.stu)).json.unread, nudges.length)

  // a graded assessment for the course → the approved plan is re-built and the student is told
  const asmt = (await w.owner.query(`insert into education_tutor.assessments (tenant_id, course_id, title, settings, status, created_by) values ($1, $2, 'Limits check', '{}', 'published', $3) returning id`, [tenantX, w.courseId, stuId])).rows[0].id
  const att = (await w.owner.query(`insert into education_tutor.assessment_attempts (tenant_id, user_id, assessment_id, course_id, status, plan, score, max_score) values ($1, $2, $3, $4, 'graded', '[]', 1, 4) returning id`, [tenantX, stuId, asmt, w.courseId])).rows[0].id
  await system.tx((t) => enqueueSystem(t, 'education.tutor/agent.after_assessment', { userId: stuId, attemptId: att }, { tenantId: tenantX, idempotencyKey: `after:${att}` }))
  await runJobs()
  const latest = (await w.owner.query(`select version, trigger from education_tutor.plans where user_id = $1 order by version desc limit 1`, [stuId])).rows[0]
  assert.deepEqual(latest, { version: 3, trigger: 'assessment_update' })
  const told = (await w.h.call('GET', A, w.stu)).json.messages.filter((m: { kind: string; content: string }) => m.kind === 'nudge' && /Limits check/.test(m.content))
  assert.equal(told.length, 1)
})

test('forget me deletes the companion memory', async () => {
  assert.equal((await w.h.call('DELETE', `${A}/memory`, w.stu)).status, 204)
  for (const t of ['agent_profiles', 'agent_conversations', 'agent_messages', 'agent_tasks', 'agent_tool_calls']) {
    assert.equal((await w.owner.query(`select count(*)::int as n from education_tutor.${t} where user_id = $1`, [stuId])).rows[0].n, 0, t)
  }
})

test('product insights: tenant admins only, aggregates only (no ids or student text)', async () => {
  assert.equal((await w.h.call('GET', '/api/m/education.tutor/insights/product', w.stu)).status, 403)
  assert.equal((await w.h.call('GET', '/api/m/education.tutor/insights/product', w.prof)).status, 403)
  const r = await w.h.call('GET', '/api/m/education.tutor/insights/product?days=30', w.admin)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.ok(Array.isArray(r.json.signals) && Array.isArray(r.json.recommendations))
  const body = JSON.stringify(r.json)
  assert.ok(!body.includes(stuId) && !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(body), 'no ids')
  // only 2 students used the companion here: per-student areas are suppressed below 5
  assert.ok(r.json.signals.every((s: { area: string }) => s.area === 'ai' || s.area === 'ai_error'))
})

test('any subject: the chat creates a personal course with a validated syllabus; practice questions are generated and only verified ones kept', async () => {
  const fresh = (await w.h.call('POST', `${A}/conversations`, w.stu)).json.conversationId
  decideQueue.push({ intent: 'set_goal', profile: { objective: 'conceptual_mastery' }, actions: [{ tool: 'course.create', args: { subject: 'Geography class 9' } }], reply: 'Creating your course.' })
  const r = await say(w.stu, 'I want to learn Geography class 9', fresh)
  const course = (await w.owner.query(`select id, title, owner_user_id from education_tutor.courses where owner_user_id = $1`, [stuId])).rows
  assert.equal(course.length, 1)
  assert.equal(course[0].title, 'Geography Class 9')
  const concepts = (await w.owner.query(`select name, status from education_tutor.concepts where course_id = $1 order by created_at`, [course[0].id])).rows
  assert.deepEqual(concepts.map((c) => c.name), ['India: size and location', 'Physical features of India', 'Drainage', 'Climate'])
  assert.ok(concepts.every((c) => c.status === 'approved'))
  assert.equal((await w.owner.query(`select count(*)::int as n from education_tutor.concept_edges e join education_tutor.concepts c on c.id = e.to_concept where c.course_id = $1`, [course[0].id])).rows[0].n, 3)
  assert.equal((await w.h.call('GET', A, w.stu)).json.profile.courseId, course[0].id, 'the new course becomes the course of this goal')
  assert.ok(r.messages[1]!.cards.some((c) => c.type === 'choices' || c.type === 'links'))
  // practice: generated on demand; the MCQ whose own explanation contradicts its key is rejected
  const deps = (await w.owner.query(`select id from platform.ai_deployments where model_id = 'tutor-1' order by created_at limit 1`)).rows as { id: string }[]
  assert.equal((await w.h.call('PUT', '/api/admin/ai/routes', w.admin, { target: 'category:assessment', candidates: [{ deploymentId: deps[0]!.id }] })).status, 200)
  const prep = await w.h.call('POST', `/api/m/education.tutor/courses/${course[0].id}/practice/prepare`, w.stu, {})
  assert.equal(prep.status, 200, JSON.stringify(prep.json))
  assert.equal(prep.json.added, 1)
  assert.equal(prep.json.rejected, 1)
  const items = (await w.owner.query(`select status, origin, validation from education_tutor.items where course_id = $1`, [course[0].id])).rows
  assert.deepEqual(items.map((i) => [i.status, i.origin]), [['approved', 'ai_verified']])
  // other students cannot add questions to a course they are not enrolled in
  assert.equal((await w.h.call('POST', `/api/m/education.tutor/courses/${course[0].id}/practice/prepare`, w.stu2, {})).status, 404)
})

test('one chat everywhere: a doubt sent from a book page is answered inside that book, with the way back to the lesson', async () => {
  const fresh = (await w.h.call('POST', `${A}/conversations`, w.stu)).json.conversationId
  const book = (await w.owner.query(`select id from education_tutor.studio_books where user_id = $1 limit 1`, [stuId])).rows[0]
  assert.ok(book, 'a book exists from the approved plan')
  decideQueue.push({ intent: 'question', reply: 'ignored draft' })
  const r = await w.h.call('POST', `${A}/messages`, w.stu, { conversationId: fresh, message: 'what is a limit, simply?', language: 'en', context: { bookId: book.id, pageNo: 1, selection: 'limit' } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const reply = r.json.messages[1]
  assert.match(reply.content, /value a function gets close to/)
  assert.ok(reply.cards.some((c: { type: string; bookAnswer?: { bookId: string } }) => c.type === 'book_answer' && c.bookAnswer!.bookId === book.id))
  assert.ok(!JSON.stringify(reply.cards).includes('gets close to'), 'answer text is only in the encrypted message, not in card JSON')
  // another student's book is not reachable through the chat
  const other = await w.h.call('POST', `${A}/messages`, w.stu2, { message: 'explain', language: 'en', context: { bookId: book.id, pageNo: 1 } })
  assert.equal(other.status, 404)
})

test('journey rule: with own material the plan waits for the upload; nothing opens while setting up', async () => {
  const fresh = (await w.h.call('POST', `${A}/conversations`, w.stu2)).json.conversationId
  decideQueue.push({ intent: 'set_goal', profile: { objective: 'exam_prep', topic: 'Limits', examDate: inDays(20), dailyMinutes: 40, material: 'own', skip: ['confidence', 'level'] }, actions: [{ tool: 'studio.open', args: { title: 'Limits' } }, { tool: 'practice.start', args: {} }], reply: 'I opened the book for you!' })
  const r = await say(w.stu2, 'Limits exam in 20 days, 40 min a day, I will upload my notes', fresh)
  const last = r.messages[1]!
  assert.equal(r.state.phase, 'onboarding', 'no plan before the material is uploaded')
  assert.ok(last.cards.some((c) => c.type === 'upload'), 'asks for the file')
  assert.ok(!last.cards.some((c) => c.type === 'plan_proposal' || c.type === 'links'), 'nothing opened or planned')
  assert.doesNotMatch(last.content, /opened the book/, 'the model cannot claim an action that did not happen')
  assert.match(last.content, /📎/)
})

test('"Another subject or skill" asks which one: no course is created without a named subject', async () => {
  const fresh = (await w.h.call('POST', `${A}/conversations`, w.stu2)).json.conversationId
  const before = (await w.owner.query(`select count(*)::int as n from education_tutor.courses`)).rows[0].n
  const r = await say(w.stu2, 'Another subject or skill', fresh)
  assert.match(r.messages[1]!.content, /Which subject or skill/)
  // the model asking for a vague course is refused too
  decideQueue.push({ intent: 'set_goal', actions: [{ tool: 'course.create', args: { subject: 'Comprehensive course of an unspecified subject' } }], reply: 'Created!' })
  await say(w.stu2, 'I want to learn something new', fresh)
  assert.equal((await w.owner.query(`select count(*)::int as n from education_tutor.courses`)).rows[0].n, before)
})
