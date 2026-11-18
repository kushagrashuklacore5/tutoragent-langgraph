/**
 * Teaching strategy and learner observation (pure, deterministic, unit-tested).
 * - `chooseStrategy` picks how to teach from the goal, the time left and what the evidence shows; it can switch.
 * - `observe` turns stored evidence into FINDINGS, each with the evidence behind it, a sample size and a confidence.
 *   Findings describe learning behaviour only (never psychological or medical states).
 * - `adapt` maps findings to concrete adjustments; the orchestrator may phrase them, never decide them.
 */
import type { ConceptProfile } from './insight.ts'

export type StrategyName = 'exam_sprint' | 'exam_prep' | 'concept_mastery' | 'skill_building' | 'interview_prep' | 'exploration'
export interface Strategy {
  name: StrategyName
  label: string
  /** share of study time per activity */
  mix: { learn: number; practice: number; retrieval: number; timed: number; teachBack: number }
  /** first hint level offered when stuck (1 = "what do you know?") */
  hintStart: number
  assessments: string[]
  reasons: string[]
}

const S: Record<StrategyName, Omit<Strategy, 'name' | 'reasons'>> = {
  exam_sprint: { label: 'Exam sprint', mix: { learn: 0.25, practice: 0.3, retrieval: 0.2, timed: 0.25, teachBack: 0 }, hintStart: 2, assessments: ['diagnostic now', 'topic practice daily', 'pattern-aligned paper mid-way', 'full mock 1-2 days before'] },
  exam_prep: { label: 'Exam preparation', mix: { learn: 0.35, practice: 0.3, retrieval: 0.2, timed: 0.1, teachBack: 0.05 }, hintStart: 1, assessments: ['diagnostic', 'weekly topic papers', 'mock in the final week'] },
  concept_mastery: { label: 'Deep understanding', mix: { learn: 0.35, practice: 0.25, retrieval: 0.15, timed: 0, teachBack: 0.25 }, hintStart: 1, assessments: ['diagnostic', 'transfer questions after each concept', 'delayed checks after 2-4 weeks'] },
  skill_building: { label: 'Hands-on skill building', mix: { learn: 0.2, practice: 0.55, retrieval: 0.1, timed: 0, teachBack: 0.15 }, hintStart: 1, assessments: ['task-based checks', 'progressively harder problems'] },
  interview_prep: { label: 'Interview preparation', mix: { learn: 0.2, practice: 0.35, retrieval: 0.2, timed: 0.15, teachBack: 0.1 }, hintStart: 2, assessments: ['concept + application questions', 'timed mock rounds', 'explain-aloud answers'] },
  exploration: { label: 'Guided exploration', mix: { learn: 0.45, practice: 0.25, retrieval: 0.15, timed: 0, teachBack: 0.15 }, hintStart: 1, assessments: ['light checks', 'occasional retrieval practice'] },
}

export function chooseStrategy(o: { objective?: string; daysToExam: number | null; findings?: Finding[] }): Strategy {
  const reasons: string[] = []
  let name: StrategyName
  if (o.objective === 'exam_prep' || (o.daysToExam !== null && o.daysToExam <= 30 && o.objective !== 'interview_prep')) {
    name = o.daysToExam !== null && o.daysToExam <= 10 ? 'exam_sprint' : 'exam_prep'
    reasons.push(o.daysToExam !== null ? `exam in ${o.daysToExam} day(s)` : 'goal: exam preparation')
  } else if (o.objective === 'interview_prep') { name = 'interview_prep'; reasons.push('goal: interview preparation') }
  else if (o.objective === 'practical_skills' || o.objective === 'project') { name = 'skill_building'; reasons.push('goal: practical skills') }
  else if (o.objective === 'conceptual_mastery') { name = 'concept_mastery'; reasons.push('goal: deep understanding') }
  else { name = 'exploration'; reasons.push('no specific deadline or goal yet') }
  const s = { ...S[name], mix: { ...S[name].mix } }
  // evidence can shift the mix (never the goal): rote learning → more teach-back/transfer; guessing → more retrieval
  for (const f of o.findings ?? []) {
    if (f.kind === 'memorising_without_understanding' && f.confidence !== 'low') { s.mix.teachBack += 0.1; s.mix.timed = Math.max(0, s.mix.timed - 0.05); s.mix.practice = Math.max(0, s.mix.practice - 0.05); reasons.push(`more explain-it-back: ${f.title}`) }
    if (f.kind === 'repeated_guessing' && f.confidence !== 'low') { s.mix.retrieval += 0.05; s.mix.timed = Math.max(0, s.mix.timed - 0.05); reasons.push('fewer timed sets while answers are mostly guesses') }
  }
  const total = Object.values(s.mix).reduce((a, b) => a + b, 0)
  for (const k of Object.keys(s.mix) as (keyof Strategy['mix'])[]) s.mix[k] = Math.round((s.mix[k] / total) * 100) / 100
  return { name, ...s, reasons }
}

