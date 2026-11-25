/**
 * Per-run context handed to every node through `config.configurable.ctx`. It is NEVER checkpointed: it holds the
 * decrypted student text, the learner profile and tool results. The runner rebuilds it from the database for every
 * invocation (also when a run resumes after a restart), so nodes stay restart-safe.
 */
import type { LangGraphRunnableConfig } from '@langchain/langgraph'
import type { ModuleDeps, Principal } from '@platform/contracts'
import type { Sql } from '@platform/tenancy-db'
import type { LearnerProfile } from '../profile.ts'
import type { Message } from '../store.ts'
import type { ToolRegistry } from '../tools.ts'
import type { studioService } from '../../studio/service.ts'
import type { Lang, Usage } from './rules.ts'

export interface TurnContext {
  d: ModuleDeps
  p: Principal
  tools: ToolRegistry
  studio: ReturnType<typeof studioService>
  now: Date
  conversationId: string
  /** conversation version when this run started (optimistic concurrency on save) */
  convVersion: number
  /** the student's message for this turn (decrypted; empty for button presses) */
  text: string
  history: Message[]
  /** working profile (saved at checkpoints of the journey, never in the graph state) */
  profile: LearnerProfile
  loaded: LearnerProfile
  courses: { id: string; code: string; title: string; createdAt?: string }[]
  concepts: { id: string; name: string }[]
  stated: Set<string>
  usage: Usage[]
  /** tool results the reply is composed from (may contain material excerpts: not checkpointed) */
  results: Record<string, unknown>
  draft: string | null
  /** a reply already decided by a node (document summary, book answer, honest failure) */
  reply: string | null
  lang: Lang
  /** answers of a submitted onboarding intake (student text: never checkpointed) */
  intake?: { id: string; answers: Record<string, string>; review: boolean } | null
}

export const ctxOf = (config: LangGraphRunnableConfig): TurnContext => {
  const c = config.configurable?.ctx as TurnContext | undefined
  if (!c) throw new Error('companion graph invoked without a turn context')
  return c
}
export const tx = <T>(c: TurnContext, fn: (t: Sql) => Promise<T>) => c.d.inTenant(c.p, fn)
