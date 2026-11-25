import { test } from 'node:test'
import assert from 'node:assert/strict'
import { arith, checkPractice, validateOutline } from '../src/courses/personal.ts'
import { choicesFor } from '../src/agent/graph/rules.ts'
import { concreteSubject, parseSlotAnswer, requiredSlots, statedDailyMinutes, subjectSwitch } from '../src/agent/profile.ts'

const now = new Date('2026-11-19T10:00:00Z')

test('syllabus drafts are validated: dedupe, plain text, prerequisites only to earlier topics, too-short rejected', () => {
  const v = validateOutline({ title: '**Geography** Class 9', topics: [
    { name: 'India: size and location', estMinutes: 40 }, { name: 'Physical features of India', prerequisites: [1] },
    { name: 'physical features of india' }, { name: 'Drainage', prerequisites: [5, 2] }, { name: 'Climate', estMinutes: 5000 },
  ] }, 'Geography')
  assert.equal(v.title, 'Geography Class 9')
  assert.deepEqual(v.topics.map((t) => t.name), ['India: size and location', 'Physical features of India', 'Drainage', 'Climate'])
  assert.deepEqual(v.topics[2]!.prerequisites, [2])
  assert.equal(v.topics[3]!.estMinutes, 300)
  assert.throws(() => validateOutline({ topics: [{ name: 'Only one' }] }, 'X'), /reliable syllabus/)
})

test('auto practice questions: MCQ key must be what its explanation supports; numeric needs a verifiable calculation', () => {
  const ok = checkPractice({ type: 'mcq', stem: 'Which river is the longest in India?', options: ['Ganga', 'Godavari', 'Narmada', 'Yamuna'], correct: 'Ganga', explanation: 'The Ganga is the longest river in India, about 2525 km.' }, [])
  assert.ok(ok.spec, ok.problems.join())
  const wrongKey = checkPractice({ type: 'mcq', stem: 'Which river is the longest in India?', options: ['Ganga', 'Godavari', 'Narmada', 'Yamuna'], correct: 'Godavari', explanation: 'The Ganga is the longest river in India.' }, [])
  assert.equal(wrongKey.spec, null)
  const namesDistractor = checkPractice({ type: 'mcq', stem: 'Which is the southernmost point of mainland India?', options: ['Kanyakumari', 'Indira Point', 'Chennai'], correct: 'Kanyakumari', explanation: 'Kanyakumari is the southernmost point of the mainland; Indira Point is in the islands.' }, [])
  assert.ok(namesDistractor.spec, 'a good explanation may mention distractors after the answer')
  assert.equal(checkPractice({ type: 'mcq', stem: 'Which is the southernmost point of mainland India?', options: ['Kanyakumari', 'Indira Point', 'Chennai'], correct: 'Indira Point', explanation: 'Kanyakumari is the southernmost point of the mainland; Indira Point is in the islands.' }, []).spec, null)
  assert.equal(checkPractice({ type: 'mcq', stem: 'Pick one of these values', options: ['1', '2'], correct: '1', explanation: 'It is 1' }, []).spec, null)
  assert.ok(checkPractice({ type: 'numeric', stem: 'A car covers 120 km in 2 hours. Speed in km/h?', value: 60, answerExpr: '120/2', explanation: 'Speed = distance/time = 60 km/h' }, []).spec)
  assert.equal(checkPractice({ type: 'numeric', stem: 'A car covers 120 km in 2 hours. Speed?', value: 60, answerExpr: '180/3', explanation: 'Speed is 60' }, []).spec, null, 'hidden numbers')
  assert.equal(checkPractice({ type: 'mcq', stem: 'Which river is the longest in India?', options: ['Ganga', 'Kaveri', 'Tapi'], correct: 'Ganga', explanation: 'Ganga is the longest river.' }, ['Which river is the longest in India?']).spec, null, 'duplicate')
})

