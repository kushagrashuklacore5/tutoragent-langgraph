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
import { applyDoubts, askOrder, mergeProfile, missingRequired, nextSlot, parseSlotAnswer, PLAN_FIELDS, profileSummary, readyToPlan, type LearnerProfile, type Slot } from './profile.ts'
import { prepareSession } from './nudges.ts'
import { AGENT_PROMPT_VERSION, buildComposePrompt, buildDecidePrompt, COMPOSE_TASK, DECIDE_TASK, INTENTS, SLOT_QUESTIONS, TEMPLATES, tpl, type Intent } from './prompts.ts'
import { addMessage, createConversation, getConversation, initialState, latestConversation, listMessages, loadProfile, saveProfile, saveState, type Card, type ConvState, type Message, type Proposal, type Workflow } from './store.ts'
import { executeTool, type ToolOutcome, type ToolRegistry } from './tools.ts'
import { companionTools } from './toolset.ts'

type Lang = 'en' | 'hi' | 'hinglish'
interface Usage { task: string; model: string; operationId: string; inputTokens: number; outputTokens: number }
export interface TurnResult { conversationId: string; messages: Message[]; state: PublicState }
export interface PublicState { phase: ConvState['phase']; pendingProposalId: string | null; appliedPlan: ConvState['appliedPlan']; nextSession: ConvState['nextSession']; workflow: Workflow | null; profileComplete: boolean }

const STALE_WORKFLOW_MS = 2 * 60_000
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
  phase: s.phase, pendingProposalId: s.phase === 'awaiting_approval' ? s.proposal?.id ?? null : null, appliedPlan: s.appliedPlan, nextSession: s.nextSession, workflow: s.workflow, profileComplete: missingRequired(profile).length === 0,
})

export const proposalCard = (pr: Proposal): Card => {
  const { plan: _plan, ...roadmap } = pr.roadmap
  return { type: 'plan_proposal', proposal: { id: pr.id, courseId: pr.courseId, courseTitle: pr.courseTitle, inputs: pr.inputs, roadmap, strategy: pr.strategy, examEvidence: pr.examEvidence } }
}

