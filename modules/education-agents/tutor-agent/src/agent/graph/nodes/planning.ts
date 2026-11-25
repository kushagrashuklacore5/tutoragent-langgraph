/**
 * Course & roadmap subgraph: begin → syllabus → [papers] → mastery → propose → [diagnostic] → finish.
 * Every step is its own checkpointed node: a run interrupted by a crash or restart continues at the step it was on
 * (completed steps are not executed again). Optional steps (exam evidence, starting-point check) may be skipped,
 * never fail the plan. The proposal is then shown and the parent graph waits at the approval interrupt.
 * apply_plan applies the STORED proposal after the student's approval (button or explicit reply) — never model output.
 */
import { randomUUID } from 'node:crypto'
import { StateGraph, START, END, type LangGraphRunnableConfig } from '@langchain/langgraph'
import { prepareSession } from '../../nudges.ts'
import { TEMPLATES } from '../../prompts.ts'
import type { Card, Proposal, Workflow } from '../../store.ts'
import { executeTool } from '../../tools.ts'
import { QUESTION_SET_JOB } from '../../job-names.ts'
import { ctxOf, tx } from '../context.ts'
import { APPLY_STEPS, planningSteps, proposalCard, withoutLinks } from '../rules.ts'
import { CompanionState, type CompanionStateT, type CompanionUpdate } from '../state.ts'

type StepKey = 'syllabus' | 'papers' | 'mastery' | 'propose' | 'diagnostic'
const TOOL: Record<StepKey, string> = { syllabus: 'curriculum.syllabus', papers: 'exam.insights', mastery: 'mastery.analyse', propose: 'plan.propose', diagnostic: 'assessment.self_test' }

function begin(s: CompanionStateT, config: LangGraphRunnableConfig): CompanionUpdate {
  const c = ctxOf(config)
  const steps = planningSteps(c.profile)
  const wf: Workflow = { id: randomUUID(), kind: 'planning', status: 'running', steps: steps.map((x) => ({ name: x.name, status: 'pending' as const })), updatedAt: c.now.toISOString() }
  return { workflow: wf, conv: { ...s.conv!, phase: 'planning', workflow: wf } }
}

const step = (key: StepKey) => async (s: CompanionStateT, config: LangGraphRunnableConfig): Promise<CompanionUpdate> => {
  const c = ctxOf(config)
  const plan = planningSteps(c.profile).find((x) => x.tool === TOOL[key])!
  const wf: Workflow = structuredClone(s.workflow!)
  const st = wf.steps.find((x) => x.name === plan.name)!
  const o = await executeTool(c.tools, { d: c.d, p: c.p, conversationId: c.conversationId, now: c.now }, plan.tool, { courseId: c.profile.courseId, ...(plan.args ?? {}) }, { origin: 'orchestrator' })
  const out = { tool: o.tool, status: o.status, ms: o.durationMs, error: o.error?.code }
  if (o.status !== 'ok') {
    st.status = plan.optional ? 'skipped' : 'failed'
    st.error = o.error?.code ?? o.status
    if (!plan.optional) wf.status = 'failed'
    return { workflow: wf, outcomes: [out] }
  }
  st.status = 'done'
  delete st.error
  const update: CompanionUpdate = { workflow: wf, outcomes: [out] }
  if (key === 'propose') update.conv = { ...s.conv!, proposal: o.result as Proposal }
  else c.results[plan.tool] = withoutLinks(o.result)
  // the starting-point check prepared while planning is offered as a link (never opened before approval)
  const r = o.result as { href?: string; label?: string }
  if (key === 'diagnostic' && r.href && r.label) update.cards = [{ type: 'links', links: [{ label: r.label, href: r.href }] }]
  return update
}

