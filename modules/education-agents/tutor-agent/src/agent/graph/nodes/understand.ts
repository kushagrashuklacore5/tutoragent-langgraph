/**
 * load: start of a turn — fresh conversation state from the database (jobs may have changed it), per-turn channels
 * reset, and the deterministic reading of the message (slot answers, scope choice, material, daily time).
 * understand: ONE model call (DECIDE) for intent/profile/tool requests, then the rules decide what is accepted.
 */
import type { LangGraphRunnableConfig } from '@langchain/langgraph'
import { AppError } from '@platform/core'
import { applyIntake, parseLevelAnswer, settledWithoutIntake, statedLearner } from '../../intake.ts'
import { applyDoubts, askOrder, courseNamed, UNPLANNED, mergeProfile, missingRequired, parseSlotAnswer, plannable, PLAN_FIELDS, profileSummary, relatedTo, requestedTopic, statedDailyMinutes, topicChange, statedTotalMinutes, subjectSwitch, type LearnerProfile, type Slot } from '../../profile.ts'
import { AGENT_PROMPT_VERSION, buildDecidePrompt, DECIDE_TASK, INTENTS, SLOT_QUESTIONS, type Intent } from '../../prompts.ts'
import { getConversation, initialState, saveProfile, type ConvState } from '../../store.ts'
import { status } from '../../status.ts'
import { ctxOf, tx, type TurnContext } from '../context.ts'
import { ANOTHER_RE, CONTINUE_RE, GO_AHEAD_RE, documentScope, LANGUAGE_WORDS, MATERIAL_WORDS, type Lang } from '../rules.ts'
import { RESET, type CompanionStateT, type CompanionUpdate, type Decision } from '../state.ts'

/** a student is waiting: past this the turn continues with rules and templates (live: a CPU fallback took 32-63 s) */
const TURN_MODEL_MS = 15_000
/** words that state WHEN (a date, a span, or no fixed date) */
const DATE_WORDS = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}(st|nd|rd|th)?\s*(of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}|tomorrow|next (week|month|year)|this (week|month)|in (a|one|two|three|\d+) (days?|weeks?|months?)|no (fixed )?(date|deadline|exam)|kal|parso)\b/i
/** a model call through the gateway; failures return null (the turn continues with rules and templates) */
export async function modelJson(c: TurnContext, task: string, messages: unknown): Promise<Record<string, unknown> | null> {
  try {
    const r = await c.d.ai(c.p).run(task, { messages } as never, { promptVersion: AGENT_PROMPT_VERSION, signal: AbortSignal.timeout(TURN_MODEL_MS) })
    c.usage.push({ task, model: r.route.modelId, operationId: r.operationId, inputTokens: r.usage.inputTokens ?? 0, outputTokens: r.usage.outputTokens ?? 0 })
    return (r.json ?? null) as Record<string, unknown> | null
  } catch (e) {
    // the reason is kept for an honest reply (rate limit, timeout), never hidden behind a generic message
    c.results.__modelError = (e as { code?: string }).code ?? 'unavailable'
    return null
  }
}

