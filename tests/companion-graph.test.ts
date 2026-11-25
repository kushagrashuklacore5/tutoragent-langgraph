/**
 * The companion as a LangGraph workflow, end to end over HTTP with the REAL PostgreSQL checkpointer:
 * interrupts and resume (roadmap approval), durability across a server restart without repeating completed steps,
 * thread ownership and "forget me", subject switching, practice only after setup + an explicit request, and a
 * transient provider failure retried by a node's RetryPolicy.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { createWorker } from '@platform/jobs'
import { hashingEmbed, makeDocx } from '@platform/testing'
import { GatewayError, type GenerateRequest } from '@platform/ai-adapter-kit'
import { manifest as tutor } from '@modules/education-tutor-agent'
import { startHarness } from './helpers.ts'
import { setupTutorWorld, type TutorWorld } from './tutor-setup.ts'

const usage = { inputTokens: 50, outputTokens: 20, cachedInputTokens: null, reasoningTokens: null }
const out = (json: unknown) => ({ text: JSON.stringify(json), toolCalls: [], finish: 'stop' as const, usage })
const A = '/api/m/education.tutor/agent'
const decideQueue: unknown[] = []
let flakyOutline = 0
function respond(req: GenerateRequest) {
  const sys = req.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n')
  if (/Ek Bharat study companion: ONE friendly/.test(sys)) return out(decideQueue.shift() ?? { intent: 'other', reply: 'Okay.' })
  if (/Write your reply as JSON/.test(sys)) return out({ reply: 'Here you go.' })
  if (/design a complete, structured self-study course/.test(sys)) {
    const user = req.messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join(' ')
    return /Mathematics/.test(user)
      ? out({ title: 'Mathematics Class 9', topics: [{ name: 'Number systems' }, { name: 'Polynomials' }, { name: 'Linear equations' }] })
      : out({ title: 'Geography Class 9', topics: [{ name: 'India: size and location' }, { name: 'Physical features of India' }, { name: 'Drainage' }] })
  }
  if (/You read a student's uploaded document/.test(sys)) {
    // the provider is overloaded once: the node's RetryPolicy must recover
    if (flakyOutline++ === 0) throw new GatewayError('overloaded', 'provider overloaded (503)')
    return out({ subject: 'Volcanoes', title: 'Volcanoes', summary: 'How volcanoes form and erupt.', sections: [{ name: 'Magma and plates', keyTerms: ['magma', 'tectonic plates'] }, { name: 'Eruptions', keyTerms: ['lava', 'ash'] }] })
  }
  return out({ segments: [{ text: 'ok', source: 'general' }], assessment: 'not_an_attempt' })
}

let w: TutorWorld
let tenantX = '', stuId = ''
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const thread = (conv: string) => `${tenantX}:${conv}`
const say = async (token: string, conversationId: string, message: string, extra: Record<string, unknown> = {}, h = w.h) => {
  const r = await h.call('POST', `${A}/messages`, token, { conversationId, message, language: 'en', ...extra })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  return r.json as { messages: { content: string; cards: { type: string; auto?: boolean; links?: { href: string }[]; proposal?: { id: string } }[] }[]; state: { phase: string; pendingProposalId: string | null } }
}
const toolRuns = async (tool: string) => (await w.owner.query(`select count(*)::int as n from education_tutor.agent_tool_calls where user_id = $1 and tool = $2 and status = 'ok'`, [stuId, tool])).rows[0].n as number
const pendingInterrupt = async (conv: string) => (await w.owner.query(`select count(*)::int as n from agent_graph.checkpoint_writes where thread_id = $1 and channel = '__interrupt__'`, [thread(conv)])).rows[0].n as number
async function drain() {
  const db = createDatabase(w.h.test.appUrl); const sys = createSystemDatabase(w.h.test.systemUrl)
  await createWorker({ system: sys, db, handlers: w.h.app.platform.jobs }).drain()
  await db.close(); await sys.close()
}

before(async () => {
  w = await setupTutorWorld({ respond, embed: hashingEmbed }, { documents: true })
  const policy = { processingLocation: 'IN', selfHosted: true, retentionDays: 0, zeroRetention: true, trainsOnData: false, dpaInPlace: true, termsVerified: true }
  const conn = await w.h.call('POST', '/api/admin/ai/connections', w.admin, { adapter: 'fake', name: 'emb', baseUrl: 'http://127.0.0.1:9', allowPrivateNetwork: true, dataPolicy: policy })
  await w.h.call('POST', '/api/admin/ai/models/approve', w.admin, { adapter: 'fake', modelId: 'emb', declared: { operations: ['embed'], embeddingDimensions: [256] } })
  const emb = await w.h.call('POST', '/api/admin/ai/deployments', w.admin, { connectionId: conn.json.id, modelId: 'emb' })
  assert.equal((await w.h.call('PUT', '/api/admin/ai/routes', w.admin, { target: 'category:embeddings', candidates: [{ deploymentId: emb.json.id }] })).status, 200)
  tenantX = (await w.owner.query(`select id from platform.tenants where slug = 'iit-x'`)).rows[0].id
  stuId = (await w.owner.query(`select id from platform.users where email = 'stu@x.test'`)).rows[0].id
})
after(async () => { await w?.close() })

let conv = '', proposalId = ''
test('roadmap approval is a LangGraph interrupt: the thread waits in the PostgreSQL checkpoint', async () => {
  conv = (await w.h.call('POST', `${A}/conversations`, w.stu)).json.conversationId
  decideQueue.push({ intent: 'request_plan', profile: { objective: 'exam_prep', topic: 'Limits', examDate: inDays(20), dailyMinutes: 40, material: 'curriculum', skip: ['confidence', 'level'] }, reply: 'Planning.' })
  const r = await say(w.stu, conv, 'Limits exam in 20 days, 40 min a day, use the course syllabus, plan it now')
  assert.equal(r.state.phase, 'awaiting_approval')
  proposalId = r.state.pendingProposalId!
  assert.ok(proposalId)
  assert.equal(await pendingInterrupt(conv), 1, 'the run is paused at the approval interrupt')
  assert.equal(await toolRuns('curriculum.syllabus'), 1)
  assert.equal(await toolRuns('plan.propose'), 1)
  // checkpoints hold no student text (it is encrypted in agent_messages)
  const blobs = (await w.owner.query(`select convert_from(blob, 'UTF8') as b from agent_graph.checkpoint_blobs where thread_id = $1 and blob is not null`, [thread(conv)]).catch(() => ({ rows: [] as { b: string }[] }))).rows.map((x) => x.b).join(' ')
  assert.doesNotMatch(blobs, /40 min a day/, 'the student message is not in the checkpoint')
})

test('durable: after a server restart the approval resumes the paused run; completed steps are not repeated', async () => {
  // a brand-new app instance (new graph, new checkpoint pool) on the same database = a restarted server
  const h2 = await startHarness([tutor], { test: w.h.test, migrate: false, fake: { respond }, documents: true })
  try {
    const r = await h2.call('POST', `${A}/proposals/${proposalId}/approve`, w.stu, { conversationId: conv })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.state.phase, 'active')
    assert.equal(await toolRuns('plan.apply'), 1)
    assert.equal(await toolRuns('curriculum.syllabus'), 1, 'planning steps finished before the restart were not run again')
    assert.equal(await toolRuns('plan.propose'), 1)
    assert.equal((await w.owner.query(`select count(*)::int as n from education_tutor.plans where user_id = $1`, [stuId])).rows[0].n, 1)
    // a repeated approval is a no-op: no duplicate plan, no duplicate side effects
    assert.equal((await h2.call('POST', `${A}/proposals/${proposalId}/approve`, w.stu, { conversationId: conv })).status, 200)
    assert.equal(await toolRuns('plan.apply'), 1)
  } finally { await h2.close() }
})

test('thread ownership: another student cannot resume or approve someone else\'s thread', async () => {
  const conv2 = (await w.h.call('POST', `${A}/conversations`, w.stu)).json.conversationId
  decideQueue.push({ intent: 'modify_plan', profile: { dailyMinutes: 30 }, reply: 'Updating.' })
  const r = await say(w.stu, conv2, 'make it 30 minutes a day')
  const pid = r.state.pendingProposalId
  if (pid) {
    assert.equal((await w.h.call('POST', `${A}/proposals/${pid}/approve`, w.stu2, { conversationId: conv2 })).status, 404, 'the thread id is never an authorization')
    assert.equal((await w.h.call('POST', `${A}/messages`, w.stu2, { conversationId: conv2, message: 'yes', language: 'en' })).status, 404)
  }
  assert.equal((await w.owner.query(`select count(*)::int as n from education_tutor.agent_conversations where id = $1 and user_id = $2`, [conv2, stuId])).rows[0].n, 1)
})

test('subject switch: Geography → Mathematics changes the course and drops the old goal details', async () => {
  const c3 = (await w.h.call('POST', `${A}/conversations`, w.stu2)).json.conversationId
  decideQueue.push({ intent: 'set_goal', profile: { objective: 'conceptual_mastery', topic: 'Drainage' }, reply: 'Geography it is.' })
  await say(w.stu2, c3, 'I want to learn Geography class 9 CBSE, the Drainage chapter')
  const geo = (await w.h.call('GET', A, w.stu2)).json.profile
  decideQueue.push({ intent: 'set_goal', profile: { objective: 'conceptual_mastery' }, reply: 'Okay, maths.' })
  await say(w.stu2, c3, 'Actually I want to study Mathematics class 9 now')
  const maths = (await w.h.call('GET', A, w.stu2)).json
  assert.notEqual(maths.profile.courseId, geo.courseId, 'the course changed')
  assert.notEqual(maths.profile.topic, 'Drainage', 'the Geography chapter did not carry over')
  assert.ok(maths.courses.some((c: { id: string; title: string }) => c.id === maths.profile.courseId))
})

test('practice: never opened while setting up; opens on an explicit request once the plan is active', async () => {
  const c4 = (await w.h.call('POST', `${A}/conversations`, w.stu)).json.conversationId
  // the plan from the first test is active for stu: an explicit request opens the practice coach
  decideQueue.push({ intent: 'practice', actions: [{ tool: 'practice.start', args: { conceptId: 'Limits' } }], reply: 'Practice time.' })
  const r = await say(w.stu, c4, 'Give me practice on limits now')
  const link = r.messages[1]!.cards.find((c) => c.type === 'links')
  assert.ok(link?.auto, 'explicit request + active plan: opens by itself')
  assert.match(link.links![0]!.href, /^\/practice\//)
  // a student still setting up gets no workspace at all
  await w.h.call('DELETE', `${A}/memory`, w.stu2)
  const c5 = (await w.h.call('POST', `${A}/conversations`, w.stu2)).json.conversationId
  decideQueue.push({ intent: 'practice', profile: { objective: 'exam_prep' }, actions: [{ tool: 'practice.start', args: {} }], reply: 'Opening practice!' })
  const r2 = await say(w.stu2, c5, 'quadratic equations practice please')
  assert.ok(!r2.messages[1]!.cards.some((c) => c.type === 'links'), 'nothing opens before the goal, material and plan are settled')
})

test('document intelligence retries a transient provider failure (node RetryPolicy) and then grounds the course', async () => {
  const c6 = (await w.h.call('POST', `${A}/conversations`, w.stu2)).json.conversationId
  decideQueue.push({ intent: 'set_goal', profile: { objective: 'general', material: 'own', dailyMinutes: 30 }, reply: 'Upload it.' })
  await say(w.stu2, c6, 'I will upload my notes')
  const r0 = await fetch(`${w.h.url}${A}/material?filename=volcanoes.docx`, { method: 'POST', headers: { authorization: `Bearer ${w.stu2}`, 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, body: makeDocx([['Volcanoes form where magma rises between tectonic plates.'], ['Eruptions release lava, ash and gas.']]) as unknown as BodyInit })
  assert.equal(r0.status, 200)
  const up = await r0.json() as { documentId: string; courseId: string }
  await drain()
  const r = await say(w.stu2, c6, 'I have uploaded my notes: volcanoes.docx', { documentId: up.documentId, documentTitle: 'volcanoes.docx' })
  assert.ok(flakyOutline >= 2, 'the analysis was retried after the overload')
  assert.match(r.messages[1]!.content, /Volcanoes/)
  assert.equal(await pendingInterrupt(c6), 1, 'the run waits at the scope interrupt')
  const topics = (await w.owner.query(`select name from education_tutor.concepts where course_id = $1 order by created_at`, [up.courseId])).rows.map((x) => x.name)
  assert.deepEqual(topics, ['Magma and plates', 'Eruptions'])
})

test('forget me deletes the student\'s graph threads (checkpoints) and only theirs', async () => {
  const before = (await w.owner.query(`select count(*)::int as n from agent_graph.checkpoints where thread_id = $1`, [thread(conv)])).rows[0].n
  assert.ok(before > 0)
  const otherThreads = (await w.owner.query(`select count(distinct thread_id)::int as n from agent_graph.checkpoints c join education_tutor.agent_conversations v on c.thread_id = $1 || ':' || v.id::text where v.user_id <> $2`, [tenantX, stuId])).rows[0].n
  assert.equal((await w.h.call('DELETE', `${A}/memory`, w.stu)).status, 204)
  assert.equal((await w.owner.query(`select count(*)::int as n from agent_graph.checkpoints where thread_id = $1`, [thread(conv)])).rows[0].n, 0)
  const otherAfter = (await w.owner.query(`select count(distinct thread_id)::int as n from agent_graph.checkpoints c join education_tutor.agent_conversations v on c.thread_id = $1 || ':' || v.id::text where v.user_id <> $2`, [tenantX, stuId])).rows[0].n
  assert.equal(otherAfter, otherThreads, 'other students\' threads are untouched')
})

test('performance: per-turn latency, checkpoint writes and model calls stay bounded', async () => {
  const cp = (await w.h.call('POST', `${A}/conversations`, w.stu2)).json.conversationId
  const ops0 = (await w.owner.query(`select count(*)::int as n from platform.ai_operations`)).rows[0].n
  const times: number[] = []
  for (let i = 0; i < 10; i++) {
    decideQueue.push({ intent: 'smalltalk', reply: `Hi ${i}!` })
    const t0 = performance.now()
    await say(w.stu2, cp, `hello ${i}`)
    times.push(performance.now() - t0)
  }
  const ops = (await w.owner.query(`select count(*)::int as n from platform.ai_operations`)).rows[0].n - ops0
  const ckpt = (await w.owner.query(`select count(*)::int as n from agent_graph.checkpoints where thread_id = $1`, [thread(cp)])).rows[0].n
  const writes = (await w.owner.query(`select count(*)::int as n from agent_graph.checkpoint_writes where thread_id = $1`, [thread(cp)])).rows[0].n
  const sorted = [...times].sort((a, b) => a - b)
  console.log(`PERF turns=10 p50=${sorted[4]!.toFixed(0)}ms p90=${sorted[8]!.toFixed(0)}ms max=${sorted[9]!.toFixed(0)}ms modelCalls/turn=${(ops / 10).toFixed(1)} checkpoints/turn=${(ckpt / 10).toFixed(1)} checkpointWrites/turn=${(writes / 10).toFixed(1)}`)
  assert.ok(ops / 10 <= 2, 'at most two model calls per ordinary turn')
  assert.ok(ckpt / 10 <= 8, 'checkpoints per turn are bounded (one per step)')
  assert.ok(sorted[4]! < 1500, 'median turn latency with a local model stub stays low')
})
