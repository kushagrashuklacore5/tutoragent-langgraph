/**
 * Companion memory, owner-only (RLS) and encrypted at rest:
 *   - durable learner memory: agent_profiles.profile_enc (goals, preferences, doubts) — kept until the student deletes it
 *   - session state: agent_conversations.state (phase, asked slots, proposal, workflow) — structural, no free text
 *   - conversation: agent_messages.content_enc — purged after RETENTION_DAYS without activity
 */
import { randomUUID } from 'node:crypto'
import { AppError } from '@platform/core'
import type { ModuleDeps, Principal } from '@platform/contracts'
import type { Sql } from '@platform/tenancy-db'
import type { LearnerProfile, Slot } from './profile.ts'
import type { Roadmap } from './roadmap.ts'
import type { Link, SessionAgenda } from './nudges.ts'

export const RETENTION_DAYS = 180

export interface Proposal {
  id: string
  courseId: string
  courseTitle: string
  createdAt: string
  inputs: { examDate: string | null; dailyMinutes: number; studyDaysPerWeek: number }
  roadmap: Roadmap
  strategy?: { name: string; label: string; mix: Record<string, number> }
  examEvidence?: { papers: number; top: { name: string; priority: number; verified: string; confidence: string }[] }
}
export interface WorkflowStep { name: string; status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; error?: string }
export interface Workflow { id: string; kind: 'planning' | 'apply_plan'; status: 'running' | 'done' | 'failed'; steps: WorkflowStep[]; updatedAt: string }
export interface ConvState {
  phase: 'onboarding' | 'planning' | 'awaiting_approval' | 'active'
  asked: string[]
  lastAsked: Slot | null
  proposal: Proposal | null
  workflow: Workflow | null
  appliedPlan: { courseId: string; version: number; proposalId: string; appliedAt: string } | null
  nextSession: (SessionAgenda & { courseId: string }) | null
  topic: { conceptId: string | null; name: string } | null
}
export const initialState = (): ConvState => ({ phase: 'onboarding', asked: [], lastAsked: null, proposal: null, workflow: null, appliedPlan: null, nextSession: null, topic: null })

export interface Card {
  type: 'plan_proposal' | 'links' | 'workflow' | 'agenda' | 'sources'
  proposal?: Pick<Proposal, 'id' | 'courseId' | 'courseTitle' | 'inputs' | 'strategy' | 'examEvidence'> & { roadmap: Omit<Roadmap, 'plan'> }
  links?: Link[]
  workflow?: Workflow
  agenda?: SessionAgenda
  sources?: { filename: string; pages: string; href: string }[]
  title?: string
}
export interface Message { id: string; role: 'student' | 'agent'; kind: 'text' | 'nudge'; content: string; cards: Card[]; createdAt: string; seen: boolean }

type Crypto = NonNullable<ModuleDeps['crypto']>
const cryptoOf = (d: ModuleDeps): Crypto => {
  if (!d.crypto) throw new AppError('crypto_unavailable', 'Encryption at rest is not configured on this server', { status: 503 })
  return d.crypto
}

export async function loadProfile(d: ModuleDeps, p: Pick<Principal, 'tenantId' | 'userId'>, t: Sql): Promise<LearnerProfile | null> {
  const r = (await t.query<{ profile_enc: string }>('select profile_enc from education_tutor.agent_profiles where user_id = platform.current_user_id()')).rows[0]
  if (!r) return null
  return JSON.parse(await cryptoOf(d).decrypt(p, { table: 'agent_profiles', column: 'profile_enc', recordId: p.userId }, r.profile_enc)) as LearnerProfile
}
export async function saveProfile(d: ModuleDeps, p: Pick<Principal, 'tenantId' | 'userId'>, t: Sql, profile: LearnerProfile): Promise<void> {
  const enc = await cryptoOf(d).encrypt(p, { table: 'agent_profiles', column: 'profile_enc', recordId: p.userId }, JSON.stringify(profile))
  await t.query(`insert into education_tutor.agent_profiles (tenant_id, user_id, profile_enc) values (platform.current_tenant(), platform.current_user_id(), $1)
    on conflict (tenant_id, user_id) do update set profile_enc = excluded.profile_enc, updated_at = now()`, [enc])
}

export async function latestConversation(t: Sql): Promise<{ id: string; state: ConvState; version: number; updated_at: Date } | null> {
  return (await t.query<{ id: string; state: ConvState; version: number; updated_at: Date }>(
    'select id, state, version, updated_at from education_tutor.agent_conversations where user_id = platform.current_user_id() order by updated_at desc limit 1')).rows[0] ?? null
}
export async function getConversation(t: Sql, id: string, lock = false) {
  return (await t.query<{ id: string; state: ConvState; version: number; updated_at: Date }>(
    `select id, state, version, updated_at from education_tutor.agent_conversations where id = $1${lock ? ' for update' : ''}`, [id])).rows[0] ?? null
}
export async function createConversation(t: Sql, state: ConvState = initialState()): Promise<string> {
  const id = randomUUID()
  await t.query(`insert into education_tutor.agent_conversations (id, tenant_id, user_id, state) values ($1, platform.current_tenant(), platform.current_user_id(), $2)`, [id, JSON.stringify(state)])
  return id
}
export async function saveState(t: Sql, id: string, state: ConvState): Promise<void> {
  await t.query('update education_tutor.agent_conversations set state = $2, version = version + 1, updated_at = now() where id = $1', [id, JSON.stringify(state)])
}

export async function addMessage(d: ModuleDeps, p: Pick<Principal, 'tenantId'>, t: Sql, convId: string, m: { role: 'student' | 'agent'; kind?: 'text' | 'nudge'; content: string; cards?: Card[]; usage?: unknown; dedupeKey?: string }): Promise<{ id: string; created: boolean }> {
  const id = randomUUID()
  const enc = await cryptoOf(d).encrypt(p, { table: 'agent_messages', column: 'content', recordId: id }, m.content)
  // clock_timestamp: messages written in one transaction keep their order
  const r = await t.query(`insert into education_tutor.agent_messages (id, tenant_id, user_id, conversation_id, role, kind, content_enc, cards, usage, dedupe_key, created_at)
    values ($1, platform.current_tenant(), platform.current_user_id(), $2, $3, $4, $5, $6, $7, $8, clock_timestamp()) on conflict do nothing`,
  [id, convId, m.role, m.kind ?? 'text', enc, JSON.stringify(m.cards ?? []), m.usage === undefined ? null : JSON.stringify(m.usage), m.dedupeKey ?? null])
  return { id, created: r.rowCount === 1 }
}

export async function listMessages(d: ModuleDeps, p: Pick<Principal, 'tenantId'>, t: Sql, convId: string, limit = 50): Promise<Message[]> {
  const rows = (await t.query<{ id: string; role: 'student' | 'agent'; kind: 'text' | 'nudge'; content_enc: string; cards: Card[]; created_at: Date; seen_at: Date | null }>(
    `select * from (select id, role, kind, content_enc, cards, created_at, seen_at from education_tutor.agent_messages where conversation_id = $1 order by created_at desc, id desc limit $2) x order by created_at, id`, [convId, limit])).rows
  const c = cryptoOf(d)
  return Promise.all(rows.map(async (r) => ({ id: r.id, role: r.role, kind: r.kind, cards: r.cards, createdAt: r.created_at.toISOString(), seen: r.role === 'student' || !!r.seen_at, content: await c.decrypt(p, { table: 'agent_messages', column: 'content', recordId: r.id }, r.content_enc) })))
}
