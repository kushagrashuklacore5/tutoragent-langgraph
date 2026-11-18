/** HTTP routes of the study companion (students; owner-only data). */
import { badRequest } from '@platform/core'
import type { ModuleDeps, RouteDef } from '@platform/contracts'
import { obj, P, str, uuid } from '../common.ts'
import { companion } from './orchestrator.ts'
import { createConversation, initialState, loadProfile } from './store.ts'

const LANG = ['en', 'hi', 'hinglish'] as const
const lang = (v: unknown) => (LANG.includes(v as never) ? (v as (typeof LANG)[number]) : undefined)

export function agentRoutes(d: ModuleDeps): RouteDef[] {
  const c = companion(d)
  return [
    { method: 'GET', path: '/agent', permission: P.study, handler: async ({ principal, query }) => c.view(principal, lang(query.get('language'))) },
    { method: 'POST', path: '/agent/messages', permission: P.study, handler: async ({ principal, body }) => {
      const b = obj(body)
      return c.turn(principal, {
        conversationId: b.conversationId === undefined || b.conversationId === null ? undefined : uuid(b.conversationId, 'conversationId'),
        message: str(b.message, 'message', 4000), language: lang(b.language), source: b.source === 'voice' ? 'voice' : 'text',
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
