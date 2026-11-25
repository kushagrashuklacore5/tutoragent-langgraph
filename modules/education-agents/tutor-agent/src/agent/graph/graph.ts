/**
 * The companion graph (LangGraph). One thread per conversation; one run per student turn, or a resumed run when the
 * thread is waiting at an interrupt (roadmap approval, document scope).
 *
 *   START → load → understand ─┬─ proposal button  → apply_plan | reject_plan ─────────────┐
 *                              ├─ upload (setting up) → document (subgraph) ─────────────┤
 *                              ├─ upload (plan active) → open_upload ─────────────────────┤
 *                              ├─ approve the pending plan → apply_plan ──────────────────┤
 *                              ├─ doubt from a book page → book_doubt ────────────────────┤
 *                              ├─ "continue" → resume_book ───────────────────────────────┤
 *                              └─ otherwise → act ─┬─ planning (subgraph) ─┬─ (intake submitted) → apply_plan
 *                                                  └──────────────────────────────────────┤
 *                                                                                  respond ┴→ approval_gate → load
 *                                                                                          ├→ scope_gate    → load
 *                                                                                          └→ END
 */
import { END, MemorySaver, START, StateGraph } from '@langchain/langgraph'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import { act, bookDoubt, resumeBook, shouldPlan } from './nodes/actions.ts'
import { documentGraph, openUpload } from './nodes/document.ts'
import { applyPlan, planningGraph, rejectPlan } from './nodes/planning.ts'
import { approvalGate, respond, scopeGate } from './nodes/respond.ts'
import { load, understand } from './nodes/understand.ts'
import { BOOK_EXITS, BOOK_INTENTS } from './rules.ts'
import { CompanionState, type CompanionStateT } from './state.ts'

type Next = 'apply_plan' | 'reject_plan' | 'document' | 'open_upload' | 'book_doubt' | 'resume_book' | 'act' | 'respond'
export function routeTurn(s: CompanionStateT): Next {
  const t = s.turn!, d = s.decision!, conv = s.conv!
  const pending = conv.phase === 'awaiting_approval' && !!conv.proposal && conv.appliedPlan?.proposalId !== conv.proposal.id
  if (t.proposalDecision) return !t.proposalDecision.approve ? 'reject_plan' : pending ? 'apply_plan' : 'respond'
  if (t.documentId) return d.inSetup || !conv.appliedPlan ? 'document' : 'open_upload'
  if (d.intent === 'approve_plan' && pending) return 'apply_plan'
  if (t.context && BOOK_INTENTS.has(d.intent) && !d.actions.some((a) => BOOK_EXITS.has(a.tool))) return 'book_doubt'
  if (d.intent === 'continue' && conv.activeBook) return 'resume_book'
  return 'act'
}
export const afterRespond = (s: CompanionStateT): 'approval_gate' | 'scope_gate' | typeof END =>
  s.flags.proposed ? 'approval_gate' : s.flags.askScope?.length ? 'scope_gate' : END

export function buildCompanionGraph(checkpointer: BaseCheckpointSaver | undefined) {
  return new StateGraph(CompanionState)
    .addNode('load', load)
    .addNode('understand', understand)
    .addNode('document', documentGraph)
    .addNode('open_upload', openUpload)
    .addNode('apply_plan', applyPlan)
    .addNode('reject_plan', rejectPlan)
    .addNode('book_doubt', bookDoubt)
    .addNode('resume_book', resumeBook)
    .addNode('act', act)
    .addNode('planning', planningGraph)
    .addNode('respond', respond)
    .addNode('approval_gate', approvalGate)
    .addNode('scope_gate', scopeGate)
    .addEdge(START, 'load')
    .addEdge('load', 'understand')
    .addConditionalEdges('understand', routeTurn, ['apply_plan', 'reject_plan', 'document', 'open_upload', 'book_doubt', 'resume_book', 'act', 'respond'])
    .addConditionalEdges('act', (s, config) => (shouldPlan(s, config) ? 'planning' : 'respond'), ['planning', 'respond'])
    .addEdge('document', 'respond')
    .addEdge('open_upload', 'respond')
    .addEdge('apply_plan', 'respond')
    .addEdge('reject_plan', 'respond')
    .addEdge('book_doubt', 'respond')
    .addEdge('resume_book', 'respond')
    // a submitted intake is the student's go-ahead: the proposal is applied and teaching starts (no approval loop)
    .addConditionalEdges('planning', (s) => (s.flags.autoStart && s.flags.proposed ? 'apply_plan' : 'respond'), ['apply_plan', 'respond'])
    .addConditionalEdges('respond', afterRespond, ['approval_gate', 'scope_gate', END])
    .addEdge('approval_gate', 'load')
    .addEdge('scope_gate', 'load')
    // interrupts need a checkpointer; hosts always provide PostgreSQL, the in-memory saver is for pure unit use only
    .compile({ checkpointer: checkpointer ?? new MemorySaver(), name: 'companion' })
}
export type CompanionGraph = ReturnType<typeof buildCompanionGraph>