export function companion(d: ModuleDeps, tools: ToolRegistry = companionTools()) {
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

  async function turn(p: Principal, input: { conversationId?: string; message: string; language?: Lang; source?: 'text' | 'voice' }): Promise<TurnResult> {
    const now = new Date()
    const message = input.message.trim()
    if (!message || message.length > 4000) throw badRequest('invalid_message', 'message is required (max 4000 characters)')
    const { conv, courses, profile: loaded } = await open(p, input.conversationId, input.language)
    const concepts = loaded.courseId ? await tx(p, async (t) => (await t.query<{ id: string; name: string }>(`select id, name from education_tutor.concepts where course_id = $1 and status = 'approved' order by name limit 60`, [loaded.courseId])).rows) : []
    const convId = conv.id
    const state: ConvState = { ...initialState(), ...conv.state }
    const startVersion = conv.version
    const history = await tx(p, async (t) => {
      const h = await listMessages(d, p, t, convId, 10)
      await addMessage(d, p, t, convId, { role: 'student', content: message, usage: { source: input.source ?? 'text' } })
      return h
    })
    const usage: Usage[] = []
    const allowedCourses = courses.map((c) => c.id)
    let profile = loaded
    const before = JSON.stringify(PLAN_FIELDS.map((k) => profile[k]))

    // 2. deterministic answer to the question just asked
    if (state.lastAsked) profile = mergeProfile(profile, parseSlotAnswer(state.lastAsked, message, now), now, allowedCourses).profile
    const lang0: Lang = profile.language ?? input.language ?? 'en'

    // 3. DECIDE
    const ctx = {
      today: now.toISOString().slice(0, 10), courses: courses.map((c) => ({ id: c.id, code: c.code, title: c.title })), activeCourseId: profile.courseId ?? null, topics: concepts.map((c) => ({ id: c.id, name: c.name })),
      profile: profileSummary(profile), phase: state.phase, missingSlots: missingRequired(profile),
      pendingProposal: state.phase === 'awaiting_approval' && state.proposal ? { id: state.proposal.id, course: state.proposal.courseTitle, feasibility: state.proposal.roadmap.feasibility, milestones: state.proposal.roadmap.milestones.length, horizon: state.proposal.roadmap.horizon } : null,
      activePlan: state.appliedPlan, nextSession: state.nextSession?.items.map((i) => i.label) ?? null, currentTopic: state.topic?.name ?? null,
      tools: tools.catalog(),
    }
    const decided = await ai(p, DECIDE_TASK, buildDecidePrompt({ today: ctx.today, language: lang0, context: ctx, askOrder: askOrder(profile, state.asked).map((slot) => ({ slot, ask: SLOT_QUESTIONS[slot].en })), history, message }), usage)
    const intent: Intent = INTENTS.includes(decided?.intent as Intent) ? (decided!.intent as Intent) : 'other'

    // 4. apply what the model proposed, under the rules
    if (decided) {
      const prof = { ...((decided.profile as Record<string, unknown>) ?? {}), language: decided.language }
      profile = mergeProfile(profile, prof, now, allowedCourses).profile
      const doubts = (decided.doubts ?? {}) as { open?: unknown; resolved?: unknown }
      const topic = typeof decided.topic === 'string' && decided.topic.trim() ? decided.topic.trim().slice(0, 120) : undefined
      profile = applyDoubts(profile, doubts.open, doubts.resolved, now, topic)
      if (topic) state.topic = { conceptId: null, name: topic }
    }
    const lang: Lang = profile.language ?? lang0
    const planChanged = JSON.stringify(PLAN_FIELDS.map((k) => profile[k])) !== before
    // tools read the durable profile: persist what this message established BEFORE any tool runs
    // (live regression: "exam in 7 days, 1 h a day, plan now" failed with profile_incomplete)
    if (JSON.stringify(profile) !== JSON.stringify(loaded)) await tx(p, (t) => saveProfile(d, p, t, profile))

    const outcomes: ToolOutcome[] = []
    const cards: Card[] = []
    let proposal: Proposal | null = null
    let applied: { milestones: number; checkpoints: number; today: string } | null = null
    let failedStep: string | null = null

    if (intent === 'approve_plan' && state.phase === 'awaiting_approval' && state.proposal) {
      const a = await applyApproved(p, convId, state, profile, now)
      outcomes.push(a.outcome)
      cards.push(...a.cards)
      if (a.outcome.status === 'ok') {
        const r = a.outcome.result as { milestones: number; checkpoints: number }
        applied = { milestones: r.milestones, checkpoints: r.checkpoints, today: state.nextSession?.items.map((i) => i.label).join('; ') || '-' }
      } else failedStep = APPLY_STEPS[0]!
    } else {
      // model-requested tools (validated, authorised; plan.apply is not model-callable)
      const requested = Array.isArray(decided?.actions) ? (decided!.actions as { tool?: unknown; args?: unknown }[]).slice(0, 3) : []
      for (const req of requested) {
        if (req.tool === 'plan.propose') continue // planning runs as a workflow below
        const args = { ...(req.args && typeof req.args === 'object' ? (req.args as Record<string, unknown>) : {}) }
        if (!args.courseId && profile.courseId) args.courseId = profile.courseId
        if (typeof args.conceptId === 'string' && !UUID.test(args.conceptId)) {
          const want = norm(args.conceptId)
          const hit = concepts.find((c) => norm(c.name) === want) ?? concepts.find((c) => norm(c.name).includes(want) || want.includes(norm(c.name)))
          if (hit) args.conceptId = hit.id
          else delete args.conceptId
        }
        const o = await executeTool(tools, { d, p, conversationId: convId, now }, String(req.tool ?? ''), args, { origin: 'model' })
        outcomes.push(o)
        if (o.status === 'ok') {
          const res = o.result as { href?: string; label?: string; sources?: { filename: string; pages: string; href: string }[] }
          if (res.href && res.label) cards.push({ type: 'links', links: [{ label: res.label, href: res.href }] })
          if (res.sources?.length) cards.push({ type: 'sources', sources: res.sources.map((s) => ({ filename: s.filename, pages: s.pages, href: s.href })) })
        }
      }
      // planning workflow: by rule when the goal is known (first time, after plan-relevant changes, on request, or to resume)
      const stale = state.workflow?.kind === 'planning' && state.workflow.status === 'running' && now.getTime() - Date.parse(state.workflow.updatedAt) > STALE_WORKFLOW_MS
      const resume = state.workflow?.kind === 'planning' && (state.workflow.status === 'failed' || stale)
      const explicit = requested.some((x) => x.tool === 'plan.propose') || intent === 'request_plan' || intent === 'modify_plan'
      let shouldPlan = false
      if (profile.courseId && missingRequired(profile).length === 0) {
        if (resume) shouldPlan = true
        // onboarding: once the useful follow-ups are done (or the student asks for the plan now)
        else if (state.phase === 'onboarding') shouldPlan = readyToPlan(profile, state.asked) || explicit
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
      if (question && !state.asked.includes(question)) state.asked = [...state.asked, question]
    }
    state.lastAsked = question

    // 5. COMPOSE when tools produced something the student should hear about
    const okResults = outcomes.filter((o) => o.status === 'ok')
    let reply: string | null = null
    const failed = outcomes.filter((o) => o.status !== 'ok' && o.tool !== 'plan.apply')
    if (proposal || applied || okResults.length || failed.length) {
      const results: Record<string, unknown> = {}
      // links are shown as cards: the model gets labels, not URLs (so it does not paste paths into the reply)
      for (const o of okResults) results[o.tool] = o.tool === 'plan.propose' || o.tool === 'plan.apply' ? undefined : withoutLinks(o.result)
      if (proposal) { const { plan: _pl, ...rm } = proposal.roadmap; results.planProposal = { course: proposal.courseTitle, inputs: proposal.inputs, ...rm } }
      if (applied) results.appliedPlan = { ...applied, nextSession: state.nextSession }
      if (question) results.thenAsk = SLOT_QUESTIONS[question].en
      if (failed.length) results.couldNotDo = failed.map((o) => ({ what: tools.get(o.tool)?.description ?? 'that request', why: o.status === 'timeout' ? 'took too long' : 'not possible right now' }))
      const c = await ai(p, COMPOSE_TASK, buildComposePrompt({ language: lang, message, results }) as never, usage)
      reply = typeof c?.reply === 'string' && c.reply.trim() ? c.reply.trim() : null
    }
    if (!reply && failedStep) reply = fallbackText(lang, { failedStep })
    if (!reply && !proposal && !applied) {
      const draft = typeof decided?.reply === 'string' && decided.reply.trim() ? decided.reply.trim() : null
      // the model was asked to end with the next question; add ours only when its draft asks nothing
      reply = draft ? oneQuestion(draft) : fallbackText(lang, { question })
      if (draft && question && !draft.includes('?')) reply = `${draft} ${SLOT_QUESTIONS[question][lang]}`
    }
    if (!reply) reply = fallbackText(lang, { proposal, applied })

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
