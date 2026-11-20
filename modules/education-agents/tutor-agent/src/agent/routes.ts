/** HTTP routes of the study companion (students; owner-only data). */
import { badRequest } from '@platform/core'
import type { ModuleDeps, RouteDef } from '@platform/contracts'
import { obj, P, str, uuid } from '../common.ts'
import { companion } from './orchestrator.ts'
import { recommend, type Signal } from '../domain/insights.ts'
import { withStatus, type StatusEvent } from './status.ts'
import { courseScope, MAX_UPLOAD_BYTES } from '../materials.ts'
import { createConversation, initialState, loadProfile } from './store.ts'

const LANG = ['en', 'hi', 'hinglish'] as const
const lang = (v: unknown) => (LANG.includes(v as never) ? (v as (typeof LANG)[number]) : undefined)

export function agentRoutes(d: ModuleDeps): RouteDef[] {
  const c = companion(d)
  return [
    /** developer product intelligence: tenant aggregates only (rows under 5 students suppressed in SQL) */
    { method: 'GET', path: '/insights/product', permission: P.insights, handler: async ({ principal, query }) => d.inTenant(principal, async (t) => {
      const days = Math.min(365, Math.max(1, Number(query.get('days')) || 30))
      const signals: Signal[] = (await t.query<{ area: string; key: string; events: string; failures: string; users: string }>('select * from education_tutor.product_signals($1)', [days])).rows
        .map((r) => ({ area: r.area, key: r.key ?? 'unknown', events: Number(r.events), failures: Number(r.failures), users: Number(r.users) }))
      return { days, signals, recommendations: recommend(signals) }
    }) },
    { method: 'GET', path: '/agent', permission: P.study, handler: async ({ principal, query }) => c.view(principal, lang(query.get('language'))) },
    /** the same turn, streamed: status events while the agent works ("Thinking…"), then the result */
    { method: 'POST', path: '/agent/messages/stream', permission: P.study, handler: async ({ principal, body }) => {
      const input = turnInput(obj(body))
      return { stream: streamTurn((emit) => withStatus(emit, () => c.turn(principal, input))) }
    } },
    /** upload own notes before any course exists: they go to a new personal course that the document will name */
    { method: 'POST', path: '/agent/material', permission: P.study, rawBody: { maxBytes: MAX_UPLOAD_BYTES }, handler: async ({ principal, query, body }) => {
      if (!d.documents) throw badRequest('materials_unavailable', 'Document upload is not available on this server')
      if (!Buffer.isBuffer(body) || !body.length) throw badRequest('file_required', 'Send the file as the request body')
      const courseId = await d.inTenant(principal, async (t) => (await t.query<{ id: string }>(`select education_tutor.create_personal_course('Untitled notes', '[{"name":"Your notes"}]'::jsonb, 'en') as id`)).rows[0]!.id)
      const doc = await d.documents.upload(principal, { scope: courseScope(courseId), visibility: 'private', trust: 'student_upload', filename: (query.get('filename') ?? 'document').slice(0, 200), data: body })
      return { courseId, documentId: doc.id, status: doc.status }
    } },
    { method: 'POST', path: '/agent/messages', permission: P.study, handler: async ({ principal, body }) => {
      const b = obj(body)
      return c.turn(principal, {
        conversationId: b.conversationId === undefined || b.conversationId === null ? undefined : uuid(b.conversationId, 'conversationId'),
        message: str(b.message, 'message', 4000), language: lang(b.language), source: b.source === 'voice' ? 'voice' : 'text',
        context: bookContext(b.context),
        documentId: typeof b.documentId === 'string' ? uuid(b.documentId, 'documentId') : undefined,
        documentTitle: typeof b.documentTitle === 'string' ? b.documentTitle.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim().slice(0, 160) || undefined : undefined,
      })
    } },
    { method: 'POST', path: '/agent/proposals/:proposalId/approve', permission: P.study, handler: async ({ principal, params, body }) =>
      c.decideProposal(principal, uuid(obj(body).conversationId, 'conversationId'), uuid(params.proposalId, 'proposalId'), true) },
    { method: 'POST', path: '/agent/proposals/:proposalId/reject', permission: P.study, handler: async ({ principal, params, body }) =>
      c.decideProposal(principal, uuid(obj(body).conversationId, 'conversationId'), uuid(params.proposalId, 'proposalId'), false) },
    /** start a fresh conversation; durable memory (profile, plan) is kept */
    { method: 'POST', path: '/agent/conversations', permission: P.study, handler: async ({ principal }) => d.inTenant(principal, async (t) => {
      const prev = (await t.query<{ state: { appliedPlan: unknown; nextSession: unknown; proposal: unknown; phase: string } }>('select state from education_tutor.agent_conversations where user_id = platform.current_user_id() order by updated_at desc limit 1')).rows[0]?.state
      const s = initialState()
      if (prev?.appliedPlan) Object.assign(s, { appliedPlan: prev.appliedPlan, nextSession: prev.nextSession, phase: 'active' })
      return { conversationId: await createConversation(t, s) }
    }) },
    { method: 'PATCH', path: '/agent/settings', permission: P.study, handler: async ({ principal, body }) => {
      const b = obj(body)
      if (typeof b.nudges !== 'boolean') throw badRequest('invalid_field', 'nudges must be true or false')
      return d.inTenant(principal, async (t) => {
        if (!(await loadProfile(d, principal, t))) throw badRequest('no_profile', 'Talk to the companion first')
        await t.query('update education_tutor.agent_profiles set nudges_enabled = $1 where user_id = platform.current_user_id()', [b.nudges])
        return { nudges: b.nudges }
      })
    } },
    { method: 'POST', path: '/agent/messages/seen', permission: P.study, handler: async ({ principal }) => d.inTenant(principal, async (t) => {
      const r = await t.query(`update education_tutor.agent_messages set seen_at = now() where user_id = platform.current_user_id() and role = 'agent' and seen_at is null`)
      return { seen: r.rowCount }
    }) },
    { method: 'GET', path: '/agent/unread', permission: P.study, handler: async ({ principal }) => d.inTenant(principal, async (t) =>
      ({ unread: (await t.query<{ n: number }>(`select count(*)::int as n from education_tutor.agent_messages where user_id = platform.current_user_id() and kind = 'nudge' and seen_at is null`)).rows[0]!.n })) },
    /** "forget me": delete the companion's memory of this student (profile, conversations, traces, scheduled tasks) */
    { method: 'DELETE', path: '/agent/memory', permission: P.study, handler: async ({ principal }) => d.inTenant(principal, async (t) => {
      await t.query('delete from education_tutor.agent_tasks where user_id = platform.current_user_id()')
      await t.query('delete from education_tutor.agent_tool_calls where user_id = platform.current_user_id()')
      await t.query('delete from education_tutor.agent_conversations where user_id = platform.current_user_id()')
      await t.query('delete from education_tutor.agent_profiles where user_id = platform.current_user_id()')
      await d.audit(t, principal, { action: 'agent.memory_deleted', targetType: 'agent_profile', targetId: principal.userId })
    }) },
  ]
}

