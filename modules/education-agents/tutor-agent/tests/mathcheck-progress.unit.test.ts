import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isNumeric, parseClaims, verifyClaims, type ClaimChecker } from '../src/mathcheck.ts'
import { buildProgress } from '../src/progress.ts'
import type { CitedSegment } from '../src/materials.ts'

const segs: CitedSegment[] = [
  { text: '(x+1)^2 expands to x^2+2x+1', source: 'general', citations: [] },
  { text: 'so 3*4 = 13', source: 'course', citations: [{ chunkId: 'c', documentId: 'd', filename: 'f', pageStart: 1, pageEnd: 1, locatorKind: 'page', trust: 'verified_course' }] },
  { text: 'tricky', source: 'general', citations: [] },
]
const engine = (verdicts: Record<string, string>, calls: string[] = []): ClaimChecker => ({
  async equivalent(a, b) {
    calls.push(`${a}|${b}`)
    const v = verdicts[`${a}|${b}`] ?? 'pass'
    if (v === 'throw') throw new Error('down')
    return { ok: v === 'pass', verdict: v, reason: v }
  },
})

test('claims are validated: real segment index, maths alphabet only, bounded count', () => {
  const c = parseClaims([
    { segment: 0, a: '(x+1)^2', b: 'x^2+2*x+1' }, { segment: 9, a: '1', b: '1' }, { segment: 1, a: '__import__("os")', b: '1' },
    { segment: 1, a: '3*4', b: '13' }, { segment: 'x', a: '1', b: '1' }, { segment: 0, a: '', b: '1' }, { segment: 2, a: 'a=b', b: '1' },
    { segment: 0, a: '1', b: '1' }, { segment: 0, a: '2', b: '2' }, { segment: 0, a: '3', b: '3' },
  ], segs.length)
  assert.deepEqual(c.map((x) => x.a), ['(x+1)^2', '3*4', '1', '2'])
  assert.deepEqual(parseClaims('nope', 3), [])
})

test('verified claims mark the segment; a counterexample relabels it uncertain and drops its citation', async () => {
  const r = await verifyClaims(engine({ '3*4|13': 'fail' }), segs, [{ segment: 0, a: '(x+1)^2', b: 'x^2+2*x+1', numeric: false }, { segment: 1, a: '3*4', b: '13', numeric: true }])
  assert.equal(r.segments[0]!.math, 'verified')
  assert.deepEqual([r.segments[1]!.source, r.segments[1]!.math, r.segments[1]!.citations.length], ['uncertain', 'failed', 0])
  assert.equal(r.segments[2]!.math, undefined)
  assert.deepEqual([r.verified, r.failed], [1, 1])
})

test('maths verification never blocks: no service, errors, timeouts and inconclusive results change nothing', async () => {
  const claims = [{ segment: 0, a: '1', b: '1', numeric: true }, { segment: 1, a: '2', b: '3', numeric: true }, { segment: 2, a: '4', b: '5', numeric: true }]
  assert.deepEqual((await verifyClaims(undefined, segs, claims)).segments, segs)
  const r = await verifyClaims(engine({ '1|1': 'unverified', '2|3': 'throw', '4|5': 'inconclusive' }), segs, claims)
  assert.deepEqual(r.segments, segs)
  assert.deepEqual([r.verified, r.failed], [0, 0])
})

test('a segment with one passing and one failing claim is treated as failed', async () => {
  const r = await verifyClaims(engine({ '2|3': 'fail' }), segs, [{ segment: 2, a: '1', b: '1', numeric: true }, { segment: 2, a: '2', b: '3', numeric: true }])
  assert.equal(r.segments[2]!.math, 'failed')
  assert.deepEqual([r.verified, r.failed], [0, 1])
})

test('symbolic claims can verify but never fail a segment (definitions like a = F/m are not identities)', async () => {
  // seen live: a correct "12 divided by 3 gives 4" segment was flagged because of a definition-style claim
  const claims = parseClaims([{ segment: 0, a: 'a', b: 'F/m' }, { segment: 1, a: 'F/m', b: '4' }, { segment: 2, a: '12/3', b: '4' }], 3)
  assert.deepEqual(claims.map((c) => c.numeric), [false, false, true])
  const r = await verifyClaims(engine({ 'a|F/m': 'fail', 'F/m|4': 'fail' }), segs, claims)
  assert.deepEqual(r.segments.map((s) => s.math ?? null), [null, null, 'verified'])
  assert.equal(r.segments[1]!.source, 'course', 'a correct, cited segment keeps its label')
  assert.deepEqual([r.verified, r.failed], [1, 0])
  assert.ok(isNumeric('sqrt(2)*pi/4') && isNumeric('(12+3)^2') && !isNumeric('2*x') && !isNumeric('m*a'))
})

test('progress aggregation: mastery per student/concept, practice, revision, flags', () => {
  const now = new Date('2026-11-17T12:00:00Z')
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000)
  const r = buildProgress({
    now,
    concepts: [{ id: 'c1', name: 'Limits' }, { id: 'c2', name: 'Derivatives' }],
    students: [{ userId: 'a', name: 'Asha', email: 'a@x' }, { userId: 'b', name: '', email: 'b@x' }, { userId: 'z', name: 'Zed', email: 'z@x' }],
    evidence: [
      ...[1, 2, 3, 4, 5].map((n) => ({ userId: 'a', conceptId: 'c1', e: { kind: 'practice' as const, outcome: 1, hintsUsed: 0, observedAt: day(n) } })),
      { userId: 'b', conceptId: 'c1', e: { kind: 'practice' as const, outcome: 0, hintsUsed: 0, observedAt: day(10) } },
    ],
    attempts: [
      { userId: 'a', conceptId: 'c1', outcome: 1, confidence: 'sure', at: day(1) },
      ...[1, 2, 3, 4].map((n) => ({ userId: 'b', conceptId: 'c1', outcome: 0, confidence: 'sure', at: day(9 + n) })),
    ],
    cards: [...[3, 4, 5, 6, 7].map((n) => ({ userId: 'b', dueAt: day(n) })), { userId: 'a', dueAt: day(-3) }],
  })
  const [a, b, z] = r.students
  assert.ok(a!.concepts.c1!.pMastery > b!.concepts.c1!.pMastery)
  assert.equal(a!.insufficient >= 1, true, 'no evidence on c2')
  assert.deepEqual([a!.practice.attempts, a!.practice.correctRate, a!.revision.due], [1, 1, 0])
  assert.deepEqual([b!.practice.correctRate, b!.practice.confidentWrong, b!.revision.overdue], [0, 4, 5])
  assert.ok(b!.flags.some((f) => /Inactive for 10 days/.test(f)))
  assert.ok(b!.flags.some((f) => /Practice accuracy 0%/.test(f)))
  assert.ok(b!.flags.some((f) => /5 revision cards overdue/.test(f)))
  assert.deepEqual(z!.flags, ['No learning activity yet'])
  assert.equal(z!.avgMastery, null)
  const c1 = r.concepts.find((c) => c.conceptId === 'c1')!
  assert.equal(c1.students.insufficient >= 1, true)
  assert.deepEqual([c1.practice.attempts, c1.practice.confidentWrong], [5, 4])
  assert.equal(r.concepts.find((c) => c.conceptId === 'c2')!.avgMastery, null)
})
