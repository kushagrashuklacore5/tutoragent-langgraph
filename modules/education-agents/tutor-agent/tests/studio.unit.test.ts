import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addDoubt, cleanNotebook, LineReader, mergeSectionNotes, notebookMarkdown, PAGE_CAPACITY, paginate, publicBlock, toBlock, type Block, type SourceRef } from '../src/studio/blocks.ts'
import { advance, ask, initialStudio, nextBlock, pagePrompt, resume, viewPage, type BookIndex, type StudioState } from '../src/studio/session.ts'
import { checkActivity } from '../src/studio/activity.ts'
import { licenceAllowed, parseCommons } from '../src/studio/images.ts'
import { sniffImage } from '../src/studio/routes.ts'

const src: SourceRef[] = [{ ref: 'p3', documentId: 'doc', filename: 'mechanics.pdf', page: 3, text: 'Newton\'s second law states that the net force on a body equals its mass times its acceleration, F = m a. Acceleration is in the direction of the net force.' }]

test('blocks: source labels need a retrieved citation AND shared vocabulary; otherwise honest "ai"', () => {
  const ok = toBlock({ type: 'text', text: 'The net force on a body equals its mass times its acceleration (F = m a).', label: 'source', cites: ['p3'] }, 'b1', src)!
  assert.equal(ok.label, 'source')
  assert.deepEqual(ok.cites, [{ ref: 'p3', documentId: 'doc', filename: 'mechanics.pdf', page: 3 }])
  assert.equal(toBlock({ type: 'text', text: 'Rockets work by expelling exhaust gases backwards at high speed.', label: 'source', cites: ['p3'] }, 'b2', src)!.label, 'ai', 'vocabulary does not match the cited page')
  assert.equal(toBlock({ type: 'text', text: 'Net force equals mass times acceleration.', label: 'source', cites: ['p99'] }, 'b3', src)!.label, 'ai', 'a citation not retrieved for this request')
  assert.equal(toBlock({ type: 'excerpt', text: 'Totally unrelated quote about cooking rice.', cites: ['p3'] }, 'b4', src), null, 'an ungrounded excerpt is dropped')
  assert.equal(toBlock({ type: 'html', text: '<script>' }, 'b5', src), null)
  assert.equal(toBlock({ type: 'definition', text: 'no term' }, 'b6', src), null)
  assert.ok(toBlock({ type: 'text', text: 'x'.repeat(5000) }, 'b7', src)!.text.length <= 700, 'about 5-7 lines at most')
})

test('activities: keys validated, numeric keys must be checkable, keys never sent before answering', () => {
  const mcq = toBlock({ type: 'activity', kind: 'mcq', prompt: 'If m doubles at constant F, a…', options: ['doubles', 'halves', 'stays'], correct: [1], hint: 'a = F/m', explanation: 'a is inversely proportional to m.' }, 'a1', [])!
  assert.deepEqual(mcq.activity!.key, { correct: [1] })
  const pub = publicBlock(mcq)
  assert.equal(pub.activity!.key, undefined)
  assert.equal(pub.activity!.hint, undefined)
  assert.equal(pub.activity!.explanation, undefined)
  assert.ok(!JSON.stringify(pub).includes('inversely'), 'no explanation leaks')
  assert.equal(toBlock({ type: 'activity', kind: 'mcq', prompt: 'p', options: ['a', 'b'], correct: [0, 1] }, 'a2', []), null, 'exactly one correct option')
  assert.equal(toBlock({ type: 'activity', kind: 'numeric', prompt: 'a = ?', value: 2 }, 'a3', []), null, 'numeric needs an expression the maths service can confirm')
  assert.equal(toBlock({ type: 'activity', kind: 'numeric', prompt: 'a = ?', value: 2, answerExpr: '5000/2500' }, 'a4', [])!.activity!.key!.expr, '5000/2500')
})