export type FindingKind = 'missing_prerequisite' | 'unclear_important_concept' | 'repeated_guessing' | 'memorising_without_understanding' | 'ready_to_progress' | 'strategy_ineffective' | 'forgetting' | 'hint_dependent' | 'overconfident'
export interface Finding { kind: FindingKind; conceptId: string | null; title: string; evidence: string; n: number; confidence: 'high' | 'medium' | 'low' }

export interface ObservationInput {
  concepts: { id: string; name: string; examWeight: number; prerequisites: string[] }[]
  profiles: ConceptProfile[]
  /** per concept: answers given with each confidence rating, and how many were correct */
  confidence: Map<string, { sure: number; sureRight: number; guess: number; guessRight: number; total: number }>
  /** per concept: familiar (practice) vs transfer/application correctness */
  application: Map<string, { familiarRight: number; familiar: number; transferRight: number; transfer: number }>
  /** per concept: lessons taken (tutor sessions / studio sections) and correctness on attempts AFTER the latest lesson */
  afterLessons: Map<string, { lessons: number; attemptsAfter: number; correctAfter: number }>
}

const conf = (n: number): Finding['confidence'] => (n >= 8 ? 'high' : n >= 4 ? 'medium' : 'low')
const pct = (x: number) => `${Math.round(x * 100)}%`

