import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missingRequired, nextSlot, parseSlotAnswer, requiredSlots } from '../src/agent/profile.ts'
import { scopeToTopic } from '../src/agent/toolset.ts'
import { confidenceFor, recommend } from '../src/domain/insights.ts'
import type { PlanConcept } from '../src/domain/planner.ts'

const C = 'c0000000-0000-4000-8000-000000000001'
const pc = (id: string, name: string, prerequisites: string[] = [], mastered = false): PlanConcept => ({ id, name, estMinutes: 30, examWeight: 1, pMastery: mastered ? 0.9 : 0.2, mastered, prerequisites })

test('goal-specific follow-ups: class prep asks topic + depth, never an exam date or daily time', () => {
  const p = { courseId: C, objective: 'class_prep' as const }
  assert.deepEqual(requiredSlots(p), ['courseId', 'objective', 'topic', 'depth', 'material'])
  assert.equal(nextSlot(p, []), 'topic')
  assert.deepEqual(missingRequired({ ...p, topic: 'Moles', depth: 'overview' as const, material: 'curriculum' as const, materialFor: C }), [])
})

test('exam goal asks topic, exam date and daily time; quick explanation needs only the course', () => {
  assert.deepEqual(requiredSlots({ courseId: C, objective: 'exam_prep' }), ['courseId', 'objective', 'topic', 'examDate', 'dailyMinutes', 'material'])
  assert.deepEqual(requiredSlots({ courseId: C, objective: 'quick_explanation' }), ['courseId'])
})

test('material and depth answers parse deterministically', () => {
  assert.equal(parseSlotAnswer('material', 'I will upload my NCERT chapter', new Date()).material, 'own')
  assert.equal(parseSlotAnswer('depth', 'just a quick overview', new Date()).depth, 'overview')
})

test('roadmap is scoped to the asked topic plus unmastered prerequisites only', () => {
  const all = [pc('a', 'Atomic mass'), pc('b', 'Mole concept', ['a']), pc('c', 'Stoichiometry', ['b']), pc('d', 'Thermodynamics'), pc('e', 'Units', [], true)]
  all[1]!.prerequisites.push('e')
  const r = scopeToTopic(all, 'mole concept')
  assert.deepEqual(r.concepts.map((c) => c.id), ['a', 'b'])
  assert.match(r.note ?? '', /1 prerequisite/)
  const none = scopeToTopic(all, 'quantum chromodynamics')
  assert.equal(none.concepts.length, all.length)
  assert.match(none.note ?? '', /could not match/)
})

test('product insights: evidence, n and confidence on every recommendation; small samples stay quiet', () => {
  const recs = recommend([
    { area: 'tool', key: 'studio.open', events: 120, failures: 70, users: 40 },
    { area: 'tool', key: 'plan.show', events: 8, failures: 8, users: 6 },
    { area: 'conversations', key: 'all', events: 50, failures: 0, users: 30 },
    { area: 'stalled', key: 'onboarding', events: 15, failures: 15, users: 12 },
    { area: 'ai_error', key: 'auth', events: 3, failures: 3, users: 3 },
  ])
  assert.ok(recs.some((r) => r.area === 'AI service' && r.severity === 'high' && /key/.test(r.finding)))
  assert.ok(recs.some((r) => r.finding.includes('studio.open') && r.confidence === 'high' && r.n === 120))
  assert.ok(recs.some((r) => r.finding.includes('onboarding')))
  assert.ok(!recs.some((r) => r.finding.includes('plan.show')), 'below 10 calls: no claim')
  for (const r of recs) assert.ok(r.evidence && r.n > 0 && r.suggestion)
  assert.equal(confidenceFor(29), 'low')
})