function finish(s: CompanionStateT, config: LangGraphRunnableConfig): CompanionUpdate {
  const c = ctxOf(config)
  const wf: Workflow = { ...structuredClone(s.workflow!), updatedAt: new Date().toISOString() }
  if (wf.status !== 'failed') wf.status = 'done'
  const conv = { ...s.conv!, workflow: wf }
  const proposal = wf.status === 'done' ? conv.proposal : null
  if (!proposal) {
    conv.phase = conv.appliedPlan ? 'active' : 'onboarding'
    return { conv, workflow: wf, cards: [{ type: 'workflow', workflow: wf }], flags: { failedStep: wf.steps.find((x) => x.status === 'failed')?.name ?? 'planning' } }
  }
  conv.phase = 'awaiting_approval'
  c.results.planProposal = (() => { const { plan: _p, ...rm } = proposal.roadmap; return { course: proposal.courseTitle, inputs: proposal.inputs, ...rm } })()
  // the student must see and approve the plan first: nothing opens by itself in this reply
  return { conv, workflow: wf, cards: [{ type: 'workflow', workflow: wf }, proposalCard(proposal)], flags: { proposed: true } }
}

const exam = (config: LangGraphRunnableConfig) => planningSteps(ctxOf(config).profile).some((x) => x.tool === TOOL.papers)
const failed = (s: CompanionStateT) => s.workflow?.status === 'failed'

export const planningGraph = new StateGraph(CompanionState)
  .addNode('begin', begin)
  .addNode('syllabus', step('syllabus'))
  .addNode('papers', step('papers'))
  .addNode('mastery', step('mastery'))
  .addNode('propose', step('propose'))
  .addNode('diagnostic', step('diagnostic'))
  .addNode('finish', finish)
  .addEdge(START, 'begin')
  .addEdge('begin', 'syllabus')
  .addConditionalEdges('syllabus', (s, config) => (failed(s) ? 'finish' : exam(config) ? 'papers' : 'mastery'), ['finish', 'papers', 'mastery'])
  .addEdge('papers', 'mastery')
  .addConditionalEdges('mastery', (s) => (failed(s) ? 'finish' : 'propose'), ['finish', 'propose'])
  .addConditionalEdges('propose', (s, config) => (!failed(s) && exam(config) ? 'diagnostic' : 'finish'), ['diagnostic', 'finish'])
  .addEdge('diagnostic', 'finish')
  .addEdge('finish', END)
  .compile()

