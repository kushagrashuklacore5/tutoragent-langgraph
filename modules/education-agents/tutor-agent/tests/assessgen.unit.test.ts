import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkCandidate, type Candidate } from '../src/assessgen.ts'

const hit = { chunkId: 'h1', documentId: 'd', documentVersion: 1, filename: 'mech.pdf', trust: 'verified_course', locatorKind: 'page', pageStart: 2, pageEnd: 2, charStart: 0, charEnd: 1, score: 1, vectorSimilarity: 1, keywordRank: 1,
  text: 'The net force on a body equals its mass times its acceleration: F = m a. Rearranging, the acceleration produced is a = F / m. Doubling the mass halves the acceleration.' }
const base = { types: ['mcq', 'numeric', 'descriptive'] as never[], hits: [hit], existing: ['What is the acceleration of a 2 kg cart pushed with 10 N?'], accepted: [] }
const rubric = [{ id: 'c1', criterion: 'Uses a = F/m', points: 2, keyPoints: ['a = F/m'] }, { id: 'c2', criterion: 'Compares masses', points: 2, keyPoints: ['larger mass, smaller acceleration'] }]

test('transfer questions are judged on grounded reasoning, not on the new context in their stem (live regression)', () => {
  const c: Candidate = { type: 'descriptive', cognitive: 'transfer', difficulty: 0.6, sourceIds: ['h1'], learningObjective: 'Apply a = F/m',
    stem: 'Two vehicles, a 1200 kg car and a 3000 kg truck, are each pushed forward by a 6000 N horizontal force. Explain why their accelerations are different.',
    explanation: 'The acceleration produced is a = F / m, so with the same net force the larger mass has the smaller acceleration; doubling the mass halves the acceleration.',
    modelAnswer: 'Since acceleration equals force divided by mass, the truck with more mass gets a smaller acceleration than the car.', rubric }
  assert.deepEqual(checkCandidate(c, base).problems, [])
})

test('ungrounded, duplicate, hidden-constant and malformed candidates are rejected with reasons', () => {
  const ungrounded: Candidate = { type: 'mcq', cognitive: 'recall', difficulty: 0.2, sourceIds: ['h1'], learningObjective: 'x', stem: 'Which planet is the largest in our solar system today?', explanation: 'Jupiter is the largest planet.', options: ['Jupiter', 'Mars', 'Venus', 'Earth'], correct: ['Jupiter'] }
  assert.match(checkCandidate(ungrounded, base).problems.join(), /not supported/)
  const dup: Candidate = { type: 'numeric', cognitive: 'apply', difficulty: 0.4, sourceIds: ['h1'], learningObjective: 'x', stem: 'What is the acceleration of a 2 kg cart pushed with 10 N?', explanation: 'a = F / m gives the acceleration produced.', value: 5, tolerance: 0, answerExpr: '10/2' }
  assert.match(checkCandidate(dup, base).problems.join(), /near-duplicate/)
  const hidden: Candidate = { ...dup, stem: 'A cart of mass 4 kg accelerates under a net force of 12 N on a ramp. Find its acceleration.', value: 2.45, answerExpr: '12/4*9.8/12' }
  assert.match(checkCandidate(hidden, base).problems.join(), /not in the question \(9\.8\)/)
  const noKey: Candidate = { ...dup, stem: 'A different cart of mass 3 kg accelerates under 9 N. Find a.', value: undefined, answerExpr: '9/3' }
  assert.match(checkCandidate(noKey, base).problems.join(), /incomplete answer key/)
  const allAbove: Candidate = { ...ungrounded, explanation: 'The acceleration produced is a = F / m.', stem: 'Which describes Newton second law for the acceleration of a body?', options: ['a = F/m', 'a = m/F', 'a = F m', 'All of the above'], correct: ['a = F/m'] }
  assert.match(checkCandidate(allAbove, base).problems.join(), /all\/none of the above/)
})
