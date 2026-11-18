/**
 * Stage 3 end to end (HTTP + real DB/RLS + jobs + scripted model): past-paper intelligence with provenance,
 * self-tests on the assessment engine (diagnostic → post, privacy), the 6-step hint ladder (order, leak check,
 * server-side hint count), observation/strategy, growth + outcomes, opt-in board and consented cohort minimums,
 * chapter package (flashcards into FSRS, past questions with sources), and exam-aware planning by the companion.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { createWorker } from '@platform/jobs'
import { hashingEmbed } from '@platform/testing'
import type { GenerateRequest } from '@platform/ai-adapter-kit'
import { setImageSearch } from '../modules/education-agents/tutor-agent/src/studio/images.ts'
import { postSse, setupTutorWorld, type TutorWorld } from './tutor-setup.ts'

const usage = { inputTokens: 50, outputTokens: 20, cachedInputTokens: null, reasoningTokens: null }
const out = (j: unknown) => ({ text: typeof j === 'string' ? j : JSON.stringify(j), toolCalls: [], finish: 'stop' as const, usage })
const decide: unknown[] = []
let hintCalls = 0
function respond(req: GenerateRequest) {
  const sys = req.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n')
  if (/Extract every exam QUESTION/.test(sys)) {
    // TEST FIXTURE: a synthetic paper's questions (pipeline check only)
    return out({ questions: [
      { number: '1', text: 'State what a limit of a function means.', marks: 2, type: 'short', page: 1, topic: 'Limits', features: ['definition'] },
      { number: '2', text: 'Evaluate the limit of 3x+1 as x approaches 2.', marks: 3, type: 'numerical', page: 1, topic: 'Limits', features: ['numerical'] },
      { number: '3', text: 'Define a function.', marks: 1, type: 'very_short', page: 1, topic: 'Functions' },
      { number: '4', text: 'Unrelated question about poetry.', marks: 2, type: 'short', page: 1, topic: 'other' },
    ] })
  }
  if (/graduated hint/.test(sys)) {
    hintCalls++
    const level = Number(/level (\d) of 6/.exec(sys)?.[1])
    return out({ hint: level === 2 ? 'The answer is 6.' : `Level ${level}: think about substitution.` }) // level 2 leaks the key (6) → replaced
  }
  if (/You plan a chapter/.test(sys)) return out({ title: 'Limits', sections: [{ title: 'Limits', concept: 'Limits' }] })
  if (/You write one section/.test(sys)) {
    return out([
      { type: 'heading', text: 'Limits' }, { type: 'definition', term: 'Limit', text: 'The value a function approaches as x gets close to a point.', label: 'ai' },
      { type: 'formula', text: 'lim x→a f(x) = L', label: 'ai' }, { type: 'tip', text: 'Approach, not arrive.' },
      { type: 'exam', text: 'Common mistake: assuming the limit equals f(a).' }, { type: 'summary', text: 'Limits describe approach.' },
    ].map((x) => JSON.stringify(x)).join('\n'))
  }
  if (/Ek Bharat study companion: a friendly/.test(sys)) return out(decide.shift() ?? { intent: 'other', reply: 'Okay.' })
  if (/Write your reply to the student as JSON/.test(sys)) return out({ reply: 'Here is your plan.' })
  return out({ answer: 'ok' })
}

let w: TutorWorld
let paperDoc = ''
let tenantX = ''
const T = '/api/m/education.tutor'
const drain = async () => {
  const db = createDatabase(w.h.test.appUrl); const sys = createSystemDatabase(w.h.test.systemUrl)
  await createWorker({ system: sys, db, handlers: w.h.app.platform.jobs }).drain()
  await db.close(); await sys.close()
}
const items: string[] = []

before(async () => {
  setImageSearch(async () => [])
  w = await setupTutorWorld({ respond, embed: hashingEmbed }, { documents: true })
  tenantX = (await w.owner.query(`select id from platform.tenants where slug = 'iit-x'`)).rows[0].id
  const policy = { processingLocation: 'IN', selfHosted: true, retentionDays: 0, zeroRetention: true, trainsOnData: false, dpaInPlace: true, termsVerified: true }
  const conn = await w.h.call('POST', '/api/admin/ai/connections', w.admin, { adapter: 'fake', name: 'emb', baseUrl: 'http://127.0.0.1:9', allowPrivateNetwork: true, dataPolicy: policy })
  await w.h.call('POST', '/api/admin/ai/models/approve', w.admin, { adapter: 'fake', modelId: 'emb', declared: { operations: ['embed'], embeddingDimensions: [256] } })
  const emb = await w.h.call('POST', '/api/admin/ai/deployments', w.admin, { connectionId: conn.json.id, modelId: 'emb' })
  await w.h.call('PUT', '/api/admin/ai/routes', w.admin, { target: 'category:embeddings', candidates: [{ deploymentId: emb.json.id }] })
  // approved numeric items in both topics (educator-authored)
  for (const [concept, stem, value] of [[w.cFunctions, 'f(x)=2x. f(3)?', 6], [w.cFunctions, 'f(x)=x+5. f(1)?', 6], [w.cLimits, 'lim x->1 of (x+1)?', 2], [w.cLimits, 'lim x->3 of 2x?', 6]] as const) {
    const r = await w.h.call('POST', `${T}/courses/${w.courseId}/items`, w.prof, { conceptId: concept, stem, answerSpec: { type: 'numeric', value, tolerance: 0 }, explanation: 'Substitute the value.' })
    assert.equal(r.status, 200, JSON.stringify(r.json)); items.push(r.json.id)
  }
  // a student's own copy of a past paper (synthetic text; a TEST FIXTURE, not evidence)
  const up = await fetch(`${w.h.url}${T}/courses/${w.courseId}/materials?filename=paper-2024.txt`, { method: 'POST', headers: { authorization: `Bearer ${w.stu}`, 'content-type': 'text/plain' }, body: 'Section A. 1. State what a limit of a function means. (2) 2. Evaluate the limit of 3x+1 as x approaches 2. (3) 3. Define a function. (1)' })
  paperDoc = JSON.parse(await up.text()).documentId
  await drain()
})
after(async () => { setImageSearch(null); await w?.close() })

test('past papers: extraction job, topic mapping, verified counts with sources, private to the student', async () => {
  const add = await w.h.call('POST', `${T}/courses/${w.courseId}/exam/papers`, w.stu, { documentId: paperDoc, sourceKind: 'school_paper', title: 'Unit test 2024', year: 2024, school: 'Bal Vidya School' })
  assert.equal(add.status, 200, JSON.stringify(add.json))
  assert.equal(add.json.shared, false)
  await drain()
  const ins = (await w.h.call('GET', `${T}/courses/${w.courseId}/exam/insights`, w.stu)).json
  assert.equal(ins.papers[0].status, 'ready')
  assert.equal(ins.papers[0].questions, 4)
  const lim = ins.topics.find((t: { name: string }) => t.name === 'Limits')
  assert.match(lim.verified, /Appeared in 1 of 1 paper\(s\): Unit test 2024/)
  assert.equal(lim.confidence, 'low', 'one paper is weak evidence')
  assert.equal(ins.unmatchedQuestions, 1)
  assert.match(ins.examples[lim.conceptId][0].source, /Unit test 2024 \(2024\), Q1/)
  const raw = (await w.owner.query('select text_enc from education_tutor.exam_questions')).rows.map((r) => r.text_enc).join(' ')
  assert.ok(!raw.includes('limit of a function'), 'question text encrypted at rest')
  assert.equal((await w.h.call('GET', `${T}/courses/${w.courseId}/exam/insights`, w.stu2)).json.papers.length, 0, 'another student does not see a private paper')
  assert.equal((await w.h.call('POST', `${T}/courses/${w.courseId}/exam/papers`, w.stu2, { documentId: paperDoc, sourceKind: 'school_paper', title: 'x' })).status, 404, 'nor register someone else\'s document')
})

let diagId = ''
const takeAll = async (assessmentId: string, answer: (stem: string) => number) => {
  const a = await w.h.call('POST', `${T}/assessments/${assessmentId}/attempts`, w.stu)
  assert.equal(a.status, 200, JSON.stringify(a.json))
  for (const q of a.json.questions) await w.h.call('PUT', `${T}/assessment-attempts/${a.json.id}/responses`, w.stu, { itemId: q.itemId, response: answer(q.stem), confidence: 'sure' })
  const s = await w.h.call('POST', `${T}/assessment-attempts/${a.json.id}/submit`, w.stu)
  assert.equal(s.status, 200, JSON.stringify(s.json))
  return (await w.h.call('GET', `${T}/assessment-attempts/${a.json.id}`, w.stu)).json
}

test('self-tests run on the assessment engine; private to their owner; diagnostic → post shows the change', async () => {
  const d = await w.h.call('POST', `${T}/courses/${w.courseId}/self-tests`, w.stu, { purpose: 'diagnostic' })
  assert.equal(d.status, 200, JSON.stringify(d.json))
  diagId = d.json.assessmentId
  assert.equal(d.json.questions, 5, 'every approved question spread over both topics (2 + 3)')
  assert.equal((await w.h.call('POST', `${T}/courses/${w.courseId}/self-tests`, w.prof, { purpose: 'diagnostic' })).status, 403, 'educators do not take self-tests')
  const list2 = (await w.h.call('GET', `${T}/courses/${w.courseId}/assessments`, w.stu2)).json
  assert.ok(!list2.some((a: { id: string }) => a.id === diagId), 'other students never see it')
  assert.ok(!(await w.h.call('GET', `${T}/courses/${w.courseId}/assessments`, w.prof)).json.some((a: { id: string }) => a.id === diagId), 'not mixed into the educator\'s assessments')
  assert.equal((await w.h.call('POST', `${T}/assessments/${diagId}/attempts`, w.stu2)).status, 404)
  const r1 = await takeAll(diagId, () => 0) // all wrong
  assert.equal(r1.status, 'graded')
  const p = await w.h.call('POST', `${T}/courses/${w.courseId}/self-tests`, w.stu, { purpose: 'post' })
  const r2 = await takeAll(p.json.assessmentId, (stem) => (/x\+40/.test(stem) ? 42 : /2x\. f\(3\)|x\+5|lim x->3/.test(stem) ? 6 : 2))
  assert.equal(r2.score, r2.maxScore)
  const g = (await w.h.call('GET', `${T}/courses/${w.courseId}/growth`, w.stu)).json
  assert.equal(g.outcomes.diagnostic.value, 0)
  assert.equal(g.outcomes.postLearning.value, 1)
  assert.equal(g.outcomes.change.value, 1)
  assert.ok(g.outcomes.caveats.some((c: string) => /do not prove/.test(c)))
  assert.ok(g.xp > 0 && g.xpBreakdown.some((x: { reason: string }) => x.reason === 'Improved since your diagnostic'))
  assert.equal(g.leaderboard.visible, false)
})

test('hint ladder: in order, no answer leaks, full solution only when appropriate, counted server-side', async () => {
  const item = items[0]!
  assert.equal((await w.h.call('POST', `${T}/items/${item}/hints`, w.stu, { level: 3 })).status, 409, 'one rung at a time')
  const h1 = await w.h.call('POST', `${T}/items/${item}/hints`, w.stu, { level: 1 })
  assert.match(h1.json.hint, /Level 1/)
  const h2 = await w.h.call('POST', `${T}/items/${item}/hints`, w.stu, { level: 2 })
  assert.ok(!/answer is 6/.test(h2.json.hint), 'a hint that gave the answer away was replaced')
  for (const l of [3, 4]) assert.equal((await w.h.call('POST', `${T}/items/${item}/hints`, w.stu, { level: l })).status, 200)
  assert.equal((await w.h.call('POST', `${T}/items/${item}/hints`, w.stu, { level: 6 })).status, 409, 'solution needs the worked-example rung first')
  await w.h.call('POST', `${T}/items/${item}/hints`, w.stu, { level: 5 })
  const h6 = await w.h.call('POST', `${T}/items/${item}/hints`, w.stu, { level: 6 })
  assert.match(h6.json.hint, /Answer: 6/)
  const callsBefore = hintCalls
  assert.equal(hintCalls, callsBefore, 'level 6 comes from the stored explanation, not the model')
  // the client claims no hints; the server knows better
  const att = await w.h.call('POST', `${T}/attempts`, w.stu, { itemId: item, response: '6', hintsUsed: 0, confidence: 'sure' })
  assert.equal(att.status, 200)
  const used = (await w.owner.query('select hints_used from education_tutor.attempts where id = $1', [att.json.attemptId])).rows[0].hints_used
  assert.equal(used, 6)
  assert.equal((await w.h.call('POST', `${T}/items/${item}/hints`, w.stu, { level: 2 })).status, 409, 'the ladder resets for the next attempt')
})

test('observation, prefs, opt-in board and consented cohort minimum', async () => {
  const o = (await w.h.call('GET', `${T}/courses/${w.courseId}/observation`, w.stu)).json
  assert.ok(o.strategy.name && Array.isArray(o.findings) && o.note)
  assert.equal((await w.h.call('PUT', `${T}/growth/prefs`, w.stu, { leaderboard: true })).status, 400, 'a nickname is required')
  assert.equal((await w.h.call('PUT', `${T}/growth/prefs`, w.stu, { leaderboard: true, pseudonym: 'Comet', outcomesConsent: true })).status, 200)
  assert.equal((await w.h.call('GET', `${T}/courses/${w.courseId}/growth`, w.stu)).json.leaderboard.visible, false, 'hidden below 5 participants')
  const c = await w.h.call('GET', `${T}/courses/${w.courseId}/cohort-outcomes`, w.prof)
  assert.equal(c.status, 200)
  assert.equal(c.json.shown, false)
  assert.equal(c.json.consentingStudents, 1)
  assert.equal((await w.h.call('GET', `${T}/courses/${w.courseId}/cohort-outcomes`, w.stu)).status, 403)
})

test('chapter package: from the taught book, flashcards into revision once, past questions with sources', async () => {
  const b = await w.h.call('POST', `${T}/studio/books`, w.stu, { courseId: w.courseId, title: 'Limits' })
  await postSse(w.h, `${T}/studio/books/${b.json.id}/sections/s1/generate`, w.stu, {})
  const p1 = await w.h.call('POST', `${T}/studio/books/${b.json.id}/package`, w.stu)
  assert.equal(p1.status, 200, JSON.stringify(p1.json))
  const pkg = p1.json.package
  assert.deepEqual(pkg.formulaSheet.map((f: { formula: string }) => f.formula), ['lim x→a f(x) = L'])
  assert.ok(pkg.flashcards.some((f: { front: string }) => f.front === 'Define: Limit'))
  assert.ok(pkg.pastQuestions.some((q: { source: string }) => /Unit test 2024/.test(q.source)), 'past questions with their source')
  assert.ok(pkg.mockTestId, 'a mock test was prepared')
  assert.ok(pkg.commonMistakes.some((m: { text: string }) => /equals f\(a\)/.test(m.text)))
  assert.ok(p1.json.newFlashcards >= 2)
  const p2 = await w.h.call('POST', `${T}/studio/books/${b.json.id}/package`, w.stu)
  assert.equal(p2.json.version, 2)
  assert.equal(p2.json.newFlashcards, 0, 'no duplicate cards')
  assert.equal((await w.h.call('GET', `${T}/studio/books/${b.json.id}/package`, w.stu2)).status, 404)
})

test('companion: exam goal → planning reads past papers and prepares a starting-point check', async () => {
  const conv = (await w.h.call('POST', `${T}/agent/conversations`, w.stu)).json.conversationId
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  decide.push({ intent: 'request_plan', profile: { objective: 'exam_prep', examDate: inDays(7), dailyMinutes: 60, skip: ['confidence', 'level'] }, reply: 'Planning.' })
  const r = await w.h.call('POST', `${T}/agent/messages`, w.stu, { conversationId: conv, message: 'Exam in 7 days, 1 hour a day, make my plan now', language: 'en' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const cards = r.json.messages[1].cards
  const steps = cards.find((c: { type: string }) => c.type === 'workflow').workflow.steps.map((s: { name: string; status: string }) => `${s.name}:${s.status}`)
  assert.deepEqual(steps, ['Reading your course syllabus:done', 'Checking past and sample papers:done', 'Checking what you already know:done', 'Drafting your roadmap:done', 'Preparing a short starting-point check:done'])
  const prop = cards.find((c: { type: string }) => c.type === 'plan_proposal').proposal
  assert.equal(prop.strategy.name, 'exam_sprint')
  assert.equal(prop.examEvidence.papers, 1)
  assert.ok(prop.roadmap.checkpoints.some((c: { title: string }) => /Starting-point check/.test(c.title)))
  assert.ok(prop.roadmap.checkpoints.some((c: { title: string }) => /Full mock test/.test(c.title)))
  assert.ok(cards.some((c: { type: string; links?: { href: string }[] }) => c.type === 'links' && c.links!.some((l) => l.href.endsWith('/assessments'))), 'the diagnostic is linked')
  void tenantX
})
