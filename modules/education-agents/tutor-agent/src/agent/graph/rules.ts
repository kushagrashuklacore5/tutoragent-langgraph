/**
 * The companion's fixed rules: pure constants and helpers used by the graph nodes (no I/O, unit-tested).
 * Every rule here came from a real failure of letting the model decide (see CLAUDE.md "Decided by RULE").
 */
import { missingRequired, type LearnerProfile, type Slot } from '../profile.ts'
import { SLOT_QUESTIONS, TEMPLATES, tpl } from '../prompts.ts'
import type { Card, ConvState, Message, Proposal, Workflow } from '../store.ts'

export type Lang = 'en' | 'hi' | 'hinglish'
export interface Usage { task: string; model: string; operationId: string; inputTokens: number; outputTokens: number }
export interface TurnResult { conversationId: string; messages: Message[]; state: PublicState }
export interface PublicState { phase: ConvState['phase']; pendingProposalId: string | null; appliedPlan: ConvState['appliedPlan']; nextSession: ConvState['nextSession']; workflow: Workflow | null; profileComplete: boolean; questionSet: ConvState['questionSet'] | null; sourceDoc: ConvState['sourceDoc'] | null }

export const STALE_WORKFLOW_MS = 2 * 60_000
/** tools whose result is a workspace the student asked for: opened automatically, not offered as a link */
export const AUTO_OPEN = new Set(['materials.open', 'studio.open', 'lesson.start', 'practice.start', 'assessment.self_test', 'revision.status', 'growth.summary', 'plan.show', 'package.build'])
export const UUID = /^[0-9a-f-]{36}$/i
export const norm = (x: string) => x.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
export interface PlanStep { name: string; tool: string; args?: Record<string, unknown>; optional?: boolean }
/** exam goals add past-paper evidence and a starting-point check; optional steps may be skipped, never fail the plan */
export function planningSteps(profile: LearnerProfile): PlanStep[] {
  const exam = profile.objective === 'exam_prep' || (!!profile.examDate && profile.examDate !== 'none')
  return [
    { name: 'Reading your course syllabus', tool: 'curriculum.syllabus' },
    ...(exam ? [{ name: 'Checking past and sample papers', tool: 'exam.insights', optional: true }] : []),
    { name: 'Checking what you already know', tool: 'mastery.analyse' },
    { name: 'Drafting your roadmap', tool: 'plan.propose' },
    ...(exam ? [{ name: 'Preparing a short starting-point check', tool: 'assessment.self_test', args: { purpose: 'diagnostic' }, optional: true }] : []),
  ]
}
export const APPLY_STEPS = ['Saving your plan', 'Scheduling milestones and checkpoints', 'Preparing your next session']

export const withoutLinks = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null, (k, x) => (k === 'href' ? undefined : x)))

/** Never more than one question per reply: keep the text up to the first question mark. */
export function oneQuestion(text: string): string {
  const i = text.indexOf('?')
  return i >= 0 && text.indexOf('?', i + 1) >= 0 ? text.slice(0, i + 1).trim() : text
}

export const publicState = (s: ConvState, profile: LearnerProfile): PublicState => ({
  phase: s.phase, pendingProposalId: s.phase === 'awaiting_approval' ? s.proposal?.id ?? null : null, appliedPlan: s.appliedPlan, nextSession: s.nextSession, workflow: s.workflow, profileComplete: missingRequired(profile).length === 0, questionSet: s.questionSet ?? null, sourceDoc: s.sourceDoc ?? null,
})

export const proposalCard = (pr: Proposal): Card => {
  const { plan: _plan, ...roadmap } = pr.roadmap
  return { type: 'plan_proposal', proposal: { id: pr.id, courseId: pr.courseId, courseTitle: pr.courseTitle, inputs: pr.inputs, roadmap, strategy: pr.strategy, examEvidence: pr.examEvidence } }
}


/** Deterministic reply when the model is unavailable or not needed. */
export function fallbackText(lang: Lang, ctx: { proposal?: Proposal | null; applied?: { milestones: number; checkpoints: number; today: string } | null; question?: Slot | null; failedStep?: string | null; draft?: string | null }): string {
    if (ctx.applied) return tpl(TEMPLATES.applied[lang], ctx.applied)
    if (ctx.proposal) {
      const r = ctx.proposal.roadmap
      const verdict = tpl(TEMPLATES.verdict[r.feasibility][lang], { suggest: r.suggestedDailyMinutes ?? '' })
      return tpl(TEMPLATES.proposal[lang], { course: ctx.proposal.courseTitle, verdict, first: r.milestones[0]?.title ?? '-', due: r.milestones[0]?.due ?? '-' })
    }
    if (ctx.failedStep) return tpl(TEMPLATES.planningFailed[lang], { step: ctx.failedStep })
    const q = ctx.question ? SLOT_QUESTIONS[ctx.question][lang] : ''
    return [ctx.draft ?? (q ? '' : TEMPLATES.aiDown[lang]), q].filter(Boolean).join(' ')
  }

