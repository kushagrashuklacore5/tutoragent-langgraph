/**
 * The companion's entry point for the HTTP layer: one student turn → one run of the companion graph.
 *
 * Security: a thread id is `<tenant>:<conversation>` and is used ONLY after the conversation row was read under RLS
 * as its owner; it is never an authorization. Student text is encrypted in agent_messages before the graph runs and
 * reaches nodes through the per-run context (never the checkpoint).
 * Durability: if the thread waits at an interrupt (roadmap approval, document scope), the turn RESUMES that run;
 * otherwise a fresh run starts on the same thread. Completed steps of an interrupted run are never executed again.
 * Concurrency: one run per thread at a time in this process; across processes the conversation version check in
 * `respond` makes a concurrent turn fail with 409 instead of interleaving.
 */
import { Command } from '@langchain/langgraph'
import { AppError, badRequest } from '@platform/core'
import type { ModuleDeps, Principal } from '@platform/contracts'
import type { Sql } from '@platform/tenancy-db'
import { profileSummary } from '../profile.ts'
import { TEMPLATES } from '../prompts.ts'
import { addMessage, createConversation, getConversation, initialState, latestConversation, listMessages, loadProfile, type ConvState } from '../store.ts'
import type { ToolRegistry } from '../tools.ts'
import { companionTools } from '../toolset.ts'
import type { StatusEvent } from '../status.ts'
import { studioService } from '../../studio/service.ts'
import type { TurnContext } from './context.ts'
import { buildCompanionGraph } from './graph.ts'
import { proposalCard, publicState, type BookContext, type Lang, type TurnResult } from './rules.ts'
import type { TurnInput } from './state.ts'

export const threadId = (p: Pick<Principal, 'tenantId'>, conversationId: string) => `${p.tenantId}:${conversationId}`

export function companion(d: ModuleDeps, tools: ToolRegistry = companionTools()) {
  const studio = studioService(d)
  const graph = buildCompanionGraph(d.checkpointer)
  const tx = <T>(p: Principal, fn: (t: Sql) => Promise<T>) => d.inTenant(p, fn)
  const running = new Map<string, Promise<unknown>>()

  async function studentCourses(t: Sql) {
    return (await t.query<{ id: string; code: string; title: string; createdAt: string }>(
      `select c.id, c.code, c.title, c.created_at::text as "createdAt" from education_tutor.courses c join education_tutor.enrolments e on e.course_id = c.id and e.user_id = platform.current_user_id() and e.role = 'student' order by c.code`)).rows
  }

  /** the student's conversation (RLS: owner only) and profile; deterministic defaults (single course, language) */
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

  /** run (or resume) the graph for one turn; status events are forwarded while it works */
  async function run(p: Principal, conversationId: string, input: TurnInput, text: string, onEvent?: (e: StatusEvent) => void, intake?: TurnContext['intake']): Promise<TurnResult> {
    const thread = threadId(p, conversationId)
    // one run per thread at a time in this process (the version check covers other processes)
    while (running.has(thread)) await running.get(thread)!.catch(() => {})
    const work = (async () => {
      const { courses, profile } = await open(p, conversationId, input.language)
      // the language picker in the chat is an explicit choice: it wins over the stored language
      const loaded = input.language && input.language !== profile.language ? { ...profile, language: input.language } : profile
      const concepts = loaded.courseId ? await tx(p, async (t) => (await t.query<{ id: string; name: string }>(`select id, name from education_tutor.concepts where course_id = $1 and status = 'approved' order by name limit 60`, [loaded.courseId])).rows) : []
      const history = await tx(p, (t) => listMessages(d, p, t, conversationId, 11)).then((m) => m.filter((x) => x.id !== input.messageId).slice(-10))
      const ctx: TurnContext = {
        d, p, tools, studio, now: new Date(), conversationId, convVersion: 0, text, history, profile: loaded, loaded, courses, concepts,
        stated: new Set(), usage: [], results: {}, draft: null, reply: null, lang: loaded.language ?? input.language ?? 'en', intake: intake ?? null,
      }
      const config = { configurable: { thread_id: thread, ctx }, streamMode: 'custom' as const, recursionLimit: 60 }
      const waiting = (await graph.getState({ configurable: { thread_id: thread } })).tasks.some((t) => t.interrupts.length > 0)
      for await (const ev of await graph.stream(waiting ? new Command({ resume: input }) : { turn: input }, config)) {
        const e = ev as StatusEvent
        if (e?.type === 'status') onEvent?.(e)
      }
      return tx(p, async (t) => {
        const cur = (await getConversation(t, conversationId))!
        return { conversationId, messages: await listMessages(d, p, t, conversationId, 2), state: publicState({ ...initialState(), ...cur.state }, ctx.profile) }
      })
    })()
    running.set(thread, work)
    try { return await work } finally { if (running.get(thread) === work) running.delete(thread) }
  }

  async function turn(p: Principal, input: { conversationId?: string; message: string; language?: Lang; source?: 'text' | 'voice'; context?: BookContext; documentId?: string; documentTitle?: string; intake?: { id: string; answers: Record<string, string>; review: boolean } }, onEvent?: (e: StatusEvent) => void): Promise<TurnResult> {
    const message = input.message.trim()
    if (!message || message.length > 4000) throw badRequest('invalid_message', 'message is required (max 4000 characters)')
    const { conv } = await open(p, input.conversationId, input.language)
    // the student's message is stored (encrypted) first: nothing is lost if the run is interrupted
    const messageId = await tx(p, async (t) => (await addMessage(d, p, t, conv.id, { role: 'student', content: message, usage: { source: input.source ?? 'text' } })).id)
    return run(p, conv.id, { messageId, source: input.source ?? 'text', language: input.language, context: input.context, documentId: input.documentId, documentTitle: input.documentTitle, ...(input.intake ? { intakeId: input.intake.id } : {}) }, message, onEvent, input.intake ?? null)
  }

  /** Approve / reject the pending proposal from a button: resumes the thread at the approval interrupt. */
  async function decideProposal(p: Principal, convId: string, proposalId: string, approve: boolean): Promise<TurnResult> {
    const { conv, profile } = await open(p, convId, undefined)
    const state: ConvState = { ...initialState(), ...conv.state }
    if (state.phase !== 'awaiting_approval' || state.proposal?.id !== proposalId) {
      // a repeated approval of the plan already applied is a no-op that returns the current state
      if (approve && state.appliedPlan?.proposalId === proposalId) return { conversationId: conv.id, messages: await tx(p, (t) => listMessages(d, p, t, conv.id, 2)), state: publicState(state, profile) }
      throw new AppError('proposal_not_pending', 'This plan is no longer waiting for approval', { status: 409 })
    }
    const messageId = await tx(p, async (t) => (await addMessage(d, p, t, conv.id, { role: 'student', content: approve ? 'Approve plan' : 'Change plan' })).id)
    const r = await run(p, conv.id, { messageId, source: 'text', proposalDecision: { proposalId, approve } }, '')
    if (approve && r.state.phase !== 'active') throw new AppError('plan_apply_failed', 'Your plan could not be saved. Please try again.', { status: 503 })
    return r
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

  /** forget: the graph threads of these (already ownership-checked) conversations are deleted too */
  async function forgetThreads(p: Principal, conversationIds: string[]) {
    for (const id of conversationIds) await d.checkpointer?.deleteThread(threadId(p, id))
  }

  return { turn, decideProposal, view, forgetThreads, tools, graph }
}
