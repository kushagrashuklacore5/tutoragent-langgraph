/**
 * Learning Studio end to end through HTTP, the real document pipeline (upload → parse → chunk → embed → retrieval),
 * the database (RLS, encryption at rest) and a scripted model: book from the student's own notes, a section streamed
 * into the book, page detour with a content-aware prompt, highlight-and-ask, resume to the exact lecture position,
 * a quick check answered wrongly (hint, revision card, no answer leak), notebook versions, annotations, isolation.
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
const out = (text: string) => ({ text, toolCalls: [], finish: 'stop' as const, usage })
const NOTES = 'Momentum. The momentum of a body is the product of its mass and its velocity, p = m v. Momentum is a vector quantity and its SI unit is kg m/s. Impulse. The impulse of a force equals the change in momentum it produces. A large force acting for a short time can produce the same impulse as a small force acting for a long time. Conservation. In a closed system with no external force the total momentum stays constant.'
let section = 0
let askSeen = ''
let lessonSeen = false
function respond(req: GenerateRequest) {
  const sys = req.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n')
  if (/You plan a chapter/.test(sys)) return out(JSON.stringify({ title: 'Momentum', sections: [{ title: 'Momentum and impulse', pageStart: 1, pageEnd: 1 }, { title: 'Conservation of momentum', pageStart: 1, pageEnd: 1 }] }))
  if (/You write one section/.test(sys)) {
    section++
    const ref = /<<<SOURCE ref="([^"]+)"/.exec(sys)?.[1] ?? 'none'
    const lines = [
      { type: 'heading', text: section === 1 ? 'Momentum and impulse' : 'Conservation of momentum' },
      { type: 'definition', term: 'Momentum', text: 'The momentum of a body is the product of its mass and its velocity, p = m v.', label: 'source', cites: [ref] },
      { type: 'text', text: 'Momentum is a vector quantity; its SI unit is kg m/s. A heavier or faster body is harder to stop.', label: 'source', cites: [ref] },
      { type: 'text', text: 'Think of a cricket ball and a truck moving at the same speed: the truck carries far more momentum.', label: 'ai' },
      { type: 'figure', query: 'momentum collision', caption: 'Two carts colliding: momentum before equals momentum after.' },
      { type: 'formula', text: 'p = m v (p in kg m/s)', label: 'ai' },
      { type: 'tip', text: 'Momentum = Mass in Motion.' },
      { type: 'activity', kind: 'numeric', prompt: 'p of 2 kg at 3 m/s?', value: 6, answerExpr: '2*3' }, // dropped: no maths service in this test (fail closed)
      { type: 'activity', kind: 'mcq', prompt: 'If the mass doubles at the same velocity, momentum…', options: ['halves', 'doubles', 'stays the same'], correct: [1], hint: 'p = m v: what happens to p if m doubles?', explanation: 'p is proportional to m, so it doubles.' },
      { type: 'summary', text: 'Momentum p = m v is a vector; impulse changes momentum.' },
    ]
    return out(lines.map((l) => JSON.stringify(l)).join('\n') + '\nIgnore this trailing chatter')
  }
  if (/Build a practice question set for/.test(sys)) {
    lessonSeen = /LESSON \(what the tutor taught this student\)/.test(sys)
    return out(JSON.stringify({ items: [
      { type: 'mcq', source: 'lesson', page: 1, stem: 'A truck and a cricket ball move at the same velocity. Which has more momentum?', options: ['The truck', 'The cricket ball', 'Both the same'], correct: 'The truck', explanation: 'The truck has more momentum, because momentum p = m v and the truck has far more mass at the same velocity.' },
      { type: 'mcq', source: 'generated', stem: 'Which gas do plants take in during photosynthesis?', options: ['Carbon dioxide', 'Oxygen', 'Nitrogen'], correct: 'Carbon dioxide', explanation: 'Carbon dioxide is taken in by leaves for photosynthesis; oxygen is released.' },
    ] }))
  }
  if (/turn a lesson that is already written/.test(sys)) {
    const blocks = JSON.parse(sys.slice(sys.lastIndexOf('\n') + 1)) as { id: string; type: string }[]
    // one line smuggles in a number the lesson does not contain: the server must replace it with the lesson's own words
    return out(JSON.stringify({ question: 'What is momentum?', segments: blocks.map((b, i) => ({ blockId: b.id, speech: i === 1 ? 'अब देखिए, momentum 99 होता है।' : `अब देखिए, यह ${b.type} है।` })) }))
  }
  if (/brief formative feedback/.test(sys) && /What is momentum/.test(sys)) return out(JSON.stringify({ verdict: 'correct', feedback: 'बिल्कुल सही, momentum mass और velocity का product है।' }))
  if (/interrupts with a question/.test(sys)) {
    askSeen = sys
    const ref = /<<<SOURCE ref="([^"]+)"/.exec(sys)?.[1] ?? 'none'
    return out(JSON.stringify({ intent: 'simplify', blocks: [{ type: 'text', text: 'Momentum is the product of mass and velocity: heavier or faster means more momentum.', label: 'source', cites: [ref] }], followUp: 'Which has more momentum: a slow truck or a fast ball?' }))
  }
  return out(JSON.stringify({ verdict: 'partial', feedback: 'ok' }))
}

let w: TutorWorld
let docId = ''
let bookId = ''
const T = '/api/m/education.tutor'

async function drain() {
  const db = createDatabase(w.h.test.appUrl)
  const sys = createSystemDatabase(w.h.test.systemUrl)
  await createWorker({ system: sys, db, handlers: w.h.app.platform.jobs }).drain()
  await db.close(); await sys.close()
}

before(async () => {
  setImageSearch(async (q) => (q.includes('momentum') ? [{ url: 'https://upload.wikimedia.org/x.png', thumb: 'https://upload.wikimedia.org/x-640.png', width: 640, height: 400, title: 'Carts', pageUrl: 'https://commons.wikimedia.org/wiki/File:Carts.png', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', credit: 'Jane Doe · CC BY-SA 4.0 · Wikimedia Commons' }] : []))
  w = await setupTutorWorld({ respond, embed: hashingEmbed }, { documents: true })
  const policy = { processingLocation: 'IN', selfHosted: true, retentionDays: 0, zeroRetention: true, trainsOnData: false, dpaInPlace: true, termsVerified: true }
  const conn = await w.h.call('POST', '/api/admin/ai/connections', w.admin, { adapter: 'fake', name: 'emb', baseUrl: 'http://127.0.0.1:9', allowPrivateNetwork: true, dataPolicy: policy })
  await w.h.call('POST', '/api/admin/ai/models/approve', w.admin, { adapter: 'fake', modelId: 'emb', declared: { operations: ['embed'], embeddingDimensions: [256] } })
  const emb = await w.h.call('POST', '/api/admin/ai/deployments', w.admin, { connectionId: conn.json.id, modelId: 'emb' })
  assert.equal((await w.h.call('PUT', '/api/admin/ai/routes', w.admin, { target: 'category:embeddings', candidates: [{ deploymentId: emb.json.id }] })).status, 200)
  // the student uploads their own notes (private) → existing pipeline
  const up = await fetch(`${w.h.url}${T}/courses/${w.courseId}/materials?filename=momentum-notes.txt`, { method: 'POST', headers: { authorization: `Bearer ${w.stu}`, 'content-type': 'text/plain' }, body: NOTES })
  const upBody = await up.text()
  assert.equal(up.status, 200, upBody)
  docId = JSON.parse(upBody).documentId
  await drain()
})
after(async () => { setImageSearch(null); await w?.close() })

test('book from the student\'s own notes: outline from the document, private to the student', async () => {
  const r = await w.h.call('POST', `${T}/studio/books`, w.stu, { courseId: w.courseId, title: 'Momentum', documentId: docId, language: 'en' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  bookId = r.json.id
  assert.equal(r.json.mode, 'source')
  const v = (await w.h.call('GET', `${T}/studio/books/${bookId}`, w.stu)).json
  assert.deepEqual(v.book.outline.map((s: { title: string; status: string }) => [s.title, s.status]), [['Momentum and impulse', 'pending'], ['Conservation of momentum', 'pending']])
  assert.equal((await w.h.call('GET', `${T}/studio/books/${bookId}`, w.stu2)).status, 404, 'another student cannot open it')
  assert.equal((await w.h.call('POST', `${T}/studio/books`, w.stu2, { courseId: w.courseId, title: 'x', documentId: docId })).status, 404, 'nor build a book from another student\'s private notes')
})

test('a section streams into the book: source-grounded blocks, licensed figure, verified checks only, no answer keys', async () => {
  const r = await postSse(w.h, `${T}/studio/books/${bookId}/sections/s1/generate`, w.stu, {})
  assert.equal(r.status, 200)
  const blocks = r.events.filter((e) => e.data?.type === 'block').map((e) => e.data.block)
  assert.ok(blocks.length >= 6, 'blocks arrive one by one')
  assert.equal(blocks[0].type, 'heading')
  const def = blocks.find((b: { type: string }) => b.type === 'definition')
  assert.equal(def.label, 'source')
  assert.equal(def.cites[0].filename, 'momentum-notes.txt')
  assert.equal(blocks.find((b: { text: string }) => /cricket ball/.test(b.text)).label, 'ai', 'own explanations are labelled as AI')
  const fig = blocks.find((b: { type: string }) => b.type === 'figure')
  assert.equal(fig.figure.license, 'CC BY-SA 4.0')
  assert.match(fig.figure.credit, /Jane Doe/)
  const acts = blocks.filter((b: { type: string }) => b.type === 'activity')
  assert.equal(acts.length, 1, 'the numeric check without a maths service was dropped (fail closed)')
  const raw = JSON.stringify(r.events)
  assert.ok(!raw.includes('"correct"') && !raw.includes('proportional to m'), 'no answer key or explanation reaches the browser')
  const done = r.events.find((e) => e.data?.type === 'section')!.data
  assert.ok(done.pages.length >= 1 && done.pages[0].pageNo === 1)
  // regenerate = idempotent (returns the stored pages, no new model call)
  const before = section
  const again = await postSse(w.h, `${T}/studio/books/${bookId}/sections/s1/generate`, w.stu, {})
  assert.equal(section, before)
  assert.equal(again.events.find((e) => e.data?.type === 'section')!.data.pages.length, done.pages.length)
  // second section continues the page numbering
  const s2 = await postSse(w.h, `${T}/studio/books/${bookId}/sections/s2/generate`, w.stu, {})
  assert.ok(s2.events.find((e) => e.data?.type === 'section')!.data.pages[0].pageNo > done.pages.at(-1).pageNo)
  // encrypted at rest; notebook updated progressively
  const enc = (await w.owner.query('select blocks_enc from education_tutor.studio_pages where book_id = $1', [bookId])).rows.map((x) => x.blocks_enc).join(' ')
  assert.ok(!enc.includes('Momentum') && !enc.includes('cricket'))
  const nb = (await w.h.call('GET', `${T}/studio/books/${bookId}`, w.stu)).json.notebook
  assert.equal(nb.version, 3)
  const t1 = nb.doc.topics[0]
  assert.equal(t1.definitions[0].term, 'Momentum')
  assert.deepEqual(t1.memoryTricks, ['Momentum = Mass in Motion.'])
  assert.equal(t1.practice.length, 1)
})

test('context: opening another page gives a content-aware prompt; ask keeps the lecture; resume returns exactly', async () => {
  const v = (await w.h.call('GET', `${T}/studio/books/${bookId}`, w.stu)).json
  const p1 = v.pages[0]
  const lastPage = v.pages.at(-1).pageNo
  // the student reads up to the 3rd block of page 1 (lecture position)
  const third = p1.blocks[2].id
  assert.equal((await w.h.call('POST', `${T}/studio/books/${bookId}/events`, w.stu, { kind: 'advance', pageNo: 1, blockId: third })).status, 200)
  const ev = await w.h.call('POST', `${T}/studio/books/${bookId}/events`, w.stu, { kind: 'view', pageNo: lastPage })
  assert.equal(ev.json.state.interruption.kind, 'page')
  assert.match(ev.json.prompt, new RegExp(`page ${lastPage}.*Conservation of momentum`), 'knows what is ON the page, not just its number')
  // highlight-and-ask on that page
  const target = v.pages.at(-1).blocks.find((b: { type: string; text: string }) => b.type !== 'heading' && b.type !== 'figure' && b.text)
  const a = await w.h.call('POST', `${T}/studio/books/${bookId}/ask`, w.stu, { question: 'Explain simply', selection: target.text, pageNo: lastPage, blockId: target.id })
  assert.equal(a.status, 200, JSON.stringify(a.json))
  assert.equal(a.json.answer.intent, 'simplify')
  assert.equal(a.json.answer.blocks[0].label, 'source')
  assert.deepEqual(a.json.resumeTo, { pageNo: 1, blockId: third }, 'the return point is the lecture position')
  assert.match(askSeen, /SELECTED TEXT/)
  assert.match(askSeen, /momentum-notes\.txt/, 'answered from the student\'s own source')
  const r = await w.h.call('POST', `${T}/studio/books/${bookId}/resume`, w.stu)
  assert.deepEqual(r.json.position, { pageNo: 1, blockId: third })
  assert.equal(r.json.state.interruption, null)
  const nb = (await w.h.call('GET', `${T}/studio/books/${bookId}`, w.stu)).json.notebook
  assert.ok(nb.doc.topics.some((t: { doubts: unknown[] }) => t.doubts.length === 1), 'the doubt is in the notebook')
})

test('quick check: wrong → hint (no key), then explanation + key + revision card once; never learner evidence', async () => {
  const v = (await w.h.call('GET', `${T}/studio/books/${bookId}`, w.stu)).json
  const act = v.pages.flatMap((p: { blocks: { type: string; id: string }[] }) => p.blocks).find((b: { type: string }) => b.type === 'activity')
  const r1 = await w.h.call('POST', `${T}/studio/books/${bookId}/activities/${act.id}/answer`, w.stu, { answer: 0 })
  assert.equal(r1.json.verdict, 'incorrect')
  assert.match(r1.json.hint, /p = m v/)
  assert.equal(r1.json.correct, null)
  assert.ok(r1.json.refBlockId, 'points back to the teaching block')
  assert.equal(r1.json.revisionCard, true)
  const r2 = await w.h.call('POST', `${T}/studio/books/${bookId}/activities/${act.id}/answer`, w.stu, { answer: 2 })
  assert.equal(r2.json.explanation, 'p is proportional to m, so it doubles.')
  assert.deepEqual(r2.json.correct, { option: 1 })
  assert.equal(r2.json.revisionCard, false, 'one card per check')
  const cards = (await w.owner.query(`select count(*)::int as n from education_tutor.cards c join platform.users u on u.id = c.user_id where u.email = 'stu@x.test' and c.source_ref like 'studio:%'`)).rows[0].n
  assert.equal(cards, 1)
  const evidence = (await w.owner.query(`select count(*)::int as n from education_tutor.evidence e join platform.users u on u.id = e.user_id where u.email = 'stu@x.test'`)).rows[0].n
  assert.equal(evidence, 0, 'formative checks never change mastery')
  const hist = (await w.owner.query(`select kind from education_tutor.studio_events where book_id = $1 order by id`, [bookId])).rows.map((x) => x.kind)
  assert.deepEqual(hist.filter((k) => ['created', 'section_generated', 'page_detour', 'ask', 'resume', 'activity'].includes(k)), ['created', 'section_generated', 'section_generated', 'page_detour', 'ask', 'resume', 'activity', 'activity'])
})

test('notebook: student edits are versioned; stale edits are refused; annotations are private and encrypted', async () => {
  const v = (await w.h.call('GET', `${T}/studio/books/${bookId}`, w.stu)).json
  const doc = { ...v.notebook.doc, topics: v.notebook.doc.topics.map((t: object, i: number) => (i === 0 ? { ...t, myNotes: 'p = m v, units kg m/s' } : t)) }
  const s = await w.h.call('PUT', `${T}/studio/books/${bookId}/notebook`, w.stu, { doc, version: v.notebook.version })
  assert.equal(s.json.version, v.notebook.version + 1)
  assert.equal((await w.h.call('PUT', `${T}/studio/books/${bookId}/notebook`, w.stu, { doc, version: v.notebook.version })).status, 409)
  const vers = (await w.h.call('GET', `${T}/studio/books/${bookId}/notebook/versions`, w.stu)).json
  assert.equal(vers[0].author, 'student')
  const blk = v.pages[0].blocks[1]
  const a = await w.h.call('POST', `${T}/studio/books/${bookId}/annotations`, w.stu, { kind: 'highlight', pageNo: 1, blockId: blk.id, quote: 'product of its mass', note: 'exam!' })
  assert.equal(a.status, 200)
  assert.equal((await w.h.call('POST', `${T}/studio/books/${bookId}/annotations`, w.stu, { kind: 'highlight', pageNo: 1, blockId: 'forged' })).status, 400)
  const raw = (await w.owner.query('select quote_enc, note_enc from education_tutor.studio_annotations where book_id = $1', [bookId])).rows[0]
  assert.ok(!raw.quote_enc.includes('product') && !raw.note_enc.includes('exam'))
  const got = (await w.h.call('GET', `${T}/studio/books/${bookId}`, w.stu)).json.annotations
  assert.equal(got[0].quote, 'product of its mass')
  assert.equal((await w.h.call('DELETE', `${T}/studio/books/${bookId}/annotations/${a.json.id}`, w.stu2)).status, 404)
})

test('generated mode without material, and photos need a vision-capable route', async () => {
  const g = await w.h.call('POST', `${T}/studio/books`, w.stu2, { courseId: w.courseId, title: 'Limits' })
  assert.equal(g.json.mode, 'generated')
  const r = await postSse(w.h, `${T}/studio/books/${g.json.id}/sections/s1/generate`, w.stu2, {})
  const blocks = r.events.filter((e) => e.data?.type === 'block').map((e) => e.data.block)
  assert.ok(blocks.length > 3)
  assert.ok(blocks.every((b: { label: string }) => b.label !== 'source'), 'nothing claims a source that was not retrieved for this student')
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  const ocr = await fetch(`${w.h.url}${T}/courses/${w.courseId}/studio/ocr?filename=page.png`, { method: 'POST', headers: { authorization: `Bearer ${w.stu}`, 'content-type': 'image/png' }, body: png })
  assert.equal(ocr.status, 503)
  assert.equal((await ocr.json()).error?.code ?? 'ocr_unavailable', 'ocr_unavailable')
  const pdfAsImage = await fetch(`${w.h.url}${T}/courses/${w.courseId}/studio/ocr`, { method: 'POST', headers: { authorization: `Bearer ${w.stu}` }, body: '%PDF-1.4' })
  assert.equal(pdfAsImage.status, 400)
})

test('practice is made from what was TAUGHT: lesson questions are kept and labelled, unrelated ones are rejected', async () => {
  const cMomentum = (await w.h.call('POST', `/api/m/education.tutor/courses/${w.courseId}/concepts`, w.prof, { name: 'Momentum', estMinutes: 30 })).json.id
  assert.equal((await w.h.call('POST', `/api/m/education.tutor/courses/${w.courseId}/concepts/${cMomentum}/approve`, w.prof)).status, 204)
  const dep = (await w.owner.query(`select id from platform.ai_deployments where model_id = 'tutor-1' order by created_at limit 1`)).rows[0]
  assert.equal((await w.h.call('PUT', '/api/admin/ai/routes', w.admin, { target: 'category:assessment', candidates: [{ deploymentId: dep.id }] })).status, 200)
  const r = await w.h.call('POST', `/api/m/education.tutor/courses/${w.courseId}/practice/prepare`, w.stu, { conceptId: cMomentum })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.ok(lessonSeen, 'the lesson the tutor taught was given to the question writer')
  assert.equal(r.json.added, 1, JSON.stringify(r.json))
  assert.equal(r.json.fromLesson, 1)
  assert.ok(r.json.reasons.includes('not about what was taught'), 'the unrelated question was rejected')
  const next = (await w.h.call('GET', `/api/m/education.tutor/courses/${w.courseId}/practice/next?conceptId=${cMomentum}`, w.stu)).json
  assert.equal(next.source.kind, 'lesson')
  assert.match(next.item.stem, /truck/)
})

test('live teaching: speech stays faithful to the written lesson, and only text from this server can be voiced', async () => {
  const L = `/api/m/education.tutor/studio/books/${bookId}/live`
  const view = (await w.h.call('GET', `/api/m/education.tutor/studio/books/${bookId}`, w.stu)).json
  const sectionId = view.pages[0].sectionId as string
  const written = view.pages.filter((p: { sectionId: string }) => p.sectionId === sectionId).flatMap((p: { blocks: { id: string; type: string }[] }) => p.blocks).filter((b: { type: string }) => b.type !== 'activity')
  const r = await w.h.call('POST', `${L}/script`, w.stu, { sectionId, language: 'hinglish' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual(r.json.segments.map((x: { blockId: string }) => x.blockId), written.map((b: { id: string }) => b.id), 'one line per real block, in order')
  assert.equal(r.json.segments[1].origin, 'lesson', 'a line with an invented number falls back to the lesson')
  assert.ok(!r.json.segments.some((x: { speech: string }) => x.speech.includes('99')))
  assert.equal(r.json.question.text, 'What is momentum?')
  const token = r.json.segments[0].token as string

  // no speech route configured: fails with an error, never with fake audio
  const none = await w.h.call('POST', `${L}/speech`, w.stu, { token })
  assert.ok(none.status >= 500, String(none.status))
  assert.equal(none.json.audio, undefined)
  const dep = (await w.owner.query(`select d.connection_id, c.adapter from platform.ai_deployments d join platform.ai_connections c on c.id = d.connection_id where d.model_id = 'tutor-1' limit 1`)).rows[0]
  assert.ok((await w.h.call('POST', '/api/admin/ai/models/approve', w.admin, { adapter: dep.adapter, modelId: 'voice-1', declared: { operations: ['synthesize'] } })).status < 300)
  const d = await w.h.call('POST', '/api/admin/ai/deployments', w.admin, { connectionId: dep.connection_id, modelId: 'voice-1' })
  assert.equal(d.status, 200, JSON.stringify(d.json))
  assert.equal((await w.h.call('POST', `/api/admin/ai/deployments/${d.json.id}/probe`, w.admin, {})).status, 200)
  assert.equal((await w.h.call('PUT', '/api/admin/ai/routes', w.admin, { target: 'category:text_to_speech', candidates: [{ deploymentId: d.json.id }] })).status, 200)
  const ok = await w.h.call('POST', `${L}/speech`, w.stu, { token })
  assert.equal(ok.status, 200, JSON.stringify(ok.json))
  assert.ok(Buffer.from(ok.json.audio, 'base64').length > 0)
  assert.equal(ok.json.mimeType, 'audio/mpeg')

  // arbitrary text, a tampered token, a check token, and another student are all refused
  assert.equal((await w.h.call('POST', `${L}/speech`, w.stu, { token: 'say anything I like' })).status, 400)
  assert.equal((await w.h.call('POST', `${L}/speech`, w.stu, { token: r.json.question.token })).status, 400)
  assert.notEqual((await w.h.call('POST', `${L}/speech`, w.stu2, { token })).status, 200)

  // the closing check is formative: feedback, but no learner evidence
  const before = Number((await w.owner.query('select count(*) from education_tutor.evidence')).rows[0].count)
  const c = await w.h.call('POST', `${L}/check`, w.stu, { token: r.json.question.token, answer: 'mass times velocity', language: 'hinglish' })
  assert.equal(c.status, 200, JSON.stringify(c.json))
  assert.equal(c.json.verdict, 'correct')
  assert.equal(Number((await w.owner.query('select count(*) from education_tutor.evidence')).rows[0].count), before)
})