/** One-tap answers for questions with a fixed set of answers (the parsers understand these exact labels). */
export function choicesFor(slot: Slot, lang: 'en' | 'hi' | 'hinglish', courses: { title: string }[]): string[] {
  const hi = lang !== 'en'
  switch (slot) {
    case 'material': return hi ? ['Main apne notes / PDF upload karunga', 'NCERT / course syllabus se', 'AI notes taiyaar kare'] : ['I will upload my notes / PDF', 'Use NCERT / my course syllabus', 'Prepare AI notes for me']
    case 'depth': return hi ? ['Quick overview', 'Standard', 'Deep — full detail'] : ['Quick overview', 'Standard', 'Deep — full detail']
    case 'objective': return hi ? ['Concepts samajhna', 'Exam ki taiyaari', 'Practical skills', 'General learning'] : ['Understand the concepts', 'Prepare for an exam', 'Practical skills', 'General learning']
    case 'dailyMinutes': return hi ? ['30 minutes roz', '45 minutes roz', '1 hour roz', '2 hours roz'] : ['30 minutes a day', '45 minutes a day', '1 hour a day', '2 hours a day']
    case 'courseId': return [...courses.slice(0, 5).map((c) => c.title), hi ? 'Koi aur subject' : 'Another subject or skill']
    default: return []
  }
}

export interface BookContext { bookId: string; pageNo: number; blockId?: string | null; selection?: string | null }
/** intents that, while reading, are doubts about the page */
export const BOOK_INTENTS = new Set<string>(['question', 'other', 'learn_topic', 'smalltalk', 'find_material'])
/** tools that mean "leave the book" (practice, tests, revision, progress, planning, a new course) */
export const BOOK_EXITS = new Set(['practice.start', 'assessment.self_test', 'revision.status', 'growth.summary', 'learning.observe', 'plan.show', 'course.create', 'materials.open', 'progress.summary', 'assessments.list'])

/** a message that actually talks about which material to use */
/**
 * A reply about a plan may only state what the plan says. Rejects invented durations, any percentage (mastery is never
 * claimed from a plan) and claims of checks that did not happen; the caller then uses the factual template.
 */
export function planClaimsOk(reply: string, r: { requiredMinutes: number; availableMinutes: number; dailyMinutes: number; effectiveDailyMinutes: number; horizon: { days: number; totalMinutes?: number | null } }): boolean {
  if (/\d\s*(%|percent|प्रतिशत)/i.test(reply)) return false
  if (/\b(checked|assessed|evaluated|reviewed|analy[sz]ed)\s+(your\s+)?(past|prior|previous|existing)\s+(knowledge|learning)|\bdiagnostic\s+(is\s+|was\s+)?(done|complete|completed|finished)/i.test(reply)) return false
  const minutes = [r.requiredMinutes, r.availableMinutes, r.dailyMinutes, r.effectiveDailyMinutes, r.horizon.totalMinutes ?? r.availableMinutes]
  for (const m of reply.matchAll(/(\d+(?:\.\d+)?)\s*-?\s*(hours?|hrs?|ghant[ae]|घंटे|घंटा|minutes?|mins?|मिनट|days?|din|दिन)\b/gi)) {
    const n = Number(m[1]), unit = m[2]!.toLowerCase()
    if (/^(day|din|दिन)/.test(unit)) { if (n !== r.horizon.days) return false; continue }
    const v = /^(min|मिनट)/.test(unit) ? n : n * 60
    if (!minutes.some((x) => Math.abs(x - v) <= 6)) return false
  }
  return true
}

export const MATERIAL_WORDS = /(upload|notes|pdf|\bphotos?\b|ncert|textbook|text book|syllabus|curriculum|material|kitab|book\b|\bai\b|prepare (it|them|notes)|banao|bana do|you prepare|aap bana)/i

