/**
 * Graph state of one companion thread (checkpointed in PostgreSQL after every step).
 * STRUCTURAL ONLY: ids, phases, decisions, cards and tool outcome summaries. Student text, replies, profile values
 * and tool results stay out of the checkpoint (they are encrypted in our tables, or live in the per-run context).
 */
import { Annotation } from '@langchain/langgraph'
import type { Intent } from '../prompts.ts'
import type { Card, ConvState, Workflow } from '../store.ts'
import type { BookContext, Lang } from './rules.ts'

/** one student turn, as stored by the runner (the message text itself is encrypted in agent_messages) */
export interface TurnInput {
  messageId: string
  source: 'text' | 'voice'
  language?: Lang
  context?: BookContext
  documentId?: string
  documentTitle?: string
  /** a button press on the pending plan proposal (no message to interpret) */
  proposalDecision?: { proposalId: string; approve: boolean }
  /** a submitted onboarding intake (the answers themselves travel in the run context, never the checkpoint) */
  intakeId?: string
}
export interface Decision {
  intent: Intent
  /** tool requests that survived the rules, in order (rule-required ones first) */
  actions: { tool: string; args: Record<string, unknown> }[]
  switchTo: { kind: 'existing'; courseId: string } | { kind: 'new'; subject: string } | null
  resumeBook: boolean
  askSubject: boolean
  planChanged: boolean
  inSetup: boolean
}
export interface OutcomeSummary { tool: string; status: string; ms: number; error?: string }
export interface Flags {
  failedStep?: string | null
  courseFailed?: boolean
  needUpload?: boolean
  uploadedBook?: boolean
  applied?: { milestones: number; checkpoints: number; today: string } | null
  /** a plan proposal was made in this turn (the run then waits at the approval interrupt) */
  proposed?: boolean
  /** after a document summary: the section choices (the run then waits at the scope interrupt) */
  askScope?: string[] | null
  rejected?: boolean
  /** the student submitted the intake (or said go ahead): the plan is applied and learning starts without an approval step */
  autoStart?: boolean
}

/** append-only per turn; `{ reset: true }` clears it at the start of a turn */
type Reset = { reset: true }
const perTurn = <T>() => Annotation<T[], T[] | Reset>({
  reducer: (a, b) => ('reset' in (b as object) && !Array.isArray(b) ? [] : [...a, ...(b as T[])]),
  default: () => [],
})
export const RESET: Reset = { reset: true }

export const CompanionState = Annotation.Root({
  turn: Annotation<TurnInput | null>({ reducer: (_a, b) => b, default: () => null }),
  conv: Annotation<ConvState | null>({ reducer: (_a, b) => b, default: () => null }),
  decision: Annotation<Decision | null>({ reducer: (_a, b) => b, default: () => null }),
  /** merged field by field within a turn; replaced wholesale at the start of a turn */
  flags: Annotation<Flags, Flags & { replace?: boolean }>({ reducer: (a, b) => (b.replace ? { ...b, replace: undefined } : { ...a, ...b }), default: () => ({}) }),
  cards: perTurn<Card>(),
  outcomes: perTurn<OutcomeSummary>(),
  /** the planning workflow card (resumable: completed steps are not repeated) */
  workflow: Annotation<Workflow | null>({ reducer: (_a, b) => b, default: () => null }),
})
export type CompanionStateT = typeof CompanionState.State
export type CompanionUpdate = typeof CompanionState.Update
