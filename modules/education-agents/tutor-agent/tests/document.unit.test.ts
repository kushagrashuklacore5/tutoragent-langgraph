import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groundOutline } from '../src/courses/document.ts'
import { concreteSubject, parseSlotAnswer } from '../src/agent/profile.ts'

const pages = ['Neanderthals. Homo neanderthalensis lived in Europe during the Ice Age.', 'Tools and culture: Mousterian stone tools, fire, burial of the dead.', 'Extinction about 40,000 years ago; interbreeding with Homo sapiens.']

test('document outline: only sections whose words/terms are in the document survive; pages are clipped', () => {
  const g = groundOutline({ subject: 'Neanderthals', title: 'Neanderthals', sections: [
    { name: 'Tools and culture', keyTerms: ['Mousterian', 'burial'], pageStart: 2, pageEnd: 9 },
    { name: 'Mastering effective note-taking', keyTerms: ['Cornell method', 'mind maps'] },
    { name: 'Quaternary megafauna', keyTerms: ['mammoth', 'cave bear'] },
    { name: 'Extinction', keyTerms: ['Homo sapiens', 'interbreeding'], pageStart: 3, pageEnd: 3 },
  ] }, pages)!
  assert.deepEqual(g.sections.map((s) => s.name), ['Tools and culture', 'Extinction'])
  assert.equal(g.sections[0]!.pageEnd, 3, 'page range clipped to the document')
  assert.deepEqual(g.sections[0]!.keyTerms, ['Mousterian', 'burial'])
})

test('document outline: nothing grounded → null (ask the student, never invent a syllabus)', () => {
  assert.equal(groundOutline({ subject: 'World history', sections: [{ name: 'Modern world history', keyTerms: ['treaty'] }] }, pages), null)
})

test('equations are kept exactly as written when they occur in the document', () => {
  const g = groundOutline({ subject: 'Trigonometry', sections: [{ name: 'Identities', keyTerms: ['sin^2 A + cos^2 A = 1'] }] }, ['Identities: sin^2 A + cos^2 A = 1 holds for all A.'])!
  assert.deepEqual(g.sections[0]!.keyTerms, ['sin^2 A + cos^2 A = 1'])
})

test('words about the material are never a subject; "I have notes" means own material', () => {
  assert.equal(concreteSubject('Mastering Effective Note-Taking', "I have notes but I don't know the topic"), false)
  assert.equal(concreteSubject('PDF reading skills', 'I will upload my pdf'), false)
  assert.equal(parseSlotAnswer('material', 'I have notes', new Date()).material, 'own')
})
