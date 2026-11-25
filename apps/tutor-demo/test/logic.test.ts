import { test } from 'node:test'
import assert from 'node:assert/strict'
import { destinationFor, isDemoIdentity, journey, mathParts, sessionExpiry, sessionUsable } from '../src/lib/logic.ts'

const ID = '5483d16a-77c6-475e-843b-d9081bff0c91'

test('Tutor links open the matching demo workspace; anything else is reported, never guessed', () => {
  assert.deepEqual(destinationFor(`/studio/${ID}`), { view: 'notebook', bookId: ID })
  assert.deepEqual(destinationFor(`/practice/${ID}?conceptId=abc`), { view: 'practice', courseId: ID, conceptId: 'abc' })
  assert.deepEqual(destinationFor(`/app/education/tutor/courses/${ID}/tutor?conceptId=abc`), { view: 'notebook', courseId: ID, conceptId: 'abc' })
  assert.deepEqual(destinationFor(`/app/education/tutor/courses/${ID}/materials`), { view: 'document' })
  assert.deepEqual(destinationFor('/growth'), { view: 'progress' })
  assert.equal(destinationFor(`/app/education/tutor/courses/${ID}/assessments`), null)
  assert.equal(destinationFor('https://evil.example/x'), null)
})

test('maths notation renders as parts without touching ordinary words', () => {
  assert.deepEqual(mathParts('x^2 + 3x'), [{ kind: 'text', value: 'x' }, { kind: 'sup', value: '2' }, { kind: 'text', value: ' + 3x' }])
  assert.deepEqual(mathParts('x_1'), [{ kind: 'text', value: 'x' }, { kind: 'sub', value: '1' }])
  assert.equal(mathParts('sqrt(9)')[0]!.value, '√(9)')
  assert.deepEqual(mathParts('snake_case word'), [{ kind: 'text', value: 'snake_case word' }])
})

test('destructive actions and sessions are bound to the demo identity and a short lifetime', () => {
  assert.ok(isDemoIdentity('Demo.Visitor@demo.test'))
  assert.ok(!isDemoIdentity('riya.student@demo.test'))
  assert.ok(!isDemoIdentity(undefined))
  const now = 1_000_000
  assert.equal(sessionExpiry(new Date(now + 24 * 3_600_000).toISOString(), now), now + 3_600_000, 'capped at one hour')
  assert.equal(sessionExpiry(new Date(now + 60_000).toISOString(), now), now + 60_000, 'never outlives the server session')
  assert.ok(sessionUsable({ token: 't', expiresAt: now + 60_000 }, now))
  assert.ok(!sessionUsable({ token: 't', expiresAt: now + 1_000 }, now))
  assert.ok(!sessionUsable(null, now))
})

test('the journey comes only from real state: nothing is marked done without evidence', () => {
  const empty = journey({ phase: 'onboarding', hasPlan: false, hasBook: false, evidence: 0, dueCards: 0 })
  assert.deepEqual(empty.map((s) => s.state), ['current', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming'])
  const planned = journey({ objective: 'general', material: 'own', sourceTitle: 'Notes', phase: 'active', hasPlan: true, hasBook: true, evidence: 0, dueCards: 2 })
  assert.deepEqual(planned.map((s) => s.state), ['done', 'done', 'done', 'done', 'current', 'upcoming'])
  assert.equal(planned[1]!.detail, 'Notes')
  assert.equal(planned[5]!.detail, '2 cards due')
})

test('intake: the first lesson opens with Vidya teaching; answers are sent once, custom words kept, blanks left out', async () => {
  const { intakePayload, visibleQuestions, CUSTOM } = await import('../src/lib/logic.ts')
  assert.deepEqual(destinationFor(`/studio/${ID}?teach=1`), { view: 'notebook', bookId: ID, teach: true })
  const qs = [
    { slot: 'level', label: 'Level', options: [{ value: 'class_11_12', label: 'Class 11–12' }], default: null, required: false, allowCustom: true },
    { slot: 'objective', label: 'Goal', options: [{ value: 'concepts', label: 'Understand' }, { value: 'exam', label: 'Exam' }], default: 'concepts', required: false, allowCustom: true },
    { slot: 'dailyMinutes', label: 'Time', options: [{ value: 'm60', label: '1 hour a day' }], default: 'm60', required: false, allowCustom: false, showIf: { slot: 'objective', in: ['exam'] } },
    { slot: 'material', label: 'From', options: [{ value: 'ai', label: 'Vidya' }], default: null, required: true, allowCustom: false },
  ]
  assert.deepEqual(visibleQuestions(qs, { objective: 'concepts' }).map((q) => q.slot), ['level', 'objective', 'material'])
  const p = intakePayload(qs, { level: CUSTOM, objective: 'exam', dailyMinutes: 'm60' }, { level: '  12th class ' })
  assert.deepEqual(p.answers, { level: '12th class', objective: 'exam', dailyMinutes: 'm60' })
  assert.deepEqual(p.missing, ['material'])
  assert.equal(p.summary, '12th class · Exam · 1 hour a day')
})