export async function load(_s: CompanionStateT, config: LangGraphRunnableConfig): Promise<CompanionUpdate> {
  const c = ctxOf(config)
  const cur = await tx(c, (t) => getConversation(t, c.conversationId))
  if (!cur) throw new AppError('not_found', 'Conversation not found', { status: 404 })
  c.convVersion = cur.version
  const conv: ConvState = { ...initialState(), ...cur.state }
  const msg = c.text
  c.results.__startPhase = conv.phase
  // deterministic answer to the question just asked; fields this message stated are remembered (course switches keep them)
  c.results.__answering = conv.lastAsked
  // what the message says about the learner ("I am in class 12, a beginner") is never asked again
  const learner = msg && !c.intake ? statedLearner(msg) : {}
  if (conv.lastAsked === 'level' && msg) Object.assign(learner, parseLevelAnswer(msg))
  if (Object.keys(learner).length) { Object.keys(learner).forEach((k) => c.stated.add(k)); c.profile = mergeProfile(c.profile, learner, c.now, c.courses.map((x) => x.id)).profile }
  // ONE consolidated intake: the submitted answers (or "go ahead" while it is open, taking the defaults) are applied together
  let autoStart = false
  const pending = conv.intake?.status === 'pending' && conv.intake.courseId === c.profile.courseId ? conv.intake : null
  const goAhead = !c.intake && !!pending && GO_AHEAD_RE.test(msg)
  if (c.intake || goAhead) {
    const id = c.intake?.id ?? pending!.id
    if (conv.intake?.id === id && conv.intake.status === 'submitted') c.results.__intake = 'duplicate'
    else if (!pending || pending.id !== id) c.results.__intake = 'stale'
    else {
      const r = applyIntake(c.profile, pending, c.intake?.answers ?? {}, c.now)
      if (r.problems.some((x) => x.startsWith('missing'))) c.results.__intake = 'invalid'
      else {
        const topic = c.profile.topic ?? conv.topic?.name ?? c.courses.find((x) => x.id === c.profile.courseId)?.title
        c.profile = { ...r.profile, ...(topic && !r.profile.topic ? { topic } : {}) }
        r.stated.forEach((k) => c.stated.add(k))
        conv.intake = { ...pending, status: 'submitted' }
        conv.asked = [...new Set([...conv.asked, ...pending.slots])]
        conv.lastAsked = null
        c.results.__intake = 'applied'
        autoStart = !c.intake?.review
      }
    }
  }
  if (msg && !c.intake && conv.lastAsked && conv.lastAsked !== 'subject') { const a = parseSlotAnswer(conv.lastAsked as Slot, msg, c.now); Object.keys(a).forEach((k) => c.stated.add(k)); c.profile = mergeProfile(c.profile, a, c.now, c.courses.map((x) => x.id)).profile }
  // answer to "complete material or which section?" after a document summary
  // (also later in setup, so a student can still widen or narrow a proposed plan)
  if (msg && conv.phase !== 'active' && conv.sourceDoc?.courseId === c.profile.courseId) {
    const pick = documentScope(msg, c.concepts, conv.lastAsked === 'topic')
    if (pick) { c.profile = { ...c.profile, topic: pick }; c.stated.add('topic') }
  }
  // a material choice is understood even when it was not the question just asked
  if (msg && !c.profile.material && conv.lastAsked !== 'material' && MATERIAL_WORDS.test(msg)) { const a = parseSlotAnswer('material', msg, c.now); if (a.material) { c.stated.add('material'); c.profile = mergeProfile(c.profile, a, c.now, c.courses.map((x) => x.id)).profile } }
  // a changed daily time stated in words (live: the model missed "only 45 minutes a day")
  const dm = msg ? statedDailyMinutes(msg) : null
  if (dm && dm !== c.profile.dailyMinutes) c.profile = mergeProfile(c.profile, { dailyMinutes: dm }, c.now, c.courses.map((x) => x.id)).profile
  // a total ("I have six hours") is kept alongside the daily figure, so the schedule fits both
  const total = msg ? statedTotalMinutes(msg) : null
  // the student's own words say what the limited time is for
  if (total && total !== c.profile.totalMinutes) c.profile = mergeProfile(c.profile, { totalMinutes: total, goalText: msg }, c.now, c.courses.map((x) => x.id)).profile
  return { conv, decision: null, flags: { replace: true, autoStart }, cards: RESET, outcomes: RESET, workflow: conv.workflow }
}