test('before teaching, the material source is asked explicitly (three options, one tap each)', () => {
  assert.ok(requiredSlots({ courseId: 'c', objective: 'exam_prep' }).includes('material'))
  assert.ok(requiredSlots({ courseId: 'c', objective: 'class_prep' }).includes('material'))
  assert.ok(!requiredSlots({ courseId: 'c', objective: 'quick_explanation' }).includes('material'))
  const ch = choicesFor('material', 'en', [])
  assert.equal(ch.length, 3)
  assert.deepEqual(ch.map((c) => parseSlotAnswer('material', c, now).material), ['own', 'curriculum', 'ai'])
  assert.deepEqual(choicesFor('material', 'hinglish', []).map((c) => parseSlotAnswer('material', c, now).material), ['own', 'curriculum', 'ai'])
  assert.equal(parseSlotAnswer('material', 'NCERT se padhao', now).material, 'curriculum')
  assert.equal(parseSlotAnswer('depth', 'Standard', now).depth, 'standard')
})

test('a changed daily time stated in a sentence is understood without the model', () => {
  assert.equal(statedDailyMinutes('Actually I can only give 45 minutes a day.'), 45)
  assert.equal(statedDailyMinutes('roz 1.5 ghante padh sakta hoon'), 90)
  assert.equal(statedDailyMinutes('my exam has 45 minutes for part A'), null, 'not a daily time')
})

test('the course a message is about is decided by rule: switch to an enrolled course, or create one for a new subject', () => {
  const cs = [{ id: 'chem', title: 'Class 10 Chemistry (CBSE)' }, { id: 'maths', title: 'CBSE Class 10 Mathematics Exam Preparation' }]
  assert.deepEqual(subjectSwitch('Now I want to study Physics class 10 CBSE, the chapter Electricity', cs, 'maths'), { kind: 'new', subject: 'Physics class 10 CBSE' })
  assert.deepEqual(subjectSwitch('I want to revise Chemistry now', cs, 'maths'), { kind: 'existing', courseId: 'chem' })
  assert.equal(subjectSwitch('maths chapter 4 padhna hai', cs, 'maths'), null, 'already on it')
  assert.deepEqual(subjectSwitch('teach me Chemistry class 12', cs, 'maths'), { kind: 'new', subject: 'Chemistry class 12' }, 'a different class is a different course')
  assert.equal(subjectSwitch('what is the chemistry behind soap?', cs, 'maths'), null, 'a question is not a new goal')
  assert.deepEqual(subjectSwitch('I want to learn Excel for my job', cs, 'chem'), { kind: 'new', subject: 'Excel' })
})

test('maths questions: options written as maths are matched as written; fraction answers are understood', () => {
  const mcq = checkPractice({ type: 'mcq', stem: 'Which is the correct Pythagorean identity for any angle?', options: ['sin²θ + cos²θ = 1', 'sinθ + cosθ = 1', 'tan²θ = sec²θ + 1', 'sin²θ - cos²θ = 1'], correct: 'sin²θ + cos²θ = 1', explanation: 'The correct identity is sin²θ + cos²θ = 1. sinθ + cosθ = 1 is false, e.g. at 45 degrees.' }, [])
  assert.ok(mcq.spec, mcq.problems.join())
  const frac = checkPractice({ type: 'numeric', stem: 'Given tan A = 4/3, find sin A.', value: '4/5' as unknown as number, answerExpr: '4/5', explanation: 'Take BC = 4k, AB = 3k, so AC = 5k and sin A = 4/5 = 0.8.' }, [])
  assert.ok(frac.spec, frac.problems.join())
  assert.equal(arith('(24^2+7^2)'), 625)
  assert.equal(arith('alert(1)'), null)
})

test('a course is created only for a subject the student actually named', () => {
  assert.equal(concreteSubject('Comprehensive Self-Study Course for Conceptual Mastery of an Unspecified Subject', 'Another subject or skill'), false)
  assert.equal(concreteSubject('Any subject', 'koi aur subject'), false)
  assert.equal(concreteSubject('Organic Chemistry class 12', 'I want to learn organic chemistry'), true)
  assert.equal(concreteSubject('Python programming', 'python seekhna hai'), true)
  assert.equal(concreteSubject('Economics', 'help me with my homework'), false, 'not mentioned by the student')
})
