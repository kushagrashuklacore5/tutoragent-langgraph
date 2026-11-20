/**
 * Central companion orchestrator. One student message = one turn:
 *   1. persist the student's message (so nothing is lost if the turn is interrupted);
 *   2. deterministic pre-parse of a direct answer to the question just asked;
 *   3. DECIDE (one model call through the gateway): intent, stated profile values, doubts, requested tools, draft reply;
 *   4. code decides what actually happens: profile values validated (mergeProfile), tool requests validated and
 *      authorised by the executor, approval only from the student (button, or an explicit approval of the pending
 *      proposal), the planning workflow started by rules (goal known) and resumed if it failed before;
 *   5. COMPOSE (second model call, only when tools produced results) — deterministic templates if the model fails;
 *   6. persist reply, cards, session state and durable profile; usage (model, tokens, operation ids) on the message.
 * At most two model calls per turn; background workflows (jobs) make none.
 */
import { randomUUID } from 'node:crypto'
import { AppError, badRequest } from '@platform/core'
import type { ModuleDeps, Principal } from '@platform/contracts'
import type { Sql } from '@platform/tenancy-db'
import { applyDoubts, concreteSubject, statedDailyMinutes, subjectSwitch, askOrder, plannable, mergeProfile, missingRequired, nextSlot, parseSlotAnswer, PLAN_FIELDS, profileSummary, readyToPlan, type LearnerProfile, type Slot } from './profile.ts'
import { prepareSession } from './nudges.ts'
import { AGENT_PROMPT_VERSION, buildComposePrompt, buildDecidePrompt, COMPOSE_TASK, DECIDE_TASK, INTENTS, SLOT_QUESTIONS, TEMPLATES, tpl, type Intent } from './prompts.ts'
import { addMessage, createConversation, getConversation, initialState, latestConversation, listMessages, loadProfile, saveProfile, saveState, type Card, type ConvState, type Message, type Proposal, type Workflow } from './store.ts'
import { executeTool, type ToolOutcome, type ToolRegistry } from './tools.ts'
import { studioService } from '../studio/service.ts'
import { companionTools } from './toolset.ts'
import { courseScope } from '../materials.ts'
import { analyseDocument, describe } from '../courses/document.ts'
import { status } from './status.ts'
import { QUESTION_SET_JOB } from './job-names.ts'

type Lang = 'en' | 'hi' | 'hinglish'
interface Usage { task: string; model: string; operationId: string; inputTokens: number; outputTokens: number }
export interface TurnResult { conversationId: string; messages: Message[]; state: PublicState }
export interface PublicState { phase: ConvState['phase']; pendingProposalId: string | null; appliedPlan: ConvState['appliedPlan']; nextSession: ConvState['nextSession']; workflow: Workflow | null; profileComplete: boolean; questionSet: ConvState['questionSet'] | null; sourceDoc: ConvState['sourceDoc'] | null }

const STALE_WORKFLOW_MS = 2 * 60_000
/** tools whose result is a workspace the student asked for: opened automatically, not offered as a link */
const AUTO_OPEN = new Set(['materials.open', 'studio.open', 'lesson.start', 'practice.start', 'assessment.self_test', 'revision.status', 'growth.summary', 'plan.show', 'package.build'])
const UUID = /^[0-9a-f-]{36}$/i
const norm = (x: string) => x.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
interface PlanStep { name: string; tool: string; args?: Record<string, unknown>; optional?: boolean }
/** exam goals add past-paper evidence and a starting-point check; optional steps may be skipped, never fail the plan */
function planningSteps(profile: LearnerProfile): PlanStep[] {
  const exam = profile.objective === 'exam_prep' || (!!profile.examDate && profile.examDate !== 'none')
  return [
    { name: 'Reading your course syllabus', tool: 'curriculum.syllabus' },
    ...(exam ? [{ name: 'Checking past and sample papers', tool: 'exam.insights', optional: true }] : []),
    { name: 'Checking what you already know', tool: 'mastery.analyse' },
    { name: 'Drafting your roadmap', tool: 'plan.propose' },
    ...(exam ? [{ name: 'Preparing a short starting-point check', tool: 'assessment.self_test', args: { purpose: 'diagnostic' }, optional: true }] : []),
  ]
}
const APPLY_STEPS = ['Saving your plan', 'Scheduling milestones and checkpoints', 'Preparing your next session']

const withoutLinks = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null, (k, x) => (k === 'href' ? undefined : x)))

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