/** the student approved the pending proposal: apply the STORED proposal, prepare today, start learning */
export async function applyPlan(s: CompanionStateT, config: LangGraphRunnableConfig): Promise<CompanionUpdate> {
  const c = ctxOf(config)
  const conv = structuredClone(s.conv!)
  const pr = conv.proposal!
  const wf: Workflow = { id: randomUUID(), kind: 'apply_plan', status: 'running', steps: APPLY_STEPS.map((name) => ({ name, status: 'pending' as const })), updatedAt: c.now.toISOString() }
  const o = await executeTool(c.tools, { d: c.d, p: c.p, conversationId: c.conversationId, now: c.now }, 'plan.apply', { proposal: pr }, { origin: 'orchestrator', approved: true })
  const out = { tool: o.tool, status: o.status, ms: o.durationMs, error: o.error?.code }
  if (o.status !== 'ok') {
    wf.status = 'failed'; wf.steps[0]!.status = 'failed'; wf.steps[0]!.error = o.error?.code ?? o.status
    return { outcomes: [out], flags: { failedStep: APPLY_STEPS[0]! } }
  }
  wf.steps[0]!.status = 'done'; wf.steps[1]!.status = 'done'
  const today = c.now.toISOString().slice(0, 10)
  const due = await tx(c, async (t) => (await t.query<{ n: number }>(`select count(*)::int as n from education_tutor.cards where course_id = $1 and user_id = platform.current_user_id() and due_at <= now()`, [pr.courseId])).rows[0]!.n)
  const agenda = prepareSession({ today, courseId: pr.courseId, dueCards: due, tasks: pr.roadmap.plan.tasks.filter((x) => x.kind !== 'review') as never, checkpoints: pr.roadmap.checkpoints, openDoubts: (c.profile.doubts ?? []).filter((x) => x.status === 'open') })
  conv.nextSession = { ...agenda, courseId: pr.courseId }
  wf.steps[2]!.status = 'done'; wf.status = 'done'; wf.updatedAt = new Date().toISOString()
  const v = (o.result as { version: number }).version
  conv.appliedPlan = { courseId: pr.courseId, version: v, proposalId: pr.id, appliedAt: c.now.toISOString() }
  conv.phase = 'active'
  const cards: Card[] = [{ type: 'workflow', workflow: wf }, { type: 'agenda', agenda }]
  // the plan's question set is built ONCE in the background, from the student's document first
  const planConcepts = [...new Set(pr.roadmap.milestones.flatMap((m) => m.conceptIds))]
  const src = conv.sourceDoc?.courseId === pr.courseId ? conv.sourceDoc : null
  if (planConcepts.length && src) {
    await tx(c, (t) => c.d.enqueue(t, QUESTION_SET_JOB, { userId: c.p.userId, courseId: pr.courseId, conceptIds: planConcepts, documentId: src.id }, { idempotencyKey: `qs:${c.p.userId}:${pr.courseId}:${v}:${pr.id}` })).catch(() => {})
    conv.questionSet = { courseId: pr.courseId, total: planConcepts.length, done: 0, status: 'building', added: 0, fromDocument: 0 }
  }
  // approved → learning starts: the course's existing book, a book from the source document, or the upload space
  const reuse = conv.activeBook && conv.activeBook.courseId === pr.courseId ? conv.activeBook : null
  // approving (button, reply or the intake) is the go-ahead: the book opens and Vidya starts teaching
  if (reuse) cards.push({ type: 'links', links: [{ label: `Open the book: ${reuse.title}`, href: `/studio/${reuse.id}?teach=1` }], auto: true })
  else {
    const tool = c.profile.material === 'own' && !src ? 'materials.open' : 'studio.open'
    const args = tool === 'materials.open' ? { courseId: pr.courseId } : { courseId: pr.courseId, title: (src?.title ?? c.profile.topic ?? pr.courseTitle).slice(0, 160), ...(src ? { documentId: src.id } : {}) }
    const b = await executeTool(c.tools, { d: c.d, p: c.p, conversationId: c.conversationId, now: c.now }, tool, args, { origin: 'orchestrator' })
    if (b.status === 'ok') {
      const res = b.result as { href: string; label: string; bookId?: string }
      if (res.bookId) conv.activeBook = { id: res.bookId, title: c.profile.topic ?? pr.courseTitle, courseId: pr.courseId }
      cards.push({ type: 'links', links: [{ label: res.label, href: res.bookId ? `${res.href}?teach=1` : res.href }], auto: true })
    } else return { conv, cards, outcomes: [out, { tool: b.tool, status: b.status, ms: b.durationMs, error: b.error?.code }], flags: { proposed: false, applied: { milestones: (o.result as { milestones: number }).milestones, checkpoints: (o.result as { checkpoints: number }).checkpoints, today: '-' }, failedStep: 'Opening your first lesson' } }
  }
  const r = o.result as { milestones: number; checkpoints: number }
  return { conv, cards, outcomes: [out], flags: { proposed: false, applied: { milestones: r.milestones, checkpoints: r.checkpoints, today: conv.nextSession?.items.map((i) => i.label).join('; ') || '-' } } }
}

/** the student declined the proposal (button): keep it until they say what to change */
export function rejectPlan(_s: CompanionStateT, config: LangGraphRunnableConfig): CompanionUpdate {
  const c = ctxOf(config)
  c.reply = TEMPLATES.rejected[c.lang]
  return { flags: { rejected: true } }
}