/** "ok", "go ahead", "start", "approved": consent to proceed with what is already prepared (never interpreted further) */
export const GO_AHEAD_RE = /^\s*(?:(?:ok(?:ay)?|okk+|yes|yep|sure|go|ahead|on|proceed|start|learning|teaching|let'?s|begin|do|it|draft|and|the|plan|approved?|haan|ha|theek|hai|chalo|shuru|karo|please|pls|now|fine|great|sounds|good)[\s,.!]*)+$/i
export const CONTINUE_RE = /^\s*(continue|resume|go on|carry on|next|let'?s continue|continue (the )?(lesson|book|reading)|aage( badho| chalo| padhao)?|chalo|shuru karo|जारी रखें|आगे)\s*[.!]*\s*$/i
export const LANGUAGE_WORDS = /(hindi|english|hinglish|हिंदी|हिन्दी|अंग्रेज़ी|angrezi)/i

/** research tools allowed while the goal/material/plan are being settled (nothing is opened or started) */
export const SETUP_TOOLS = new Set(['course.create', 'curriculum.syllabus', 'materials.search', 'exam.insights', 'mastery.analyse'])
/** the student asked to open/start something now (otherwise a workspace is offered as a button, never opened) */
export const EXPLICIT_OPEN = /(open|start|begin|show|take me|let'?s go|quiz|test me|practi[cs]e|revise|revision|teach|padhao|padha do|kholo|khol do|shuru|chalu|dikhao|samjhao|sikhao)/i
export const UPLOAD_ASK = {
  en: 'Please attach your PDF or notes with the 📎 button below. I will read it, use its examples and exercises, and then make your plan.',
  hinglish: 'Apni PDF ya notes neeche 📎 button se attach kijiye. Main use padhkar, uske examples aur exercises lekar aapka plan banaunga.',
  hi: 'कृपया अपनी PDF या नोट्स नीचे 📎 बटन से जोड़ें। मैं उसे पढ़कर, उसके उदाहरण और अभ्यास प्रश्न लेकर आपकी योजना बनाऊँगा।',
} as const
export const UPLOAD_ACK = { en: 'Great, we will learn from your own material.', hinglish: 'Badhiya, hum aapke apne material se padhenge.', hi: 'बढ़िया, हम आपकी अपनी सामग्री से पढ़ेंगे।' } as const
export const ANOTHER_RE = /^\s*(another subject or skill|koi aur subject|another subject|something else|kuch aur)\s*[.!]?\s*$/i
export const SUBJECT_ASK = {
  en: 'Sure. Which subject or skill would you like to learn? For example: Physics class 11, Python, Excel, Accountancy, Spoken English.',
  hinglish: 'Zaroor. Aap kaun sa subject ya skill seekhna chahte hain? Jaise: Physics class 11, Python, Excel, Accountancy, Spoken English.',
  hi: 'ज़रूर। आप कौन सा विषय या कौशल सीखना चाहते हैं? जैसे: भौतिकी कक्षा 11, Python, Excel, लेखाशास्त्र, बोलचाल की अंग्रेज़ी।',
} as const

export const ALL_LABEL = { en: 'The complete material', hinglish: 'Poora material', hi: 'पूरी सामग्री' } as const
export const ALL_RE = /(complete|whole|entire|all of it|everything|poora|pura|sab|सब|पूरी|full material)/i
/** outside the scope question a scope change must be unmistakable ("I completed it" is not "the complete material") */
const WHOLE_SCOPE_RE = /\b(complete|whole|entire|full)\s+(material|document|notes|roadmap|plan|file)\b|\ball\s+(of\s+)?(the\s+)?(\w+\s+)?(sections|topics|chapters)\b|\b(poora|pura)\s+material\b/i
const ONLY_RE = /\b(only|just|sirf|focus on)\b/i
/** Which part of an uploaded document the student chose. A rule: a model's topic must never narrow the plan (live failure). */
export function documentScope(msg: string, concepts: { name: string }[], justAsked: boolean): string | null {
  const m = norm(msg)
  if (!msg.trim()) return null
  if (justAsked ? ALL_RE.test(msg) : WHOLE_SCOPE_RE.test(msg)) return 'the complete material'
  if (!justAsked && !ONLY_RE.test(msg)) return null
  return concepts.find((x) => m.includes(norm(x.name)) || (justAsked && !!m && norm(x.name).includes(m)))?.name ?? null
}
export const SCOPE_ASK = { en: 'Do you want to study the complete material, or a particular section?', hinglish: 'Kya aap poora material padhna chahte hain, ya koi ek section?', hi: 'क्या आप पूरी सामग्री पढ़ना चाहते हैं, या कोई एक भाग?' } as const