export function companion(d: ModuleDeps, tools: ToolRegistry = companionTools()) {
  const studio = studioService(d)
  const tx = <T>(p: Principal, fn: (t: Sql) => Promise<T>) => d.inTenant(p, fn)

  async function studentCourses(t: Sql): Promise<{ id: string; code: string; title: string }[]> {
    return (await t.query<{ id: string; code: string; title: string }>(
      `select c.id, c.code, c.title from education_tutor.courses c join education_tutor.enrolments e on e.course_id = c.id and e.user_id = platform.current_user_id() and e.role = 'student' order by c.code`)).rows
  }

  /** Load (or create) the conversation and profile; deterministic defaults (single course, language). */
  async function open(p: Principal, conversationId: string | undefined, language: Lang | undefined) {
    return tx(p, async (t) => {
      let conv = conversationId ? await getConversation(t, conversationId) : await latestConversation(t)
      if (conversationId && !conv) throw new AppError('not_found', 'Conversation not found', { status: 404 })
      if (!conv) { const id = await createConversation(t); conv = (await getConversation(t, id))! }
      const courses = await studentCourses(t)
      let profile = (await loadProfile(d, p, t)) ?? {}
      if (!profile.courseId && courses.length === 1) profile = { ...profile, courseId: courses[0]!.id }
      if (profile.courseId && !courses.some((c) => c.id === profile.courseId)) profile = { ...profile, courseId: courses.length === 1 ? courses[0]!.id : undefined }
      if (!profile.language && language) profile = { ...profile, language }
      return { conv, courses, profile }
    })
  }

  /** the latest READY document the student uploaded to this course (their own material) */
  async function ownDoc(p: Principal, courseId: string): Promise<{ id: string; title: string } | null> {
    if (!d.documents) return null
    try {
      const docs = (await d.documents.list(p, courseScope(courseId))).filter((x) => x.owner_user_id === p.userId && x.status === 'ready')
      const last = docs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]
      return last ? { id: last.id, title: last.filename.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ') } : null
    } catch { return null }
  }

  async function runPlanning(p: Principal, convId: string, state: ConvState, profile: LearnerProfile, now: Date): Promise<{ outcomes: ToolOutcome[]; proposal: Proposal | null; workflow: Workflow }> {
    const prev = state.workflow?.kind === 'planning' && state.workflow.status !== 'done' ? state.workflow : null
    const steps = planningSteps(profile)
    const wf: Workflow = prev && prev.steps.length === steps.length ? prev : { id: randomUUID(), kind: 'planning', status: 'running', steps: steps.map((s) => ({ name: s.name, status: 'pending' as const })), updatedAt: now.toISOString() }
    wf.status = 'running'
    const outcomes: ToolOutcome[] = []
    let proposal: Proposal | null = null
    for (const [i, s] of steps.entries()) {
      const step = wf.steps[i]!
      // resume: completed read steps are re-run cheaply only if we need their data (syllabus/mastery feed the explanation)
      step.status = 'running'
      const o = await executeTool(tools, { d, p, conversationId: convId, now }, s.tool, { courseId: profile.courseId, ...(s.args ?? {}) }, { origin: 'orchestrator' })
      outcomes.push(o)
      if (o.status !== 'ok' && s.optional) { step.status = 'skipped'; step.error = o.error?.code ?? o.status; continue }
      if (o.status !== 'ok') { step.status = 'failed'; step.error = o.error?.code ?? o.status; wf.status = 'failed'; break }
      step.status = 'done'
      delete step.error
      if (s.tool === 'plan.propose') proposal = o.result as Proposal
    }
    if (wf.status !== 'failed') wf.status = 'done'
    wf.updatedAt = new Date().toISOString()
    return { outcomes, proposal, workflow: wf }
  }

  async function applyApproved(p: Principal, convId: string, state: ConvState, profile: LearnerProfile, now: Date): Promise<{ outcome: ToolOutcome; workflow: Workflow; cards: Card[] }> {
    const pr = state.proposal
    if (!pr) throw badRequest('no_proposal', 'There is no plan waiting for approval')
    const wf: Workflow = { id: randomUUID(), kind: 'apply_plan', status: 'running', steps: APPLY_STEPS.map((name) => ({ name, status: 'pending' as const })), updatedAt: now.toISOString() }
    // approval comes from the student (button or explicit reply to THIS proposal); the stored proposal is applied, never model arguments
    const outcome = await executeTool(tools, { d, p, conversationId: convId, now }, 'plan.apply', { proposal: pr }, { origin: 'orchestrator', approved: true })
    const cards: Card[] = []
    if (outcome.status !== 'ok') {
      wf.status = 'failed'; wf.steps[0]!.status = 'failed'; wf.steps[0]!.error = outcome.error?.code ?? outcome.status
      return { outcome, workflow: wf, cards }
    }
    wf.steps[0]!.status = 'done'; wf.steps[1]!.status = 'done'
    const today = now.toISOString().slice(0, 10)
    const openDoubts = (profile.doubts ?? []).filter((x) => x.status === 'open')
    const due = await tx(p, async (t) => (await t.query<{ n: number }>(`select count(*)::int as n from education_tutor.cards where course_id = $1 and user_id = platform.current_user_id() and due_at <= now()`, [pr.courseId])).rows[0]!.n)
    const agenda = prepareSession({ today, courseId: pr.courseId, dueCards: due, tasks: pr.roadmap.plan.tasks.filter((x) => x.kind !== 'review') as never, checkpoints: pr.roadmap.checkpoints, openDoubts })
    state.nextSession = { ...agenda, courseId: pr.courseId }
    wf.steps[2]!.status = 'done'
    wf.status = 'done'
    wf.updatedAt = new Date().toISOString()
    const v = (outcome.result as { version: number }).version
    state.appliedPlan = { courseId: pr.courseId, version: v, proposalId: pr.id, appliedAt: now.toISOString() }
    state.phase = 'active'
    cards.push({ type: 'workflow', workflow: wf }, { type: 'agenda', agenda })
    // the plan's question set is built ONCE, in the background, from the student's document first
    const planConcepts = [...new Set(pr.roadmap.milestones.flatMap((m) => m.conceptIds))]
    if (planConcepts.length && state.sourceDoc?.courseId === pr.courseId) {
      await tx(p, (t) => d.enqueue(t, QUESTION_SET_JOB, { userId: p.userId, courseId: pr.courseId, conceptIds: planConcepts, documentId: state.sourceDoc?.courseId === pr.courseId ? state.sourceDoc.id : null }, { idempotencyKey: `qs:${p.userId}:${pr.courseId}:${v}:${now.getTime()}` })).catch(() => {})
      state.questionSet = { courseId: pr.courseId, total: planConcepts.length, done: 0, status: 'building', added: 0, fromDocument: 0 }
    }
    // approved → the journey starts by itself: the upload workspace (own material) or the book opens
    // the course's book already exists (e.g. opened while planning): continue in it instead of making another
    const reuse = state.activeBook && state.activeBook.courseId === pr.courseId ? state.activeBook : null
    const src = state.sourceDoc?.courseId === pr.courseId ? state.sourceDoc : null
    const begin = reuse ? null : profile.material === 'own' && !src
      ? await executeTool(tools, { d, p, conversationId: convId, now }, 'materials.open', { courseId: pr.courseId }, { origin: 'orchestrator' })
      : await executeTool(tools, { d, p, conversationId: convId, now }, 'studio.open', { courseId: pr.courseId, title: (src?.title ?? profile.topic ?? pr.courseTitle).slice(0, 160), ...(src ? { documentId: src.id } : {}) }, { origin: 'orchestrator' })
    if (reuse) cards.push({ type: 'links', links: [{ label: `Open the book: ${reuse.title}`, href: `/studio/${reuse.id}` }], auto: true })
    else if (begin?.status === 'ok') {
      const res = begin.result as { href: string; label: string; bookId?: string }
      if (res.bookId) state.activeBook = { id: res.bookId, title: profile.topic ?? pr.courseTitle, courseId: pr.courseId }
      cards.push({ type: 'links', links: [{ label: res.label, href: res.href }], auto: true })
    }
    return { outcome, workflow: wf, cards }
  }

  async function ai(p: Principal, task: string, messages: ReturnType<typeof buildDecidePrompt>, usage: Usage[]): Promise<Record<string, unknown> | null> {
    try {
      const r = await d.ai(p).run(task, { messages }, { promptVersion: AGENT_PROMPT_VERSION })
      usage.push({ task, model: r.route.modelId, operationId: r.operationId, inputTokens: r.usage.inputTokens ?? 0, outputTokens: r.usage.outputTokens ?? 0 })
      return (r.json ?? null) as Record<string, unknown> | null
    } catch {
      return null
    }
  }

  function fallbackText(lang: Lang, ctx: { proposal?: Proposal | null; applied?: { milestones: number; checkpoints: number; today: string } | null; question?: Slot | null; failedStep?: string | null; draft?: string | null }): string {
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

  async function turn(p: Principal, input: { conversationId?: string; message: string; language?: Lang; source?: 'text' | 'voice'; context?: BookContext; documentId?: string; documentTitle?: string }): Promise<TurnResult> {
    const now = new Date()
    const message = input.message.trim()
    if (!message || message.length > 4000) throw badRequest('invalid_message', 'message is required (max 4000 characters)')
    const { conv, courses, profile: loaded } = await open(p, input.conversationId, input.language)
    const concepts = loaded.courseId ? await tx(p, async (t) => (await t.query<{ id: string; name: string }>(`select id, name from education_tutor.concepts where course_id = $1 and status = 'approved' order by name limit 60`, [loaded.courseId])).rows) : []
    const convId = conv.id
    const state: ConvState = { ...initialState(), ...conv.state }
    const startVersion = conv.version
    const startPhase = conv.state.phase
    const history = await tx(p, async (t) => {
      const h = await listMessages(d, p, t, convId, 10)
      await addMessage(d, p, t, convId, { role: 'student', content: message, usage: { source: input.source ?? 'text' } })
      return h
    })
    const usage: Usage[] = []
    const allowedCourses = courses.map((c) => c.id)
    // the language picker in the chat is an explicit choice: it wins over the stored language
    let profile: LearnerProfile = input.language && input.language !== loaded.language ? { ...loaded, language: input.language } : loaded
    const before = JSON.stringify(PLAN_FIELDS.map((k) => profile[k]))

    // 2. deterministic answer to the question just asked
    // fields this message actually stated (a course switch keeps these, drops what was carried over)
    const stated = new Set<string>()
    if (state.lastAsked) { const a = parseSlotAnswer(state.lastAsked, message, now); Object.keys(a).forEach((k) => stated.add(k)); profile = mergeProfile(profile, a, now, allowedCourses).profile }
    // answer to "complete material or which section?" after a document summary
    if (state.lastAsked === 'topic' && state.sourceDoc?.courseId === profile.courseId) {
      const pick = ALL_RE.test(message) ? 'the complete material' : concepts.find((c) => norm(message).includes(norm(c.name)) || norm(c.name).includes(norm(message)))?.name
      if (pick) { profile = { ...profile, topic: pick }; stated.add('topic') }
    }
    // a material choice is understood even when the question was not the last one asked
    if (!profile.material && state.lastAsked !== 'material' && MATERIAL_WORDS.test(message)) { const a = parseSlotAnswer('material', message, now); if (a.material) { stated.add('material'); profile = mergeProfile(profile, a, now, allowedCourses).profile } }
    // a plan change stated in words is applied deterministically (live: the model missed "only 45 minutes a day")
    const dm = statedDailyMinutes(message)
    if (dm && dm !== profile.dailyMinutes) profile = mergeProfile(profile, { dailyMinutes: dm }, now, allowedCourses).profile
    const lang0: Lang = profile.language ?? input.language ?? 'en'

    // 3. DECIDE
    const ctx = {
      today: now.toISOString().slice(0, 10), courses: courses.map((c) => ({ id: c.id, code: c.code, title: c.title })), activeCourseId: profile.courseId ?? null, topics: concepts.map((c) => ({ id: c.id, name: c.name })),
      profile: profileSummary(profile), phase: state.phase, missingSlots: missingRequired(profile),
      pendingProposal: state.phase === 'awaiting_approval' && state.proposal ? { id: state.proposal.id, course: state.proposal.courseTitle, feasibility: state.proposal.roadmap.feasibility, milestones: state.proposal.roadmap.milestones.length, horizon: state.proposal.roadmap.horizon } : null,
      activePlan: state.appliedPlan, nextSession: state.nextSession?.items.map((i) => i.label) ?? null, currentTopic: state.topic?.name ?? null,
      tools: tools.catalog(),
      // the student is reading a book page: doubts about it are answered INSIDE the book (page-aware), not by a tool
      // setup = goal, material and plan are being settled: nothing can be opened yet, only asked/researched
      journeyStage: state.phase === 'active' ? 'following the approved plan' : 'setup: understand the goal and material, then the plan (do not say you opened or started anything)',
      inBook: input.context ? { pageNo: input.context.pageNo, selectedText: input.context.selection ? input.context.selection.slice(0, 300) : null } : null,
    }
    // "continue" with an active book is deterministic (live: the model read it as an answer to its last question)
    const resumeBook = !!state.activeBook && CONTINUE_RE.test(message)
    // "Another subject or skill": just ask which one (no model call, nothing created)
    const askSubject = ANOTHER_RE.test(message)
    // setup questions are only offered while setting up (live: an active plan got "how confident are you?")
    const pendingAsk = state.phase === 'onboarding' || missingRequired(profile).length ? askOrder(profile, state.asked) : []
    status(resumeBook ? 'Opening your book where you stopped…' : 'Thinking…')
    const decided = resumeBook || askSubject ? null : await ai(p, DECIDE_TASK, buildDecidePrompt({ today: ctx.today, language: lang0, context: ctx, askOrder: pendingAsk.map((slot) => ({ slot, ask: SLOT_QUESTIONS[slot].en })), history, message }), usage)
    const intent: Intent = resumeBook ? 'continue' : INTENTS.includes(decided?.intent as Intent) ? (decided!.intent as Intent) : 'other'

    // which course this message is about is decided by rule, not by the model
    const switchTo = resumeBook ? null : subjectSwitch(message, courses, profile.courseId)
    if (switchTo?.kind === 'existing' && decided && Array.isArray(decided.actions)) decided.actions = (decided.actions as { tool?: unknown }[]).filter((x) => x.tool !== 'course.create')
    // the course switch is a rule: it happens even when the model is unavailable
    const ruleActions: { tool: string; args: Record<string, unknown> }[] = switchTo?.kind === 'new' ? [{ tool: 'course.create', args: { subject: switchTo.subject } }] : []
    if (switchTo?.kind === 'new' && decided && Array.isArray(decided.actions)) decided.actions = (decided.actions as { tool?: unknown }[]).filter((x) => x.tool !== 'course.create' && x.tool !== 'studio.open')
    // 4. apply what the model proposed, under the rules
    if (decided) {
      const prof: Record<string, unknown> = { ...((decided.profile as Record<string, unknown>) ?? {}), language: decided.language }
      Object.keys(prof).forEach((k) => { if (prof[k] !== undefined) stated.add(k) })
      // the reply language changes only when the student asks for it (live: one Hinglish question switched everything to Hindi)
      if (profile.language && prof.language !== profile.language && !LANGUAGE_WORDS.test(message)) delete prof.language
      // the material source is the student's explicit choice: never accept a guessed value (live: the model guessed
      // "curriculum" and the question was never asked)
      if (prof.material !== undefined && !MATERIAL_WORDS.test(message)) delete prof.material
      if (prof.hasMaterials !== undefined && !MATERIAL_WORDS.test(message)) delete prof.hasMaterials
      profile = mergeProfile(profile, prof, now, allowedCourses).profile
      const doubts = (decided.doubts ?? {}) as { open?: unknown; resolved?: unknown }
      const topic = typeof decided.topic === 'string' && decided.topic.trim() ? decided.topic.trim().slice(0, 120) : undefined
      profile = applyDoubts(profile, doubts.open, doubts.resolved, now, topic)
      if (topic) state.topic = { conceptId: null, name: topic }
    }
    if (switchTo?.kind === 'existing') {
      // switching to another of the student's courses: the previous goal's chapter/material/date do not carry over
      const next: LearnerProfile = { ...profile, courseId: switchTo.courseId }
      for (const k of ['topic', 'material', 'depth', 'examDate'] as const) if (!stated.has(k)) delete next[k]
      profile = next
      state.asked = state.asked.filter((x) => !['topic', 'material', 'depth', 'examDate'].includes(x))
      if (state.phase === 'awaiting_approval') { state.phase = 'onboarding'; state.proposal = null }
    }
    const lang: Lang = profile.language ?? lang0
    const planChanged = JSON.stringify(PLAN_FIELDS.map((k) => profile[k])) !== before
    // tools read the durable profile: persist what this message established BEFORE any tool runs
    // (live regression: "exam in 7 days, 1 h a day, plan now" failed with profile_incomplete)
    if (JSON.stringify(profile) !== JSON.stringify(loaded)) await tx(p, (t) => saveProfile(d, p, t, profile))

    let failedStep: string | null = null
    const outcomes: ToolOutcome[] = []
    const cards: Card[] = []
    // the student uploaded their own material from the chat: it is the source for this course, and the book opens from it
    let uploadedBook = false
    const inSetup = state.phase !== 'active' && !(profile.objective && !plannable(profile))
    if (input.documentId) status('Reading your file…', 'librarian')
    let docReply: string | null = null
    let askScope: string[] | null = null
    if (input.documentId && inSetup) {
      // DOCUMENT FIRST (live failure: notes were planned as an invented "Note-Taking" syllabus): read what the file
      // really contains before any course, topic or plan is decided
      // the document belongs to the course it was uploaded into: that course is the one being set up
      if (d.documents) {
        const info = await d.documents.get(p, input.documentId).catch(() => null)
        const cid = info?.scope?.startsWith('course:') ? info.scope.slice('course:'.length) : null
        if (cid && allowedCourses.includes(cid)) profile = { ...profile, courseId: cid }
      }
      const a = await analyseDocument(d, p, input.documentId, lang0).catch((e: unknown) => ({ ok: false as const, reason: 'failed' as const, documentId: input.documentId!, filename: input.documentTitle || 'your file', message: `I could not analyse "${input.documentTitle || 'your file'}" (${(e as { code?: string }).code ?? 'error'}). Nothing was taken from it; please try again.` }))
      if (!a.ok) {
        // never pretend: say exactly what happened, keep asking for usable material
        docReply = a.message
        state.sourceDoc = null
      } else if (profile.courseId) {
        status('Organising the topics of your document…', 'planner')
        // a personal course takes its topics from the document (its own sections, terms and order)
        const mine = (await tx(p, (t) => t.query(`select 1 from education_tutor.courses where id = $1 and owner_user_id = platform.current_user_id()`, [profile.courseId]))).rowCount
        if (mine) {
          await tx(p, (t) => t.query('select education_tutor.set_personal_course_topics($1, $2, $3::jsonb)', [profile.courseId, a.title, JSON.stringify(a.sections.map((x) => ({ name: x.name, description: x.description || x.keyTerms.join(', '), estMinutes: Math.min(240, 20 + 15 * (x.pageEnd - x.pageStart + 1)) })))])).catch(() => {}) // practice history already exists: the course keeps its topics, the document still leads
          courses.splice(0, courses.length, ...courses.map((c) => (c.id === profile.courseId ? { ...c, title: a.title } : c)))
        }
        profile = mergeProfile(profile, { material: 'own' }, now, allowedCourses).profile
        const { topic: _t, ...rest } = profile
        profile = rest
        state.sourceDoc = { id: input.documentId, title: a.title, courseId: profile.courseId! }
        state.asked = state.asked.filter((x) => x !== 'topic')
        askScope = [ALL_LABEL[lang0], ...a.sections.slice(0, 5).map((x) => x.name)]
        docReply = `${describe(a)} ${SCOPE_ASK[lang0]}`
        uploadedBook = true
      } else {
        docReply = `${describe(a)} ${SCOPE_ASK[lang0]}`
      }
      await tx(p, (t) => saveProfile(d, p, t, profile))
    } else if (input.documentId && profile.courseId) {
      profile = mergeProfile(profile, { material: 'own' }, now, allowedCourses).profile
      await tx(p, (t) => saveProfile(d, p, t, profile))
      const o = await executeTool(tools, { d, p, conversationId: convId, now }, 'studio.open', { courseId: profile.courseId, title: (input.documentTitle || profile.topic || 'My notes').slice(0, 160), documentId: input.documentId }, { origin: 'orchestrator' })
      outcomes.push(o)
      if (o.status === 'ok') {
        const res = o.result as { bookId: string; href: string; label: string }
        state.activeBook = { id: res.bookId, title: input.documentTitle || profile.topic || 'My notes', courseId: profile.courseId }
        cards.push({ type: 'links', links: [{ label: res.label, href: res.href }], auto: true })
        uploadedBook = true
      } else failedStep = 'Opening a book from your file'
    }
    let proposal: Proposal | null = null
    let applied: { milestones: number; checkpoints: number; today: string } | null = null
    let bookReply: string | null = null
    let courseFailed = false
    let needUpload = false

    if (docReply) {
      // the document turn: its summary (or the honest failure) is the whole reply; planning waits for the scope
    } else if (intent === 'approve_plan' && state.phase === 'awaiting_approval' && state.proposal) {
      const a = await applyApproved(p, convId, state, profile, now)
      outcomes.push(a.outcome)
      cards.push(...a.cards)
      if (a.outcome.status === 'ok') {
        const r = a.outcome.result as { milestones: number; checkpoints: number }
        applied = { milestones: r.milestones, checkpoints: r.checkpoints, today: state.nextSession?.items.map((i) => i.label).join('; ') || '-' }
      } else failedStep = APPLY_STEPS[0]!
    } else if (input.context && BOOK_INTENTS.has(intent) && !(Array.isArray(decided?.actions) && (decided!.actions as { tool?: unknown }[]).some((a) => BOOK_EXITS.has(String(a.tool))))) {
      // page-aware doubt: answered by the book itself (grounded in its pages/material, kept in the notebook, the
      // lecture position remembered so the lesson resumes exactly where it stopped)
      const bc = input.context
      try {
        status('Looking at this page of your book…', 'teacher')
        const r = await studio.ask(p, bc.bookId, { question: message, selection: bc.selection ?? null, pageNo: bc.pageNo, blockId: bc.blockId ?? null, source: input.source === 'voice' ? 'voice' : bc.selection ? 'highlight' : 'question' })
        const NL = String.fromCharCode(10)
        bookReply = [...r.answer.blocks.map((b) => (b.term ? `${b.term}: ${b.text}` : b.text) + (b.items?.length ? NL + b.items.map((x) => `- ${x}`).join(NL) : '')), r.answer.followUp].filter(Boolean).join(NL + NL).slice(0, 2500)
        cards.push({ type: 'book_answer', bookAnswer: { bookId: bc.bookId, resumeTo: r.resumeTo ? { pageNo: r.resumeTo.pageNo, blockId: r.resumeTo.blockId ?? null } : null, notebookVersion: r.notebookVersion } })
        state.activeBook = { id: bc.bookId, title: state.activeBook?.id === bc.bookId ? state.activeBook.title : 'Your book' }
      } catch (e) {
        failedStep = 'Answering in your book'
        if ((e as { status?: number }).status === 404) throw e
      }
    } else if (intent === 'continue' && state.activeBook) {
      // deterministic resume: the book keeps the exact lecture position
      cards.push({ type: 'links', links: [{ label: `Continue: ${state.activeBook.title}`, href: `/studio/${state.activeBook.id}` }], auto: true })
    } else {
      // model-requested tools (validated, authorised; plan.apply is not model-callable)
      const requested = [...ruleActions, ...(Array.isArray(decided?.actions) ? (decided!.actions as { tool?: unknown; args?: unknown }[]) : [])].slice(0, 3)
      for (const req of requested) {
        if (req.tool === 'plan.propose') continue // planning runs as a workflow below
        // a course is created only for a concrete subject the student named (live: "Another subject or skill"
        // created "…of an Unspecified Subject"); otherwise the tutor asks which subject
        if (req.tool === 'course.create' && switchTo?.kind !== 'new' && (profile.material === 'own' || state.sourceDoc || MATERIAL_WORDS.test(message))) continue // the document decides the subject
        if (req.tool === 'course.create' && switchTo?.kind !== 'new' && !concreteSubject(String((req.args as { subject?: unknown } | undefined)?.subject ?? ''), message)) continue
        // JOURNEY RULE: while the goal, material and plan are being settled, nothing is opened or started
        if (inSetup && !SETUP_TOOLS.has(String(req.tool))) continue
        if (uploadedBook && (req.tool === 'studio.open' || req.tool === 'materials.open')) continue // the book from the upload is already open
        const args = { ...(req.args && typeof req.args === 'object' ? (req.args as Record<string, unknown>) : {}) }
        if (!args.courseId && profile.courseId && req.tool !== 'course.create') args.courseId = profile.courseId
        if (typeof args.conceptId === 'string' && !UUID.test(args.conceptId)) {
          const want = norm(args.conceptId)
          const hit = concepts.find((c) => norm(c.name) === want) ?? concepts.find((c) => norm(c.name).includes(want) || want.includes(norm(c.name)))
          if (hit) args.conceptId = hit.id
          else delete args.conceptId
        }
        const o = await executeTool(tools, { d, p, conversationId: convId, now }, String(req.tool ?? ''), args, { origin: 'model' })
        outcomes.push(o)
        if (req.tool === 'course.create' && o.status !== 'ok') courseFailed = true
        if (o.status === 'ok') {
          const res = o.result as { href?: string; label?: string; sources?: { filename: string; pages: string; href: string }[] }
          // the agent ACTS: when the student asked to learn/practise/revise/see progress, the workspace opens itself
          if (res.href && res.label) cards.push({ type: 'links', links: [{ label: res.label, href: res.href }], auto: AUTO_OPEN.has(String(req.tool)) && !cards.some((c) => c.auto) && EXPLICIT_OPEN.test(message) })
          // a new self-study course becomes the course of this goal (planning can start on the next step)
          if (req.tool === 'course.create') {
            const cc = res as { courseId: string; title: string }
            // a NEW goal: the previous goal's chapter, material, depth and date do not carry over (live: the
            // material question was skipped for a new subject); daily time and preferences do
            if (cc.courseId !== profile.courseId) {
              // keep what THIS message stated (it differs from the start of the turn); drop what was carried over
              const next: LearnerProfile = { ...profile, courseId: cc.courseId }
              for (const k of ['topic', 'material', 'depth', 'examDate'] as const) if (!stated.has(k)) delete next[k]
              profile = next
              state.asked = state.asked.filter((x) => !['topic', 'material', 'depth', 'examDate'].includes(x))
              state.phase = 'onboarding'
              state.proposal = null
            }
            courses.push({ id: cc.courseId, code: 'MY', title: cc.title })
          }
          if (req.tool === 'studio.open' && (res as { bookId?: string }).bookId) state.activeBook = { id: (res as { bookId: string }).bookId, title: String((req.args as { title?: string } | undefined)?.title ?? 'Your book'), courseId: String(args.courseId ?? '') }
          if (res.sources?.length) cards.push({ type: 'sources', sources: res.sources.map((s) => ({ filename: s.filename, pages: s.pages, href: s.href })) })
        }
      }
      // planning workflow: by rule when the goal is known (first time, after plan-relevant changes, on request, or to resume)
      const stale = state.workflow?.kind === 'planning' && state.workflow.status === 'running' && now.getTime() - Date.parse(state.workflow.updatedAt) > STALE_WORKFLOW_MS
      const resume = state.workflow?.kind === 'planning' && (state.workflow.status === 'failed' || stale)
      const explicit = requested.some((x) => x.tool === 'plan.propose') || intent === 'request_plan' || intent === 'modify_plan'
      let shouldPlan = false
      // own material: the plan is built only after the PDF is uploaded and read (it shapes topics and practice)
      if (profile.material === 'own' && profile.courseId && state.sourceDoc?.courseId !== profile.courseId) {
        const doc = await ownDoc(p, profile.courseId)
        if (doc) state.sourceDoc = { ...doc, courseId: profile.courseId }
      }
      needUpload = profile.material === 'own' && (!profile.courseId || state.sourceDoc?.courseId !== profile.courseId)
      // the student asked for a new subject that could not be created: never plan the OLD course instead
      if (courseFailed) failedStep = 'Creating your course'
      if (!courseFailed && !needUpload && profile.courseId && plannable(profile) && missingRequired(profile).length === 0) {
        if (resume) shouldPlan = true
        // onboarding: once the useful follow-ups are done (or the student asks for the plan now)
        else if (state.phase === 'onboarding') shouldPlan = readyToPlan(profile, state.asked) || explicit || state.sourceDoc?.courseId === profile.courseId
        // later: re-propose when the goal/deadline/time changed or the student asks
        else shouldPlan = planChanged || explicit
      }
      if (shouldPlan) {
        state.phase = 'planning'
        const r = await runPlanning(p, convId, state, profile, now)
        outcomes.push(...r.outcomes)
        state.workflow = r.workflow
        if (r.proposal) {
          proposal = r.proposal
          state.proposal = r.proposal
          state.phase = 'awaiting_approval'
          // the student must see and approve the plan first: nothing opens by itself in this reply
          for (const c of cards) if (c.auto) c.auto = false
          cards.push({ type: 'workflow', workflow: r.workflow }, proposalCard(r.proposal))
          // e.g. the starting-point check prepared during planning
          const links = r.outcomes.filter((o) => o.status === 'ok').map((o) => o.result as { href?: string; label?: string }).filter((x) => x.href && x.label && x.href.includes('/assessments'))
          if (links.length) cards.push({ type: 'links', links: links.map((x) => ({ label: x.label!, href: x.href! })) })
        } else {
          failedStep = r.workflow.steps.find((s) => s.status === 'failed')?.name ?? 'planning'
          state.phase = state.appliedPlan ? 'active' : 'onboarding'
          cards.push({ type: 'workflow', workflow: r.workflow })
        }
      } else if (intent === 'reject_plan' && state.phase === 'awaiting_approval') {
        // keep the proposal until the student says what to change
      }
    }

    // onboarding question (deterministic choice; asked once)
    let question: Slot | null = null
    if (state.phase === 'onboarding' || (!proposal && !applied && missingRequired(profile).length)) {
      question = nextSlot(profile, state.asked)
      // own material and no course yet: the uploaded document will decide the course, so ask for the file
      if (question === 'courseId' && profile.material === 'own') { question = null; needUpload = true }
      // the upload comes before optional questions (the plan cannot be made without it)
      if (question && needUpload && !missingRequired(profile).includes(question)) question = null
      if (question && !state.asked.includes(question)) state.asked = [...state.asked, question]
    }
    state.lastAsked = question
    if (question) {
      const ch = choicesFor(question, lang, courses)
      if (ch.length) cards.push({ type: 'choices', choices: ch })
    }
    const askUpload = !question && needUpload && !proposal
    if (askUpload) cards.push({ type: 'upload' })

    // 5. COMPOSE when tools produced something the student should hear about
    const okResults = outcomes.filter((o) => o.status === 'ok')
    let reply: string | null = null
    const failed = outcomes.filter((o) => o.status !== 'ok' && o.tool !== 'plan.apply')
    if (proposal || applied || okResults.length || failed.length || (uploadedBook && !!state.sourceDoc)) {
      const results: Record<string, unknown> = {}
      // links are shown as cards: the model gets labels, not URLs (so it does not paste paths into the reply)
      for (const o of okResults) results[o.tool] = o.tool === 'plan.propose' || o.tool === 'plan.apply' ? undefined : withoutLinks(o.result)
      if (proposal) { const { plan: _pl, ...rm } = proposal.roadmap; results.planProposal = { course: proposal.courseTitle, inputs: proposal.inputs, ...rm } }
      if (proposal) results.sourceMaterial = state.sourceDoc?.courseId === proposal.courseId ? `the student's own uploaded file "${state.sourceDoc.title}" (its examples and exercises become practice)` : profile.material === 'curriculum' ? 'the NCERT / course syllabus' : 'notes prepared by the tutor'
      if (applied) results.appliedPlan = { ...applied, nextSession: state.nextSession }
      if (proposal && planChanged && startPhase !== 'onboarding') results.planWasJustUpdated = { because: 'the student changed their goal, deadline or daily time', newInputs: proposal.inputs, say: 'Tell the student the plan has been re-made with the new values and ask them to approve it.' }
      if (question) results.thenAsk = SLOT_QUESTIONS[question].en
      if (askUpload) results.thenAsk = UPLOAD_ASK.en
      if (state.sourceDoc && uploadedBook && !proposal) results.receivedFile = { file: state.sourceDoc.title, use: 'it is now the source of the plan and the book; its examples and exercises become practice' }
      if (failed.length) results.couldNotDo = failed.map((o) => ({ what: tools.get(o.tool)?.description ?? 'that request', why: o.status === 'timeout' ? 'took too long' : 'not possible right now' }))
      status('Writing my reply…')
      const c = await ai(p, COMPOSE_TASK, buildComposePrompt({ language: lang, message, results }) as never, usage)
      reply = typeof c?.reply === 'string' && c.reply.trim() ? c.reply.trim() : null
    }
    if (bookReply) reply = bookReply
    if (!reply && failedStep) reply = fallbackText(lang, { failedStep })
    if (!reply && !proposal && !applied) {
      const draft = typeof decided?.reply === 'string' && decided.reply.trim() ? decided.reply.trim() : null
      // the model was asked to end with the next question; add ours only when its draft asks nothing
      // one question per reply while gathering the goal; explanations may contain several (rhetorical) questions
      reply = draft ? (question ? oneQuestion(draft) : draft) : fallbackText(lang, { question })
      if (draft && question && !draft.includes('?')) reply = `${draft} ${SLOT_QUESTIONS[question][lang]}`
    }
    if (!reply) reply = fallbackText(lang, { proposal, applied })
    // the pending question is always asked (a composed reply sometimes leaves it out)
    if (question && !reply.includes('?')) reply = `${reply} ${SLOT_QUESTIONS[question][lang]}`
    // a REQUIRED fact is missing: the reply ends with exactly that question (live: the model asked "what do you want to
    // focus on first?" instead of the daily time, and the plan never came)
    else if (question && missingRequired(profile).includes(question) && !reply.includes(SLOT_QUESTIONS[question][lang])) {
      const kept = reply.replace(/[^.!?]*\?\s*$/, '').trim()
      reply = `${kept} ${SLOT_QUESTIONS[question][lang]}`.trim()
    }
    // the upload request is ours, word for word (live: the model claimed it had opened a workspace)
    if (askUpload) reply = (UPLOAD_ACK[lang] + ' ' + UPLOAD_ASK[lang]).trim()

    if (docReply) {
      reply = docReply
      question = null
      for (let i = cards.length - 1; i >= 0; i--) if (cards[i]!.type === 'choices' || cards[i]!.type === 'upload') cards.splice(i, 1)
      if (askScope) { cards.push({ type: 'choices', choices: askScope }); state.lastAsked = 'topic' }
      else state.lastAsked = null
    }
    if (askSubject) { reply = SUBJECT_ASK[lang]; for (let i = cards.length - 1; i >= 0; i--) if (cards[i]!.type === 'choices') cards.splice(i, 1) }

    // 6. persist (optimistic: a concurrent turn on the same conversation wins, this one reports busy)
    const saved = await tx(p, async (t) => {
      const cur = await getConversation(t, convId, true)
      if (!cur || cur.version !== startVersion) throw new AppError('conversation_busy', 'Another message is still being handled. Please try again.', { status: 409 })
      await saveProfile(d, p, t, profile)
      await saveState(t, convId, state)
      await addMessage(d, p, t, convId, { role: 'agent', content: reply!, cards, usage: { calls: usage, tools: outcomes.map((o) => ({ tool: o.tool, status: o.status, ms: o.durationMs, error: o.error?.code })) } })
      return listMessages(d, p, t, convId, 2)
    })
    return { conversationId: convId, messages: saved, state: publicState(state, profile) }
  }

  /** Approve / reject the pending proposal from a button (no model call). */
  async function decideProposal(p: Principal, convId: string, proposalId: string, approve: boolean): Promise<TurnResult> {
    const now = new Date()
    const { conv, profile } = await open(p, convId, undefined)
    const state: ConvState = { ...initialState(), ...conv.state }
    if (state.phase !== 'awaiting_approval' || state.proposal?.id !== proposalId) {
      // a repeated approval of the plan already applied is a no-op that returns the current state
      if (approve && state.appliedPlan?.proposalId === proposalId) return { conversationId: conv.id, messages: await tx(p, (t) => listMessages(d, p, t, conv.id, 2)), state: publicState(state, profile) }
      throw new AppError('proposal_not_pending', 'This plan is no longer waiting for approval', { status: 409 })
    }
    const lang: Lang = profile.language ?? 'en'
    let cards: Card[] = []
    let text: string
    if (approve) {
      const a = await applyApproved(p, conv.id, state, profile, now)
      cards = a.cards
      if (a.outcome.status !== 'ok') throw new AppError('plan_apply_failed', 'Your plan could not be saved. Please try again.', { status: 503 })
      const r = a.outcome.result as { milestones: number; checkpoints: number }
      text = fallbackText(lang, { applied: { milestones: r.milestones, checkpoints: r.checkpoints, today: state.nextSession?.items.map((i) => i.label).join('; ') || '-' } })
    } else {
      text = TEMPLATES.rejected[lang]
    }
    const msgs = await tx(p, async (t) => {
      const cur = await getConversation(t, conv.id, true)
      if (!cur || cur.version !== conv.version) throw new AppError('conversation_busy', 'Another message is still being handled. Please try again.', { status: 409 })
      await addMessage(d, p, t, conv.id, { role: 'student', content: approve ? 'Approve plan' : 'Change plan' })
      await saveState(t, conv.id, state)
      await addMessage(d, p, t, conv.id, { role: 'agent', content: text, cards })
      return listMessages(d, p, t, conv.id, 2)
    })
    return { conversationId: conv.id, messages: msgs, state: publicState(state, profile) }
  }

  async function view(p: Principal, language?: Lang) {
    const { conv, courses, profile } = await open(p, undefined, language)
    return tx(p, async (t) => {
      let messages = await listMessages(d, p, t, conv.id, 60)
      if (!messages.length) {
        await addMessage(d, p, t, conv.id, { role: 'agent', content: TEMPLATES.welcome[profile.language ?? language ?? 'en'] })
        messages = await listMessages(d, p, t, conv.id, 60)
      }
      const state: ConvState = { ...initialState(), ...conv.state }
      const pending = state.phase === 'awaiting_approval' && state.proposal ? proposalCard(state.proposal) : null
      return { conversationId: conv.id, messages, state: publicState(state, profile), pendingProposal: pending?.proposal ?? null, courses, profile: profileSummary(profile) }
    })
  }

  return { turn, decideProposal, view, tools }
}

/** One-tap answers for questions with a fixed set of answers (the parsers understand these exact labels). */
export function choicesFor(slot: Slot, lang: 'en' | 'hi' | 'hinglish', courses: { title: string }[]): string[] {
  const hi = lang !== 'en'
  switch (slot) {
    case 'material': return hi ? ['Main apne notes / PDF upload karunga', 'NCERT / course syllabus se', 'AI notes taiyaar kare'] : ['I will upload my notes / PDF', 'Use NCERT / my course syllabus', 'Prepare AI notes for me']
    case 'depth': return hi ? ['Quick overview', 'Standard', 'Deep — full detail'] : ['Quick overview', 'Standard', 'Deep — full detail']
    case 'courseId': return [...courses.slice(0, 5).map((c) => c.title), hi ? 'Koi aur subject' : 'Another subject or skill']
    default: return []
  }
}

export interface BookContext { bookId: string; pageNo: number; blockId?: string | null; selection?: string | null }
/** intents that, while reading, are doubts about the page */
const BOOK_INTENTS = new Set<string>(['question', 'other', 'learn_topic', 'smalltalk', 'find_material'])
/** tools that mean "leave the book" (practice, tests, revision, progress, planning, a new course) */
const BOOK_EXITS = new Set(['practice.start', 'assessment.self_test', 'revision.status', 'growth.summary', 'learning.observe', 'plan.show', 'course.create', 'materials.open', 'progress.summary', 'assessments.list'])

/** a message that actually talks about which material to use */
const MATERIAL_WORDS = /(upload|notes|pdf|photo|ncert|textbook|text book|syllabus|curriculum|material|kitab|book\b|\bai\b|prepare (it|them|notes)|banao|bana do|you prepare|aap bana)/i

const CONTINUE_RE = /^\s*(continue|resume|go on|carry on|next|let'?s continue|continue (the )?(lesson|book|reading)|aage( badho| chalo| padhao)?|chalo|shuru karo|जारी रखें|आगे)\s*[.!]*\s*$/i
const LANGUAGE_WORDS = /(hindi|english|hinglish|हिंदी|हिन्दी|अंग्रेज़ी|angrezi)/i

/** research tools allowed while the goal/material/plan are being settled (nothing is opened or started) */
const SETUP_TOOLS = new Set(['course.create', 'curriculum.syllabus', 'materials.search', 'exam.insights', 'mastery.analyse'])
/** the student asked to open/start something now (otherwise a workspace is offered as a button, never opened) */
const EXPLICIT_OPEN = /(open|start|begin|show|take me|let'?s go|quiz|test me|practi[cs]e|revise|revision|teach|padhao|padha do|kholo|khol do|shuru|chalu|dikhao|samjhao|sikhao)/i
const UPLOAD_ASK = {
  en: 'Please attach your PDF or notes with the 📎 button below. I will read it, use its examples and exercises, and then make your plan.',
  hinglish: 'Apni PDF ya notes neeche 📎 button se attach kijiye. Main use padhkar, uske examples aur exercises lekar aapka plan banaunga.',
  hi: 'कृपया अपनी PDF या नोट्स नीचे 📎 बटन से जोड़ें। मैं उसे पढ़कर, उसके उदाहरण और अभ्यास प्रश्न लेकर आपकी योजना बनाऊँगा।',
} as const
const UPLOAD_ACK = { en: 'Great, we will learn from your own material.', hinglish: 'Badhiya, hum aapke apne material se padhenge.', hi: 'बढ़िया, हम आपकी अपनी सामग्री से पढ़ेंगे।' } as const
const ANOTHER_RE = /^\s*(another subject or skill|koi aur subject|another subject|something else|kuch aur)\s*[.!]?\s*$/i
const SUBJECT_ASK = {
  en: 'Sure. Which subject or skill would you like to learn? For example: Physics class 11, Python, Excel, Accountancy, Spoken English.',
  hinglish: 'Zaroor. Aap kaun sa subject ya skill seekhna chahte hain? Jaise: Physics class 11, Python, Excel, Accountancy, Spoken English.',
  hi: 'ज़रूर। आप कौन सा विषय या कौशल सीखना चाहते हैं? जैसे: भौतिकी कक्षा 11, Python, Excel, लेखाशास्त्र, बोलचाल की अंग्रेज़ी।',
} as const

const ALL_LABEL = { en: 'The complete material', hinglish: 'Poora material', hi: 'पूरी सामग्री' } as const
const ALL_RE = /(complete|whole|entire|all of it|everything|poora|pura|sab|सब|पूरी|full material)/i
const SCOPE_ASK = { en: 'Do you want to study the complete material, or a particular section?', hinglish: 'Kya aap poora material padhna chahte hain, ya koi ek section?', hi: 'क्या आप पूरी सामग्री पढ़ना चाहते हैं, या कोई एक भाग?' } as const