export function observe(o: ObservationInput): Finding[] {
  const byId = new Map(o.profiles.map((p) => [p.conceptId, p]))
  const name = (id: string) => o.concepts.find((c) => c.id === id)?.name ?? 'a topic'
  const out: Finding[] = []
  const maxW = Math.max(1, ...o.concepts.map((c) => c.examWeight))
  for (const c of o.concepts) {
    const p = byId.get(c.id)
    if (!p) continue
    const m = p.mastery
    // a weak prerequisite under a topic the student is struggling with
    if (m.state !== 'mastered' && m.evidenceCount >= 2 && m.pMastery < 0.5) {
      for (const pre of c.prerequisites) {
        const pp = byId.get(pre)
        if (pp && pp.mastery.evidenceCount > 0 && pp.mastery.pMastery < 0.5) out.push({ kind: 'missing_prerequisite', conceptId: pre, title: `${name(pre)} may be holding back ${c.name}`, evidence: `${name(pre)} at ${pct(pp.mastery.pMastery)} and ${c.name} at ${pct(m.pMastery)}`, n: pp.mastery.evidenceCount + m.evidenceCount, confidence: conf(Math.min(pp.mastery.evidenceCount, m.evidenceCount) * 2) })
      }
    }
    if (c.examWeight / maxW >= 0.6 && m.evidenceCount >= 3 && m.pMastery < 0.45) out.push({ kind: 'unclear_important_concept', conceptId: c.id, title: `${c.name} is important and still unclear`, evidence: `mastery ${pct(m.pMastery)} after ${m.evidenceCount} answers`, n: m.evidenceCount, confidence: conf(m.evidenceCount) })
    const cf = o.confidence.get(c.id)
    if (cf && cf.total >= 4 && cf.guess / cf.total >= 0.5) out.push({ kind: 'repeated_guessing', conceptId: c.id, title: `Many answers in ${c.name} are guesses`, evidence: `${cf.guess} of ${cf.total} answers marked "guessing"`, n: cf.total, confidence: conf(cf.total) })
    if (cf && cf.sure >= 3 && cf.sureRight / cf.sure < 0.6) out.push({ kind: 'overconfident', conceptId: c.id, title: `Confident answers in ${c.name} are often wrong`, evidence: `${cf.sure - cf.sureRight} of ${cf.sure} "sure" answers were wrong`, n: cf.sure, confidence: conf(cf.sure) })
    const ap = o.application.get(c.id)
    if (ap && ap.familiar >= 3 && ap.transfer >= 2 && ap.familiarRight / ap.familiar >= 0.75 && ap.transferRight / ap.transfer <= 0.4) out.push({ kind: 'memorising_without_understanding', conceptId: c.id, title: `${c.name}: familiar questions fine, new situations not yet`, evidence: `${pct(ap.familiarRight / ap.familiar)} on familiar vs ${pct(ap.transferRight / ap.transfer)} on transfer questions`, n: ap.familiar + ap.transfer, confidence: conf(ap.transfer * 2) })
    const al = o.afterLessons.get(c.id)
    if (al && al.lessons >= 2 && al.attemptsAfter >= 3 && al.correctAfter / al.attemptsAfter < 0.4) out.push({ kind: 'strategy_ineffective', conceptId: c.id, title: `Explanations of ${c.name} are not landing yet`, evidence: `${al.lessons} lessons, then ${al.correctAfter} of ${al.attemptsAfter} correct`, n: al.attemptsAfter, confidence: conf(al.attemptsAfter) })
    if ((p.hintDependency ?? 0) >= 0.6 && m.evidenceCount >= 4) out.push({ kind: 'hint_dependent', conceptId: c.id, title: `${c.name} mostly solved with hints`, evidence: `${pct(p.hintDependency!)} of correct answers used hints`, n: m.evidenceCount, confidence: conf(m.evidenceCount) })
    if (m.state === 'stale' || (p.forgettingRisk ?? 0) >= 0.7) out.push({ kind: 'forgetting', conceptId: c.id, title: `${c.name} is fading`, evidence: `no practice for a while (forgetting risk ${pct(p.forgettingRisk ?? 1)})`, n: m.evidenceCount, confidence: conf(m.evidenceCount) })
    if (m.state === 'mastered' && (p.transfer.attempted === 0 || p.transfer.passed / p.transfer.attempted >= 0.5)) out.push({ kind: 'ready_to_progress', conceptId: c.id, title: `Ready to move on from ${c.name}`, evidence: `mastered (${pct(m.pMastery)}, ${m.unassistedCorrect} correct without help)`, n: m.evidenceCount, confidence: conf(m.evidenceCount) })
  }
  const rank: Record<FindingKind, number> = { missing_prerequisite: 0, strategy_ineffective: 1, unclear_important_concept: 2, memorising_without_understanding: 3, overconfident: 4, repeated_guessing: 5, hint_dependent: 6, forgetting: 7, ready_to_progress: 8 }
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || (b.confidence === 'high' ? 1 : 0) - (a.confidence === 'high' ? 1 : 0))
}

export interface Adjustment { action: 'revise_prerequisite' | 'switch_explanation' | 'application_practice' | 'retrieval_without_choices' | 'calibration_practice' | 'reduce_hints' | 'schedule_review' | 'advance'; conceptId: string | null; why: string }

/** Deterministic adjustments from findings (low-confidence findings never change the plan, they are only shown). */
export function adapt(findings: Finding[]): Adjustment[] {
  const map: Record<FindingKind, Adjustment['action']> = {
    missing_prerequisite: 'revise_prerequisite', strategy_ineffective: 'switch_explanation', unclear_important_concept: 'switch_explanation',
    memorising_without_understanding: 'application_practice', repeated_guessing: 'retrieval_without_choices', overconfident: 'calibration_practice',
    hint_dependent: 'reduce_hints', forgetting: 'schedule_review', ready_to_progress: 'advance',
  }
  const seen = new Set<string>()
  const out: Adjustment[] = []
  for (const f of findings) {
    if (f.confidence === 'low') continue
    const key = `${map[f.kind]}:${f.conceptId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ action: map[f.kind], conceptId: f.conceptId, why: `${f.title} (${f.evidence})` })
  }
  return out.slice(0, 6)
}