export async function understand(s: CompanionStateT, config: LangGraphRunnableConfig): Promise<CompanionUpdate> {
  const c = ctxOf(config)
  const conv: ConvState = { ...s.conv! }
  const msg = c.text
  const before = JSON.stringify(PLAN_FIELDS.map((k) => c.loaded[k]))
  const lang0: Lang = c.profile.language ?? s.turn?.language ?? 'en'
  // rule-decided turns need no model: a button press, "continue" with an open book, "another subject"
  const button = !!s.turn?.proposalDecision
  const resumeBook = !button && !!conv.activeBook && CONTINUE_RE.test(msg)
  const askSubject = !button && ANOTHER_RE.test(msg)
  // a submitted intake is structured: nothing to interpret, so no model call
  const intakeTurn = !!c.results.__intake
  const duplicateIntake = c.results.__intake === 'duplicate'
  // "ok" / "approved" while a plan waits for approval approves THAT stored plan (a rule; works when the model is down)
  const consent = !button && conv.phase === 'awaiting_approval' && !!conv.proposal && GO_AHEAD_RE.test(msg)
  const pendingAsk = conv.phase === 'onboarding' || missingRequired(c.profile).length ? askOrder(c.profile, conv.asked) : []
  let decided: Record<string, unknown> | null = null
  if (!button && !resumeBook && !askSubject && !intakeTurn && !consent) {
    status('Thinking…')
    const ctx = {
      today: c.now.toISOString().slice(0, 10), courses: c.courses, activeCourseId: c.profile.courseId ?? null, topics: c.concepts,
      profile: profileSummary(c.profile), phase: conv.phase, missingSlots: missingRequired(c.profile),
      pendingProposal: conv.phase === 'awaiting_approval' && conv.proposal ? { id: conv.proposal.id, course: conv.proposal.courseTitle, feasibility: conv.proposal.roadmap.feasibility, milestones: conv.proposal.roadmap.milestones.length, horizon: conv.proposal.roadmap.horizon } : null,
      activePlan: conv.appliedPlan, nextSession: conv.nextSession?.items.map((i) => i.label) ?? null, currentTopic: conv.topic?.name ?? null,
      tools: c.tools.catalog(),
      journeyStage: conv.phase === 'active' ? 'following the approved plan' : 'setup: understand the goal and material, then the plan (do not say you opened or started anything)',
      inBook: s.turn?.context ? { pageNo: s.turn.context.pageNo, selectedText: s.turn.context.selection ? s.turn.context.selection.slice(0, 300) : null } : null,
    }
    decided = await modelJson(c, DECIDE_TASK, buildDecidePrompt({ today: ctx.today, language: lang0, context: ctx, askOrder: pendingAsk.map((slot) => ({ slot, ask: SLOT_QUESTIONS[slot].en })), history: c.history, message: msg }))
  } else if (resumeBook) status('Opening your book where you stopped…')
  const intent: Intent = button ? (s.turn!.proposalDecision!.approve ? 'approve_plan' : 'reject_plan') : resumeBook || (duplicateIntake && conv.activeBook) ? 'continue' : c.results.__intake === 'applied' ? 'request_plan' : consent ? 'approve_plan' : INTENTS.includes(decided?.intent as Intent) ? (decided!.intent as Intent) : 'other'
  c.draft = typeof decided?.reply === 'string' && decided.reply.trim() ? decided.reply.trim() : null

  // which course a message is about is a rule (also when the model is down)
  let switchTo = button || resumeBook || intakeTurn ? null : subjectSwitch(msg, c.courses, c.profile.courseId)
  // an explicitly requested topic is the student's intent: it decides the course, and course discovery never overrides it
  // (live: "explain me dissection of human body" was answered with a list of unrelated courses, four times)
  const answering = c.results.__answering as string | null
  const changing = button || resumeBook || intakeTurn || s.turn?.context ? null : topicChange(msg)
  const answeringSubject = answering === 'subject' || answering === 'courseId' || !!changing
  const asked = changing ?? (button || resumeBook || askSubject || intakeTurn || s.turn?.context || MATERIAL_WORDS.test(msg) ? null : requestedTopic(msg, answeringSubject))
  // outside a book page, an explicitly requested topic unrelated to the current course (its title and topics) is a new subject, not a question about it
  const unrelated = !!asked && conv.phase !== 'planning' && !!c.profile.courseId && !relatedTo(asked, [c.courses.find((x) => x.id === c.profile.courseId)?.title ?? '', ...c.concepts.map((x) => x.name)])
  if (!switchTo && asked && (!c.profile.courseId || answeringSubject || unrelated)) {
    const named = courseNamed(asked, c.courses)
    switchTo = named ? (named.id === c.profile.courseId ? null : { kind: 'existing', courseId: named.id }) : { kind: 'new', subject: asked }
  }
  let modelActions = Array.isArray(decided?.actions) ? (decided!.actions as { tool?: unknown; args?: unknown }[]).filter((x) => typeof x.tool === 'string') : []
  if (switchTo) modelActions = modelActions.filter((x) => x.tool !== 'course.create' && !(switchTo.kind === 'new' && x.tool === 'studio.open'))
  const actions = [
    ...(switchTo?.kind === 'new' ? [{ tool: 'course.create', args: { subject: switchTo.subject } as Record<string, unknown> }] : []),
    ...modelActions.map((x) => ({ tool: String(x.tool), args: { ...(x.args && typeof x.args === 'object' ? (x.args as Record<string, unknown>) : {}) } })),
  ].slice(0, 3)

  // apply what the model proposed, under the rules
  let profile: LearnerProfile = c.profile
  if (decided) {
    const prof: Record<string, unknown> = { ...((decided.profile as Record<string, unknown>) ?? {}), language: decided.language }
    // the scope of an uploaded document is the student's choice (documentScope), never the model's paraphrase
    if (!switchTo && conv.sourceDoc?.courseId === c.profile.courseId) delete prof.topic
    Object.keys(prof).forEach((k) => { if (prof[k] !== undefined) c.stated.add(k) })
    // reply language changes only when the student asks (live: one Hinglish question switched everything to Hindi)
    if (profile.language && prof.language !== profile.language && !LANGUAGE_WORDS.test(msg)) delete prof.language
    // the material source is the student's explicit choice, never a guess
    if (prof.material !== undefined && !MATERIAL_WORDS.test(msg)) delete prof.material
    if (prof.hasMaterials !== undefined && !MATERIAL_WORDS.test(msg)) delete prof.hasMaterials
    // "I have six hours" is a total: the model must not turn it into six hours every day
    delete prof.totalMinutes
    if (c.profile.totalMinutes) delete prof.goalText
    if ((statedTotalMinutes(msg) || c.profile.totalMinutes) && !statedDailyMinutes(msg) && conv.lastAsked !== 'dailyMinutes') delete prof.dailyMinutes
    // a timetable is the student's to state: the model may not carry an old goal's date or daily time into this one
    // (live: "Prepare me for my Class 12 chemistry examination" got the previous goal's "no date, 30 min")
    if (prof.dailyMinutes !== undefined && !statedDailyMinutes(msg) && conv.lastAsked !== 'dailyMinutes') delete prof.dailyMinutes
    if (prof.examDate !== undefined && conv.lastAsked !== 'examDate' && !DATE_WORDS.test(msg)) delete prof.examDate
    profile = mergeProfile(profile, prof, c.now, c.courses.map((x) => x.id)).profile
    const doubts = (decided.doubts ?? {}) as { open?: unknown; resolved?: unknown }
    const topic = typeof decided.topic === 'string' && decided.topic.trim() ? decided.topic.trim().slice(0, 120) : undefined
    profile = applyDoubts(profile, doubts.open, doubts.resolved, c.now, topic)
    if (topic) conv.topic = { conceptId: null, name: topic }
  }
  if (switchTo?.kind === 'existing') {
    // switching to another enrolled course: the previous goal's chapter/material/date do not carry over
    const next: LearnerProfile = { ...profile, courseId: switchTo.courseId }
    for (const k of ['topic', 'material', 'depth', 'examDate', 'confidence', 'objective', 'dailyMinutes', 'totalMinutes'] as const) if (!c.stated.has(k)) delete next[k]
    profile = next
    conv.asked = conv.asked.filter((x) => !['topic', 'material', 'depth', 'examDate', 'confidence', 'objective', 'dailyMinutes'].includes(x))
    if (conv.phase === 'awaiting_approval') { conv.phase = 'onboarding'; conv.proposal = null }
  }
  if (asked && (switchTo || answeringSubject || unrelated || !c.profile.courseId)) {
    // the requested topic is kept as the learning topic; an explanation request needs no study plan
    profile = { ...profile, topic: profile.topic && c.stated.has('topic') ? profile.topic : asked }
    c.stated.add('topic')
    // a new learning goal is prepared and taught (the intake asks what it is for), never left as a one-off answer
    if (profile.objective && UNPLANNED.includes(profile.objective) && !c.stated.has('objective')) { const { objective: _o, ...rest } = profile; profile = rest }
    if (switchTo?.kind === 'new' || (switchTo?.kind === 'existing')) conv.intake = null
    conv.topic = { conceptId: null, name: asked }
  }
  // goal and material already stated (no schedule needed): sensible defaults, no further questions
  if (conv.phase === 'onboarding' && plannable(profile)) { const settled = settledWithoutIntake(profile); if (settled) profile = settled }
  c.profile = profile
  c.lang = profile.language ?? lang0
  // tools read the durable profile: persist what this message established BEFORE any tool runs
  if (JSON.stringify(profile) !== JSON.stringify(c.loaded)) await tx(c, (t) => saveProfile(c.d, c.p, t, profile))
  const decision: Decision = {
    intent, actions, switchTo, resumeBook, askSubject,
    planChanged: JSON.stringify(PLAN_FIELDS.map((k) => profile[k])) !== before,
    inSetup: conv.phase !== 'active' && !(profile.objective && !plannable(profile)),
  }
  return { decision, conv }
}