function bookContext(v: unknown) {
  if (!v || typeof v !== 'object') return undefined
  const c = v as Record<string, unknown>
  if (typeof c.bookId !== 'string') return undefined
  const pageNo = Number(c.pageNo)
  return { bookId: uuid(c.bookId, 'context.bookId'), pageNo: Number.isInteger(pageNo) && pageNo >= 1 ? pageNo : 1, blockId: typeof c.blockId === 'string' ? c.blockId.slice(0, 40) : null, selection: typeof c.selection === 'string' && c.selection.trim() ? c.selection.trim().slice(0, 1500) : null }
}

function turnInput(b: Record<string, unknown>) {
  return {
    conversationId: b.conversationId === undefined || b.conversationId === null ? undefined : uuid(b.conversationId, 'conversationId'),
    message: str(b.message, 'message', 4000), language: lang(b.language), source: b.source === 'voice' ? 'voice' as const : 'text' as const,
    context: bookContext(b.context),
    documentId: typeof b.documentId === 'string' ? uuid(b.documentId, 'documentId') : undefined,
    documentTitle: typeof b.documentTitle === 'string' ? b.documentTitle.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim().slice(0, 160) || undefined : undefined,
  }
}

/** events of a running turn as an async stream: status lines, then {type:'done', result} (or an error event) */
async function* streamTurn<T>(run: (emit: (e: StatusEvent) => void) => Promise<T>): AsyncGenerator<unknown> {
  const queue: unknown[] = []
  let wake: (() => void) | null = null
  let finished = false
  const push = (e: unknown) => { queue.push(e); wake?.(); wake = null }
  run(push).then((result) => push({ type: 'done', result }), (e: unknown) => push({ type: 'failed', code: (e as { code?: string }).code ?? 'internal', message: (e as { status?: number }).status && (e as { status: number }).status < 500 ? (e as Error).message : 'The tutor could not finish this step.', status: (e as { status?: number }).status ?? 500 }))
    .finally(() => { finished = true; wake?.(); wake = null })
  while (true) {
    while (queue.length) {
      const e = queue.shift()
      yield e
      if ((e as { type: string }).type === 'done' || (e as { type: string }).type === 'failed') return
    }
    if (finished && !queue.length) return
    await new Promise<void>((r) => { wake = r })
  }
}
