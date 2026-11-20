/**
 * Document-first learning, end to end (HTTP → upload → parse → chunk → embed → companion), with a scripted model.
 * Regression for a live failure: notes about Neanderthals were planned as an invented "Mastering Effective
 * Note-Taking" course. The course, its topics and the plan must come from what the uploaded document contains.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { createWorker } from '@platform/jobs'
import { hashingEmbed, makeDocx, makePdf } from '@platform/testing'
import type { GenerateRequest } from '@platform/ai-adapter-kit'
import { setupTutorWorld, type TutorWorld } from './tutor-setup.ts'

const usage = { inputTokens: 50, outputTokens: 20, cachedInputTokens: null, reasoningTokens: null }
const out = (json: unknown) => ({ text: JSON.stringify(json), toolCalls: [], finish: 'stop' as const, usage })
const T = '/api/m/education.tutor'
const A = `${T}/agent`
const decideQueue: unknown[] = []
let docPromptSeen = ''

/** the outline model: answers from the text it was given (and includes one invented section that must be dropped) */
function outline(text: string) {
  if (/Neanderthal/.test(text)) return { subject: 'Neanderthals and human evolution', title: 'Neanderthals', summary: 'Who the Neanderthals were, their tools and culture, and their extinction.', structured: true, sections: [
    { name: 'Who were the Neanderthals', keyTerms: ['Homo neanderthalensis', 'Europe', 'Ice Age'], pageStart: 1, pageEnd: 1 },
    { name: 'Tools and culture', keyTerms: ['Mousterian', 'tools', 'burial'], pageStart: 2, pageEnd: 2 },
    { name: 'Extinction', keyTerms: ['extinction', 'Homo sapiens', 'interbreeding'], pageStart: 3, pageEnd: 3 },
    { name: 'Mastering effective note-taking', keyTerms: ['Cornell method', 'mind maps'], pageStart: 1, pageEnd: 1 },
  ] }
  if (/Trigonometric/.test(text)) return { subject: 'Trigonometry', title: 'Introduction to Trigonometry', summary: 'Trigonometric ratios and identities.', structured: true, sections: [
    { name: 'Trigonometric Ratios', keyTerms: ['sin A = BC/AC', 'cos A = AB/AC'], pageStart: 1, pageEnd: 1 },
    { name: 'Trigonometric Identities', keyTerms: ['sin^2 A + cos^2 A = 1', '1 + tan^2 A = sec^2 A'], pageStart: 2, pageEnd: 2 },
  ] }
  if (/Newton/.test(text)) return { subject: 'Laws of motion', title: 'Force and Laws of Motion', summary: 'Newton\'s three laws and momentum.', structured: true, sections: [
    { name: 'Newton\'s first law', keyTerms: ['inertia', 'balanced forces'], pageStart: 1, pageEnd: 1 },
    { name: 'Newton\'s second law', keyTerms: ['F = m a', 'momentum'], pageStart: 1, pageEnd: 1 },
    { name: 'Newton\'s third law', keyTerms: ['action', 'reaction'], pageStart: 2, pageEnd: 2 },
  ] }
  // fragmentary text: the model guesses a syllabus that is not in it
  return { subject: 'General studies', structured: false, sections: [{ name: 'Modern world history', keyTerms: ['World War', 'treaty'] }] }
}
function respond(req: GenerateRequest) {
  const sys = req.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n')
  const user = req.messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n')
  if (/You read a student's uploaded document/.test(sys)) { docPromptSeen = user; return out(outline(user)) }
  if (/Ek Bharat study companion: ONE friendly/.test(sys)) return out(decideQueue.shift() ?? { intent: 'other', reply: 'Okay.' })
  if (/Write your reply as JSON/.test(sys)) return out({ reply: 'Here is your plan.' })
  if (/design a complete, structured self-study course/.test(sys)) return out({ title: 'Mastering Effective Note-Taking', topics: [{ name: 'Cornell method' }, { name: 'Mind maps' }, { name: 'Outlining' }] })
  return out({ segments: [{ text: 'ok', source: 'general' }], assessment: 'not_an_attempt' })
}

let w: TutorWorld
let stuId = ''
async function drain() {
  const db = createDatabase(w.h.test.appUrl)
  const sys = createSystemDatabase(w.h.test.systemUrl)
  await createWorker({ system: sys, db, handlers: w.h.app.platform.jobs }).drain()
  await db.close(); await sys.close()
}
async function upload(path: string, filename: string, type: string, body: Buffer | string) {
  const r = await fetch(`${w.h.url}${path}?filename=${encodeURIComponent(filename)}`, { method: 'POST', headers: { authorization: `Bearer ${w.stu}`, 'content-type': type }, body: body as unknown as BodyInit })
  const text = await r.text()
  assert.equal(r.status, 200, text)
  await drain()
  return JSON.parse(text) as { documentId: string; courseId?: string }
}
const say = async (conversationId: string, message: string, extra: Record<string, unknown> = {}) => {
  const r = await w.h.call('POST', `${A}/messages`, w.stu, { conversationId, message, language: 'en', ...extra })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  return r.json as { messages: { content: string; cards: { type: string; choices?: string[]; proposal?: { roadmap: { milestones: { conceptNames: string[] }[] } } }[] }[]; state: { phase: string } }
}
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

before(async () => {
  w = await setupTutorWorld({ respond, embed: hashingEmbed }, { documents: true })
  const policy = { processingLocation: 'IN', selfHosted: true, retentionDays: 0, zeroRetention: true, trainsOnData: false, dpaInPlace: true, termsVerified: true }
  const conn = await w.h.call('POST', '/api/admin/ai/connections', w.admin, { adapter: 'fake', name: 'emb', baseUrl: 'http://127.0.0.1:9', allowPrivateNetwork: true, dataPolicy: policy })
  await w.h.call('POST', '/api/admin/ai/models/approve', w.admin, { adapter: 'fake', modelId: 'emb', declared: { operations: ['embed'], embeddingDimensions: [256] } })
  const emb = await w.h.call('POST', '/api/admin/ai/deployments', w.admin, { connectionId: conn.json.id, modelId: 'emb' })
  assert.equal((await w.h.call('PUT', '/api/admin/ai/routes', w.admin, { target: 'category:embeddings', candidates: [{ deploymentId: emb.json.id }] })).status, 200)
  stuId = (await w.owner.query(`select id from platform.users where email = 'stu@x.test'`)).rows[0].id
})
after(async () => { await w?.close() })

test('Neanderthals DOCX: no invented "note-taking" course; subject, sections and plan come from the document', async () => {
  const conv = (await w.h.call('POST', `${A}/conversations`, w.stu)).json.conversationId
  const courses0 = (await w.owner.query(`select count(*)::int as n from education_tutor.courses where owner_user_id = $1`, [stuId])).rows[0].n
  // the live failure: the model wants a course named after the FORMAT of the material
  decideQueue.push({ intent: 'set_goal', profile: { objective: 'general', material: 'own', dailyMinutes: 30 }, actions: [{ tool: 'course.create', args: { subject: 'Mastering Effective Note-Taking' } }], reply: 'I created a note-taking course!' })
  const r1 = await say(conv, "I have notes but I don't know the topic. I want to upload my notes. Just general learning.")
  assert.equal((await w.owner.query(`select count(*)::int as n from education_tutor.courses where owner_user_id = $1`, [stuId])).rows[0].n, courses0, 'no course is invented before the document is read')
  assert.ok(r1.messages[1]!.cards.some((c) => c.type === 'upload'), 'asks for the file instead')
  assert.doesNotMatch(r1.messages[1]!.content, /note-taking course/i)

  // the DOCX is uploaded before any course exists
  const doc = makeDocx([
    ['Neanderthals', 'Homo neanderthalensis lived in Europe and western Asia during the Ice Age, from about 400,000 years ago.'],
    ['Tools and culture', 'Neanderthals made Mousterian stone tools, used fire and buried their dead (burial).'],
    ['Extinction', 'Their extinction about 40,000 years ago overlapped with Homo sapiens; interbreeding left Neanderthal DNA in modern humans.'],
  ])
  const up = await upload(`${A}/material`, 'Neanderthals.docx', DOCX, doc)
  assert.ok(up.courseId)
  const r2 = await say(conv, 'I have uploaded my notes: Neanderthals.docx. Teach me from them.', { documentId: up.documentId, documentTitle: 'Neanderthals.docx' })
  assert.match(docPromptSeen, /Homo neanderthalensis/, 'the document text itself was analysed')
  const reply = r2.messages[1]!
  assert.match(reply.content, /Neanderthals\.docx/)
  assert.match(reply.content, /Neanderthals and human evolution/)
  assert.match(reply.content, /complete material, or a particular section/)
  const choices = reply.cards.find((c) => c.type === 'choices')!.choices!
  assert.deepEqual(choices, ['The complete material', 'Who were the Neanderthals', 'Tools and culture', 'Extinction'], 'the invented section is not offered')
  const concepts = (await w.owner.query(`select name from education_tutor.concepts where course_id = $1 order by created_at`, [up.courseId])).rows.map((x) => x.name)
  assert.deepEqual(concepts, ['Who were the Neanderthals', 'Tools and culture', 'Extinction'], 'the course topics are the document sections')
  assert.equal((await w.owner.query(`select title from education_tutor.courses where id = $1`, [up.courseId])).rows[0].title, 'Neanderthals')
  assert.ok(!reply.cards.some((c) => c.type === 'plan_proposal'), 'no plan before the student picks the scope')

  // scope: the complete material → a plan built from the document's sections only
  const r3 = await say(conv, 'The complete material')
  const prop = r3.messages[1]!.cards.find((c) => c.type === 'plan_proposal')!.proposal!
  const planned = prop.roadmap.milestones.flatMap((m) => m.conceptNames)
  assert.deepEqual([...planned].sort(), [...concepts].sort())
  assert.ok(!planned.some((n) => /note/i.test(n)))
  assert.deepEqual(planned, concepts, 'the roadmap follows the order of the document')
})

test('Mathematics PDF: mathematical topics and equations are kept exactly as written', async () => {
  const conv = (await w.h.call('POST', `${A}/conversations`, w.stu)).json.conversationId
  decideQueue.push({ intent: 'set_goal', profile: { objective: 'general', material: 'own', dailyMinutes: 30 }, reply: 'Upload it.' })
  await say(conv, 'I will upload my maths notes')
  const pdf = makePdf([['Trigonometric Ratios', 'In a right triangle, sin A = BC/AC and cos A = AB/AC.'], ['Trigonometric Identities', 'sin^2 A + cos^2 A = 1 and 1 + tan^2 A = sec^2 A.']])
  const up = await upload(`${A}/material`, 'trig.pdf', 'application/pdf', pdf)
  const r = await say(conv, 'I have uploaded my notes: trig.pdf. Teach me from them.', { documentId: up.documentId, documentTitle: 'trig.pdf' })
  assert.match(r.messages[1]!.content, /Trigonometry/)
  const concepts = (await w.owner.query(`select name, description from education_tutor.concepts where course_id = $1 order by created_at`, [up.courseId])).rows
  assert.deepEqual(concepts.map((x) => x.name), ['Trigonometric Ratios', 'Trigonometric Identities'])
  assert.match(concepts[1].description, /sin\^2 A \+ cos\^2 A = 1/, 'equations preserved as written in the document')
})

test('Physics document (into an existing personal course): roadmap topics are the document\'s own sections', async () => {
  const conv = (await w.h.call('POST', `${A}/conversations`, w.stu)).json.conversationId
  decideQueue.push({ intent: 'set_goal', profile: { objective: 'general', material: 'own', dailyMinutes: 30 }, reply: 'Upload it.' })
  await say(conv, 'I want to upload my physics notes')
  const up = await upload(`${A}/material`, 'motion.txt', 'text/plain', 'Force and Laws of Motion. Newton\'s first law: inertia and balanced forces. Newton\'s second law: F = m a, rate of change of momentum. Newton\'s third law: every action has an equal and opposite reaction.')
  await say(conv, 'I have uploaded my notes: motion.txt. Teach me from them.', { documentId: up.documentId, documentTitle: 'motion.txt' })
  const r = await say(conv, 'The complete material')
  const prop = r.messages[1]!.cards.find((c) => c.type === 'plan_proposal')?.proposal
  assert.ok(prop, JSON.stringify(r.messages[1]))
  assert.deepEqual([...prop.roadmap.milestones.flatMap((m) => m.conceptNames)].sort(), ['Newton\'s first law', 'Newton\'s second law', 'Newton\'s third law'])
})

test('unclear document: asks for clarification instead of inventing a syllabus', async () => {
  const conv = (await w.h.call('POST', `${A}/conversations`, w.stu)).json.conversationId
  decideQueue.push({ intent: 'set_goal', profile: { objective: 'general', material: 'own', dailyMinutes: 30 }, reply: 'Upload it.' })
  await say(conv, 'I will upload my notes')
  const up = await upload(`${A}/material`, 'scraps.txt', 'text/plain', 'misc page 4 see above. ok ok. remember to bring the blue folder on tuesday and the charger. also call back later re the thing.')
  const r = await say(conv, 'I have uploaded my notes: scraps.txt', { documentId: up.documentId, documentTitle: 'scraps.txt' })
  assert.match(r.messages[1]!.content, /could not find clear topics/)
  assert.ok(!r.messages[1]!.cards.some((c) => c.type === 'plan_proposal'))
  const names = (await w.owner.query(`select name from education_tutor.concepts where course_id = $1`, [up.courseId])).rows.map((x) => x.name)
  assert.ok(!names.includes('Modern world history'), 'the guessed syllabus was not stored')
})

test('failed extraction: the tutor says so and does not proceed as if the file was read', async () => {
  const conv = (await w.h.call('POST', `${A}/conversations`, w.stu)).json.conversationId
  decideQueue.push({ intent: 'set_goal', profile: { objective: 'general', material: 'own', dailyMinutes: 30 }, reply: 'Upload it.' })
  await say(conv, 'I will upload my notes')
  // a corrupt PDF: passes the type check at upload, fails in the parser
  const bad = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(400, 0x41), Buffer.from('\n%%EOF')])
  const r0 = await fetch(`${w.h.url}${A}/material?filename=broken.pdf`, { method: 'POST', headers: { authorization: `Bearer ${w.stu}`, 'content-type': 'application/pdf' }, body: bad as unknown as BodyInit })
  assert.equal(r0.status, 200, 'accepted for processing')
  const up = await r0.json() as { documentId: string }
  await drain()
  const st = (await w.owner.query(`select status from documents.documents where id = $1`, [up.documentId]).catch(() => ({ rows: [] as { status: string }[] }))).rows[0]?.status
  if (st) assert.equal(st, 'failed', 'the parser rejected it')
  const r = await say(conv, 'I have uploaded my notes: broken.pdf', { documentId: up.documentId, documentTitle: 'broken.pdf' })
  assert.match(r.messages[1]!.content, /could not read|almost no readable text/)
  assert.match(r.messages[1]!.content, /Nothing was taken from it/)
  assert.ok(!r.messages[1]!.cards.some((c) => c.type === 'plan_proposal' || c.type === 'choices'))
})
