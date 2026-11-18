/** Unit tests for the web app's pure helpers. Run: node --test apps/web/test/ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, describeError, isEndpointMissing, toApiError } from '../src/lib/api.ts'
import { SseParser, applyProgress, interpretTurnEvent } from '../src/lib/sse.ts'
import { parseInline, parseMarkdown, prettyMath, safeHref } from '../src/lib/markdown.ts'
import { checkUpload, citationLabel, countdownText, daysUntil, masteryView, missedMinutes, normalizeSegments, taskKey, todaysTasks, weekOf, type PlanTask } from '../src/lib/tutor.ts'
import { historyEntries, normalizeTurn, sessionTitle } from '../src/lib/turns.ts'

test('API errors map to plain language and detect missing endpoints', () => {
  const e = toApiError(503, { error: { code: 'no_eligible_route', message: 'x' } })
  assert.ok(e instanceof ApiError)
  assert.equal(e.code, 'no_eligible_route')
  assert.match(describeError(e), /no AI model is configured/)
  assert.equal(toApiError(0, null).code, 'network')
  assert.match(describeError(toApiError(0, null)), /offline/)
  assert.match(describeError(toApiError(500, { error: { code: 'internal', message: 'Internal error' } })), /on our side/)
  assert.equal(describeError(toApiError(400, { error: { code: 'daily_minutes_invalid', message: 'dailyMinutes must be 10–600' } })), 'dailyMinutes must be 10–600')
  assert.equal(isEndpointMissing(toApiError(404, { error: { code: 'not_found', message: 'Not found' } })), true)
  assert.equal(isEndpointMissing(toApiError(404, { error: { code: 'not_found', message: 'Course not found' } })), false)
  assert.equal(toApiError(502, 'garbage').code, 'http_502')
})

test('SSE parser handles split chunks, CRLF, multi-line data, comments and named events', () => {
  const p = new SseParser()
  const evs = [...p.feed('data: {"type":"prog'), ...p.feed('ress","text":"Hel"}\r'), ...p.feed('\n\r\n: keepalive\n\nevent: error\ndata: {"code":"x",\ndata: "message":"boom"}\n\n')]
  assert.deepEqual(evs, [
    { event: 'message', data: '{"type":"progress","text":"Hel"}' },
    { event: 'error', data: '{"code":"x",\n"message":"boom"}' },
  ])
  assert.deepEqual(p.feed('data: tail'), [])
  assert.deepEqual(p.end(), [{ event: 'message', data: 'tail' }])
})

test('turn stream events are interpreted leniently', () => {
  assert.deepEqual(interpretTurnEvent({ event: 'message', data: '{"type":"progress","text":"Hi"}' }), { kind: 'progress', text: 'Hi', index: null })
  const t = interpretTurnEvent({ event: 'message', data: '{"type":"turn","turn":{"move":"ask","segments":[]}}' })
  assert.equal(t.kind, 'turn')
  assert.equal(interpretTurnEvent({ event: 'message', data: '{"move":"hint","segments":[{"text":"a","source":"general"}]}' }).kind, 'turn')
  assert.deepEqual(interpretTurnEvent({ event: 'error', data: '{"code":"timeout","message":"slow"}' }), { kind: 'error', code: 'timeout', message: 'slow' })
  assert.equal(interpretTurnEvent({ event: 'message', data: 'not json' }).kind, 'ignore')
  assert.equal(applyProgress('', 'Hel'), 'Hel')
  assert.equal(applyProgress('Hel', 'Hello'), 'Hello') // cumulative
  assert.equal(applyProgress('Hello', ' world'), 'Hello world') // delta
})

test('segments: course claims without a usable citation are shown as uncertain; citations are labelled', () => {
  const segs = normalizeSegments([
    { text: 'From the book', source: 'course', citations: ['bare-chunk-id'] },
    { text: 'Cited', source: 'course', citations: [{ chunkId: 'c1', documentId: 'd1', filename: 'notes.pdf', pageStart: 12, pageEnd: 13 }] },
    { text: 'Made up', source: 'ai_example' },
    { text: 'x', source: 'evil<script>' },
    { text: '   ', source: 'general' },
    null,
  ])
  assert.deepEqual(segs.map((s) => s.source), ['uncertain', 'course', 'ai_example', 'uncertain'])
  assert.equal(citationLabel(segs[1]!.citations[0]!), 'notes.pdf · pp. 12–13')
  assert.equal(citationLabel({ chunkId: '', documentId: 'd', filename: 'a.pdf', pageStart: 4, pageEnd: 4 }), 'a.pdf · p. 4')
  const own = normalizeSegments([{ text: 'x', source: 'course', citations: [{ chunkId: 'c', documentId: 'd', filename: 'mine.pdf', pageStart: 2, pageEnd: 2, trust: 'student_upload' }] }])
  assert.equal(citationLabel(own[0]!.citations[0]!), 'Your notes: mine.pdf · p. 2')
  const turn = normalizeTurn({ move: 'rm -rf', hintLevel: 9, segments: [{ text: 'hi', source: 'general' }], assessment: 'nope' })
  assert.equal(turn.move, 'explain')
  assert.equal(turn.hintLevel, 4)
  assert.equal(turn.assessment, 'not_an_attempt')
  assert.equal(turn.policyNote, null)
})

test('markdown: safe subset, no raw HTML, only http(s) links', () => {
  const blocks = parseMarkdown('# Title\n\nSome **bold** and *em* with `code` and $x^2$.\n\n- one\n- two\n\n```py\nprint(1)\n```\n\n$$\n\\frac{a}{b}\n$$\n\n<img src=x onerror=alert(1)>')
  assert.deepEqual(blocks.map((b) => b.type), ['h', 'p', 'ul', 'code', 'math', 'p'])
  const last = blocks.at(-1)!
  assert.ok(last.type === 'p' && last.c[0]!.t === 'text' && last.c[0]!.v.startsWith('<img'), 'HTML stays literal text')
  assert.ok(parseInline('[x](javascript:alert(1))').every((n) => n.t === 'text'), 'no link node for javascript: URLs')
  assert.equal(safeHref('https://example.org/a'), 'https://example.org/a')
  assert.equal(safeHref('data:text/html,hi'), null)
  assert.deepEqual(parseInline('costs $5 and $10'), [{ t: 'text', v: 'costs $5 and $10' }])
  assert.deepEqual(parseInline('snake_case_name'), [{ t: 'text', v: 'snake_case_name' }])
  assert.equal(prettyMath('\\lim_{x \\to 2} \\frac{x^2-4}{x-2}'), 'lim_(x → 2) (x²-4)/(x-2)')
})

test('mastery view never shows a score without evidence', () => {
  assert.deepEqual(masteryView({ state: 'insufficient_evidence', pMastery: 0.5, low: 0.1, high: 0.9 }), { label: 'Not enough evidence', level: 0, percent: null, range: null })
  const m = masteryView({ state: 'mastered', pMastery: 0.9, low: 0.8, high: 0.97 })
  assert.equal(m.label, 'Mastered')
  assert.equal(m.range, '80–97%')
})

test('plan helpers: today, week, missed minutes, countdown', () => {
  const tasks: PlanTask[] = [
    { date: '2026-11-16', conceptId: 'a', conceptName: 'A', kind: 'learn', minutes: 30 },
    { date: '2026-11-17', conceptId: '*', conceptName: 'Spaced revision', kind: 'review', minutes: 10 },
    { date: '2026-11-17', conceptId: 'a', conceptName: 'A', kind: 'practice', minutes: 15 },
    { date: '2026-11-17', conceptId: 'b', conceptName: 'B', kind: 'learn', minutes: 20 },
    { date: '2026-11-17', conceptId: 'c', conceptName: 'C', kind: 'learn', minutes: 20 },
  ]
  assert.equal(todaysTasks({ tasks }, '2026-11-17').length, 3)
  const w = weekOf(tasks, '2026-11-16')
  assert.equal(w.length, 7)
  assert.equal(w[1]!.minutes, 65)
  assert.equal(w[6]!.date, '2026-11-22')
  assert.equal(missedMinutes(tasks, '2026-11-17', new Set()), 30)
  assert.equal(missedMinutes(tasks, '2026-11-17', new Set([taskKey(tasks[0]!)])), 0)
  const now = new Date(2026, 10, 17, 22, 0)
  assert.equal(daysUntil('2026-11-27', now), 10)
  assert.equal(countdownText(1), 'Exam is tomorrow')
  assert.equal(countdownText(-2), 'Exam date has passed')
})

test('uploads: type and size checks', () => {
  assert.deepEqual(checkUpload('Notes.PDF', 1000, ''), { mime: 'application/pdf' })
  assert.ok('error' in checkUpload('virus.exe', 10, ''))
  assert.ok('error' in checkUpload('big.pdf', 51 * 1024 * 1024, 'application/pdf'))
  assert.ok('error' in checkUpload('empty.txt', 0, 'text/plain'))
})

test('server stream shape: start event and per-segment progress deltas', async () => {
  const { DraftText } = await import('../src/lib/sse.ts')
  assert.deepEqual(interpretTurnEvent({ event: 'message', data: '{"type":"start","move":"hint","hintLevel":2,"policyNote":null}' }), { kind: 'start', move: 'hint', hintLevel: 2, policyNote: null })
  const d = new DraftText()
  for (const data of ['{"type":"progress","index":0,"delta":"What do"}', '{"type":"progress","index":0,"delta":" you know?"}', '{"type":"progress","index":1,"delta":"Try x=2."}']) {
    const r = interpretTurnEvent({ event: 'message', data })
    assert.equal(r.kind, 'progress')
    if (r.kind === 'progress') d.add(r)
  }
  assert.equal(d.toString(), 'What do you know?\n\nTry x=2.')
  assert.equal(isEndpointMissing(toApiError(503, { error: { code: 'materials_unavailable', message: 'x' } })), true)
})

test('history: stored turns rebuild the transcript; legacy/garbled tutor turns degrade safely', () => {
  const e = historyEntries([
    { role: 'student', content: 'is it 42?' },
    { role: 'tutor', content: 'x', move: 'hint', hintLevel: 2, segments: [{ text: 'See page 2', source: 'course', citations: [{ chunkId: 'c', documentId: 'd', filename: 'n.pdf', pageStart: 2, pageEnd: 2, trust: 'verified_course' }] }] },
    { role: 'tutor', content: 'old reply', move: 'explain', hintLevel: 0, segments: [{ text: 'cited by bare id', source: 'course', citations: ['chunk-1'] }] },
    { role: 'tutor', content: 'plain only', move: 'ask', segments: null },
    { role: 'system', content: 'ignored' }, null,
  ])
  assert.equal(e.length, 4)
  assert.deepEqual(e[0], { role: 'student', text: 'is it 42?' })
  const t = e[1]!.role === 'tutor' ? e[1]!.turn : null
  assert.equal(t!.move, 'hint'); assert.equal(t!.hintLevel, 2); assert.equal(t!.segments[0]!.citations[0]!.pageStart, 2)
  assert.equal(e[2]!.role === 'tutor' && e[2]!.turn.segments[0]!.source, 'uncertain', 'legacy bare-id citations are not shown as course material')
  assert.equal(e[3]!.role === 'tutor' && e[3]!.turn.segments[0]!.text, 'plain only')
})

test('session titles', () => {
  assert.equal(sessionTitle({ conceptName: 'Limits', problem: 'Find  lim\nx->2' }), 'Limits — Find lim x->2')
  assert.equal(sessionTitle({ conceptName: null, problem: null }), 'General question')
  assert.ok(sessionTitle({ conceptName: null, problem: 'a'.repeat(200) }).endsWith('…'))
})

test('voice: speakable text, and voice choice by tutor language', async () => {
  const { speakable, pickVoice } = await import('../src/lib/voice.ts')
  assert.equal(speakable('**Note:** $x^2 = 9$ so x = 3, see [p. 2](http://a)'), 'Note: x squared equals 9 so x equals 3, see p. 2')
  assert.equal(speakable('a = F/m and 3/4'), 'a equals F/m and 3 over 4')
  const voices = [{ lang: 'en-US', name: 'US' }, { lang: 'hi-IN', name: 'Hindi', localService: true }, { lang: 'en-IN', name: 'India' }]
  assert.equal(pickVoice(voices, 'hi')!.name, 'Hindi')
  assert.equal(pickVoice(voices, 'hinglish')!.name, 'India')
  assert.equal(pickVoice([{ lang: 'en_GB', name: 'UK' }], 'en')!.name, 'UK')
  assert.equal(pickVoice([{ lang: 'fr-FR', name: 'FR' }], 'hi'), null)
})