test('quick checks: deterministic marking, hint first then explanation, explain → model feedback', () => {
  const mcq = { kind: 'mcq' as const, prompt: 'q', options: ['a', 'b'], key: { correct: [1] }, hint: 'h', explanation: 'e' }
  assert.deepEqual(checkActivity(mcq, 1, 0), { verdict: 'correct', reveal: 'explanation' })
  assert.deepEqual(checkActivity(mcq, 0, 0), { verdict: 'incorrect', reveal: 'hint' })
  assert.deepEqual(checkActivity(mcq, 0, 1), { verdict: 'incorrect', reveal: 'explanation' })
  const num = { kind: 'numeric' as const, prompt: 'q', key: { value: 2, tolerance: 0.02 } }
  assert.equal(checkActivity(num, '2.01 m/s^2', 0).verdict, 'correct')
  assert.equal(checkActivity(num, '2.5', 0).verdict, 'incorrect')
  assert.equal(checkActivity(num, 'two', 0).verdict, 'incorrect')
  assert.equal(checkActivity({ kind: 'short', prompt: 'q', key: { accept: ['Newton'] } }, ' newton ', 0).verdict, 'correct')
  assert.equal(checkActivity({ kind: 'explain', prompt: 'q', key: { modelAnswer: 'm' } }, 'because force…', 0).verdict, 'needs_feedback')
})

test('streamed NDJSON: complete lines only, fences and junk ignored', () => {
  const r = new LineReader()
  assert.deepEqual(r.push('```json\n{"type":"heading","te'), [])
  assert.deepEqual(r.push('xt":"A"}\nnoise\n{"type":"text","text":"B"},\n'), [{ type: 'heading', text: 'A' }, { type: 'text', text: 'B' }])
  assert.deepEqual(r.push('{"type":"summary","text":"C"}'), [])
  assert.deepEqual(r.end(), [{ type: 'summary', text: 'C' }])
})

const blk = (id: string, type: Block['type'], n = 400): Block => ({ id, type, text: 'x'.repeat(n), label: 'ai', cites: [] })
test('pagination: pages respect capacity and continue numbering', () => {
  const pages = paginate([blk('h', 'heading', 20), blk('a', 'text', 650), blk('b', 'text', 650), blk('c', 'figure', 50), blk('d', 'text', 300), blk('e', 'activity', 100)], 4)
  assert.deepEqual(pages.map((p) => p.pageNo), [4, 5, 6].slice(0, pages.length))
  assert.ok(pages.length >= 2)
  assert.deepEqual(pages.flatMap((p) => p.blocks.map((b) => b.id)), ['h', 'a', 'b', 'c', 'd', 'e'], 'order preserved')
  assert.ok(PAGE_CAPACITY > 700)
})

test('lecture state: detours keep the lecture position; resume returns exactly; nothing skipped or repeated', () => {
  const idx: BookIndex = new Map([[1, ['s1-0', 's1-1', 's1-2']], [2, ['s1-3']], [3, ['s2-0', 's2-1']], [4, ['s2-2']], [15, ['s9-1', 's9-2', 's9-3']]])
  const now = new Date('2026-11-18T10:00:00Z')
  let s: StudioState = { ...initialStudio(), lecture: { pageNo: 15, blockId: 's9-2' }, view: { pageNo: 15, blockId: 's9-2' } }
  const v = viewPage(s, 4, now)
  assert.equal(v.detour, true)
  assert.deepEqual(v.state.interruption!.returnTo, { pageNo: 15, blockId: 's9-2' })
  s = v.state
  s = ask(s, 'highlight', 4, now)
  assert.equal(s.interruption!.kind, 'highlight')
  assert.deepEqual(s.lecture, { pageNo: 15, blockId: 's9-2' }, 'asking never moves the lecture')
  s = advance(s, { pageNo: 4, blockId: 's2-2' }, idx)
  assert.deepEqual(s.lecture, { pageNo: 15, blockId: 's9-2' }, 'reading elsewhere during a detour does not move the lecture')
  const r = resume(s)
  assert.deepEqual(r.position, { pageNo: 15, blockId: 's9-2' })
  assert.equal(r.state.interruption, null)
  assert.deepEqual(nextBlock(idx, r.position), { pageNo: 15, blockId: 's9-3' }, 'the next block after the resume point: no repeat, no skip')
  assert.deepEqual(advance(r.state, { pageNo: 15, blockId: 's9-1' }, idx).lecture, { pageNo: 15, blockId: 's9-2' }, 'never backwards')
  assert.equal(viewPage(r.state, 16, now).detour, false, 'turning to the next page is not a detour')
  assert.deepEqual(nextBlock(idx, { pageNo: 2, blockId: 's1-3' }), { pageNo: 3, blockId: 's2-0' })
  assert.equal(nextBlock(idx, { pageNo: 15, blockId: 's9-3' }), null)
  // back to the lecture page ends a page detour quietly
  const d2 = viewPage(viewPage(r.state, 3, now).state, 15, now)
  assert.equal(d2.state.interruption, null)
  assert.match(pagePrompt('hinglish', 4, 'Momentum', 'Momentum is mass times velocity.', 15), /page 4.*Momentum.*page 15/)
})

test('notebook: concise notes from structure, doubts kept, student notes preserved, markdown export, validation', () => {
  const blocks: Block[] = [
    { id: '1', type: 'heading', text: 'Newton\'s second law', label: 'ai', cites: [] },
    { id: '2', type: 'definition', term: 'Net force', text: 'The vector sum of all forces on a body.', label: 'source', cites: [] },
    { id: '3', type: 'formula', text: 'F = m a', label: 'ai', cites: [] },
    { id: '4', type: 'text', text: 'Acceleration is proportional to net force. It is inversely proportional to mass.', label: 'ai', cites: [] },
    { id: '5', type: 'tip', text: 'FMA: Force Makes Acceleration.', label: 'ai', cites: [] },
    { id: '6', type: 'activity', text: 'q', label: 'ai', cites: [], activity: { kind: 'mcq', prompt: 'If m doubles?', options: ['a', 'b'], key: { correct: [0] } } },
    { id: '7', type: 'summary', text: 'F = m a links force, mass and acceleration.', label: 'ai', cites: [] },
  ]
  let nb = mergeSectionNotes({ title: 'Mechanics', topics: [], summary: '' }, 's1', 'Newton\'s second law', blocks)
  nb = { ...nb, topics: nb.topics.map((t) => ({ ...t, myNotes: 'remember units!' })) }
  nb = mergeSectionNotes(nb, 's1', 'Newton\'s second law', blocks)
  const t = nb.topics[0]!
  assert.deepEqual(t.definitions, [{ term: 'Net force', text: 'The vector sum of all forces on a body.' }], 'no duplicates')
  assert.deepEqual(t.formulae, ['F = m a'])
  assert.deepEqual(t.memoryTricks, ['FMA: Force Makes Acceleration.'])
  assert.deepEqual(t.practice, ['If m doubles?'])
  assert.deepEqual(t.keyPoints, ['Acceleration is proportional to net force.'], 'first sentence only, not the whole explanation')
  assert.equal(t.myNotes, 'remember units!', 'student notes survive AI updates')
  nb = addDoubt(nb, 's1', 'x', 'Why does a halve?', 'Because a = F/m.')
  assert.equal(nb.topics[0]!.doubts.length, 1)
  const md = notebookMarkdown(nb)
  assert.match(md, /# Mechanics[\s\S]*\*\*Net force\*\*[\s\S]*F = m a[\s\S]*Q: Why does a halve\?[\s\S]*remember units!/)
  assert.equal(cleanNotebook({ topics: 'x' }, 't'), null)
  assert.equal(cleanNotebook(JSON.parse(JSON.stringify(nb)), 't')!.topics[0]!.title, 'Newton\'s second law')
})

test('images: only reusable licences from Wikimedia hosts, attribution kept', () => {
  assert.ok(licenceAllowed('CC BY-SA 4.0') && licenceAllowed('Public domain') && licenceAllowed('CC0') && licenceAllowed('CC BY 3.0'))
  assert.ok(!licenceAllowed('Fair use') && !licenceAllowed('All rights reserved') && !licenceAllowed('CC BY-NC 4.0'))
  const page = (title: string, license: string, url = 'https://upload.wikimedia.org/a.png', mime = 'image/png', index = 1) => ({ title, index, imageinfo: [{ url, thumburl: url, thumbwidth: 640, thumbheight: 400, descriptionurl: `https://commons.wikimedia.org/wiki/${title}`, mime, extmetadata: { LicenseShortName: { value: license }, Artist: { value: '<a href="x">Jane Doe</a>' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' } } }] })
  const hits = parseCommons({ query: { pages: { 1: page('File:Force.png', 'CC BY-SA 4.0'), 2: page('File:Book.png', 'Fair use'), 3: page('File:Evil.png', 'CC0', 'https://evil.example/x.png'), 4: page('File:Doc.pdf', 'CC0', 'https://upload.wikimedia.org/d.pdf', 'application/pdf') } } })
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.credit, 'Jane Doe · CC BY-SA 4.0 · Wikimedia Commons')
  assert.equal(hits[0]!.pageUrl, 'https://commons.wikimedia.org/wiki/File:Force.png')
  assert.deepEqual(parseCommons({}), [])
})

test('photo uploads are recognised by their bytes', () => {
  assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png')
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniffImage(Buffer.from('%PDF-1.7 not an image')), null)
})

test('maths is made readable without a renderer; tips are not prefixed twice', async () => {
  const { plainMath } = await import('../src/studio/blocks.ts')
  const bs = String.fromCharCode(92) // backslash, written explicitly to keep the LaTeX input exact
  assert.equal(plainMath(`v = ${bs}frac{${bs}Delta s}{${bs}Delta t} ${bs}quad a = ${bs}frac{${bs}Delta v}{${bs}Delta t}`), 'v = Δs/Δt a = Δv/Δt')
  assert.equal(plainMath(`$a = ${bs}frac{v-u}{t}$, x^{2}, ${bs}sqrt{2gh}, 3 ${bs}times 10^{8}`), 'a = (v-u)/t, x^2, √(2gh), 3 × 10^8')
  assert.equal(toBlock({ type: 'tip', text: 'Remember: FMA' }, 't', [])!.text, 'FMA')
})

test('images: irrelevant search results are rejected (no figure beats a wrong figure)', async () => {
  const { relevant } = await import('../src/studio/images.ts')
  assert.equal(relevant('free body diagram', { title: 'ChronicBackache1035', about: 'File:ChronicBackache1035.png Chronic backache Medical illustrations' }), false)
  assert.equal(relevant('free body diagram', { title: 'Free body diagram of a block', about: 'Free body diagrams Physics' }), true)
  assert.equal(relevant('velocity time graph', { title: 'Velocity-time graph', about: 'Kinematics' }), true)
  assert.equal(relevant('diagram', { title: 'anything', about: '' }), false, 'a query with no content words matches nothing')
})

test('images: every content word of a short query must match; title matches rank first', async () => {
  const { relevance } = await import('../src/studio/images.ts')
  assert.equal(relevance('free body diagram', { title: 'Nautilus diagram-en', about: 'body chambers of a nautilus' }), 0)
  assert.ok(relevance('free body diagram', { title: 'Free body diagram mod', about: '' }) > relevance('free body diagram', { title: 'Block forces', about: 'free body diagrams physics' }))
})

test('MCQ keys from the model are verified, never trusted (live regression: key contradicted its explanation)', async () => {
  const { verifyMcqKey } = await import('../src/studio/activity.ts')
  const live = { kind: 'mcq' as const, prompt: 'A 5 kg crate is pulled with 20 N. Acceleration?', options: ['2 m/s^2', '4 m/s^2', '5 m/s^2'], key: { correct: [0], expr: '20/5' }, explanation: 'a = 20 N / 5 kg = 4 m/s^2' }
  assert.equal(verifyMcqKey(live, 4), null, 'the keyed option (2) does not match the evaluated answer (4): dropped')
  assert.equal(verifyMcqKey({ ...live, key: { correct: [1], expr: '20/5' } }, 4), 1)
  assert.equal(verifyMcqKey({ ...live, key: { correct: [1] } }, null), null, 'numeric options without a checkable expression: dropped')
  const text = { kind: 'mcq' as const, prompt: 'If m doubles at constant v, p…', options: ['halves', 'doubles', 'stays the same'], key: { correct: [0] }, explanation: 'p = m v, so p doubles.' }
  assert.equal(verifyMcqKey(text, null), null, 'explanation names a different option')
  assert.equal(verifyMcqKey({ ...text, key: { correct: [1] } }, null), 1)
})
